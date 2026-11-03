from collections.abc import Iterator
from dataclasses import dataclass
from pathlib import Path

import pytest
import yaml
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import select

from minibrain.app import create_app
from minibrain.auth.accounts import create_local
from minibrain.auth.config import AuthConfigError, load_auth
from minibrain.auth.roles import Role
from minibrain.registry.models import AuditEvent, User
from minibrain.settings import Settings
from tests.conftest import FakeBackend
from tests.test_accounts import ADMIN, PASSWORD, csrf

PROXY = "10.0.0.2"
STRANGER = "198.51.100.7"
AUTH = {
    "proxy": {"addresses": ["10.0.0.0/30"]},
    "roles": {"minibrain-admins": "admin", "ML-Team": "builder"},
}


@dataclass
class Proxied:
    settings: Settings
    app: FastAPI

    def client(self, address: str = PROXY) -> TestClient:
        return TestClient(self.app, base_url="https://testserver", client=(address, 41000))

    def users(self) -> list[User]:
        with self.app.state.sessions() as session:
            return list(session.scalars(select(User).order_by(User.id)))

    def events(self, action: str) -> list[AuditEvent]:
        with self.app.state.sessions() as session:
            query = select(AuditEvent).where(AuditEvent.action == action).order_by(AuditEvent.id)
            return list(session.scalars(query))


def write_config(home: Path, monkeypatch: pytest.MonkeyPatch, auth: dict, policy: dict | None = None) -> None:
    path = home / "minibrain.yaml"
    path.write_text(yaml.safe_dump({"auth": auth} | ({"policy": policy} if policy else {})))
    monkeypatch.setenv("MINIBRAIN_CONFIG", str(path))


def proxied_install(settings: Settings, monkeypatch: pytest.MonkeyPatch, auth: dict) -> Iterator[Proxied]:
    settings.home.mkdir(parents=True, exist_ok=True)
    write_config(settings.home, monkeypatch, auth)
    app = create_app(settings=settings, backend=FakeBackend(), background=False, config_max_age=0)
    with TestClient(app):
        yield Proxied(settings=settings, app=app)


@pytest.fixture
def proxied(settings: Settings, monkeypatch: pytest.MonkeyPatch) -> Iterator[Proxied]:
    yield from proxied_install(settings, monkeypatch, AUTH)


def as_person(user: str, email: str | None = None, groups: str | None = None) -> dict[str, str]:
    headers = {"X-Forwarded-User": user}
    if email:
        headers["X-Forwarded-Email"] = email
    if groups is not None:
        headers["X-Forwarded-Groups"] = groups
    return headers


def test_proxy_headers_sign_people_in_and_map_their_groups(proxied: Proxied) -> None:
    client = proxied.client()
    admin = as_person("ada", "Ada@Example.com", "staff, minibrain-admins")
    info = client.get("/api/auth/session", headers=admin).json()
    assert info["methods"]["proxy"] is True
    assert info["person"] | {"id": None} == {
        "id": None,
        "name": "ada",
        "email": "ada@example.com",
        "source": "proxy",
        "role": "admin",
        "role_locked": True,
    }
    assert client.get("/api/policies", headers=admin).status_code == 200
    builder = as_person("bea", "bea@example.com", "ml-team")
    assert client.get("/api/sources", headers=builder).status_code == 200
    assert client.get("/api/policies", headers=builder).status_code == 403
    assert [(user.subject, user.source, user.groups) for user in proxied.users()] == [
        ("ada", "proxy", ["staff", "minibrain-admins"]),
        ("bea", "proxy", ["ml-team"]),
    ]
    assert [(event.actor, event.detail["sign_in"]) for event in proxied.events("auth.sign_in")] == [
        ("ada@example.com", "proxy"),
        ("bea@example.com", "proxy"),
    ]
    assert [event.actor for event in proxied.events("account.create")] == ["ada@example.com", "bea@example.com"]


def test_proxy_headers_from_anywhere_else_are_ignored(proxied: Proxied) -> None:
    stranger = proxied.client(STRANGER)
    forged = as_person("ada", "ada@example.com", "minibrain-admins")
    assert stranger.get("/api/minibrains", headers=forged).status_code == 401
    assert stranger.get("/api/auth/session", headers=forged).json()["person"] is None
    assert proxied.users() == []


def test_a_proxy_without_a_user_header_falls_back_to_sign_in(proxied: Proxied) -> None:
    client = proxied.client()
    assert client.get("/api/minibrains").status_code == 401
    info = client.get("/api/auth/session").json()
    assert (info["setup"], info["person"]) == (False, None)


def test_unmapped_people_get_the_default_role(settings: Settings, monkeypatch: pytest.MonkeyPatch) -> None:
    for proxied in proxied_install(settings, monkeypatch, AUTH):
        client = proxied.client()
        nobody = as_person("nia", "nia@example.com", "sales")
        refused = client.get("/api/minibrains", headers=nobody)
        assert refused.status_code == 403 and "Ask an admin" in refused.json()["detail"]
        person = client.get("/api/auth/session", headers=nobody).json()["person"]
        assert (person["role"], person["role_locked"]) == (None, False)
        admin = as_person("ada", groups="minibrain-admins")
        changed = client.put("/api/policies/default_role", json={"value": "viewer"}, headers=admin)
        assert changed.status_code == 403
        headers = admin | csrf_for(client, admin)
        assert client.put("/api/policies/default_role", json={"value": "viewer"}, headers=headers).status_code == 200
        assert client.get("/api/minibrains", headers=nobody).status_code == 200
        assert client.get("/api/sources", headers=nobody).status_code == 403


def csrf_for(client: TestClient, headers: dict[str, str]) -> dict[str, str]:
    return {"X-CSRF-Token": client.get("/api/auth/session", headers=headers).json()["csrf_token"]}


def test_proxy_people_need_the_csrf_token_too(proxied: Proxied) -> None:
    client = proxied.client()
    builder = as_person("bea", groups="ml-team")
    assert client.post("/api/minibrains", json={"name": "Triage"}, headers=builder).status_code == 403
    token = csrf_for(client, builder)
    assert client.post("/api/minibrains", json={"name": "Triage"}, headers=builder | token).status_code == 201
    other = as_person("cy", groups="ml-team")
    assert client.post("/api/minibrains", json={"name": "Other"}, headers=other | token).status_code == 403


def test_admins_set_roles_unless_groups_decide(proxied: Proxied) -> None:
    client = proxied.client()
    admin = as_person("ada", groups="minibrain-admins")
    client.get("/api/auth/session", headers=as_person("nia", groups="sales"))
    people = client.get("/api/accounts", headers=admin).json()
    assert people["mapping"] == [
        {"group": "minibrain-admins", "role": "admin"},
        {"group": "ml-team", "role": "builder"},
    ]
    assert (people["default_role"], people["default_role_locked"]) == ("none", False)
    assert people["proxy_addresses"] == ["10.0.0.0/30"]
    ids = {person["name"]: person["id"] for person in people["people"]}
    headers = admin | csrf_for(client, admin)
    given = client.patch(f"/api/accounts/{ids['nia']}", json={"role": "builder"}, headers=headers)
    assert given.status_code == 200 and given.json()["role"] == "builder"
    assert client.get("/api/sources", headers=as_person("nia", groups="sales")).status_code == 200
    locked = client.patch(f"/api/accounts/{ids['ada']}", json={"role": "viewer"}, headers=headers)
    assert locked.status_code == 422 and "minibrain.yaml" in locked.json()["detail"]


def test_turned_off_proxy_people_are_refused(proxied: Proxied) -> None:
    client = proxied.client()
    admin = as_person("ada", groups="minibrain-admins")
    bea = as_person("bea", groups="ml-team")
    assert client.get("/api/minibrains", headers=bea).status_code == 200
    bea_id = client.get("/api/auth/session", headers=bea).json()["person"]["id"]
    headers = admin | csrf_for(client, admin)
    assert client.patch(f"/api/accounts/{bea_id}", json={"disabled": True}, headers=headers).status_code == 200
    refused = client.get("/api/minibrains", headers=bea)
    assert refused.status_code == 403 and "turned off" in refused.json()["detail"]


def test_forwarded_addresses_count_only_from_the_proxy(proxied: Proxied) -> None:
    admin = as_person("ada", groups="minibrain-admins")
    through = proxied.client()
    headers = admin | {"X-Forwarded-For": "203.0.113.5, 10.0.0.1", "X-Forwarded-Proto": "https"}
    headers |= csrf_for(through, headers)
    assert through.put("/api/policies/request_logs", json={"value": False}, headers=headers).status_code == 200
    stranger = proxied.client(STRANGER)
    set_up_admin(proxied, stranger)
    token = csrf(stranger)
    spoofed = {"X-Forwarded-For": "203.0.113.99"} | token
    assert stranger.put("/api/policies/request_logs", json={"value": True}, headers=spoofed).status_code == 200
    events = proxied.events("policy.update")
    assert [event.ip for event in events] == ["203.0.113.5", STRANGER]


def set_up_admin(proxied: Proxied, client: TestClient) -> None:
    with proxied.app.state.sessions() as session:
        create_local(session, ADMIN, "Ada", Role.ADMIN, PASSWORD)
        session.commit()
    response = client.post("/api/auth/login", json={"email": ADMIN, "password": PASSWORD})
    assert response.status_code == 200, response.text


def test_local_accounts_still_work_behind_the_proxy(proxied: Proxied) -> None:
    client = proxied.client(STRANGER)
    set_up_admin(proxied, client)
    assert client.get("/api/minibrains").status_code == 200
    assert client.get("/api/auth/session").json()["person"]["source"] == "local"


def test_auth_config_is_checked(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    for auth, message in (
        ({"proxy": {"addresses": []}}, "cannot be empty"),
        ({"proxy": {"addresses": ["not-an-ip"]}}, "not an address"),
        ({"roles": {"ops": "owner"}}, "not viewer, builder or admin"),
        ({"proxy": {"addresses": ["10.0.0.1"], "user_header": "X Forwarded"}}, "header name"),
    ):
        write_config(tmp_path, monkeypatch, auth)
        with pytest.raises(AuthConfigError, match=message):
            load_auth()
    write_config(tmp_path, monkeypatch, {"default_role": "viewer"})
    assert load_auth().proxy is None


def test_default_role_set_in_the_config_file_is_locked(settings: Settings, monkeypatch: pytest.MonkeyPatch) -> None:
    for proxied in proxied_install(settings, monkeypatch, AUTH | {"default_role": "viewer"}):
        client = proxied.client()
        nobody = as_person("nia", groups="sales")
        assert client.get("/api/minibrains", headers=nobody).status_code == 200
        admin = as_person("ada", groups="minibrain-admins")
        headers = admin | csrf_for(client, admin)
        refused = client.put("/api/policies/default_role", json={"value": "none"}, headers=headers)
        assert refused.status_code == 409
        people = client.get("/api/accounts", headers=admin).json()
        assert (people["default_role"], people["default_role_locked"]) == ("viewer", True)
