import json
import os
import time


def record(config, ok):
    config.state_dir.mkdir(parents=True, exist_ok=True, mode=0o700)
    target = config.state_dir / "heartbeat.json"
    temporary = target.with_suffix(".tmp")
    temporary.write_text(json.dumps({"at": time.time(), "ok": ok}))
    temporary.chmod(0o600)
    os.replace(temporary, target)


def healthy(config):
    try:
        data = json.loads((config.state_dir / "heartbeat.json").read_text())
        return data["ok"] is True and 0 <= time.time() - data["at"] <= max(120, config.evaluation_seconds * 3)
    except (OSError, ValueError, KeyError, TypeError):
        return False
