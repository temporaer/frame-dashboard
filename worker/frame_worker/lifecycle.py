import fcntl
import hashlib
import json
import sqlite3
import time
from contextlib import contextmanager
from pathlib import Path


class Busy(RuntimeError):
    pass


class Lifecycle:
    def __init__(self, directory, tv, host, minimum_seconds=300, clock=time.time):
        self.directory = Path(directory)
        self.directory.mkdir(parents=True, exist_ok=True, mode=0o700)
        self.tv, self.minimum_seconds, self.clock = tv, minimum_seconds, clock
        self.db = sqlite3.connect(self.directory / "images.sqlite")
        self.db.row_factory = sqlite3.Row
        self.db.executescript("""
          PRAGMA journal_mode=WAL;
          PRAGMA synchronous=FULL;
          CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
          CREATE TABLE IF NOT EXISTS images (
            id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, state TEXT NOT NULL
          );
        """)
        identity = hashlib.sha256(host.encode()).hexdigest()
        if self.get("tv") not in (None, identity):
            self.db.close()
            raise ValueError("Journal belongs to another TV; use a different state volume")
        self.set("tv", identity)

    def close(self):
        self.db.close()

    def get(self, key, default=None):
        row = self.db.execute("SELECT value FROM metadata WHERE key=?", (key,)).fetchone()
        return json.loads(row["value"]) if row else default

    def set(self, key, value):
        with self.db:
            self.db.execute("INSERT OR REPLACE INTO metadata VALUES (?, ?)", (key, json.dumps(value)))

    @contextmanager
    def lock(self):
        with (self.directory / "writer.lock").open("a") as file:
            try:
                fcntl.flock(file, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError as error:
                raise Busy("Another worker or CLI operation is running") from error
            try:
                yield
            finally:
                fcntl.flock(file, fcntl.LOCK_UN)

    def owned(self):
        return {row["id"]: dict(row) for row in self.db.execute("SELECT * FROM images")}

    def inspect(self):
        return {"owned": list(self.owned().values()), "pending": self.get("pending"), "lastSelected": self.get("selected")}

    def publish(self, file, fingerprint, activate=False):
        with self.lock():
            return self._publish(file, fingerprint, activate)

    def _publish(self, file, fingerprint, activate):
        pending = self.get("pending")
        if pending and pending["stage"] == "uploading":
            return "recovery_required"
        if self.tv.status() != "art":
            return "deferred_tv_state"
        current = self.tv.current()
        owned = self.owned()
        if current not in owned and not activate:
            return "awaiting_activation"
        if pending and pending.get("id") == current:
            self._selected(current, pending["fingerprint"])
            pending = None
        if self.get("selected") == current and self.get("fingerprint") == fingerprint:
            self._cleanup(False)
            return "unchanged"
        if pending and pending["fingerprint"] == fingerprint and pending["stage"] == "uploaded":
            content_id = pending["id"]
        else:
            if self.clock() - self.get("lastUpload", float("-inf")) < self.minimum_seconds:
                return "throttled"
            existing_images = self.tv.available()
            pending = {"stage": "uploading", "fingerprint": fingerprint, "file": str(file), "previous": current}
            self.set("pending", pending)
            self.set("lastUpload", self.clock())
            content_id = self.tv.upload(file)
            if content_id in existing_images:
                raise ValueError("TV returned a pre-existing upload ID")
            with self.db:
                self.db.execute("INSERT INTO images VALUES (?, ?, 'uploaded')", (content_id, fingerprint))
                pending = {**pending, "stage": "uploaded", "id": content_id}
                self.db.execute("INSERT OR REPLACE INTO metadata VALUES ('pending', ?)", (json.dumps(pending),))
        if self.tv.status() != "art":
            return "deferred_before_selection"
        latest = self.tv.current()
        if latest != current:
            return "deferred_user_selection"
        self.tv.select(content_id)
        if self.tv.current() != content_id:
            return "selection_unconfirmed"
        self._selected(content_id, fingerprint)
        self._cleanup(False)
        return "selected"

    def _selected(self, content_id, fingerprint):
        with self.db:
            self.db.execute("UPDATE images SET state=CASE WHEN id=? THEN 'selected' ELSE 'superseded' END", (content_id,))
            for key, value in (("selected", content_id), ("fingerprint", fingerprint), ("pending", None)):
                self.db.execute("INSERT OR REPLACE INTO metadata VALUES (?, ?)", (key, json.dumps(value)))

    def cleanup(self, dry_run=True):
        with self.lock():
            return self._cleanup(dry_run)

    def _cleanup(self, dry_run):
        if self.tv.status() != "art":
            return []
        current = self.tv.current()
        pending = self.get("pending") or {}
        available = self.tv.available()
        candidates = [
            item["id"] for item in self.owned().values()
            if item["state"] == "superseded" and item["id"] not in (current, pending.get("id"))
        ]
        if not dry_run:
            present = [item for item in candidates if item in available]
            if present:
                # Never remove the displayed artwork even if it changed mid-cleanup.
                latest = self.tv.current()
                present = [item for item in present if item != latest]
                if present:
                    self.tv.delete(present)
            remaining = self.tv.available()
            with self.db:
                for content_id in candidates:
                    if content_id not in remaining:
                        self.db.execute("DELETE FROM images WHERE id=?", (content_id,))
        return [item for item in candidates if item in available]

    def recover_upload(self, content_id, confirm_owned=False):
        with self.lock():
            pending = self.get("pending")
            if not confirm_owned or not pending or pending["stage"] != "uploading":
                raise ValueError("Explicit positive ownership confirmation and unknown upload required")
            if content_id not in self.tv.available() or content_id in self.owned():
                raise ValueError("Recovery ID is absent or already journaled")
            with self.db:
                self.db.execute("INSERT INTO images VALUES (?, ?, 'uploaded')", (content_id, pending["fingerprint"]))
                self.db.execute("INSERT OR REPLACE INTO metadata VALUES ('pending', ?)", (json.dumps({**pending, "stage": "uploaded", "id": content_id}),))
