import os
from dataclasses import dataclass
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent


@dataclass(frozen=True)
class Settings:
    home: Path
    web_dist: Path

    @property
    def database_url(self) -> str:
        return f"sqlite:///{self.home / 'minibrain.db'}"

    @property
    def queue_path(self) -> Path:
        return self.home / "queue.db"

    def minibrain_dir(self, slug: str) -> Path:
        return self.home / "minibrains" / slug

    def jobs_dir(self) -> Path:
        return self.home / "jobs"


def load_settings() -> Settings:
    home = Path(os.environ.get("MINIBRAIN_HOME", Path.home() / ".minibrain")).expanduser()
    web_dist = Path(os.environ.get("MINIBRAIN_WEB_DIST", REPO_ROOT / "web" / "dist"))
    home.mkdir(parents=True, exist_ok=True)
    return Settings(home=home, web_dist=web_dist)
