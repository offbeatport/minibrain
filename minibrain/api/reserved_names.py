from fastapi import APIRouter, Depends

from minibrain.api.access import viewer
from minibrain.api.deps import SessionDep
from minibrain.api.schemas import ReservedNameInfo
from minibrain.registry.models import ReservedName
from minibrain.registry.service import NotFoundError, deleted_on, reserved_name

router = APIRouter(prefix="/api/reserved-names", tags=["models"])


def reserved_info(reserved: ReservedName) -> ReservedNameInfo:
    return ReservedNameInfo(
        name=reserved.name,
        kind="base" if reserved.kind == "base" else "custom",
        model_name=reserved.model_name,
        deleted_at=reserved.deleted_at,
        deleted_by=reserved.deleted_by,
        message=deleted_on(reserved),
    )


@router.get(
    "/{name}",
    dependencies=[Depends(viewer)],
    description="An API name kept after its model was deleted, so it never reaches another model.",
)
def read_reserved(name: str, session: SessionDep) -> ReservedNameInfo:
    reserved = reserved_name(session, name)
    if reserved is None:
        raise NotFoundError(f"{name} is not a reserved name")
    return reserved_info(reserved)
