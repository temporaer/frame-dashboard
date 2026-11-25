import argparse
import json
import os
import re
import signal
import sys
import threading
import time
from pathlib import Path

from .config import Config
from .health import healthy, record
from .lifecycle import Lifecycle
from .render import render, snapshot
from .tv import Television


def emit(event, **fields):
    print(json.dumps({"event": event, **fields}), flush=True)


def activation(config, journal):
    file = config.shared_dir / "activation.json"
    if not file.exists():
        return None
    data = json.loads(file.read_text())
    from datetime import datetime
    requested = datetime.fromisoformat(data["requestedAt"].replace("Z", "+00:00")).timestamp()
    if not 0 <= time.time() - requested < 3600 or journal.get("activation") == data["id"]:
        return None
    return data["id"]


def candidate(config, journal):
    data = snapshot(config)
    previous = journal.get("render")
    if previous and previous["sourceFingerprint"] == data["fingerprint"] and Path(previous["file"]).is_file():
        return previous
    output = config.state_dir / "renders" / ("candidate-" + data["fingerprint"] + ".jpg")
    result = render(config, data, output)
    journal.set("render", result)
    pending = journal.get("pending") or {}
    files = sorted(output.parent.iterdir(), key=lambda p: p.stat().st_mtime, reverse=True)
    for old in files[3:]:
        if re.fullmatch(r"candidate-[a-f0-9]{64}\.jpg", old.name) and str(old) != pending.get("file"):
            old.unlink()
    return result


def main(argv=None):
    parser = argparse.ArgumentParser(description="Optional Frame renderer / safe Art Mode worker")
    sub = parser.add_subparsers(dest="command", required=True)
    render_parser = sub.add_parser("render")
    render_parser.add_argument("--output", required=True)
    render_parser.add_argument("--at")
    render_parser.add_argument("--variant", choices=["day", "quiet"])
    for name in ("run", "pair", "status", "list", "activate", "health"):
        sub.add_parser(name)
    upload = sub.add_parser("upload")
    upload.add_argument("--file", required=True)
    upload.add_argument("--activate", action="store_true", help="Allow replacing other artwork, only while already in Art Mode")
    clean = sub.add_parser("cleanup")
    clean.add_argument("--apply", action="store_true", help="Default is dry-run")
    recover = sub.add_parser("recover-upload")
    recover.add_argument("--id", required=True)
    recover.add_argument("--confirm-owned", action="store_true")
    args = parser.parse_args(argv)
    os.umask(0o077)
    config = Config.load()
    if args.command == "health":
        ok = healthy(config)
        emit("worker_health", ok=ok)
        return 0 if ok else 1
    if args.command == "render":
        emit("rendered", **render(config, snapshot(config, args.at, args.variant), args.output))
        return 0
    if config.demo or not config.enabled:
        raise ValueError("TV operations require DEMO_MODE=false and ART_MODE_ENABLED=true")
    tv = Television(config)
    if args.command == "pair":
        emit("pairing", **tv.pair())
        return 0
    if args.command == "status":
        emit("tv_status", state=tv.status(operator=True), capabilities=tv.capabilities())
        return 0
    journal = Lifecycle(config.state_dir, tv, config.host, config.minimum_seconds)
    try:
        if args.command == "list":
            emit("artwork", **journal.inspect(), unproven=sorted(tv.available() - journal.owned().keys()))
        elif args.command == "cleanup":
            emit("cleanup", dryRun=not args.apply, ids=journal.cleanup(not args.apply))
        elif args.command == "recover-upload":
            journal.recover_upload(args.id, args.confirm_owned)
            emit("upload_reconciled")
        elif args.command == "upload":
            from hashlib import sha256
            from PIL import Image
            image = Path(args.file).resolve()
            with Image.open(image) as check:
                if check.format != "JPEG" or check.size != (3840, 2160):
                    raise ValueError("Test image must be a 3840 x 2160 JPEG")
            result = journal.publish(image, sha256(image.read_bytes()).hexdigest(), args.activate)
            emit("test_upload", result=result)
            return 0 if result in ("selected", "unchanged") else 1
        elif args.command == "activate":
            image = candidate(config, journal)
            result = journal.publish(image["file"], image["fingerprint"], activate=True)
            emit("activation", result=result, wake=False)
            return 0 if result in ("selected", "unchanged") else 1
        else:
            stop = threading.Event()
            for signum in (signal.SIGTERM, signal.SIGINT):
                signal.signal(signum, lambda *_: stop.set())
            while not stop.is_set():
                try:
                    image = candidate(config, journal)
                    requested = activation(config, journal)
                    result = journal.publish(image["file"], image["fingerprint"], activate=bool(requested))
                    if requested and result in ("selected", "unchanged"):
                        journal.set("activation", requested)
                    record(config, result != "recovery_required")
                    emit("art_evaluated", result=result)
                except Exception as error:
                    # Third-party exceptions may embed URLs, tokens or TV payloads.
                    record(config, False)
                    emit("art_cycle_failed", code=type(error).__name__)
                stop.wait(config.evaluation_seconds)
    finally:
        journal.close()
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as error:
        emit("command_failed", code=type(error).__name__)
        sys.exit(1)
