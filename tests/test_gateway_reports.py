from fastapi.testclient import TestClient

from minibrain.app import create_app
from minibrain.registry.compute import live_gateways
from minibrain.settings import Settings
from tests.conftest import FakeBackend


def test_a_main_that_stops_cleanly_leaves_no_gateway_report_behind(settings: Settings) -> None:
    settings.home.mkdir(parents=True)
    app = create_app(settings=settings, backend=FakeBackend(), background=False, config_max_age=0)
    with TestClient(app):
        app.state.gateway_config.rebuild()
        with app.state.sessions() as session:
            assert [gateway.id for gateway in live_gateways(session)] == [app.state.gateway_config.id]
    with app.state.sessions() as session:
        assert live_gateways(session) == []
