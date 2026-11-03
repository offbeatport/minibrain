from typing import Any

from fastapi import APIRouter, Depends, Response
from sqlalchemy.orm import Session

from minibrain.api.access import builder, viewer
from minibrain.api.aibom import MEDIA_TYPE, adapter_of, build_aibom, edited_at, export_aibom
from minibrain.api.card_builder import build_card
from minibrain.api.card_export import card_data, digest, export_json, export_markdown
from minibrain.api.card_schemas import ModelCard, ModelCardEdit, ModelCardExport
from minibrain.api.deps import SessionDep, SettingsDep
from minibrain.auth.identity import current_actor
from minibrain.registry.models import AuditEvent, Minibrain, Version
from minibrain.registry.service import get_minibrain, get_version
from minibrain.settings import Settings
from minibrain.versions import library_version

router = APIRouter(prefix="/api/minibrains", tags=["model cards"])

EDITABLE = ("intended_use", "known_limits")


def card_of(session: Session, settings: Settings, minibrain: Minibrain, version: Version) -> ModelCard:
    return build_card(session, settings, minibrain, version, current_actor())


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


@router.get("/{slug}/versions/{number}/card", dependencies=[Depends(viewer)])
def read_card(slug: str, number: int, session: SessionDep, settings: SettingsDep) -> ModelCardExport:
    minibrain = get_minibrain(session, slug)
    return exported(card_of(session, settings, minibrain, get_version(minibrain, number)))


@router.get("/{slug}/versions/{number}/card.json", response_class=Response, dependencies=[Depends(viewer)])
def card_json(slug: str, number: int, session: SessionDep, settings: SettingsDep) -> Response:
    minibrain = get_minibrain(session, slug)
    card = card_of(session, settings, minibrain, get_version(minibrain, number))
    return download(export_json(card_data(card)), "application/json", f"{slug}-v{number}-model-card.json")


@router.get("/{slug}/versions/{number}/card.md", response_class=Response, dependencies=[Depends(viewer)])
def card_markdown(slug: str, number: int, session: SessionDep, settings: SettingsDep) -> Response:
    minibrain = get_minibrain(session, slug)
    card = card_of(session, settings, minibrain, get_version(minibrain, number))
    body = export_markdown(card, digest(card_data(card)))
    return download(body, "text/markdown; charset=utf-8", f"{slug}-v{number}-model-card.md")


@router.get("/{slug}/versions/{number}/aibom.json", response_class=Response, dependencies=[Depends(viewer)])
def aibom_json(slug: str, number: int, session: SessionDep, settings: SettingsDep) -> Response:
    minibrain = get_minibrain(session, slug)
    version = get_version(minibrain, number)
    card = card_of(session, settings, minibrain, version)
    edited = edited_at(session, card.version.id)
    bom = build_aibom(card, adapter_of(session, version), edited, library_version("minibrain") or "unknown")
    return download(export_aibom(bom), MEDIA_TYPE, f"{slug}-v{number}-aibom.cdx.json")


@router.put("/{slug}/versions/{number}/card", dependencies=[Depends(builder)])
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
        session.add(AuditEvent(actor=current_actor(), action="version.card", target=f"{slug}@{number}", detail=detail))
    session.commit()
    return exported(card_of(session, settings, minibrain, version))
