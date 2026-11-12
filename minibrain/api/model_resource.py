from typing import Annotated, Literal

from fastapi import APIRouter, Depends, HTTPException, Query, Request, Response
from pydantic import Field
from sqlalchemy import select
from sqlalchemy.orm import Session

from minibrain.api.access import builder, viewer
from minibrain.api.base_models import (
    context_for,
    deploy_base,
    detail_of,
    health_for,
    model_row,
    update_base,
    wake_teardowns,
)
from minibrain.api.deps import QueueDep, SessionDep, SettingsDep, StoreDep
from minibrain.api.jobs import canceller
from minibrain.api.model_rows import all_rows
from minibrain.api.models import deploy_custom, read_custom, update_custom
from minibrain.api.schemas import BaseModelDetail, DeployRequest, ModelDetail, ModelRow, ModelUpdate
from minibrain.auth.identity import current_actor, current_role
from minibrain.auth.roles import LABELS, Role, allows
from minibrain.registry.models import BaseModel, Model
from minibrain.registry.service import no_model
from minibrain.settings import Settings
from minibrain.teardown import delete_base, delete_custom

router = APIRouter(prefix="/api/models")

Kind = Literal["custom", "base"]
ListKind = Annotated[Kind | None, Query(description="Only custom or only base models.")]
AnyModelDetail = Annotated[ModelDetail | BaseModelDetail, Field(discriminator="kind")]
NAME_HELP = "Custom and base models share one namespace of API names, so a name finds either kind."
BASE_ADMIN = "Base models need the Admin role."


def find(session: Session, name: str) -> Model | BaseModel:
    custom = session.scalar(select(Model).where(Model.slug == name))
    if custom is not None:
        return custom
    base = session.get(BaseModel, name)
    if base is None:
        raise no_model(session, name)
    return base


def require_admin() -> None:
    if not allows(current_role(), Role.ADMIN):
        raise HTTPException(status_code=403, detail=f"This needs the {LABELS[Role.ADMIN]} role")


def detail_for(session: Session, settings: Settings, request: Request, model: Model | BaseModel) -> AnyModelDetail:
    if isinstance(model, Model):
        return read_custom(settings, model)
    return detail_of(session, settings, request, model)


@router.get(
    "",
    dependencies=[Depends(viewer)],
    summary="List models",
    description="Custom and base models as rows: availability, activity, deployment, versions and usage, "
    "most recently changed first.",
)
def list_models(
    request: Request, session: SessionDep, settings: SettingsDep, store: StoreDep, kind: ListKind = None
) -> list[ModelRow]:
    rows = all_rows(session, settings, store, health_for(request), context_for(session, settings, request))
    return [row for row in rows if kind is None or row.kind == kind]


@router.get("/{name}", dependencies=[Depends(viewer)], summary="Read a model", description=NAME_HELP)
def read_model(name: str, request: Request, session: SessionDep, settings: SettingsDep) -> AnyModelDetail:
    return detail_for(session, settings, request, find(session, name))


@router.patch(
    "/{name}",
    dependencies=[Depends(builder)],
    summary="Rename, describe or tag a model",
    description=f"{BASE_ADMIN} {NAME_HELP}",
)
def update_model(
    name: str, body: ModelUpdate, request: Request, session: SessionDep, settings: SettingsDep
) -> AnyModelDetail:
    model = find(session, name)
    if isinstance(model, Model):
        return update_custom(session, settings, model, body)
    require_admin()
    update_base(session, model, body)
    session.commit()
    return detail_of(session, settings, request, model)


@router.delete(
    "/{name}",
    status_code=202,
    dependencies=[Depends(builder)],
    summary="Delete a model",
    description=f"{BASE_ADMIN} Deleting runs in the background; the row shows its progress. With undeploy, a "
    "deployed model is stopped first; with cancel_jobs, its running jobs are cancelled; with cascade, a base "
    "model's custom models are deleted with it.",
)
def delete_model(
    name: str,
    request: Request,
    session: SessionDep,
    settings: SettingsDep,
    store: StoreDep,
    queue: QueueDep,
    undeploy: bool = False,
    cancel_jobs: bool = False,
    cascade: bool = False,
) -> ModelRow:
    model = find(session, name)
    cancel = canceller(session, queue, cancel_jobs)
    if isinstance(model, Model):
        delete_custom(session, model, current_actor(), undeploy=undeploy, cancel=cancel)
    else:
        require_admin()
        delete_base(session, model, current_actor(), cascade=cascade, undeploy=undeploy, cancel=cancel)
    session.commit()
    wake_teardowns(request)
    return model_row(request, session, settings, store, "custom" if isinstance(model, Model) else "base", name)


@router.post(
    "/{name}/deploy",
    dependencies=[Depends(builder)],
    summary="Deploy or undeploy a model",
    description="Deploying serves the model on /v1 under its API name. Undeploying answers 202 while it stops.",
)
def deploy_model(
    name: str, body: DeployRequest, request: Request, response: Response, session: SessionDep, settings: SettingsDep
) -> AnyModelDetail:
    model = find(session, name)
    if isinstance(model, Model):
        stopping = deploy_custom(session, model, body.deployed)
    else:
        stopping = deploy_base(session, settings, model, body.deployed)
    if stopping:
        response.status_code = 202
    session.commit()
    if not body.deployed:
        wake_teardowns(request)
    return detail_for(session, settings, request, model)
