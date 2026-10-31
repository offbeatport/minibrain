import os
import threading
import time

import httpx

PROBE_SECONDS = 60.0
PROBE_TIMEOUT = 3.0


def endpoint() -> str:
    return (
        os.environ.get("MINIBRAIN_HF_ENDPOINT") or os.environ.get("HF_ENDPOINT") or "https://huggingface.co"
    ).rstrip("/")


def offline() -> bool:
    return os.environ.get("MINIBRAIN_OFFLINE", "").strip().lower() in {"1", "true", "yes"}


def token() -> str | None:
    return os.environ.get("HF_TOKEN") or os.environ.get("HUGGING_FACE_HUB_TOKEN") or None


def headers() -> dict[str, str]:
    found = token()
    return {"Authorization": f"Bearer {found}"} if found else {}


def file_url(repo: str, revision: str, path: str) -> str:
    return f"{endpoint()}/{repo}/resolve/{revision}/{path}"


def metadata_url(repo: str, revision: str) -> str:
    return f"{endpoint()}/api/models/{repo}/revision/{revision}?blobs=true"


class Connectivity:
    def __init__(self) -> None:
        self.checked_at = 0.0
        self.online: bool | None = None
        self.lock = threading.Lock()

    def check(self) -> bool | None:
        if offline():
            return False
        with self.lock:
            if time.monotonic() - self.checked_at < PROBE_SECONDS:
                return self.online
            try:
                response = httpx.head(f"{endpoint()}/api/models", timeout=PROBE_TIMEOUT, follow_redirects=True)
                self.online = response.status_code < 500
            except httpx.HTTPError:
                self.online = False
            self.checked_at = time.monotonic()
            return self.online


CONNECTIVITY = Connectivity()
