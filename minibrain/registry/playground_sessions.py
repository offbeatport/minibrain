import json
from datetime import timedelta
from typing import Any

from sqlalchemy import delete
from sqlalchemy.orm import Session

from minibrain.encryption.keys import Keys
from minibrain.encryption.secrets import open_text, seal_text
from minibrain.policy import Policy
from minibrain.registry.models import Model, PlaygroundSession, now

TITLE = "title"
CONTENT = "content"
TITLE_CHARS = 60
UNTITLED = "New chat"
LOCKED_OFF = "Not saved: request inputs and answers are off for every model (Settings, Security)."
BASES_OFF = "Not saved: base models keep no request inputs and answers by default (Settings, Security)."


def context_of(session_id: int, part: str) -> str:
    return f"minibrain.playground.{session_id}.{part}"


def title_from(turns: list[dict[str, Any]]) -> str:
    for turn in turns:
        content = turn.get("content")
        if turn.get("kind") == "user" and isinstance(content, str) and content.strip():
            text = " ".join(content.split())
            return text if len(text) <= TITLE_CHARS else f"{text[: TITLE_CHARS - 1].rstrip()}…"
    return UNTITLED


def seal_title(keys: Keys, row: PlaygroundSession, title: str) -> None:
    row.title = seal_text(keys, title, context_of(row.id, TITLE))


def seal_state(keys: Keys, row: PlaygroundSession, state: dict[str, Any]) -> None:
    encoded = json.dumps(state, ensure_ascii=False, separators=(",", ":"))
    row.content = seal_text(keys, encoded, context_of(row.id, CONTENT))


def title_of(keys: Keys, row: PlaygroundSession) -> str:
    return open_text(keys, row.title, context_of(row.id, TITLE))


def state_of(keys: Keys, row: PlaygroundSession) -> dict[str, Any]:
    found = json.loads(open_text(keys, row.content, context_of(row.id, CONTENT)))
    return found if isinstance(found, dict) else {}


def not_kept(policy: Policy, model: Model | None) -> str | None:
    locked = bool(policy["request_bodies_locked"])
    if model is None:
        if policy["request_bodies"]:
            return None
        return LOCKED_OFF if locked else BASES_OFF
    if policy.keeps_bodies(model.request_bodies):
        return None
    if locked:
        return LOCKED_OFF
    return f"Not saved: {model.name} does not keep request inputs and answers (Deployments, {model.name})."


def purge(session: Session, days: int) -> int:
    if days <= 0:
        return 0
    cutoff = now() - timedelta(days=days)
    result = session.execute(delete(PlaygroundSession).where(PlaygroundSession.updated_at < cutoff))
    session.commit()
    return int(getattr(result, "rowcount", 0) or 0)
