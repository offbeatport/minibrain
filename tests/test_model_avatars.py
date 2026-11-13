from typing import Any

import pytest
from sqlalchemy import select

from minibrain.auth.roles import Role
from minibrain.registry.models import AuditEvent
from tests.conftest import Harness, blank_dataset

SLUG = "brisk-heron"
PIXELBOT = {"style": "pixelbot", "seed": "a1b2c3d4", "tone": "parquet"}
INITIALS = {"style": "initials", "seed": "initials", "tone": "csv", "letters": "BH"}


def create(harness: Harness, avatar: dict[str, Any] | None = None, name: str = "Brisk Heron") -> Any:
    body: dict[str, Any] = {"name": name}
    if avatar is not None:
        body["avatar"] = avatar
    return harness.client.post("/api/models", json={"dataset": blank_dataset(harness.client)} | body)


def events(harness: Harness, action: str) -> list[AuditEvent]:
    with harness.sessions() as session:
        return list(session.scalars(select(AuditEvent).where(AuditEvent.action == action)))


def test_avatar_is_stored_on_create_and_returned_everywhere(harness: Harness) -> None:
    created = create(harness, PIXELBOT)
    assert created.status_code == 201, created.text
    assert created.json()["avatar"] == {**PIXELBOT, "letters": None}
    rows = {row["key"]: row for row in harness.client.get("/api/models").json()}
    assert rows[SLUG]["avatar"]["style"] == "pixelbot"
    assert rows[SLUG]["avatar"]["tone"] == "parquet"
    assert all(row["avatar"] is None for row in rows.values() if row["kind"] == "base")
    page = harness.client.get(f"/api/models/{SLUG}/overview").json()
    assert page["avatar"]["seed"] == "a1b2c3d4"
    assert events(harness, "model.create")[0].detail["avatar"] == PIXELBOT


def test_a_model_without_an_avatar_returns_none(harness: Harness) -> None:
    created = create(harness)
    assert created.status_code == 201, created.text
    assert created.json()["avatar"] is None
    assert "avatar" not in events(harness, "model.create")[0].detail


@pytest.mark.parametrize(
    "avatar",
    [
        {"style": "robots", "seed": "a1", "tone": "csv"},
        {"style": "pixelbot", "seed": "a1", "tone": "#ff0000"},
        {"style": "pixelbot", "seed": "a1", "tone": "red"},
        {"style": "initials", "seed": "initials", "tone": "csv", "letters": "ABC"},
        {"style": "initials", "seed": "initials", "tone": "csv", "letters": ""},
        {"style": "initials", "seed": "initials", "tone": "csv", "letters": "A!"},
        {"style": "pixelbot", "seed": "a1", "tone": "csv", "letters": "AB"},
        {"style": "pixelbot", "seed": "x" * 65, "tone": "csv"},
        {"style": "pixelbot", "seed": "<svg>", "tone": "csv"},
        {"style": "pixelbot", "tone": "csv"},
    ],
)
def test_bad_avatars_are_refused(harness: Harness, avatar: dict[str, Any]) -> None:
    assert create(harness, avatar).status_code == 422


def test_changing_the_avatar_is_audited_once(harness: Harness) -> None:
    create(harness, PIXELBOT)
    changed = harness.client.put(f"/api/models/{SLUG}/avatar", json=INITIALS)
    assert changed.status_code == 200, changed.text
    assert changed.json()["avatar"] == INITIALS
    assert harness.client.put(f"/api/models/{SLUG}/avatar", json=INITIALS).status_code == 200
    audited = events(harness, "model.avatar")
    assert len(audited) == 1
    assert audited[0].target == SLUG
    assert {key: audited[0].detail[key] for key in ("name", "from", "to")} == {
        "name": "Brisk Heron",
        "from": PIXELBOT,
        "to": INITIALS,
    }
    activity = harness.client.get(f"/api/models/{SLUG}/activity").json()
    assert any("changed the avatar" in str(event) for event in activity["events"])


def test_changing_the_avatar_needs_a_builder(harness: Harness) -> None:
    create(harness, PIXELBOT)
    viewer = harness.person(Role.VIEWER)
    assert viewer.put(f"/api/models/{SLUG}/avatar", json=INITIALS).status_code == 403
    assert harness.client.put(f"/api/models/{SLUG}/avatar", json={"style": "initials"}).status_code == 422
    assert harness.client.put("/api/models/missing/avatar", json=INITIALS).status_code == 404


def test_duplicate_copies_the_avatar(harness: Harness) -> None:
    create(harness, PIXELBOT)
    copy = harness.client.post(f"/api/models/{SLUG}/duplicate", json={"name": "Brisk Heron copy"})
    assert copy.status_code == 201, copy.text
    assert copy.json()["avatar"] == {**PIXELBOT, "letters": None}
