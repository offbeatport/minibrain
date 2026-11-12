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
from minibrain.registry.models import AuditEvent, Model, Version
from minibrain.registry.service import get_model, get_version
from minibrain.settings import Settings
from minibrain.versions import library_version

router = APIRouter(prefix="/api/models")

EDITABLE = ("intended_use", "known_limits")


def card_of(session: Session, settings: Settings, model: Model, version: Version) -> ModelCard:
    return build_card(session, settings, model, version, current_actor())


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


@router.get("/{name}/versions/{number}/card", dependencies=[Depends(viewer)], summary="Read a version's model card")
def read_card(name: str, number: int, session: SessionDep, settings: SettingsDep) -> ModelCardExport:
    model = get_model(session, name)
    return exported(card_of(session, settings, model, get_version(model, number)))


@router.get(
    "/{name}/versions/{number}/card.json",
    response_class=Response,
    dependencies=[Depends(viewer)],
    summary="Download a version's model card as JSON",
)
def card_json(name: str, number: int, session: SessionDep, settings: SettingsDep) -> Response:
    model = get_model(session, name)
    card = card_of(session, settings, model, get_version(model, number))
    return download(export_json(card_data(card)), "application/json", f"{name}-v{number}-model-card.json")


@router.get(
    "/{name}/versions/{number}/card.md",
    response_class=Response,
    dependencies=[Depends(viewer)],
    summary="Download a version's model card as Markdown",
)
def card_markdown(name: str, number: int, session: SessionDep, settings: SettingsDep) -> Response:
    model = get_model(session, name)
    card = card_of(session, settings, model, get_version(model, number))
    body = export_markdown(card, digest(card_data(card)))
    return download(body, "text/markdown; charset=utf-8", f"{name}-v{number}-model-card.md")


@router.get(
    "/{name}/versions/{number}/aibom.json",
    response_class=Response,
    dependencies=[Depends(viewer)],
    summary="Download a version's AI bill of materials",
)
def aibom_json(name: str, number: int, session: SessionDep, settings: SettingsDep) -> Response:
    model = get_model(session, name)
    version = get_version(model, number)
    card = card_of(session, settings, model, version)
    edited = edited_at(session, card.version.id)
    bom = build_aibom(card, adapter_of(session, version), edited, library_version("minibrain") or "unknown")
    return download(export_aibom(bom), MEDIA_TYPE, f"{name}-v{number}-aibom.cdx.json")


@router.put("/{name}/versions/{number}/card", dependencies=[Depends(builder)], summary="Edit a version's model card")
def edit_card(
    name: str, number: int, body: ModelCardEdit, session: SessionDep, settings: SettingsDep
) -> ModelCardExport:
    model = get_model(session, name)
    version = get_version(model, number)
    changed = edits(version, body)
    for field, (_, after) in changed.items():
        setattr(version, field, after or None)
    if changed:
        detail = {
            "name": model.name,
            "from": {field: before for field, (before, _) in changed.items()},
            "to": {field: after for field, (_, after) in changed.items()},
        }
        session.add(AuditEvent(actor=current_actor(), action="version.card", target=f"{name}@{number}", detail=detail))
    session.commit()
    return exported(card_of(session, settings, model, version))
