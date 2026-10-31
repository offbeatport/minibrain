import threading
from collections.abc import Iterator
from typing import Annotated

from fastapi import Depends, Request
from sqlalchemy.orm import Session

from minibrain.artifacts import ArtifactStore
from minibrain.jobs.queue import SqlJobQueue
from minibrain.models.hardware import NodeReport, report
from minibrain.serve.backend import ServingBackend
from minibrain.settings import Settings

DETECT_LOCK = threading.Lock()


def get_local_node(request: Request) -> NodeReport:
    with DETECT_LOCK:
        if getattr(request.app.state, "node", None) is None:
            request.app.state.node = report()
        return request.app.state.node


def get_session(request: Request) -> Iterator[Session]:
    with request.app.state.sessions() as session:
        yield session


def get_settings(request: Request) -> Settings:
    return request.app.state.settings


def get_backend(request: Request) -> ServingBackend:
    return request.app.state.backend


def get_queue(request: Request) -> SqlJobQueue:
    return request.app.state.queue


def get_store(request: Request) -> ArtifactStore:
    return request.app.state.store


SessionDep = Annotated[Session, Depends(get_session)]
SettingsDep = Annotated[Settings, Depends(get_settings)]
BackendDep = Annotated[ServingBackend, Depends(get_backend)]
QueueDep = Annotated[SqlJobQueue, Depends(get_queue)]
StoreDep = Annotated[ArtifactStore, Depends(get_store)]
LocalNodeDep = Annotated[NodeReport, Depends(get_local_node)]
