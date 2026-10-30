import shutil
import subprocess
from pathlib import Path
from typing import Any

from hatchling.builders.hooks.plugin.interface import BuildHookInterface

WEB_DIR = "web"
DIST_DIR = "web/dist"
PACKAGED_DIR = "minibrain/web"


class CustomBuildHook(BuildHookInterface):
    def initialize(self, version: str, build_data: dict[str, Any]) -> None:
        if version == "editable":
            return
        root = Path(self.root)
        self.build_web(root / WEB_DIR)
        if not (root / DIST_DIR / "index.html").is_file():
            raise RuntimeError("web/dist is missing; install pnpm so the build can produce it")
        build_data["force_include"][str(root / DIST_DIR)] = PACKAGED_DIR

    def build_web(self, web: Path) -> None:
        pnpm = shutil.which("pnpm")
        if pnpm is None:
            self.app.display_warning("pnpm not found; packaging the existing web/dist as it is")
            return
        subprocess.run([pnpm, "install", "--frozen-lockfile"], cwd=web, check=True)
        subprocess.run([pnpm, "build"], cwd=web, check=True)
