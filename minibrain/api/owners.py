from typing import Any

from sqlalchemy import ColumnElement, and_, case, exists, false, literal, or_, select

from minibrain.registry.models import BaseModel, Model, RequestLog

DELETED = "deleted:"


def split_token(token: str) -> tuple[str, bool]:
    return (token.removeprefix(DELETED), True) if token.startswith(DELETED) else (token, False)


def custom_owned(slug: Any, model_id: Any, token: str) -> ColumnElement[bool]:
    key, deleted = split_token(token)
    if deleted:
        return and_(slug == key, model_id.is_(None))
    return and_(slug == key, or_(model_id.is_not(None), ~exists().where(Model.slug == key)))


def custom_token(slug: Any, model_id: Any) -> ColumnElement[Any]:
    held = and_(model_id.is_(None), slug.in_(select(Model.slug)))
    return case((held, literal(DELETED) + slug), else_=slug)


def base_added(key: Any) -> Any:
    return select(BaseModel.created_at).where(BaseModel.id == key).scalar_subquery()


def base_owned(token: str) -> ColumnElement[bool]:
    key, deleted = split_token(token)
    served = and_(RequestLog.model_slug.is_(None), RequestLog.model == key)
    added = base_added(key)
    if deleted:
        return and_(served, RequestLog.at < added)
    return and_(served, or_(added.is_(None), RequestLog.at >= added))


def base_token() -> ColumnElement[Any]:
    earlier = RequestLog.at < base_added(RequestLog.model)
    return case(
        (RequestLog.model_slug.is_not(None), None),
        (earlier, literal(DELETED) + RequestLog.model),
        else_=RequestLog.model,
    )


def log_owned(tokens: list[str]) -> ColumnElement[bool]:
    chosen = [
        or_(custom_owned(RequestLog.model_slug, RequestLog.model_id, token), base_owned(token)) for token in tokens
    ]
    return or_(*chosen) if chosen else false()


def log_custom_token() -> ColumnElement[Any]:
    return custom_token(RequestLog.model_slug, RequestLog.model_id)
