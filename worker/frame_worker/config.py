import os
from dataclasses import dataclass
from pathlib import Path
from urllib.parse import urlparse


def boolean(env, name, default="false"):
    value = env.get(name, default)
    if value not in ("true", "false"):
        raise ValueError(f"{name} must be true or false")
    return value == "true"


def interval(env, name, default):
    value = int(env.get(name, default))
    if not 10 <= value <= 86400:
        raise ValueError(f"{name} must be between 10 and 86400")
    return value


@dataclass(frozen=True)
class Config:
    backend: str
    token: str
    state_dir: Path
    shared_dir: Path
    host: str
    port: int
    enabled: bool
    demo: bool
    safe_probes: bool
    matte: str
    evaluation_seconds: int
    minimum_seconds: int

    @classmethod
    def load(cls, env=None):
        env = os.environ if env is None else env
        backend = env.get("DASHBOARD_BACKEND_URL", "http://dashboard:4321").rstrip("/")
        parsed = urlparse(backend)
        if parsed.scheme not in ("https", "http") or not parsed.hostname or parsed.username or parsed.password or parsed.path or parsed.query or parsed.fragment:
            raise ValueError("DASHBOARD_BACKEND_URL must be a credential-free origin")
        demo = boolean(env, "DEMO_MODE")
        token = env.get("WORKER_TOKEN", "")
        if not demo and len(token) < 32:
            raise ValueError("WORKER_TOKEN requires at least 32 characters")
        port = int(env.get("TV_PORT", "8002"))
        if port not in (8001, 8002):
            raise ValueError("TV_PORT must be 8001 or 8002")
        enabled = boolean(env, "ART_MODE_ENABLED")
        host = env.get("TV_HOST", "")
        if enabled and not demo and (not host or "/" in host or ":" in host):
            raise ValueError("TV_HOST must be a hostname or IPv4 address")
        matte = env.get("TV_MATTE", "none")
        if not matte or len(matte) > 100 or not all(c.isalnum() or c in "_-" for c in matte):
            raise ValueError("Invalid TV_MATTE")
        return cls(
            backend, token, Path(env.get("ART_STATE_DIR", "/state")),
            Path(env.get("ART_CONTROL_DIR", "/control")), host, port, enabled, demo,
            boolean(env, "TV_SAFE_PROBES_CONFIRMED"), matte,
            interval(env, "ART_EVALUATION_SECONDS", "60"),
            interval(env, "ART_MIN_UPLOAD_INTERVAL_SECONDS", "300"),
        )
