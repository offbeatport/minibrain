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
from minibrain.data.sources import copy_rows, merge_rows
from minibrain.data.splits import (
    MIN_ROWS,
    SPLITS,
    DatasetVersionError,
    Row,
    answer_labels,
    clean,
    pairs,
    read_rows,
    split,
)
from minibrain.registry.files import ArtifactKind, store_file, store_for
from minibrain.registry.models import Artifact, Dataset, DatasetVersion, Model, Version, now
from minibrain.registry.service import ConflictError, latest_dataset_version, latest_version
from minibrain.settings import Settings
from minibrain.tasks.examples import Example, encode_turns

DATASET_VERSION_FILE = "dataset_version.parquet"


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


def split_summary(rows: list[Row]) -> tuple[dict[str, int], list[str], dict[str, list[Example]] | None]:
    examples = clean(rows)
    labels = answer_labels(examples)
    try:
        splits = split(examples)
    except DatasetVersionError:
        return {}, labels, None
    return {name: len(splits[name]) for name in SPLITS}, labels, splits


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
    findings = run_checks(pairs(rows_read), splits, load_limits(session).checks(), labelled=bool(labels))
    stop = blocking(findings)
    if stop is not None:
        raise ConflictError(f"{stop.title}: {stop.detail}")
    artifact = store_file(session, store_for(settings), target, ArtifactKind.DATASET_VERSION)
    return Taken(artifact=artifact, rows=len(rows_read), counts=counts, labels=labels, findings=findings)


def stored(dataset: Dataset | None, result: Taken, moment: datetime) -> DatasetVersion:
    return DatasetVersion(
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
    return max((dataset_version.number or 0 for dataset_version in dataset.versions), default=0) + 1


def take_version(session: Session, settings: Settings, dataset: Dataset) -> DatasetVersion:
    limit = load_limits(session).row_limit
    sql = dataset_sql(dataset)
    tables, aliases = dataset_tables(settings, store_for(settings), dataset)
    prints = {table.name: table.fingerprint for table in tables}
    settings.work_dir().mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(dir=settings.work_dir()) as scratch:
        target = Path(scratch) / DATASET_VERSION_FILE
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


def version_if_mapped(session: Session, settings: Settings, dataset: Dataset | None) -> DatasetVersion | None:
    if dataset is None or not dataset.sql or not dataset.sources:
        return None
    return take_version(session, settings, dataset)


def plain_copy(settings: Settings, dataset_version: DatasetVersion, target: Path) -> None:
    with store_for(settings).open(dataset_version.artifact_id) as stream, target.open("wb") as sink:
        shutil.copyfileobj(stream, sink)


def with_feedback(session: Session, settings: Settings, model: Model, version: DatasetVersion) -> DatasetVersion:
    extra = training_rows(session, model)
    if not extra:
        return version
    settings.work_dir().mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(dir=settings.work_dir()) as scratch:
        target = Path(scratch) / DATASET_VERSION_FILE
        plain_copy(settings, version, target)
        _, added = merge_rows(target, [(encode_turns(row.turns), row.input, row.expected) for row in extra])
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


def chosen_dataset_version(session: Session, model: Model, dataset_version_id: int | None) -> DatasetVersion:
    dataset = model.dataset
    if dataset_version_id is not None:
        found = session.get(DatasetVersion, dataset_version_id)
        if found is None or found.number is None or dataset is None or found.dataset_id != dataset.id:
            raise ConflictError(f"pick a version of the dataset {model.name} trains on")
        return found
    found = latest_dataset_version(model)
    if found is not None:
        return found
    if dataset is None:
        raise ConflictError("upload a data file or pick a dataset first")
    raise ConflictError(f"{dataset.name} has no saved version yet; update it on the Data page first")


def training_dataset_version(
    session: Session, settings: Settings, model: Model, dataset_version_id: int | None = None
) -> DatasetVersion:
    return with_feedback(session, settings, model, chosen_dataset_version(session, model, dataset_version_id))


def require_splits(dataset_version: DatasetVersion) -> None:
    if not dataset_version.counts:
        raise ConflictError(
            f"The data has fewer than {MIN_ROWS} labelled rows after removing empty and repeated inputs; "
            "add rows before scoring or training."
        )


def taken(dataset_version: DatasetVersion) -> tuple[datetime, int]:
    return (dataset_version.taken_at or dataset_version.created_at, dataset_version.id)


def version_number(dataset_version: DatasetVersion) -> int | None:
    if dataset_version.number is not None:
        return dataset_version.number
    return dataset_version.base.number if dataset_version.base is not None else None


def latest_of(dataset: Dataset) -> DatasetVersion | None:
    return latest_version(dataset)


def versions_of(dataset: Dataset) -> list[DatasetVersion]:
    numbered = [dataset_version for dataset_version in dataset.versions if dataset_version.number is not None]
    return sorted(numbered, key=lambda dataset_version: dataset_version.number or 0, reverse=True)


def current_prints(settings: Settings, dataset: Dataset) -> dict[str, str]:
    return {source.table_name: fingerprint(settings, source) for source in dataset.sources}


def changes_since(settings: Settings, dataset: Dataset, dataset_version: DatasetVersion | None) -> Changes | None:
    if dataset_version is None:
        return None
    if dataset_version.dataset_id != dataset.id:
        return Changes(data=False, query=False, dataset=True)
    changed = current_prints(settings, dataset) != (dataset_version.fingerprints or {})
    return Changes(data=changed, query=dataset.sql != dataset_version.sql)


def latest_ids(session: Session) -> set[int]:
    newest = (
        select(DatasetVersion.dataset_id, func.max(DatasetVersion.number).label("number"))
        .where(DatasetVersion.dataset_id.is_not(None), DatasetVersion.number.is_not(None))
        .group_by(DatasetVersion.dataset_id)
        .subquery()
    )
    found = select(DatasetVersion.id).join(
        newest, (DatasetVersion.dataset_id == newest.c.dataset_id) & (DatasetVersion.number == newest.c.number)
    )
    return set(session.scalars(found))


def doomed_dataset_versions(session: Session) -> list[DatasetVersion]:
    keep = load_limits(session).keep_versions
    used = set(session.scalars(select(Version.dataset_version_id)))
    candidates = list(session.scalars(select(DatasetVersion)))
    used |= {
        dataset_version.base_id
        for dataset_version in candidates
        if dataset_version.id in used and dataset_version.base_id is not None
    }
    newest = latest_ids(session)
    doomed: list[DatasetVersion] = []
    saved: dict[int, list[DatasetVersion]] = defaultdict(list)
    for dataset_version in candidates:
        if dataset_version.id in used:
            continue
        if (dataset_version.saved or dataset_version.number is not None) and dataset_version.dataset_id is not None:
            saved[dataset_version.dataset_id].append(dataset_version)
        else:
            doomed.append(dataset_version)
    for group in saved.values():
        older = sorted(group, key=taken, reverse=True)[keep:]
        doomed += [dataset_version for dataset_version in older if dataset_version.id not in newest]
    return doomed


def cleanup(session: Session, settings: Settings) -> int:
    doomed = doomed_dataset_versions(session)
    artifacts = {dataset_version.artifact_id for dataset_version in doomed}
    for dataset_version in doomed:
        session.delete(dataset_version)
    session.flush()
    store = store_for(settings)
    for artifact_id in artifacts:
        if session.scalar(select(DatasetVersion.id).where(DatasetVersion.artifact_id == artifact_id).limit(1)) is None:
            found = session.get(Artifact, artifact_id)
            if found is not None:
                session.delete(found)
            store.delete(artifact_id)
    return len(doomed)
