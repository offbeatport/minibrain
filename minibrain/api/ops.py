from fastapi import APIRouter, Request
from fastapi.responses import PlainTextResponse, Response
from sqlalchemy import text

from minibrain.api.deps import SessionDep
from minibrain.telemetry.prometheus import metrics_response

router = APIRouter(include_in_schema=False)


@router.get("/healthz")
def healthz() -> dict[str, str]:
    return {"status": "ok"}


@router.get("/readyz")
def readyz(session: SessionDep) -> dict[str, str]:
    session.execute(text("SELECT 1"))
    return {"status": "ready"}


@router.get("/metrics", response_class=PlainTextResponse)
def metrics(request: Request) -> Response:
    return metrics_response(request)
