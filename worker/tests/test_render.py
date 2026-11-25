import copy
import json
import os
from pathlib import Path
import subprocess
from urllib.request import urlopen

from PIL import Image
import pytest

from frame_worker.config import Config
from frame_worker.render import render, snapshot


@pytest.fixture(scope="module")
def demo_server(tmp_path_factory):
    root = Path(__file__).resolve().parents[2]
    directory = tmp_path_factory.mktemp("demo")
    environment = {
        **os.environ, "DEMO_MODE": "true", "HOST": "127.0.0.1",
        "PORT": "0", "DATA_DIR": str(directory),
    }
    process = subprocess.Popen(
        ["node", "scripts/server.mjs"], cwd=root,
        env=environment, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
    )
    try:
        started = json.loads(process.stdout.readline())
        assert started["event"] == "listening"
        origin = f"http://127.0.0.1:{started['port']}"
        with urlopen(origin + "/healthz", timeout=5) as response:
            assert response.status == 200
        yield Config.load({"DEMO_MODE": "true", "DASHBOARD_BACKEND_URL": origin})
    finally:
        process.terminate()
        try:
            process.wait(timeout=30)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait()


def test_4k_day_evening_quiet_and_deterministic_clock(demo_server, tmp_path):
    day = snapshot(demo_server, "2026-11-25T10:00:00Z")
    later = snapshot(demo_server, "2026-11-25T10:01:00Z")
    evening = snapshot(demo_server, "2026-11-25T19:00:00Z")
    quiet = snapshot(demo_server, "2026-11-25T10:00:00Z", "quiet")
    results = []
    for name, data in [("day", day), ("later", later), ("evening", evening), ("quiet", quiet)]:
        output = tmp_path / (name + ".jpg")
        result = render(demo_server, data, output)
        with Image.open(output) as image:
            assert image.format == "JPEG"
            assert image.size == (3840, 2160)
        results.append(result)
    assert results[0]["sha256"] == results[1]["sha256"]
    assert len({r["sha256"] for r in results}) == 3


def test_browser_overflow_privacy_and_remote_navigation(demo_server):
    from playwright.sync_api import sync_playwright

    data = snapshot(demo_server, "2026-11-25T10:00:00Z")
    today = next(d for d in data["projection"]["days"] if d["date"] == "2026-11-25")
    today["tasks"][0]["text"] = "Ein außergewöhnlich langes gemeinsames Haushaltsvorhaben " * 12
    today["events"] = [
        {**today["events"][0], "id": str(i), "title": "Ein ausführlicher Termin mit einem langen Titel " * 4}
        for i in range(20)
    ]
    with sync_playwright() as p:
        browser = p.chromium.launch()
        try:
            page = browser.new_page(viewport={"width": 1920, "height": 1080})
            page.add_init_script("window.__FRAME_RENDER = true; window.__FRAME_SNAPSHOT = " + json.dumps(data))
            page.goto(demo_server.backend + "/render")
            page.wait_for_selector("html[data-frame-ready]", state="attached")
            assert page.locator("#tasks li:not(.more)").count() <= 5
            assert page.locator("#events li:not(.more)").count() <= 4
            assert page.locator("#tasks .more").count() == 1
            assert page.locator(".focus").is_hidden()
            assert page.locator("#day").evaluate("(e) => e.scrollHeight <= e.clientHeight + 1")
            page.keyboard.press("ArrowRight")
            assert page.locator("body").get_attribute("class").find("browsing") >= 0
            page.keyboard.press("Enter")
            assert "browsing" not in page.locator("body").get_attribute("class")
            assert page.locator("#week").is_visible()
            quiet = snapshot(demo_server, "2026-11-25T10:00:00Z", "quiet")
            page.close()
            page = browser.new_page(viewport={"width": 1920, "height": 1080})
            page.add_init_script("window.__FRAME_RENDER = true; window.__FRAME_SNAPSHOT = " + json.dumps(quiet))
            page.goto(demo_server.backend + "/render")
            page.wait_for_selector("html[data-frame-ready]", state="attached")
            assert page.locator(".placard").is_hidden()
            assert page.locator("#day").is_hidden()
            assert page.locator("#week").is_hidden()
            assert page.locator("#bleed").is_visible()
            quiet["projection"]["errors"] = ["Machbar: nicht verfügbar"]
            quiet["projection"]["health"][0]["state"] = "unavailable"
            page.close()
            page = browser.new_page(viewport={"width": 1920, "height": 1080})
            page.add_init_script("window.__FRAME_RENDER = true; window.__FRAME_SNAPSHOT = " + json.dumps(quiet))
            page.goto(demo_server.backend + "/render")
            page.wait_for_selector("html[data-frame-ready]", state="attached")
            assert page.locator("#status").is_visible()
            assert "nicht verfügbar" in page.locator("#status").inner_text()
        finally:
            browser.close()


def test_incomplete_or_failed_artwork_is_not_captured(demo_server, tmp_path):
    data = copy.deepcopy(snapshot(demo_server, "2026-11-25T10:00:00Z"))
    today = next(d for d in data["projection"]["days"] if d["date"] == "2026-11-25")
    today["art"]["image"] = "/missing-image.jpg"
    today["art"].pop("fallback", None)
    with pytest.raises(ValueError, match="valid render"):
        render(demo_server, data, tmp_path / "must-not-exist.jpg")
    assert not (tmp_path / "must-not-exist.jpg").exists()
