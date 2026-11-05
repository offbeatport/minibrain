import io
import json
import os
import platform
import sys
import zipfile
from dataclasses import asdict
from datetime import UTC, datetime
from pathlib import Path
from typing import Any, Literal

import pydantic
from fastapi import APIRouter, Depends
from fastapi.responses import Response
from sqlalchemy import func, make_url, select
from sqlalchemy.orm import Session

from minibrain.api.access import admin
from minibrain.api.deps import LocalNodeDep, SessionDep, SettingsDep, StoreDep
from minibrain.api.system import database_store, install_settings, storage_settings
from minibrain.artifacts import ArtifactStore
from minibrain.data.limits import load_limits
from minibrain.models import hub
from minibrain.models.catalog import SNAPSHOT_KEY, bundled, catalog_url, daily_sync
from minibrain.models.hardware import NodeReport
from minibrain.models.sources import s3_endpoint
from minibrain.policy import describe
from minibrain.policy import load as load_policy
from minibrain.recent_logs import RECENT
from minibrain.redaction import redact, scrub, secret_name
from minibrain.registry.compute import NODE_FRESH, pools
from minibrain.registry.models import BaseModel, CatalogModel, Job, JobStatus, Node, now
from minibrain.registry.settings_store import read
from minibrain.settings import REPO_ROOT, Settings
from minibrain.siem import target_of
from minibrain.telemetry.logs import log_format
from minibrain.telemetry.prometheus import load_metrics_access
from minibrain.telemetry.target import OtlpTarget, TargetError
from minibrain.telemetry.target import target_of as otlp_target_of
from minibrain.versions import library_version

router = APIRouter(prefix="/api/system", tags=["system"])

BUILD_FILE = Path(__file__).resolve().parent.parent / "build.json"
ENVIRONMENT_PREFIXES = ("MINIBRAIN_", "HF_", "HUGGING_FACE_", "AWS_")
RECENT_FAILURES = 20


class InstallSoftware(pydantic.BaseModel):
    minibrain: str
    commit: str | None
    python: str
    duckdb: str | None
    torch: str | None
    transformers: str | None
    system: str
    arch: str


class InstallPlaces(pydantic.BaseModel):
    host: str
    home: str
    database_kind: Literal["sqlite", "postgres"]
    database_location: str
    database_bytes: int | None
    storage_kind: Literal["local", "s3"]
    storage_location: str
    storage_bucket: str | None
    storage_endpoint: str | None
    web_path: str
    web_url: str | None
    web_built_at: datetime | None
    web_bundle: str | None


class InstallCatalogue(pydantic.BaseModel):
    snapshot: str | None
    bundled_snapshot: str
    source: str
    entries: int
    synced_at: datetime | None
    models: int
    models_verified_at: datetime | None


class InstallCompute(pydantic.BaseModel):
    pools: int
    machines: int
    machines_online: int
    workers_online: int
    engines_online: int


class InstallEndpoint(pydantic.BaseModel):
    name: str
    url: str
    allowed: bool
    by_policy: bool


class InstallNetwork(pydantic.BaseModel):
    mode: Literal["open", "allowlist", "offline"]
    locked: bool
    source: str
    allowed_hosts: list[str]
    endpoints: list[InstallEndpoint]


class InstallObservability(pydantic.BaseModel):
    otlp: bool
    metrics: bool
    metrics_token: bool
    metrics_addresses: list[str]
    log_format: Literal["text", "json"]


class InstallInfo(pydantic.BaseModel):
    software: InstallSoftware
    places: InstallPlaces
    catalogue: InstallCatalogue
    compute: InstallCompute
    network: InstallNetwork
    observability: InstallObservability


def git_commit(git: Path) -> str | None:
    if git.is_file():
        git = git.parent / git.read_text().strip().removeprefix("gitdir: ")
    head = git / "HEAD"
    if not head.is_file():
        return None
    text = head.read_text().strip()
    if not text.startswith("ref: "):
        return text or None
    ref = text.removeprefix("ref: ")
    common = git / "commondir"
    root = git / common.read_text().strip() if common.is_file() else git
    loose = root / ref
    if loose.is_file():
        return loose.read_text().strip() or None
    packed = root / "packed-refs"
    lines = packed.read_text().splitlines() if packed.is_file() else []
    return next((sha for sha, _, name in (line.partition(" ") for line in lines) if name == ref), None)


def build_commit() -> str | None:
    if BUILD_FILE.is_file():
        return json.loads(BUILD_FILE.read_text()).get("commit") or None
    return git_commit(REPO_ROOT / ".git")


def system_name() -> str:
    if sys.platform == "darwin":
        release = platform.mac_ver()[0]
        return f"macOS {release}".strip()
    if sys.platform.startswith("linux"):
        try:
            pretty = platform.freedesktop_os_release().get("PRETTY_NAME")
        except OSError:
            pretty = None
        return f"{pretty or 'Linux'}, kernel {platform.release()}"
    return f"{platform.system()} {platform.release()}".strip()


def software() -> InstallSoftware:
    return InstallSoftware(
        minibrain=library_version("minibrain") or "unknown",
        commit=build_commit(),
        python=platform.python_version(),
        duckdb=library_version("duckdb"),
        torch=library_version("torch"),
        transformers=library_version("transformers"),
        system=system_name(),
        arch=platform.machine(),
    )


def web_build(dist: Path) -> tuple[datetime | None, str | None]:
    index = dist / "index.html"
    if not index.is_file():
        return None, None
    bundles = sorted(path.name for path in (dist / "assets").glob("index-*.js"))
    return datetime.fromtimestamp(index.stat().st_mtime, UTC), bundles[0] if bundles else None


def places(session: Session, settings: Settings, store: ArtifactStore, node: NodeReport) -> InstallPlaces:
    database = database_store(settings)
    storage = storage_settings(session, settings, store)
    built_at, bundle = web_build(settings.web_dist)
    s3 = storage.kind == "s3"
    return InstallPlaces(
        host=node.host,
        home=str(settings.home),
        database_kind="postgres" if database.kind == "postgres" else "sqlite",
        database_location=database.location,
        database_bytes=database.used_bytes,
        storage_kind=storage.kind,
        storage_location=storage.location,
        storage_bucket=storage.bucket if s3 else None,
        storage_endpoint=storage.endpoint if s3 else None,
        web_path=str(settings.web_dist),
        web_url=settings.ui_url,
        web_built_at=built_at,
        web_bundle=bundle,
    )


def catalogue(session: Session) -> InstallCatalogue:
    shipped = bundled()
    return InstallCatalogue(
        snapshot=read(session, SNAPSHOT_KEY),
        bundled_snapshot=shipped["snapshot"],
        source=shipped.get("source", ""),
        entries=int(session.scalar(select(func.count(CatalogModel.id))) or 0),
        synced_at=session.scalar(select(func.max(CatalogModel.synced_at))),
        models=int(session.scalar(select(func.count(BaseModel.id))) or 0),
        models_verified_at=session.scalar(select(func.max(BaseModel.verified_at))),
    )


def compute(session: Session, node: NodeReport) -> InstallCompute:
    found = pools(session, node)
    machines = [item for pool in found for item in pool.nodes]
    fresh = session.scalars(select(Node).where(Node.seen_at >= now() - NODE_FRESH))
    return InstallCompute(
        pools=len(found),
        machines=len(machines),
        machines_online=sum(item.online for item in machines),
        workers_online=sum("worker" in item.roles for item in fresh),
        engines_online=sum(len(pool.engines) for pool in found),
    )


def network(session: Session, settings: Settings, store: ArtifactStore) -> InstallNetwork:
    policy = load_policy(session)
    described = next(item for item in describe(session) if item["name"] == "network")
    governed = [("Hugging Face", hub.endpoint()), ("Model imports from S3", s3_endpoint())]
    if catalog_url():
        governed.append(("Catalogue updates", str(catalog_url())))
    endpoints = [
        InstallEndpoint(name=name, url=url, allowed=policy.outbound_allowed(url), by_policy=True)
        for name, url in governed
    ]
    storage = storage_settings(session, settings, store)
    if storage.kind == "s3" and storage.endpoint:
        endpoints.append(InstallEndpoint(name="Artifact storage", url=storage.endpoint, allowed=True, by_policy=False))
    siem = target_of(policy)
    if siem is not None:
        endpoints.append(InstallEndpoint(name="SIEM export", url=siem.describe(), allowed=True, by_policy=False))
    collector = otlp_target(policy.values)
    for name, url in collector.urls() if collector is not None else []:
        endpoints.append(InstallEndpoint(name=name, url=url, allowed=True, by_policy=False))
    return InstallNetwork(
        mode=policy["network"],
        locked=bool(described["locked"]),
        source=str(described["source"]),
        allowed_hosts=list(policy["allowed_hosts"]),
        endpoints=endpoints,
    )


def otlp_target(values: dict[str, Any]) -> OtlpTarget | None:
    try:
        return otlp_target_of(values | {"otel_headers": None})
    except TargetError:
        return None


def observability(session: Session) -> InstallObservability:
    access = load_metrics_access()
    return InstallObservability(
        otlp=otlp_target(load_policy(session).values) is not None,
        metrics=access.enabled,
        metrics_token=access.token is not None,
        metrics_addresses=[str(network) for network in access.networks],
        log_format="json" if log_format() == "json" else "text",
    )


def install_info(session: Session, settings: Settings, store: ArtifactStore, node: NodeReport) -> InstallInfo:
    return InstallInfo(
        software=software(),
        places=places(session, settings, store, node),
        catalogue=catalogue(session),
        compute=compute(session, node),
        network=network(session, settings, store),
        observability=observability(session),
    )


@router.get("/install", dependencies=[Depends(admin)])
def install(session: SessionDep, settings: SettingsDep, store: StoreDep, node: LocalNodeDep) -> InstallInfo:
    return install_info(session, settings, store, node)


def settings_summary(session: Session, settings: Settings, store: ArtifactStore) -> dict[str, Any]:
    return {
        "home": str(settings.home),
        "web_dist": str(settings.web_dist),
        "ui_url": settings.ui_url,
        "database_url": make_url(settings.database_url).render_as_string(hide_password=True),
        "storage": storage_settings(session, settings, store).model_dump(exclude={"access_key"}),
        "catalogue": {"url": catalog_url(), "daily_sync": daily_sync(session)},
        "hugging_face": {"endpoint": hub.endpoint(), "token_set": hub.token() is not None, "offline": hub.offline()},
        "data_limits": asdict(load_limits(session)),
        "training": install_settings().model_dump(),
        "environment_variables_set": sorted(name for name in os.environ if name.startswith(ENVIRONMENT_PREFIXES)),
    }


def jobs_summary(session: Session) -> dict[str, Any]:
    counts = session.execute(select(Job.kind, Job.status, func.count()).group_by(Job.kind, Job.status)).all()
    failed = session.scalars(
        select(Job).where(Job.status == JobStatus.FAILED).order_by(Job.id.desc()).limit(RECENT_FAILURES)
    )
    return {
        "counts": [{"kind": kind, "status": status, "count": count} for kind, status, count in counts],
        "recent_failures": [
            {
                "id": job.id,
                "kind": job.kind,
                "attempt": job.attempt,
                "error_code": job.error_code,
                "error": job.error,
                "finished_at": job.finished_at,
            }
            for job in failed
        ],
    }


def known_secrets(settings: Settings) -> list[str]:
    found = [value for name, value in os.environ.items() if secret_name(name)]
    folder = settings.home / "secrets"
    if folder.is_dir():
        found += [path.read_text().strip() for path in folder.iterdir() if path.is_file()]
    password = make_url(settings.database_url).password
    if password:
        found.append(str(password))
    return found


def as_json(value: Any) -> str:
    return json.dumps(redact(value), indent=2, sort_keys=True, default=str) + "\n"


def diagnostics_files(session: Session, settings: Settings, store: ArtifactStore, node: NodeReport) -> dict[str, str]:
    return {
        "install.json": as_json(install_info(session, settings, store, node).model_dump(mode="json")),
        "machine.json": as_json(node.as_dict()),
        "settings.json": as_json(settings_summary(session, settings, store)),
        "policies.json": as_json(
            {item["name"]: {"value": item["value"], "source": item["source"]} for item in describe(session)}
        ),
        "jobs.json": as_json(jobs_summary(session)),
        "server.log": RECENT.text() or "No warnings or errors logged since the server started.\n",
    }


@router.get(
    "/diagnostics",
    response_class=Response,
    responses={200: {"content": {"application/zip": {}}}},
    dependencies=[Depends(admin)],
)
def diagnostics(session: SessionDep, settings: SettingsDep, store: StoreDep, node: LocalNodeDep) -> Response:
    stamp = now().strftime("%Y%m%d-%H%M%S")
    folder = f"minibrain-diagnostics-{stamp}"
    secrets = known_secrets(settings)
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w", zipfile.ZIP_DEFLATED) as archive:
        for name, text in diagnostics_files(session, settings, store, node).items():
            archive.writestr(f"{folder}/{name}", scrub(text, secrets))
    return Response(
        buffer.getvalue(),
        media_type="application/zip",
        headers={"Content-Disposition": f'attachment; filename="{folder}.zip"'},
    )
