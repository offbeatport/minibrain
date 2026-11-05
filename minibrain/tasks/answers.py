from collections.abc import Sequence
from dataclasses import dataclass, field

from sqlalchemy import select
from sqlalchemy.orm import Session

from minibrain.artifacts import ArtifactStore
from minibrain.registry.models import Job, JobKind, JobStatus, JudgeScore, Model, Version
from minibrain.tasks.examples import Example
from minibrain.tasks.graders import Grader, Judge, digest
from minibrain.tasks.service import graders_of, live_version, split_examples, version_metric

SPLIT = "eval"


@dataclass(frozen=True)
class Side:
    answer: str
    scores: dict[str, float]
    reason: str | None = None


@dataclass(frozen=True)
class Row:
    example: Example
    mine: Side
    live: Side | None = None
    worse: bool | None = None


@dataclass(frozen=True)
class Compared:
    number: int
    live: int | None
    metric: str | None
    rows: list[Row] = field(default_factory=list)


def example_key(example: Example) -> str:
    return digest({"messages": example.messages(), "expected": example.expected})


def eval_answers(version: Version) -> list[str]:
    jobs = [
        job
        for job in version.model.jobs
        if job.version_id == version.id and job.kind == JobKind.EVAL and job.status == JobStatus.SUCCEEDED
    ]
    newest: Job | None = max(jobs, key=lambda job: job.id, default=None)
    found = ((newest.result or {}).get("answers") or {}).get(SPLIT) if newest is not None else None
    return [str(answer) for answer in found or []]


def judged(
    session: Session, graders: Sequence[Grader], examples: Sequence[Example], answers: Sequence[str]
) -> dict[str, JudgeScore]:
    judge = next((grader for grader in graders if isinstance(grader, Judge)), None)
    if judge is None:
        return {}
    keys = [judge.key(answer, example) for example, answer in zip(examples, answers, strict=True)]
    return {row.key: row for row in session.scalars(select(JudgeScore).where(JudgeScore.key.in_(keys)))}


def side_of(graders: Sequence[Grader], example: Example, answer: str, cached: dict[str, JudgeScore]) -> Side:
    scores: dict[str, float] = {}
    reason = None
    for grader in graders:
        scores |= grader.score(answer, example)
        if isinstance(grader, Judge):
            found = cached.get(grader.key(answer, example))
            reason = found.reason if found is not None else None
    return Side(answer, scores, reason)


def sides(session: Session, store: ArtifactStore, version: Version) -> dict[str, tuple[Example, Side]]:
    examples = split_examples(session, store, version).get(SPLIT, [])
    answers = eval_answers(version)
    if not examples or len(answers) != len(examples):
        return {}
    cached = judged(session, graders_of(version), examples, answers)
    scores = {key: row.score for key, row in cached.items()}
    graders = graders_of(version, scores)
    return {
        example_key(example): (example, side_of(graders, example, answer, cached))
        for example, answer in zip(examples, answers, strict=True)
    }


def worse(mine: Side, live: Side | None, metric: str | None) -> bool | None:
    if live is None or metric is None or metric not in mine.scores or metric not in live.scores:
        return None
    return mine.scores[metric] < live.scores[metric]


def compared(session: Session, store: ArtifactStore, model: Model, version: Version) -> Compared:
    live = live_version(model)
    against = live if live is not None and live.id != version.id else None
    theirs = sides(session, store, against) if against is not None else {}
    metric = version_metric(version)
    rows = []
    for key, (example, mine) in sides(session, store, version).items():
        other = theirs.get(key, (example, None))[1]
        rows.append(Row(example, mine, other, worse(mine, other, metric)))
    return Compared(version.number, against.number if against is not None else None, metric, rows)
