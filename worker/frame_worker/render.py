import hashlib
import json
import os
from pathlib import Path
from urllib.error import HTTPError
from urllib.parse import urlencode, urlparse
from urllib.request import HTTPRedirectHandler, Request, build_opener


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        raise HTTPError(req.full_url, code, "Redirect refused", headers, fp)


def snapshot(config, at=None, variant=None):
    query = {k: v for k, v in {"at": at, "variant": variant}.items() if v}
    request = Request(
        config.backend + "/api/render-snapshot?" + urlencode(query),
        headers={"Authorization": "Bearer " + config.token, "Accept": "application/json"},
    )
    with build_opener(NoRedirect()).open(request, timeout=20) as response:
        raw = response.read(2 * 1024 * 1024 + 1)
    if len(raw) > 2 * 1024 * 1024:
        raise ValueError("Snapshot too large")
    data = json.loads(raw)
    if data["projection"]["schemaVersion"] != 1:
        raise ValueError("Unsupported snapshot")
    if not data["projection"].get("health") or all(h["state"] == "unavailable" for h in data["projection"]["health"]):
        raise ValueError("No valid source snapshot available")
    return data


def render(config, data, output):
    from playwright.sync_api import sync_playwright

    output = Path(output)
    output.parent.mkdir(parents=True, exist_ok=True)
    origin = urlparse(config.backend)
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True)
        try:
            context = browser.new_context(
                viewport={"width": 3840, "height": 2160}, device_scale_factor=1,
                locale=data["projection"]["locale"], timezone_id=data["projection"]["tz"],
                extra_http_headers={"Authorization": "Bearer " + config.token},
                reduced_motion="reduce",
            )

            def restrict(route):
                requested = urlparse(route.request.url)
                if (requested.scheme, requested.netloc) == (origin.scheme, origin.netloc):
                    route.continue_()
                else:
                    route.abort()

            context.route("**/*", restrict)
            context.add_init_script(
                "window.__FRAME_RENDER = true; window.__FRAME_SNAPSHOT = " +
                json.dumps(data, ensure_ascii=True) + ";"
            )
            page = context.new_page()
            response = page.goto(config.backend + "/render", wait_until="domcontentloaded")
            if response is None or response.status != 200:
                raise ValueError("Render page rejected")
            page.wait_for_selector("html[data-frame-ready], html[data-frame-error]", state="attached", timeout=45000)
            if page.evaluate("window.__FRAME_ERROR || null"):
                raise ValueError("Frontend could not produce a valid render")
            page.evaluate("document.fonts.ready")
            page.evaluate("""async () => {
              await Promise.all(Array.from(document.images).filter(i => i.src).map(i => i.decode()));
              await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
            }""")
            actual_art = page.evaluate("window.__FRAME_ART")
            image = page.screenshot(type="jpeg", quality=95, animations="disabled")
        finally:
            browser.close()
    temporary = output.with_suffix(output.suffix + ".tmp")
    with temporary.open("wb") as file:
        file.write(image)
        file.flush()
        os.fsync(file.fileno())
    temporary.replace(output)
    checksum = hashlib.sha256(image).hexdigest()
    return {"fingerprint": checksum, "sourceFingerprint": data["fingerprint"], "art": actual_art, "sha256": checksum, "file": str(output)}
