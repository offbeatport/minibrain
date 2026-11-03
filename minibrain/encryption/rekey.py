import logging
import shutil
import tempfile
import threading
import time
from collections.abc import Callable, Iterator
from dataclasses import asdict, dataclass, field
from datetime import datetime, timedelta
from pathlib import Path
from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session, sessionmaker

from minibrain.artifacts import STAGED_NAME, ArtifactStore, is_artifact_id, staged_context
from minibrain.encryption.envelope import HEADER, EnvelopeError, is_sealed, read_exact
from minibrain.encryption.keys import EncryptionError, Keys, record, records_of, retire_records
from minibrain.encryption.providers import KeyUnavailableError
from minibrain.encryption.sealed import (
    FileState,
    artifact_context,
    encrypt_in_place,
    rewrap_head,
    rewrap_in_place,
    state_of,
)
from minibrain.encryption.secrets import needs_reseal, open_text, seal_text, wrapped_of
from minibrain.leader import Leader
from minibrain.registry.models import SYSTEM_ACTOR, AuditEvent, Connection, Setting, now
from minibrain.registry.settings_store import read, write

TASK = "encryption.task"
LAST = "encryption.last"
GRACE = timedelta(hours=1)
POLL_SECONDS = 5.0
CHECK_SECONDS = 3600.0
PROGRESS_SECONDS = 2.0
ENCRYPT = "encrypt"
ROTATE = "rotate"
CHECK = "check"
KINDS = (ENCRYPT, ROTATE, CHECK)
QUEUED = "queued"
RUNNING = "running"
DONE = "done"
FAILED = "failed"
MAX_PROBLEMS = 20

log = logging.getLogger("minibrain.encryption")


@dataclass
class Tally:
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
    keys: dict[str, int] = field(default_factory=dict)
    problems: list[str] = field(default_factory=list)

    def problem(self, text: str) -> None:
        self.damaged += 1
        if len(self.problems) < MAX_PROBLEMS:
            self.problems.append(text)

    def seen(self, state: FileState) -> None:
        self.files += 1
        if not state.sealed:
            self.plain += 1
            return
        for ref in state.keys:
            self.keys[ref] = self.keys.get(ref, 0) + 1
        if state.current:
            self.current += 1
        else:
            self.older += 1


@dataclass(frozen=True)
class Plan:
    encrypt: bool = False
    rewrap: bool = False


Progress = Callable[[Tally], None]


def local_ids(root: Path) -> Iterator[str]:
    if not root.is_dir():
        return
    for folder in sorted(root.iterdir()):
        if not folder.is_dir() or len(folder.name) != 2:
            continue
        for path in sorted(folder.iterdir()):
            if path.is_file() and is_artifact_id(path.name) and path.name.startswith(folder.name):
                yield path.name


def head_of(path: Path) -> bytes:
    with path.open("rb") as stream:
        return read_exact(stream, HEADER)


def visit_local(path: Path, context: bytes, expected: str | None, keys: Keys, plan: Plan, tally: Tally) -> None:
    sealing = keys.sealing()
    try:
        state = state_of(head_of(path), keys)
        if not state.sealed and plan.encrypt and sealing:
            encrypt_in_place(path, keys, context, expected)
            tally.encrypted += 1
            state = state_of(head_of(path), keys)
        elif state.sealed and not state.current and plan.rewrap and sealing:
            rewrap_in_place(path, keys, context)
            tally.rewrapped += 1
            state = state_of(head_of(path), keys)
        tally.seen(state)
    except (EnvelopeError, EncryptionError, OSError) as error:
        tally.files += 1
        tally.problem(f"{path.name}: {error}")
    except Exception as error:
        tally.files += 1
        tally.problem(f"{path.name}: {type(error).__name__}: {error}")


def visit_remote(store: ArtifactStore, artifact_id: str, keys: Keys, plan: Plan, tally: Tally) -> None:
    remote = store.remote
    if remote is None:
        return
    sealing = keys.sealing()
    context = artifact_context(artifact_id)
    try:
        head = remote.head(artifact_id)
        state = state_of(head, keys)
        work = (not state.sealed and plan.encrypt) or (state.sealed and not state.current and plan.rewrap)
        if work and sealing:
            store.cache.mkdir(parents=True, exist_ok=True)
            with tempfile.TemporaryDirectory(dir=store.cache, prefix=".rekey-") as scratch:
                local = Path(scratch) / artifact_id
                remote.download(artifact_id, local)
                if state.sealed:
                    fresh = rewrap_head(head_of(local), keys, context)
                    if fresh is not None:
                        with local.open("r+b") as handle:
                            handle.write(fresh)
                    tally.rewrapped += 1
                else:
                    encrypt_in_place(local, keys, context, artifact_id)
                    tally.encrypted += 1
                remote.upload(local, artifact_id)
            state = state_of(remote.head(artifact_id), keys)
        tally.seen(state)
    except (EnvelopeError, EncryptionError, OSError) as error:
        tally.files += 1
        tally.problem(f"{artifact_id} in the bucket: {error}")
    except Exception as error:
        tally.files += 1
        tally.problem(f"{artifact_id} in the bucket: {type(error).__name__}: {error}")


def visit_staging(store: ArtifactStore, keys: Keys, plan: Plan, tally: Tally) -> None:
    root = store.staging
    if not root.is_dir():
        return
    for path in sorted(root.rglob("*")):
        if not path.is_file():
            continue
        relative = path.relative_to(root).as_posix()
        if path.name != STAGED_NAME or relative.count("/") != 1:
            if plan.encrypt and keys.sealing() and not is_sealed(head_of(path)):
                path.unlink(missing_ok=True)
                tally.removed += 1
            continue
        visit_local(path, staged_context(relative), None, keys, plan, tally)


def clear_cache(store: ArtifactStore, tally: Tally) -> None:
    if not store.cache.is_dir():
        return
    for entry in store.cache.iterdir():
        if entry.is_dir() and is_artifact_id(entry.name):
            shutil.rmtree(entry, ignore_errors=True)
            tally.removed += 1


def sealed_settings(session: Session) -> list[Setting]:
    found = []
    for row in session.scalars(select(Setting)):
        value = row.value
        if isinstance(value, dict) and isinstance(value.get("sealed"), str) and value["sealed"]:
            found.append(row)
    return found


def visit_secrets(session: Session, keys: Keys, plan: Plan, tally: Tally) -> None:
    targets: list[tuple[Callable[[], str], Callable[[str], None], str, str]] = []
    for connection in session.scalars(select(Connection).where(Connection.secret.is_not(None))):
        targets.append(
            (
                lambda row=connection: row.secret or "",
                lambda token, row=connection: setattr(row, "secret", token),
                f"minibrain.connection.{connection.id}",
                f"connection {connection.name}",
            )
        )
    for row in sealed_settings(session):
        targets.append(
            (
                lambda item=row: str(item.value["sealed"]),
                lambda token, item=row: setattr(item, "value", dict(item.value) | {"sealed": token}),
                row.key,
                f"setting {row.key}",
            )
        )
    for getter, setter, context, label in targets:
        token = getter()
        if not token:
            continue
        tally.secrets += 1
        try:
            stale = needs_reseal(keys, token)
            if stale and (plan.encrypt or plan.rewrap):
                setter(seal_text(keys, open_text(keys, token, context), context))
                tally.resealed += 1
                stale = False
            wrapped = wrapped_of(getter())
            if wrapped is not None:
                ref = f"{wrapped.provider}:{wrapped.key}"
                tally.keys[ref] = tally.keys.get(ref, 0) + 1
            if stale:
                tally.secrets_older += 1
        except Exception as error:
            tally.problem(f"{label}: {error}")
    session.flush()


def run_pass(session: Session, store: ArtifactStore, keys: Keys, plan: Plan, progress: Progress | None = None) -> Tally:
    keys.invalidate()
    if keys.sealing():
        target = keys.target()
        record(session, target.kind, target.current(), SYSTEM_ACTOR, target.describe())
    tally = Tally()
    last = time.monotonic()

    def report() -> None:
        nonlocal last
        if progress is not None and time.monotonic() - last >= PROGRESS_SECONDS:
            progress(tally)
            last = time.monotonic()

    for artifact_id in local_ids(store.root):
        visit_local(store.path(artifact_id), artifact_context(artifact_id), artifact_id, keys, plan, tally)
        report()
    if store.remote is not None:
        for artifact_id in store.remote.ids():
            if not store.local(artifact_id):
                visit_remote(store, artifact_id, keys, plan, tally)
                report()
    visit_staging(store, keys, plan, tally)
    if plan.encrypt and keys.sealing():
        clear_cache(store, tally)
    visit_secrets(session, keys, plan, tally)
    if progress is not None:
        progress(tally)
    return tally


def in_use(tally: Tally) -> set[tuple[str, str]]:
    found = set()
    for ref in tally.keys:
        provider, _, key = ref.partition(":")
        found.add((provider, key))
    return found


def retire_unused(session: Session, keys: Keys, tally: Tally, grace: timedelta, actor: str) -> list[str]:
    if not keys.sealing() or tally.older or tally.secrets_older or tally.damaged:
        return []
    target = keys.target()
    current = (target.kind, target.current())
    newest = next(
        (item for item in records_of(session) if (item.get("provider"), item.get("key")) == current),
        None,
    )
    created = datetime.fromisoformat(str(newest["created_at"])) if newest and newest.get("created_at") else None
    if created is not None and now() - created < grace:
        return []
    keep = in_use(tally) | {current}
    dropped = [f"{target.kind}:{key}" for key in target.retire({key for kind, key in keep if kind == target.kind})]
    retired = retire_records(session, keep)
    names = sorted({f"{item['provider']}:{item['key']}" for item in retired} | set(dropped))
    if names:
        session.add(
            AuditEvent(
                actor=actor,
                action="encryption.retire",
                target=f"{current[0]}:{current[1]}",
                detail={"retired": names, "kept": sorted(f"{p}:{k}" for p, k in keep)},
            )
        )
    return names


def rotate_key(session: Session, keys: Keys, actor: str) -> tuple[str, str, str]:
    target = keys.target()
    before = target.current()
    note = ""
    try:
        after = target.rotate()
    except KeyUnavailableError as error:
        after, note = target.current(), str(error)
    record(session, target.kind, after, actor, target.describe())
    detail = {"provider": target.kind, "from": before, "to": after} | ({"note": note} if note else {})
    session.add(AuditEvent(actor=actor, action="encryption.rotate", target=f"{target.kind}:{after}", detail=detail))
    keys.invalidate()
    return before, after, note


def plan_for(kind: str) -> Plan:
    return {ENCRYPT: Plan(encrypt=True), ROTATE: Plan(rewrap=True), CHECK: Plan()}[kind]


def summary(tally: Tally) -> dict[str, Any]:
    return asdict(tally)


def save_last(session: Session, kind: str, tally: Tally, started: datetime) -> None:
    write(
        session,
        LAST,
        {"kind": kind, "started_at": started.isoformat(), "finished_at": now().isoformat(), "tally": summary(tally)},
    )


def request(session: Session, kind: str, actor: str) -> dict[str, Any]:
    if kind not in KINDS:
        raise EncryptionError(f"unknown encryption task {kind}")
    current = read(session, TASK, None)
    if isinstance(current, dict) and current.get("state") in (QUEUED, RUNNING):
        raise EncryptionError(f"a {current.get('kind')} pass is already {current.get('state')}")
    task = {"kind": kind, "state": QUEUED, "requested_by": actor, "requested_at": now().isoformat()}
    write(session, TASK, task)
    return task


def update_task(sessions: sessionmaker[Session], **changes: Any) -> None:
    with sessions() as session:
        current = read(session, TASK, None) or {}
        write(session, TASK, dict(current) | changes)
        session.commit()


def execute(sessions: sessionmaker[Session], store: ArtifactStore, keys: Keys, task: dict[str, Any]) -> Tally:
    kind = str(task.get("kind"))
    actor = str(task.get("requested_by") or SYSTEM_ACTOR)
    started = now()
    update_task(sessions, state=RUNNING, started_at=started.isoformat(), progress=summary(Tally()))

    def progress(tally: Tally) -> None:
        update_task(sessions, progress=summary(tally))

    with sessions() as session:
        if kind == ROTATE:
            rotate_key(session, keys, actor)
            session.commit()
        tally = run_pass(session, store, keys, plan_for(kind), progress)
        retired = retire_unused(session, keys, tally, GRACE, actor)
        save_last(session, kind, tally, started)
        action = {ENCRYPT: "encryption.encrypt_existing", ROTATE: "encryption.rewrap", CHECK: "encryption.check"}[kind]
        detail = {key: value for key, value in summary(tally).items() if key != "problems"} | {"retired": retired}
        session.add(AuditEvent(actor=actor, action=action, target="encryption", detail=detail))
        current = dict(read(session, TASK, None) or {})
        state = FAILED if tally.damaged else DONE
        write(session, TASK, current | {"state": state, "finished_at": now().isoformat(), "progress": summary(tally)})
        session.commit()
    return tally


def due_check(session: Session, keys: Keys) -> bool:
    if not keys.sealing():
        return False
    live = [item for item in records_of(session) if not item.get("retired_at")]
    if len(live) < 2:
        return False
    target = keys.target()
    newest = next(
        (item for item in live if (item.get("provider"), item.get("key")) == (target.kind, target.current())), None
    )
    if newest is None or not newest.get("created_at"):
        return False
    if now() - datetime.fromisoformat(str(newest["created_at"])) < GRACE:
        return False
    last = read(session, LAST, None)
    finished = datetime.fromisoformat(str(last["finished_at"])) if isinstance(last, dict) else None
    return finished is None or finished < datetime.fromisoformat(str(newest["created_at"])) + GRACE


def pending(sessions: sessionmaker[Session]) -> dict[str, Any] | None:
    with sessions() as session:
        task = read(session, TASK, None)
    return task if isinstance(task, dict) and task.get("state") in (QUEUED, RUNNING) else None


def scheduled_check(sessions: sessionmaker[Session], keys: Keys) -> dict[str, Any] | None:
    with sessions() as session:
        if not due_check(session, keys):
            return None
        task = request(session, CHECK, SYSTEM_ACTOR)
        session.commit()
    return task


def rekey_forever(
    sessions: sessionmaker[Session], store: ArtifactStore, keys: Keys, stop: threading.Event, leader: Leader
) -> None:
    checked = 0.0
    while not stop.wait(POLL_SECONDS):
        if not leader.held():
            continue
        try:
            task = pending(sessions)
            if task is None and time.monotonic() - checked > CHECK_SECONDS:
                checked = time.monotonic()
                task = scheduled_check(sessions, keys)
        except Exception:
            log.exception("could not read the encryption task")
            continue
        if task is None:
            continue
        try:
            execute(sessions, store, keys, task)
        except Exception as error:
            log.exception("encryption pass failed")
            update_task(sessions, state=FAILED, finished_at=now().isoformat(), error=f"{type(error).__name__}: {error}")
