from pathlib import Path

from fastapi.testclient import TestClient

from minibrain.app import create_app
from minibrain.settings import Settings
from tests.conftest import FakeBackend, sign_in


def test_dev_ui_url_redirects_pages_but_not_the_api(tmp_path: Path) -> None:
    settings = Settings(home=tmp_path / "home", web_dist=tmp_path / "web", ui_url="http://localhost:5173")
    settings.home.mkdir(parents=True)
    app = create_app(settings=settings, backend=FakeBackend(), background=False)
    with TestClient(app) as client:
        sign_in(app, client)
        page = client.get("/discover?provider=Qwen", follow_redirects=False)
        assert (page.status_code, page.headers["location"]) == (307, "http://localhost:5173/discover?provider=Qwen")
        setup = client.get("/setup?token=abc", follow_redirects=False)
        assert setup.headers["location"] == "http://localhost:5173/setup?token=abc"
        assert client.get("/api/models").status_code == 200
        assert client.get("/api/nothing-here", follow_redirects=False).status_code == 404
