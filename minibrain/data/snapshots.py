import shutil
import tempfile
from collections import defaultdict
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from minibrain.data.checks import Finding, blocking, run_checks
from minibrain.data.feedback import training_rows
from minibrain.data.limits import load_limits
from minibrain.data.shared import dataset_sql, dataset_tables, fingerprint
from minibrain.data.snapshot import (
    MIN_ROWS,
    SPLITS,
    Example,
    SnapshotError,
    clean,
    is_parquet,
    labels_of,
    read_rows,
    split,
)
from minibrain.data.sources import copy_rows, merge_rows
from minibrain.registry.files import ArtifactKind, snapshot_location, store_file, store_for
from minibrain.registry.models import Artifact, Dataset, Minibrain, Snapshot, Version, now
from minibrain.registry.service import ConflictError, latest_snapshot, latest_version
from minibrain.settings import Settings

SNAPSHOT_FILE = "snapshot.parquet"


@dataclass(frozen=True)
class Changes:
    data: bool
    query: bool
    dataset: bool = False


def over_limit(limit: int) -> str:
    return (
        f"The query returns more than {limit:,} rows, the most one dataset version holds. Filter or sample in the "
        f"query, for example USING SAMPLE reservoir({limit} ROWS) REPEATABLE (7), or raise the limit under Settings, "
        "Data."
    )


def split_summary(
    rows: list[tuple[str | None, str | None]],
) -> tuple[dict[str, int], list[str], dict[str, list[Example]] | None]:
    examples = clean(rows)
    try:
        splits = split(examples)
    except SnapshotError:
        return {}, sorted({example.label for example in examples}), None
    return {name: len(splits[name]) for name in SPLITS}, labels_of(splits), splits


@dataclass(frozen=True)
class Taken:
    artifact: Artifact
    rows: int
    counts: dict[str, int]
    labels: list[str]
    findings: list[Finding]


def checked(session: Session, settings: Settings, target: Path) -> Taken:
    rows_read = read_rows(target)
    counts, labels, splits = split_summary(rows_read)
    findings = run_checks(rows_read, splits, load_limits(session).checks())
    stop = blocking(findings)
    if stop is not None:
        raise ConflictError(f"{stop.title}: {stop.detail}")
    artifact = store_file(session, store_for(settings), target, ArtifactKind.SNAPSHOT)
    return Taken(artifact=artifact, rows=len(rows_read), counts=counts, labels=labels, findings=findings)


def stored(dataset: Dataset | None, result: Taken, moment: datetime) -> Snapshot:
    return Snapshot(
        dataset=dataset,
        hash=result.artifact.id,
        artifact_id=result.artifact.id,
        counts=result.counts,
        labels=result.labels,
        rows=result.rows,
        size=result.artifact.size,
        created_at=moment,
    )


def next_number(dataset: Dataset) -> int:
    return max((snapshot.number or 0 for snapshot in dataset.snapshots), default=0) + 1


def take_version(session: Session, settings: Settings, dataset: Dataset) -> Snapshot:
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
            raise ConflictError("The query returns no rows, so there is no version to save.")
        result = checked(session, settings, target)
    moment = now()
    found = latest_version(dataset)
    if found is None or found.hash != result.artifact.id:
        found = stored(dataset, result, moment)
        found.number = next_number(dataset)
        found.saved = True
        session.add(found)
    found.fingerprints = prints
    found.checks = [finding.as_dict() for finding in result.findings]
    found.sql = sql
    found.taken_at = moment
    session.flush()
    return found


def version_if_mapped(session: Session, settings: Settings, dataset: Dataset | None) -> Snapshot | None:
    if dataset is None or not dataset.sql or not dataset.sources:
        return None
    return take_version(session, settings, dataset)


def plain_copy(session: Session, settings: Settings, snapshot: Snapshot, target: Path) -> bool:
    if snapshot.artifact_id is None or not is_parquet(snapshot_location(session, store_for(settings), snapshot)):
        return False
    with store_for(settings).open(snapshot.artifact_id) as stream, target.open("wb") as sink:
        shutil.copyfileobj(stream, sink)
    return True


def with_feedback(session: Session, settings: Settings, minibrain: Minibrain, version: Snapshot) -> Snapshot:
    extra = training_rows(session, minibrain)
    if not extra:
        return version
    settings.work_dir().mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(dir=settings.work_dir()) as scratch:
        target = Path(scratch) / SNAPSHOT_FILE
        if not plain_copy(session, settings, version, target):
            return version
        _, added = merge_rows(target, [(example.input, example.label) for example in extra])
        if added == 0:
            return version
        result = checked(session, settings, target)
    moment = now()
    found = next((copy for copy in version.copies if copy.hash == result.artifact.id), None)
    if found is None:
        found = stored(version.dataset, result, moment)
        found.base = version
        session.add(found)
    found.fingerprints = version.fingerprints
    found.checks = [finding.as_dict() for finding in result.findings]
    found.sql = version.sql
    found.feedback_rows = added
    found.taken_at = moment
    session.flush()
    return found


def dataset_version(session: Session, minibrain: Minibrain, snapshot_id: int | None) -> Snapshot:
    dataset = minibrain.dataset
    if snapshot_id is not None:
        found = session.get(Snapshot, snapshot_id)
        if found is None or found.number is None or dataset is None or found.dataset_id != dataset.id:
            raise ConflictError(f"pick a version of the dataset {minibrain.name} trains on")
        return found
    found = latest_snapshot(minibrain)
    if found is not None:
        return found
    if dataset is None:
        raise ConflictError("upload a data file or pick a dataset first")
    raise ConflictError(f"{dataset.name} has no saved version yet; update it on the Data page first")


def training_snapshot(
    session: Session, settings: Settings, minibrain: Minibrain, snapshot_id: int | None = None
) -> Snapshot:
    return with_feedback(session, settings, minibrain, dataset_version(session, minibrain, snapshot_id))


def require_splits(snapshot: Snapshot) -> None:
    if not snapshot.counts:
        raise ConflictError(
            f"The data has fewer than {MIN_ROWS} labelled rows after removing empty and repeated inputs; "
            "add rows before scoring or training."
        )


def taken(snapshot: Snapshot) -> tuple[datetime, int]:
    return (snapshot.taken_at or snapshot.created_at, snapshot.id)


def version_number(snapshot: Snapshot) -> int | None:
    if snapshot.number is not None:
        return snapshot.number
    return snapshot.base.number if snapshot.base is not None else None


def latest_of(dataset: Dataset) -> Snapshot | None:
    return latest_version(dataset)


def versions_of(dataset: Dataset) -> list[Snapshot]:
    numbered = [snapshot for snapshot in dataset.snapshots if snapshot.number is not None]
    return sorted(numbered, key=lambda snapshot: snapshot.number or 0, reverse=True)


def current_prints(settings: Settings, dataset: Dataset) -> dict[str, str]:
    return {source.table_name: fingerprint(settings, source) for source in dataset.sources}


def changes_since(settings: Settings, dataset: Dataset, snapshot: Snapshot | None) -> Changes | None:
    if snapshot is None:
        return None
    if snapshot.dataset_id != dataset.id:
        return Changes(data=False, query=False, dataset=True)
    changed = current_prints(settings, dataset) != (snapshot.fingerprints or {})
    return Changes(data=changed, query=dataset.sql != snapshot.sql)


def latest_ids(session: Session) -> set[int]:
    newest = (
        select(Snapshot.dataset_id, func.max(Snapshot.number).label("number"))
        .where(Snapshot.dataset_id.is_not(None), Snapshot.number.is_not(None))
        .group_by(Snapshot.dataset_id)
        .subquery()
    )
    found = select(Snapshot.id).join(
        newest, (Snapshot.dataset_id == newest.c.dataset_id) & (Snapshot.number == newest.c.number)
    )
    return set(session.scalars(found))


def doomed_snapshots(session: Session) -> list[Snapshot]:
    keep = load_limits(session).keep_snapshots
    used = set(session.scalars(select(Version.snapshot_id)))
    used |= set(session.scalars(select(Minibrain.snapshot_id).where(Minibrain.snapshot_id.is_not(None))))
    candidates = list(session.scalars(select(Snapshot).where(Snapshot.minibrain_id.is_(None))))
    used |= {snapshot.base_id for snapshot in candidates if snapshot.id in used and snapshot.base_id is not None}
    newest = latest_ids(session)
    doomed: list[Snapshot] = []
    saved: dict[int, list[Snapshot]] = defaultdict(list)
    for snapshot in candidates:
        if snapshot.id in used:
            continue
        if (snapshot.saved or snapshot.number is not None) and snapshot.dataset_id is not None:
            saved[snapshot.dataset_id].append(snapshot)
        else:
            doomed.append(snapshot)
    for group in saved.values():
        older = sorted(group, key=taken, reverse=True)[keep:]
        doomed += [snapshot for snapshot in older if snapshot.id not in newest]
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
