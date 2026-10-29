from collections.abc import Callable, Iterator
from typing import Annotated

from fastapi import Depends, Request
from sqlalchemy.orm import Session

from minibrain.serve.backend import ServingBackend
from minibrain.settings import Settings

Enqueue = Callable[[int], object]


def get_session(request: Request) -> Iterator[Session]:
    with request.app.state.sessions() as session:
        yield session


def get_settings(request: Request) -> Settings:
    return request.app.state.settings


def get_backend(request: Request) -> ServingBackend:
    return request.app.state.backend


def get_enqueue(request: Request) -> Enqueue:
    return request.app.state.enqueue


SessionDep = Annotated[Session, Depends(get_session)]
SettingsDep = Annotated[Settings, Depends(get_settings)]
BackendDep = Annotated[ServingBackend, Depends(get_backend)]
EnqueueDep = Annotated[Enqueue, Depends(get_enqueue)]
