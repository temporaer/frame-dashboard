from dataclasses import replace
import json
import time

from frame_worker.config import Config
from frame_worker.health import healthy, record
from frame_worker.tv import Television


def test_unconfirmed_passive_probe_never_opens_connection(tmp_path, monkeypatch):
    config = replace(Config.load({"DEMO_MODE": "true"}), state_dir=tmp_path)
    tv = Television(config)
    (tmp_path / "pairing.token").write_text("fixture")
    calls = []
    monkeypatch.setattr(tv, "call", lambda *args: calls.append(args) or "on")
    assert tv.status() == "unknown"
    assert calls == []
    assert tv.status(operator=True) == "art"
    assert calls == [("get_artmode",)]


def test_worker_heartbeat_rejects_missing_failed_and_stale_cycles(tmp_path):
    config = replace(Config.load({"DEMO_MODE": "true"}), state_dir=tmp_path)
    assert not healthy(config)
    record(config, True)
    assert healthy(config)
    record(config, False)
    assert not healthy(config)
    (tmp_path / "heartbeat.json").write_text(json.dumps({"at": time.time() - 181, "ok": True}))
    assert not healthy(config)
