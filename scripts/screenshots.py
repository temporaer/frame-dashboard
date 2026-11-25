"""Generate synthetic 4K screenshots; leaves no server process running."""
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "worker"))
from frame_worker.config import Config
from frame_worker.render import render, snapshot


def main():
    with tempfile.TemporaryDirectory(prefix="frame-screenshots-") as directory:
        process = subprocess.Popen(
            ["node", "scripts/server.mjs"], cwd=ROOT,
            env={**os.environ, "DEMO_MODE": "true", "HOST": "127.0.0.1", "PORT": "0", "DATA_DIR": directory},
            stdout=subprocess.PIPE, text=True,
        )
        try:
            started = json.loads(process.stdout.readline())
            config = Config.load({"DEMO_MODE": "true", "DASHBOARD_BACKEND_URL": f"http://127.0.0.1:{started['port']}"})
            for name, instant, variant in [
                ("day", "2026-11-25T10:00:00Z", "day"),
                ("evening", "2026-11-25T19:00:00Z", "day"),
                ("quiet", "2026-11-25T10:00:00Z", "quiet"),
            ]:
                output = ROOT / "docs" / "screenshots" / (name + ".jpg")
                render(config, snapshot(config, instant, variant), output)
                print(output.relative_to(ROOT))
        finally:
            process.terminate()
            try:
                process.wait(timeout=30)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait()


if __name__ == "__main__":
    main()
