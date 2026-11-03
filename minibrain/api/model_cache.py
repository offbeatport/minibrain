from datetime import datetime

from fastapi import APIRouter
from pydantic import BaseModel, Field

from minibrain.api.deps import SessionDep, SettingsDep
from minibrain.auth.identity import current_actor
from minibrain.models.cache import (
    KEY,
    CachedBase,
    CachePlan,
    CacheSettings,
    cached_bases,
    estimate,
    evict,
    load_settings,
    plan,
    save_settings,
)
from minibrain.registry.models import AuditEvent

router = APIRouter(prefix="/api", tags=["models"])

MAX_BUDGET_GB = 1_000_000


class ModelCacheSettings(BaseModel):
    enabled: bool
    budget_gb: float = Field(gt=0, le=MAX_BUDGET_GB)


class CachedBaseInfo(BaseModel):
    key: str
    name: str
    size_bytes: int
    last_used_at: datetime
    pinned: bool
    kept: list[str]
    evictable: bool


class CachePlanInfo(BaseModel):
    enabled: bool
    budget_bytes: int
    used_bytes: int
    incoming_bytes: int
    freed_bytes: int
    after_bytes: int
    over: bool
    still_over: bool
    evict: list[CachedBaseInfo]


class ModelCacheInfo(BaseModel):
    enabled: bool
    budget_gb: float
    budget_bytes: int
    used_bytes: int
    evictable_bytes: int
    bases: list[CachedBaseInfo]
    plan: CachePlanInfo


class CacheEstimateRequest(BaseModel):
    size_bytes: int = Field(ge=0)


def base_info(base: CachedBase) -> CachedBaseInfo:
    return CachedBaseInfo(
        key=base.key,
        name=base.name,
        size_bytes=base.size_bytes,
        last_used_at=base.last_used_at,
        pinned=base.pinned,
        kept=list(base.kept),
        evictable=base.evictable,
    )


def plan_info(found: CachePlan) -> CachePlanInfo:
    return CachePlanInfo(
        enabled=found.settings.enabled,
        budget_bytes=found.settings.budget_bytes,
        used_bytes=found.used,
        incoming_bytes=found.incoming,
        freed_bytes=found.freed,
        after_bytes=found.after,
        over=found.over,
        still_over=found.still_over,
        evict=[base_info(base) for base in found.evict],
    )


def settings_info(settings: CacheSettings) -> ModelCacheSettings:
    return ModelCacheSettings(enabled=settings.enabled, budget_gb=settings.budget_gb)


@router.get("/settings/model-cache")
def read_cache_settings(session: SessionDep) -> ModelCacheSettings:
    return settings_info(load_settings(session))


@router.put("/settings/model-cache")
def update_cache_settings(body: ModelCacheSettings, session: SessionDep) -> ModelCacheSettings:
    before = load_settings(session)
    saved = save_settings(session, body.model_dump())
    if saved != before:
        detail = {"from": settings_info(before).model_dump(), "to": settings_info(saved).model_dump()}
        session.add(AuditEvent(actor=current_actor(), action="settings.model_cache", target=KEY, detail=detail))
    session.commit()
    return settings_info(saved)


@router.get("/models/cache")
def model_cache(session: SessionDep) -> ModelCacheInfo:
    settings = load_settings(session)
    bases = cached_bases(session)
    return ModelCacheInfo(
        enabled=settings.enabled,
        budget_gb=settings.budget_gb,
        budget_bytes=settings.budget_bytes,
        used_bytes=sum(base.size_bytes for base in bases),
        evictable_bytes=sum(base.size_bytes for base in bases if base.evictable),
        bases=[base_info(base) for base in bases],
        plan=plan_info(plan(bases, settings)),
    )


@router.post("/models/cache/estimate")
def estimate_download(body: CacheEstimateRequest, session: SessionDep) -> CachePlanInfo:
    return plan_info(estimate(session, body.size_bytes))


@router.post("/models/cache/free")
def free_up_space(session: SessionDep, settings: SettingsDep) -> CachePlanInfo:
    return plan_info(evict(session, settings, "manual", current_actor()))
