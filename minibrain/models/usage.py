from datetime import timedelta

from sqlalchemy.orm import Session

from minibrain.registry.models import Model, now

TOUCH_EVERY = timedelta(minutes=5)


def touch(session: Session, key: str) -> None:
    model = session.get(Model, key)
    if model is None:
        return
    moment = now()
    if model.last_used_at is None or moment - model.last_used_at >= TOUCH_EVERY:
        model.last_used_at = moment
