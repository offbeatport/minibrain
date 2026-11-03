from collections.abc import Iterator
from dataclasses import dataclass
from pathlib import Path
from urllib.parse import parse_qs, urlparse

import httpx2
import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from joserfc.jwk import RSAKey
from sqlalchemy import select

from minibrain.app import create_app
from minibrain.auth.config import AuthConfigError, load_auth
from minibrain.auth.first_run import FirstRun, prepare
from minibrain.registry.models import AuditEvent, User
from minibrain.settings import Settings
from tests.conftest import FakeBackend
from tests.fake_oidc import CLIENT_CREDENTIAL, CLIENT_ID, ISSUER, FakeProvider
from tests.test_accounts import csrf
from tests.test_proxy import write_config

OIDC = {
    "issuer": ISSUER,
    "client_id": CLIENT_ID,
    "client_secret": CLIENT_CREDENTIAL,
    "label": "Keycloak",
}
AUTH = {"oidc": OIDC, "roles": {"minibrain-admins": "admin", "ml-team": "builder"}}
ADA = {"sub": "ada-1", "email": "Ada@Example.com", "name": "Ada Lovelace", "groups": ["ml-team"]}


@dataclass
class Sso:
    app: FastAPI
    provider: FakeProvider

    def browser(self) -> TestClient:
        return TestClient(self.app, base_url="https://testserver", follow_redirects=False)

    def users(self) -> list[User]:
        with self.app.state.sessions() as session:
            return list(session.scalars(select(User).order_by(User.id)))

    def events(self, action: str) -> list[AuditEvent]:
        with self.app.state.sessions() as session:
            return list(session.scalars(select(AuditEvent).where(AuditEvent.action == action).order_by(AuditEvent.id)))


def sso_install(settings: Settings, monkeypatch: pytest.MonkeyPatch, auth: dict) -> Iterator[Sso]:
    settings.home.mkdir(parents=True, exist_ok=True)
    write_config(settings.home, monkeypatch, auth)
    app = create_app(settings=settings, backend=FakeBackend(), background=False)
    provider = FakeProvider(claims=dict(ADA))
    app.state.oidc.transport = httpx2.MockTransport(provider.handle)
    with TestClient(app):
        yield Sso(app=app, provider=provider)


@pytest.fixture
def sso(settings: Settings, monkeypatch: pytest.MonkeyPatch) -> Iterator[Sso]:
    yield from sso_install(settings, monkeypatch, AUTH)


def sign_in(sso: Sso, browser: TestClient, next_path: str = "/models") -> str:
    started = browser.get("/api/auth/oidc/start", params={"next": next_path})
    assert started.status_code == 303, started.text
    callback = urlparse(sso.provider.authorize(started.headers["location"]))
    done = browser.get(f"{callback.path}?{callback.query}")
    assert done.status_code == 303
    return done.headers["location"]


def error_of(location: str) -> str:
    assert location.startswith("/?sign_in_error=")
    return parse_qs(urlparse(location).query)["sign_in_error"][0]


def test_single_sign_on_signs_people_in_with_pkce(sso: Sso) -> None:
    browser = sso.browser()
    info = browser.get("/api/auth/session").json()
    assert (info["methods"]["oidc"], info["setup"], info["person"]) == ("Keycloak", False, None)
    started = browser.get("/api/auth/oidc/start", params={"next": "/models"})
    query = parse_qs(urlparse(started.headers["location"]).query)
    assert query["redirect_uri"] == ["https://testserver/api/auth/oidc/callback"]
    assert query["code_challenge_method"] == ["S256"] and query["scope"] == ["openid email profile"]
    callback = urlparse(sso.provider.authorize(started.headers["location"]))
    done = browser.get(f"{callback.path}?{callback.query}")
    assert (done.status_code, done.headers["location"]) == (303, "/models")
    person = browser.get("/api/auth/session").json()["person"]
    assert (person["email"], person["name"], person["source"]) == ("ada@example.com", "Ada Lovelace", "oidc")
    assert (person["role"], person["role_locked"]) == ("builder", True)
    assert browser.get("/api/sources").status_code == 200
    assert browser.post("/api/minibrains", json={"name": "Triage"}, headers=csrf(browser)).status_code == 201
    [user] = sso.users()
    assert (user.source, user.subject, user.groups) == ("oidc", "ada-1", ["ml-team"])
    [signed] = sso.events("auth.sign_in")
    assert (signed.actor, signed.detail["sign_in"]) == ("ada@example.com", "oidc")
    assert all(not url.startswith("http://") for url in sso.provider.calls)


def test_signing_in_again_updates_groups_and_keeps_one_account(sso: Sso) -> None:
    assert sign_in(sso, sso.browser()) == "/models"
    sso.provider.claims["groups"] = ["minibrain-admins"]
    browser = sso.browser()
    assert sign_in(sso, browser, "//evil.example/") == "/"
    assert browser.get("/api/auth/session").json()["person"]["role"] == "admin"
    assert len(sso.users()) == 1 and len(sso.events("account.create")) == 1


@pytest.mark.parametrize(
    ("change", "message"),
    [
        ({"aud": "someone-else"}, "did not verify"),
        ({"iss": "https://other.example.test"}, "did not verify"),
        ({"nonce": "replayed"}, "did not verify"),
        ({"exp": 1_000_000}, "did not verify"),
    ],
)
def test_id_tokens_that_do_not_verify_are_refused(sso: Sso, change: dict, message: str) -> None:
    sso.provider.token_claims = change
    assert message in error_of(sign_in(sso, sso.browser()))
    assert sso.users() == []


def test_a_token_signed_by_another_key_is_refused(sso: Sso) -> None:
    sso.provider.signing_key = RSAKey.generate_key(2048, parameters={"kid": "signing"})
    assert "did not verify" in error_of(sign_in(sso, sso.browser()))


def test_the_callback_needs_the_browser_that_started_it(sso: Sso) -> None:
    started = sso.browser().get("/api/auth/oidc/start")
    callback = urlparse(sso.provider.authorize(started.headers["location"]))
    stranger = sso.browser()
    assert "another browser" in error_of(stranger.get(f"{callback.path}?{callback.query}").headers["location"])
    browser = sso.browser()
    started = browser.get("/api/auth/oidc/start")
    callback = urlparse(sso.provider.authorize(started.headers["location"]))
    forged = callback.query.replace("state=", "state=x")
    assert "does not match" in error_of(browser.get(f"{callback.path}?{forged}").headers["location"])
    refused = browser.get("/api/auth/oidc/callback", params={"error": "access_denied"})
    assert "access_denied" in error_of(refused.headers["location"])
    assert sso.users() == []


def test_a_wrong_pkce_verifier_is_refused_by_the_provider(sso: Sso) -> None:
    browser = sso.browser()
    started = browser.get("/api/auth/oidc/start")
    location = started.headers["location"]
    tampered = location.replace("code_challenge=", "code_challenge=x")
    callback = urlparse(sso.provider.authorize(tampered))
    assert "refused the sign-in" in error_of(browser.get(f"{callback.path}?{callback.query}").headers["location"])


def test_turned_off_people_cannot_sign_in_with_sso(sso: Sso) -> None:
    sign_in(sso, sso.browser())
    with sso.app.state.sessions() as session:
        session.scalars(select(User)).one().disabled = True
        session.commit()
    assert "turned off" in error_of(sign_in(sso, sso.browser()))


def test_unmapped_people_wait_for_an_admin(sso: Sso) -> None:
    sso.provider.claims["groups"] = ["sales"]
    browser = sso.browser()
    sign_in(sso, browser)
    assert browser.get("/api/minibrains").status_code == 403


def test_a_provider_that_names_another_issuer_is_refused(sso: Sso) -> None:
    sso.provider.issuer = "https://impostor.example.test"
    assert "different issuer" in error_of(sso.browser().get("/api/auth/oidc/start").headers["location"])


def test_without_oidc_the_start_route_says_so(settings: Settings) -> None:
    settings.home.mkdir(parents=True)
    app = create_app(settings=settings, backend=FakeBackend(), background=False)
    with TestClient(app, base_url="https://testserver", follow_redirects=False) as client:
        assert "not set up" in error_of(client.get("/api/auth/oidc/start").headers["location"])


def test_oidc_config_is_checked(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    for oidc, message in (
        ({"issuer": "idp.example.test", "client_id": "x"}, "issuer URL"),
        ({"issuer": ISSUER}, "client_id"),
        ({"issuer": ISSUER, "client_id": "x", "scopes": ["email"]}, "openid"),
    ):
        write_config(tmp_path, monkeypatch, {"oidc": oidc})
        with pytest.raises(AuthConfigError, match=message):
            load_auth()
    write_config(tmp_path, monkeypatch, {"oidc": {"issuer": ISSUER, "client_id": "x", "client_secret": "file"}})
    monkeypatch.setenv("MINIBRAIN_OIDC_CLIENT_SECRET", "from-env")
    loaded = load_auth().oidc
    assert loaded is not None and loaded.client_secret == "from-env" and loaded.label == "single sign-on"


def test_an_sso_group_mapped_to_admin_needs_no_setup_link(sso: Sso) -> None:
    with sso.app.state.sessions() as session:
        assert prepare(session, load_auth(), {}) == FirstRun()
    assert sso.browser().get("/api/auth/session").json()["setup"] is False


def test_sso_without_an_admin_group_gets_a_setup_link(settings: Settings, monkeypatch: pytest.MonkeyPatch) -> None:
    for sso in sso_install(settings, monkeypatch, {"oidc": OIDC, "roles": {"ml-team": "builder"}}):
        with sso.app.state.sessions() as session:
            found = prepare(session, load_auth(), {})
        assert found.token is not None
        assert sso.browser().get("/api/auth/session").json()["setup"] is True


def test_sso_with_admin_as_the_default_role_needs_no_setup_link(
    settings: Settings, monkeypatch: pytest.MonkeyPatch
) -> None:
    for sso in sso_install(settings, monkeypatch, {"oidc": OIDC, "default_role": "admin"}):
        with sso.app.state.sessions() as session:
            assert prepare(session, load_auth(), {}) == FirstRun()
