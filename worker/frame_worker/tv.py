import logging
import os
from pathlib import Path


class Television:
    def __init__(self, config):
        self.config = config
        self.token_file = config.state_dir / "pairing.token"

    def client(self, pairing=False):
        from samsungtvws import SamsungTVWS

        # Library connection messages can contain fresh pairing credentials.
        for name in list(logging.Logger.manager.loggerDict):
            if name.startswith(("samsungtvws", "websocket")):
                logging.getLogger(name).disabled = True
        if not pairing and not self.token_file.exists():
            raise RuntimeError("Pairing required")
        self.config.state_dir.mkdir(parents=True, exist_ok=True, mode=0o700)
        os.umask(0o077)
        return SamsungTVWS(
            host=self.config.host, port=self.config.port,
            token_file=str(self.token_file), timeout=10,
            name="HouseholdFrameDashboard",
        ).art()

    def call(self, method, *args, pairing=False, **kwargs):
        client = self.client(pairing=pairing)
        try:
            return getattr(client, method)(*args, **kwargs)
        finally:
            client.close()
            if self.token_file.exists():
                self.token_file.chmod(0o600)

    def status(self, operator=False):
        if not self.config.safe_probes and not operator:
            return "unknown"
        if not self.token_file.exists():
            return "unpaired"
        result = self.call("get_artmode")
        return "art" if result == "on" else "viewing" if result == "off" else "unknown"

    def pair(self):
        version = self.call("get_api_version", pairing=True)
        return {"apiVersion": version, "paired": self.token_file.exists()}

    def current(self):
        data = self.call("get_current")
        if not isinstance(data, dict) or not isinstance(data.get("content_id"), str):
            raise ValueError("Invalid current-artwork response")
        return data["content_id"]

    def available(self):
        data = self.call("available")
        if not isinstance(data, list):
            raise ValueError("Invalid artwork list")
        return {item["content_id"] for item in data if isinstance(item, dict) and isinstance(item.get("content_id"), str)}

    def upload(self, file):
        result = self.call(
            "upload", str(Path(file)), matte=self.config.matte,
            portrait_matte=self.config.matte, file_type="jpg",
        )
        if not isinstance(result, str) or not result:
            raise ValueError("Upload outcome unknown")
        return result

    def select(self, content_id):
        return self.call("select_image", content_id, show=True)

    def delete(self, content_ids):
        if not self.call("delete_list", content_ids):
            raise RuntimeError("Deletion not confirmed")

    def capabilities(self):
        return {"apiVersion": self.call("get_api_version"), "mattes": self.call("get_matte_list")}
