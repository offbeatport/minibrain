from collections.abc import Iterable, Iterator
from dataclasses import dataclass
from typing import Any

from fastapi.routing import APIRoute

MANAGEMENT_ROOT = "/api"
MODEL = "/api/models/{name}"


@dataclass(frozen=True)
class Section:
    name: str
    description: str
    prefixes: tuple[str, ...]


@dataclass(frozen=True)
class SectionGroup:
    name: str
    sections: tuple[Section, ...]


MODELS = Section(
    "Models",
    "Custom and base models under one API name: list, read, change, deploy, delete, add and import, "
    "plus each model's page.",
    ("/api/models", "/api/reserved-names", "/api/catalog", "/api/presets"),
)
VERSIONS = Section(
    "Versions",
    "A custom model's versions: add, promote, test, delete, their files and model cards.",
    (f"{MODEL}/versions",),
)
DATA = Section(
    "Data",
    "Sources, connections, datasets and their versions, and the data a custom model trains on.",
    (
        "/api/sources",
        "/api/samples",
        "/api/query",
        "/api/data",
        "/api/datasets",
        "/api/dataset-versions",
        "/api/dataset-folders",
        "/api/connections",
        "/api/extensions",
        f"{MODEL}/dataset",
        f"{MODEL}/dataset-versions",
        f"{MODEL}/mapping",
        f"{MODEL}/query",
        f"{MODEL}/preview",
        f"{MODEL}/golden",
    ),
)
TRAINING = Section(
    "Training and jobs",
    "Training plans, jobs, their events and metrics, and the artifacts they leave.",
    ("/api/jobs", "/api/artifacts", f"{MODEL}/training-plan"),
)
EVALUATIONS = Section(
    "Evaluations",
    "A custom model's contract, graders, judge and promotion rule, and the answers a version was scored on.",
    (
        f"{MODEL}/contract",
        f"{MODEL}/graders",
        f"{MODEL}/judge",
        f"{MODEL}/promotion",
        f"{MODEL}/label-proposal",
        f"{MODEL}/versions/{{number}}/answers",
    ),
)
FEEDBACK = Section(
    "Feedback",
    "Ratings and corrections on answers, the review queue and saved test examples.",
    ("/api/feedback", f"{MODEL}/feedback", f"{MODEL}/test-examples"),
)
PLAYGROUND = Section(
    "Playground",
    "Chat with any model from the browser, with saved presets and chats.",
    ("/api/playground",),
)
MONITORING = Section(
    "Monitoring",
    "Request logs, traffic and latency, across models or for one.",
    ("/api/requests", f"{MODEL}/traffic"),
)
KEYS = Section("Keys", "API keys for the OpenAI-compatible API and the models they cover.", ("/api/keys",))
INFRASTRUCTURE = Section(
    "Infrastructure",
    "Compute pools, device prices, the install and its servers.",
    ("/api/compute", "/api/system"),
)
SETTINGS = Section(
    "Settings",
    "Install-wide settings: storage, data, judge, safety, catalogue, policies and encryption.",
    ("/api/settings", "/api/policies", "/api/catalog/settings"),
)
ACCOUNTS = Section("Accounts", "Sign-in, sessions and the people who use this install.", ("/api/auth", "/api/accounts"))
AUDIT = Section("Audit", "The audit log, its export and its hash chain.", ("/api/audit",))
REFERENCE = Section("Reference", "The OpenAPI documents this page renders.", ("/api/openapi",))

GROUPS = (
    SectionGroup("Build", (MODELS, VERSIONS, DATA, TRAINING, EVALUATIONS, FEEDBACK, PLAYGROUND)),
    SectionGroup("Operate", (MONITORING, KEYS, INFRASTRUCTURE)),
    SectionGroup("Administer", (SETTINGS, ACCOUNTS, AUDIT, REFERENCE)),
)
SECTIONS = tuple(section for group in GROUPS for section in group.sections)


def under(path: str, prefix: str) -> bool:
    return path == prefix or path.startswith((f"{prefix}/", f"{prefix}."))


def section_of(path: str) -> Section | None:
    found = [(len(prefix), section) for section in SECTIONS for prefix in section.prefixes if under(path, prefix)]
    return max(found, key=lambda item: item[0])[1] if found else None


def routes_of(routes: Iterable[Any]) -> Iterator[APIRoute]:
    for route in routes:
        included = getattr(route, "original_router", None)
        if included is not None:
            yield from routes_of(included.routes)
        elif isinstance(route, APIRoute):
            yield route


def tag_sections(routes: Iterable[Any]) -> None:
    for route in routes_of(routes):
        if not route.path.startswith(f"{MANAGEMENT_ROOT}/"):
            continue
        section = section_of(route.path)
        if section is None:
            raise LookupError(f"{route.path} belongs to no API reference section; add it to minibrain/api/sections.py")
        route.tags = [section.name]


def section_tags() -> list[dict[str, str]]:
    return [{"name": section.name, "description": section.description} for section in SECTIONS]


def tag_groups() -> list[dict[str, Any]]:
    return [{"name": group.name, "tags": [section.name for section in group.sections]} for group in GROUPS]
