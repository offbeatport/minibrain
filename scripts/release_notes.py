import argparse
import re
import shutil
import subprocess
import sys
from dataclasses import dataclass
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SERVER = "https://github.com"
HEADER = re.compile(r"^(?P<kind>[a-z]+)(?:\((?P<scope>[^)]+)\))?(?P<breaking>!)?: (?P<summary>.+)$")
BREAKING_FOOTER = re.compile(r"^BREAKING[ -]CHANGE: ", re.MULTILINE)
BREAKING = "Breaking changes"
OTHER = "Other changes"
SECTIONS = {
    "feat": "Features",
    "fix": "Fixes",
    "perf": "Performance",
    "refactor": "Refactoring",
    "docs": "Documentation",
    "build": "Build",
    "ci": "CI",
    "test": "Tests",
    "style": "Style",
    "chore": "Chores",
    "revert": "Reverts",
}
ORDER = [BREAKING, *SECTIONS.values(), OTHER]
FIELD = "\x1f"
RECORD = "\x1e"


@dataclass(frozen=True)
class Change:
    sha: str
    section: str
    scope: str | None
    summary: str

    def render(self) -> str:
        scope = f"**{self.scope}:** " if self.scope else ""
        return f"- {scope}{self.summary} ({self.sha})"


def parse(sha: str, subject: str, body: str = "") -> Change:
    found = HEADER.match(subject.strip())
    if found is None or found["kind"] not in SECTIONS:
        section = BREAKING if BREAKING_FOOTER.search(body) else OTHER
        return Change(sha, section, None, subject.strip())
    breaking = bool(found["breaking"]) or bool(BREAKING_FOOTER.search(body))
    section = BREAKING if breaking else SECTIONS[found["kind"]]
    return Change(sha, section, found["scope"], found["summary"].strip())


def git(*args: str, cwd: Path = ROOT, check: bool = True) -> str:
    executable = shutil.which("git")
    if executable is None:
        raise RuntimeError("git is not installed")
    done = subprocess.run([executable, *args], cwd=cwd, capture_output=True, text=True, check=False)
    if check and done.returncode != 0:
        raise RuntimeError(f"git {' '.join(args)} failed: {done.stderr.strip()}")
    return done.stdout if done.returncode == 0 else ""


def previous_tag(ref: str, cwd: Path = ROOT) -> str | None:
    found = git("describe", "--tags", "--abbrev=0", "--match", "v[0-9]*", f"{ref}^", cwd=cwd, check=False).strip()
    return found or None


def changes(ref: str, since: str | None, cwd: Path = ROOT) -> list[Change]:
    span = f"{since}..{ref}" if since else ref
    log = git("log", "--no-merges", f"--format=%h{FIELD}%s{FIELD}%b{RECORD}", span, cwd=cwd)
    records = [record.strip("\n") for record in log.split(RECORD) if record.strip()]
    return [parse(*record.split(FIELD, 2)) for record in records]


def install_lines(version: str, repo: str, image: str) -> list[str]:
    wheel = f"{SERVER}/{repo}/releases/download/v{version}/minibrain-{version}-py3-none-any.whl"
    return [
        "## Install",
        "",
        f"- Wheel: `uv tool install --python 3.12 {wheel}`",
        f"- Docker, CPU: `docker run -p 127.0.0.1:8000:8000 -v minibrain-data:/data {image}:{version}`",
        f"- Docker, NVIDIA CUDA 13.2: `{image}:{version}-cuda`",
        "- Check downloads with `sha256sum --check --ignore-missing SHA256SUMS`",
        f"- Guide: [docs/install.md]({SERVER}/{repo}/blob/v{version}/docs/install.md)",
    ]


def render(found: list[Change], *, version: str, since: str | None, repo: str, image: str) -> str:
    lines = install_lines(version, repo, image)
    lines += ["", f"## Changes since {since}" if since else "## Changes", ""]
    for section in ORDER:
        entries = [change.render() for change in found if change.section == section]
        if entries:
            lines += [f"### {section}", "", *entries, ""]
    if not found:
        lines += ["No commits.", ""]
    if since:
        lines += [f"**Full changelog**: {SERVER}/{repo}/compare/{since}...v{version}", ""]
    return "\n".join(lines)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Release notes from Conventional Commits since the previous v* tag")
    parser.add_argument("--version", required=True, help="the version being released, without the leading v")
    parser.add_argument("--ref", default="HEAD", help="the commit or tag being released")
    parser.add_argument("--repo", default="offbeatport/minibrain", help="owner/name on GitHub")
    parser.add_argument("--image", default="ghcr.io/offbeatport/minibrain", help="the container image name")
    args = parser.parse_args(argv)
    since = previous_tag(args.ref)
    notes = render(changes(args.ref, since), version=args.version, since=since, repo=args.repo, image=args.image)
    sys.stdout.write(notes)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
