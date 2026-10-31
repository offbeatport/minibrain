import os
import secrets
from dataclasses import dataclass
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent


@dataclass(frozen=True)
class Settings:
    home: Path
    web_dist: Path
    database: str | None = None

    @property
    def database_url(self) -> str:
        return self.database or f"sqlite:///{self.home / 'minibrain.db'}"

    def minibrain_dir(self, slug: str) -> Path:
        return self.home / "minibrains" / slug

    def artifacts_dir(self) -> Path:
        return self.home / "artifacts"

    def cache_dir(self) -> Path:
        return self.home / "cache"

    def work_dir(self) -> Path:
        return self.home / "work"

    def secret(self, name: str) -> str:
        override = os.environ.get(f"MINIBRAIN_{name.upper()}")
        if override:
            return override
        path = self.home / "secrets" / name
        if not path.exists():
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(secrets.token_urlsafe(32))
            path.chmod(0o600)
        return path.read_text().strip()


def default_web_dist() -> Path:
    packaged = Path(__file__).resolve().parent / "web"
    return packaged if (packaged / "index.html").is_file() else REPO_ROOT / "web" / "dist"


def load_settings() -> Settings:
    home = Path(os.environ.get("MINIBRAIN_HOME", Path.home() / ".minibrain")).expanduser()
    web_dist = Path(os.environ.get("MINIBRAIN_WEB_DIST", default_web_dist()))
    home.mkdir(parents=True, exist_ok=True)
    return Settings(home=home, web_dist=web_dist, database=os.environ.get("MINIBRAIN_DATABASE_URL") or None)
