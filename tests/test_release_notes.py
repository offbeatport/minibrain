import os
from pathlib import Path

import pytest

from scripts.release_notes import BREAKING, OTHER, Change, changes, git, parse, previous_tag, render

IDENTITY = {
    "GIT_CONFIG_GLOBAL": os.devnull,
    "GIT_CONFIG_NOSYSTEM": "1",
    "GIT_AUTHOR_NAME": "Release Test",
    "GIT_AUTHOR_EMAIL": "release@example.com",
    "GIT_COMMITTER_NAME": "Release Test",
    "GIT_COMMITTER_EMAIL": "release@example.com",
}


@pytest.fixture
def repo(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    for name, value in IDENTITY.items():
        monkeypatch.setenv(name, value)
    git("init", "--quiet", "--initial-branch", "main", cwd=tmp_path)
    return tmp_path


def commit(repo: Path, subject: str, body: str = "") -> None:
    message = ["-m", subject, "-m", body] if body else ["-m", subject]
    git("commit", "--quiet", "--allow-empty", *message, cwd=repo)


def test_conventional_headers_pick_the_section_and_scope() -> None:
    assert parse("a1", "feat(auth): sign in with OIDC") == Change("a1", "Features", "auth", "sign in with OIDC")
    assert parse("b2", "fix: wrap header actions") == Change("b2", "Fixes", None, "wrap header actions")
    assert parse("c3", "feat(api)!: drop /api/v0").section == BREAKING
    assert parse("d4", "refactor: one guard", "BREAKING CHANGE: roles renamed").section == BREAKING
    assert parse("e5", "Merge branch main") == Change("e5", OTHER, None, "Merge branch main")
    assert parse("f6", "wip: half done") == Change("f6", OTHER, None, "wip: half done")


def test_changes_since_the_previous_tag(repo: Path) -> None:
    commit(repo, "feat: first")
    git("tag", "v0.1.0", cwd=repo)
    commit(repo, "fix(web): second")
    commit(repo, "feat(api)!: third")
    git("tag", "-a", "v0.2.0", "-m", "v0.2.0", cwd=repo)
    commit(repo, "docs: fourth")

    assert previous_tag("v0.1.0", cwd=repo) is None
    assert previous_tag("v0.2.0", cwd=repo) == "v0.1.0"
    assert previous_tag("HEAD", cwd=repo) == "v0.2.0"
    assert [change.summary for change in changes("v0.2.0", "v0.1.0", cwd=repo)] == ["third", "second"]
    assert [change.summary for change in changes("v0.1.0", None, cwd=repo)] == ["first"]


def test_notes_list_breaking_changes_first_and_link_the_comparison() -> None:
    found = [
        Change("a1", "Fixes", "web", "wrap header actions"),
        Change("b2", BREAKING, "api", "drop /api/v0"),
        Change("c3", "Features", None, "release workflow"),
    ]
    notes = render(found, version="0.2.0", since="v0.1.0", repo="offbeatport/minibrain", image="ghcr.io/o/minibrain")
    sections = [line for line in notes.splitlines() if line.startswith("### ")]
    assert sections == ["### Breaking changes", "### Features", "### Fixes"]
    assert "- **api:** drop /api/v0 (b2)" in notes
    assert "- release workflow (c3)" in notes
    assert "releases/download/v0.2.0/minibrain-0.2.0-py3-none-any.whl" in notes
    assert "`ghcr.io/o/minibrain:0.2.0-cuda`" in notes
    assert "releases/download/v0.2.0/install.sh | MINIBRAIN_VERSION=0.2.0 sh" in notes
    identity = (
        "--certificate-identity https://github.com/offbeatport/minibrain/.github/workflows/release.yml@refs/tags/v0.2.0"
    )
    assert f"cosign verify {identity} --certificate-oidc-issuer https://token.actions.githubusercontent.com" in notes
    assert notes.rstrip().endswith("https://github.com/offbeatport/minibrain/compare/v0.1.0...v0.2.0")


def test_a_first_release_lists_every_commit_without_a_comparison() -> None:
    notes = render([Change("a1", "Features", None, "first")], version="0.1.0", since=None, repo="o/m", image="i")
    assert "## Changes\n" in notes
    assert "compare" not in notes
