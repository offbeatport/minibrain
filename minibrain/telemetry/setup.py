from typing import Any

from sqlalchemy.orm import Session, sessionmaker

from minibrain.connections.vault import unseal
from minibrain.policy import PolicyError
from minibrain.policy import load as load_policy
from minibrain.settings import Settings
from minibrain.telemetry.instruments import Gauges
from minibrain.telemetry.prometheus import MetricsAccess
from minibrain.telemetry.runtime import Telemetry
from minibrain.telemetry.target import OtlpTarget, TargetError, configured_values, target_of, warn_once


def main_telemetry(sessions: sessionmaker[Session], settings: Settings, access: MetricsAccess) -> Telemetry:
    def values() -> dict[str, Any]:
        try:
            with sessions() as session:
                return load_policy(session).values
        except PolicyError as error:
            raise TargetError(str(error)) from error

    def resolve() -> OtlpTarget | None:
        return target_of(values(), lambda token, context: unseal(settings, token, context))

    return Telemetry(warn_once(resolve), Gauges(sessions), scraped=access.enabled)


def gateway_telemetry(access: MetricsAccess) -> Telemetry:
    return Telemetry(warn_once(lambda: target_of(configured_values())), scraped=access.enabled)
