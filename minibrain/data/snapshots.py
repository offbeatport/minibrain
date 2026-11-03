import tempfile
from collections import defaultdict
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path

from sqlalchemy import select
from sqlalchemy.orm import Session

from minibrain.data.limits import load_limits
from minibrain.data.shared import dataset_of, dataset_sql, dataset_tables, fingerprint
from minibrain.data.snapshot import MIN_ROWS, SPLITS, SnapshotError, clean, labels_of, read_rows, split
from minibrain.data.sources import copy_rows
from minibrain.registry.files import ArtifactKind, store_file, store_for
from minibrain.registry.models import Artifact, Dataset, Minibrain, Snapshot, Version, now
from minibrain.registry.service import ConflictError, latest_snapshot
from minibrain.settings import Settings

SNAPSHOT_FILE = "snapshot.parquet"


@dataclass(frozen=True)
class Changes:
    data: bool
    query: bool
    dataset: bool = False


def over_limit(limit: int) -> str:
    return (
        f"The query returns more than {limit:,} rows, the most one snapshot holds. Filter or sample in the query, "
        f"for example USING SAMPLE reservoir({limit} ROWS) REPEATABLE (7), or raise the limit under Settings, Data."
    )


def split_summary(rows: list[tuple[str | None, str | None]]) -> tuple[dict[str, int], list[str]]:
    examples = clean(rows)
    try:
        splits = split(examples)
    except SnapshotError:
        return {}, sorted({example.label for example in examples})
    return {name: len(splits[name]) for name in SPLITS}, labels_of(splits)


def find_snapshot(session: Session, dataset: Dataset, digest: str) -> Snapshot | None:
    return session.scalar(select(Snapshot).where(Snapshot.dataset_id == dataset.id, Snapshot.hash == digest))


def take_snapshot(session: Session, settings: Settings, dataset: Dataset, saved: bool) -> Snapshot:
    limit = load_limits(session).row_limit
    sql = dataset_sql(dataset)
    tables, aliases = dataset_tables(settings, store_for(settings), dataset)
    prints = {table.name: table.fingerprint for table in tables}
    settings.work_dir().mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(dir=settings.work_dir()) as scratch:
        target = Path(scratch) / SNAPSHOT_FILE
        rows = copy_rows(tables, sql, target, limit, aliases)
        if rows > limit:
            raise ConflictError(over_limit(limit))
        if rows == 0:
            raise ConflictError("The query returns no rows, so there is nothing to snapshot.")
        counts, labels = split_summary(read_rows(target))
        artifact = store_file(session, store_for(settings), target, ArtifactKind.SNAPSHOT)
    moment = now()
    found = find_snapshot(session, dataset, artifact.id)
    if found is None:
        found = Snapshot(
            dataset=dataset,
            hash=artifact.id,
            artifact_id=artifact.id,
            counts=counts,
            labels=labels,
            rows=rows,
            size=artifact.size,
            created_at=moment,
        )
        session.add(found)
    found.fingerprints = prints
    found.sql = sql
    found.saved = found.saved or saved
    found.taken_at = moment
    session.flush()
    return found


def snapshot_for_model(session: Session, settings: Settings, minibrain: Minibrain, saved: bool) -> Snapshot:
    if minibrain.dataset is None:
        current = latest_snapshot(minibrain)
        if current is not None:
            return current
    snapshot = take_snapshot(session, settings, dataset_of(minibrain), saved)
    minibrain.snapshot = snapshot
    session.flush()
    return snapshot


def require_splits(snapshot: Snapshot) -> None:
    if not snapshot.counts:
        raise ConflictError(
            f"The snapshot has fewer than {MIN_ROWS} labelled rows after removing empty and repeated inputs; "
            "add rows before scoring or training."
        )


def taken(snapshot: Snapshot) -> tuple[datetime, int]:
    return (snapshot.taken_at or snapshot.created_at, snapshot.id)


def latest_of(dataset: Dataset) -> Snapshot | None:
    return max(dataset.snapshots, key=taken, default=None)


def current_prints(dataset: Dataset) -> dict[str, str]:
    return {source.table_name: fingerprint(source) for source in dataset.sources}


def changes_since(dataset: Dataset, snapshot: Snapshot | None) -> Changes | None:
    if snapshot is None:
        return None
    if snapshot.dataset_id != dataset.id:
        return Changes(data=False, query=False, dataset=True)
    return Changes(data=current_prints(dataset) != (snapshot.fingerprints or {}), query=dataset.sql != snapshot.sql)


def model_snapshot(minibrain: Minibrain) -> Snapshot | None:
    if minibrain.snapshot is not None:
        return minibrain.snapshot
    newest = max(minibrain.versions, key=lambda version: version.number, default=None)
    return newest.snapshot if newest is not None else latest_snapshot(minibrain)


def doomed_snapshots(session: Session) -> list[Snapshot]:
    keep = load_limits(session).keep_snapshots
    used = set(session.scalars(select(Version.snapshot_id)))
    pinned = set(session.scalars(select(Minibrain.snapshot_id).where(Minibrain.snapshot_id.is_not(None))))
    doomed: list[Snapshot] = []
    saved: dict[int, list[Snapshot]] = defaultdict(list)
    for snapshot in session.scalars(select(Snapshot).where(Snapshot.minibrain_id.is_(None))):
        if snapshot.id in used or snapshot.id in pinned:
            continue
        if snapshot.saved and snapshot.dataset_id is not None:
            saved[snapshot.dataset_id].append(snapshot)
        else:
            doomed.append(snapshot)
    for group in saved.values():
        doomed += sorted(group, key=taken, reverse=True)[keep:]
    return doomed


def cleanup(session: Session, settings: Settings) -> int:
    doomed = doomed_snapshots(session)
    artifacts = {snapshot.artifact_id for snapshot in doomed if snapshot.artifact_id}
    for snapshot in doomed:
        session.delete(snapshot)
    session.flush()
    store = store_for(settings)
    for artifact_id in artifacts:
        if session.scalar(select(Snapshot.id).where(Snapshot.artifact_id == artifact_id).limit(1)) is None:
            found = session.get(Artifact, artifact_id)
            if found is not None:
                session.delete(found)
            store.delete(artifact_id)
    return len(doomed)
