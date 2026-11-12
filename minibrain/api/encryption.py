from typing import Any

from fastapi import APIRouter, Depends
from pydantic import BaseModel
from sqlalchemy.orm import Session

from minibrain.api.access import admin
from minibrain.api.deps import SessionDep, SettingsDep
from minibrain.auth.identity import current_actor
from minibrain.encryption import rekey
from minibrain.encryption.keys import (
    LABELS,
    OFF,
    POLICY,
    EncryptionError,
    build,
    check_switch,
    keys_for,
    probe,
    records_of,
)
from minibrain.encryption.providers import KeyUnavailableError
from minibrain.policy import PolicyError, describe, update
from minibrain.policy import load as load_policy
from minibrain.registry.models import AuditEvent
from minibrain.registry.settings_store import read
from minibrain.settings import Settings

router = APIRouter(prefix="/api/settings/encryption")

PROVIDER_PREFIXES = ("vault_", "hsm_", "kms_")


class EncryptionChoice(BaseModel):
    value: str
    label: str


class EncryptionField(BaseModel):
    name: str
    label: str
    description: str
    kind: str
    choices: list[EncryptionChoice]
    value: Any
    locked: bool
    source: str


class EncryptionKey(BaseModel):
    provider: str
    key: str
    where: str
    created_at: str | None = None
    created_by: str | None = None
    retired_at: str | None = None
    current: bool
    files: int | None = None


class EncryptionCounts(BaseModel):
    files: int = 0
    current: int = 0
    older: int = 0
    plain: int = 0
    damaged: int = 0
    encrypted: int = 0
    rewrapped: int = 0
    removed: int = 0
    secrets: int = 0
    secrets_older: int = 0
    resealed: int = 0
    problems: list[str] = []


class EncryptionPass(BaseModel):
    kind: str
    started_at: str | None = None
    finished_at: str | None = None
    counts: EncryptionCounts


class EncryptionTask(BaseModel):
    kind: str
    state: str
    requested_by: str | None = None
    requested_at: str | None = None
    started_at: str | None = None
    finished_at: str | None = None
    error: str | None = None
    progress: EncryptionCounts | None = None


class EncryptionStatus(BaseModel):
    provider: str
    provider_label: str
    key: str | None
    where: str | None
    problem: str | None
    fields: list[EncryptionField]
    keys: list[EncryptionKey]
    last: EncryptionPass | None
    task: EncryptionTask | None


class EncryptionUpdate(BaseModel):
    values: dict[str, Any]


class EncryptionTaskRequest(BaseModel):
    kind: str


class EncryptionCheck(BaseModel):
    ok: bool
    message: str


def is_encryption_field(name: str) -> bool:
    return name == POLICY or name.startswith(PROVIDER_PREFIXES)


def known(model: type[BaseModel], value: dict[str, Any]) -> dict[str, Any]:
    return {name: item for name, item in value.items() if name in model.model_fields}


def counts_of(value: Any) -> EncryptionCounts | None:
    return EncryptionCounts.model_validate(known(EncryptionCounts, value)) if isinstance(value, dict) else None


def task_of(value: Any) -> EncryptionTask | None:
    if not isinstance(value, dict) or "kind" not in value:
        return None
    fields = known(EncryptionTask, value) | {"progress": counts_of(value.get("progress"))}
    return EncryptionTask.model_validate(fields)


def last_of(value: Any) -> EncryptionPass | None:
    if not isinstance(value, dict):
        return None
    counts = counts_of(value.get("tally")) or EncryptionCounts()
    started, finished = value.get("started_at"), value.get("finished_at")
    return EncryptionPass(kind=str(value.get("kind")), started_at=started, finished_at=finished, counts=counts)


def key_rows(session: Session, kind: str, current: str | None) -> list[EncryptionKey]:
    last = read(session, rekey.LAST, None)
    used = (last.get("tally") or {}).get("keys", {}) if isinstance(last, dict) else {}
    rows = []
    for item in records_of(session):
        ref = f"{item.get('provider')}:{item.get('key')}"
        rows.append(
            EncryptionKey(
                provider=str(item.get("provider")),
                key=str(item.get("key")),
                where=str(item.get("label") or ""),
                created_at=item.get("created_at"),
                created_by=item.get("created_by"),
                retired_at=item.get("retired_at"),
                current=(item.get("provider"), item.get("key")) == (kind, current),
                files=used.get(ref, 0) if isinstance(used, dict) and last is not None else None,
            )
        )
    return rows


def status(session: Session, settings: Settings) -> EncryptionStatus:
    keys = keys_for(settings)
    keys.invalidate()
    kind = keys.kind()
    current, where, problem = None, None, None
    if kind != OFF:
        try:
            target = keys.target()
            current, where = target.current(), target.describe()
        except Exception as error:
            problem = str(error)
    fields = [
        EncryptionField.model_validate(known(EncryptionField, item))
        for item in describe(session)
        if is_encryption_field(str(item["name"]))
    ]
    return EncryptionStatus(
        provider=kind,
        provider_label=LABELS.get(kind, kind),
        key=current,
        where=where,
        problem=problem,
        fields=fields,
        keys=key_rows(session, kind, current),
        last=last_of(read(session, rekey.LAST, None)),
        task=task_of(read(session, rekey.TASK, None)),
    )


def apply_values(session: Session, values: dict[str, Any], actor: str) -> None:
    current = load_policy(session)
    for name, value in values.items():
        if not is_encryption_field(name):
            raise PolicyError(f"{name} is not an encryption setting")
        if current[name] != value:
            update(session, name, value, actor)
    session.flush()


@router.get("", dependencies=[Depends(admin)], summary="Read encryption status")
def encryption_status(session: SessionDep, settings: SettingsDep) -> EncryptionStatus:
    return status(session, settings)


@router.put("", dependencies=[Depends(admin)], summary="Change encryption settings")
def change_encryption(body: EncryptionUpdate, session: SessionDep, settings: SettingsDep) -> EncryptionStatus:
    actor = current_actor()
    try:
        apply_values(session, body.values, actor)
        check_switch(session, settings, actor)
    except BaseException:
        session.rollback()
        raise
    session.commit()
    keys_for(settings).invalidate()
    return status(session, settings)


@router.post("/test", dependencies=[Depends(admin)], summary="Test an encryption key")
def test_encryption(body: EncryptionUpdate, session: SessionDep, settings: SettingsDep) -> EncryptionCheck:
    try:
        apply_values(session, body.values, current_actor())
        values = dict(load_policy(session).values)
        kind = str(values.get(POLICY))
        if kind == OFF:
            return EncryptionCheck(ok=True, message="Encryption at rest is off, so there is no key to test")
        provider = build(settings, kind, values, records_of(session))
        probe(provider)
        message = f"{LABELS.get(kind, kind)} wrapped and unwrapped a test key with {provider.current()}"
        return EncryptionCheck(ok=True, message=message)
    except (EncryptionError, KeyUnavailableError, PolicyError) as error:
        return EncryptionCheck(ok=False, message=str(error))
    finally:
        session.rollback()


@router.post("/tasks", dependencies=[Depends(admin)], summary="Start a re-encryption task")
def start_task(body: EncryptionTaskRequest, session: SessionDep, settings: SettingsDep) -> EncryptionStatus:
    actor = current_actor()
    if body.kind != rekey.CHECK and not keys_for(settings).sealing():
        raise EncryptionError("turn encryption at rest on first")
    rekey.request(session, body.kind, actor)
    session.add(AuditEvent(actor=actor, action=f"encryption.{body.kind}.request", target="encryption", detail={}))
    session.commit()
    return status(session, settings)
