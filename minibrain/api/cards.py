from typing import Any

from fastapi import APIRouter, Response
from sqlalchemy.orm import Session

from minibrain.api.card_builder import build_card
from minibrain.api.card_export import card_data, digest, export_json, export_markdown
from minibrain.api.card_schemas import ModelCard, ModelCardEdit, ModelCardExport
from minibrain.api.deps import SessionDep, SettingsDep
from minibrain.api.policies import LOCAL_USER
from minibrain.registry.models import AuditEvent, Minibrain, Version
from minibrain.registry.service import get_minibrain, get_version
from minibrain.settings import Settings

router = APIRouter(prefix="/api/minibrains", tags=["model cards"])

EDITABLE = ("intended_use", "known_limits")


def card_of(session: Session, settings: Settings, minibrain: Minibrain, version: Version) -> ModelCard:
    return build_card(session, settings, minibrain, version, LOCAL_USER)


def exported(card: ModelCard) -> ModelCardExport:
    return ModelCardExport(card=card, sha256=digest(card_data(card)))


def download(body: str, media_type: str, filename: str) -> Response:
    headers = {"Content-Disposition": f'attachment; filename="{filename}"'}
    return Response(content=body.encode(), media_type=media_type, headers=headers)


def edits(version: Version, body: ModelCardEdit) -> dict[str, tuple[str, str]]:
    found: dict[str, tuple[str, str]] = {}
    for field in EDITABLE:
        value: Any = getattr(body, field)
        if value is None:
            continue
        before = getattr(version, field) or ""
        after = str(value).strip()
        if after != before:
            found[field] = (before, after)
    return found


@router.get("/{slug}/versions/{number}/card")
def read_card(slug: str, number: int, session: SessionDep, settings: SettingsDep) -> ModelCardExport:
    minibrain = get_minibrain(session, slug)
    return exported(card_of(session, settings, minibrain, get_version(minibrain, number)))


@router.get("/{slug}/versions/{number}/card.json", response_class=Response)
def card_json(slug: str, number: int, session: SessionDep, settings: SettingsDep) -> Response:
    minibrain = get_minibrain(session, slug)
    card = card_of(session, settings, minibrain, get_version(minibrain, number))
    return download(export_json(card_data(card)), "application/json", f"{slug}-v{number}-model-card.json")


@router.get("/{slug}/versions/{number}/card.md", response_class=Response)
def card_markdown(slug: str, number: int, session: SessionDep, settings: SettingsDep) -> Response:
    minibrain = get_minibrain(session, slug)
    card = card_of(session, settings, minibrain, get_version(minibrain, number))
    body = export_markdown(card, digest(card_data(card)))
    return download(body, "text/markdown; charset=utf-8", f"{slug}-v{number}-model-card.md")


@router.put("/{slug}/versions/{number}/card")
def edit_card(
    slug: str, number: int, body: ModelCardEdit, session: SessionDep, settings: SettingsDep
) -> ModelCardExport:
    minibrain = get_minibrain(session, slug)
    version = get_version(minibrain, number)
    changed = edits(version, body)
    for field, (_, after) in changed.items():
        setattr(version, field, after or None)
    if changed:
        detail = {
            "name": minibrain.name,
            "from": {field: before for field, (before, _) in changed.items()},
            "to": {field: after for field, (_, after) in changed.items()},
        }
        session.add(AuditEvent(actor=LOCAL_USER, action="version.card", target=f"{slug}@{number}", detail=detail))
    session.commit()
    return exported(card_of(session, settings, minibrain, version))
