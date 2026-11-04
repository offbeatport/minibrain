import io
import logging
from collections.abc import Iterator
from dataclasses import dataclass
from datetime import timedelta
from pathlib import Path
from types import SimpleNamespace
from typing import Any, cast

import pytest
import uvicorn
from alembic import command
from fastapi.testclient import TestClient
from sqlalchemy import inspect, select, text, update
from sqlalchemy.orm import Session, sessionmaker

from minibrain import cli
from minibrain.app import create_app
from minibrain.auth.accounts import LOCK_AFTER, SESSION_COOKIE
from minibrain.auth.addresses import loopback_name
from minibrain.auth.config import AuthConfig
from minibrain.auth.first_run import (
    SETUP_KEY,
    FirstRun,
    FirstRunError,
    issue_setup_token,
    prepare,
    setup_pending,
)
from minibrain.auth.passwords import hash_password, verify_password
from minibrain.registry.db import make_engine, make_sessions, migrate
from minibrain.registry.models import ApiKey, AuditEvent, LoginSession, Setting, User, now
from minibrain.settings import Settings
from tests.conftest import ADMIN_EMAIL, FakeBackend, Harness
from tests.test_data_catalogue import columns_of, migration_config

PASSWORD = "correct horse battery"
ADMIN = "ada@example.com"


@dataclass
class Install:
    client: TestClient
    sessions: sessionmaker[Session]
    settings: Settings

    def browser(self, base_url: str = "https://testserver") -> TestClient:
        return TestClient(self.client.app, base_url=base_url)

    def events(self, prefix: str) -> list[AuditEvent]:
        with self.sessions() as session:
            query = select(AuditEvent).where(AuditEvent.action.startswith(prefix)).order_by(AuditEvent.id)
            return list(session.scalars(query))

    def setup_token(self) -> str:
        with self.sessions() as session:
            token = issue_setup_token(session, "pytest")
            session.commit()
        return token


def start(settings: Settings) -> Iterator[Install]:
    settings.home.mkdir(parents=True, exist_ok=True)
    app = create_app(settings=settings, backend=FakeBackend(), background=False, config_max_age=0)
    with TestClient(app, base_url="https://testserver") as client:
        yield Install(client=client, sessions=app.state.sessions, settings=settings)


@pytest.fixture
def install(settings: Settings) -> Iterator[Install]:
    yield from start(settings)


def csrf(client: TestClient) -> dict[str, str]:
    token = client.get("/api/auth/session").json()["csrf_token"]
    return {"X-CSRF-Token": token}


def set_up(install: Install, client: TestClient | None = None) -> TestClient:
    browser = client or install.client
    body = {"token": install.setup_token(), "email": ADMIN, "name": "Ada Lovelace", "password": PASSWORD}
    response = browser.post("/api/auth/setup", json=body)
    assert response.status_code == 200, response.text
    return browser


def invite(admin: TestClient, email: str, role: str = "builder") -> dict[str, Any]:
    response = admin.post("/api/accounts", json={"email": email, "name": email, "role": role}, headers=csrf(admin))
    assert response.status_code == 201, response.text
    return response.json()


def redeem(install: Install, link: dict[str, Any], password: str = PASSWORD) -> TestClient:
    browser = install.browser()
    token = link["path"].split("#token=", 1)[1]
    response = browser.post("/api/auth/reset", json={"token": token, "password": password})
    assert response.status_code == 200, response.text
    return browser


def test_everyone_signs_in_even_on_loopback(install: Install) -> None:
    for base in ("http://127.0.0.1:8000", "http://localhost:5173", "https://testserver"):
        browser = install.browser(base)
        info = browser.get("/api/auth/session").json()
        assert (info["setup"], info["person"], info["csrf_token"]) == (True, None, None)
        refused = browser.get("/api/minibrains")
        assert refused.status_code == 401 and refused.json()["detail"] == "Sign in to use minibrain"
        assert browser.post("/api/minibrains", json={"name": "Triage"}).status_code == 401


def test_setup_needs_the_one_time_token(install: Install) -> None:
    body = {"email": ADMIN, "name": "Ada Lovelace", "password": PASSWORD}
    missing = install.client.post("/api/auth/setup", json=body | {"token": "guess"})
    assert missing.status_code == 403 and "minibrain admin setup-link" in missing.json()["detail"]
    old = install.setup_token()
    token = install.setup_token()
    assert install.client.post("/api/auth/setup", json=body | {"token": old}).status_code == 403
    weak = install.client.post("/api/auth/setup", json=body | {"token": token, "password": "short"})
    assert weak.status_code == 422
    with install.sessions() as session:
        assert session.scalars(select(User)).all() == [] and setup_pending(session)
    assert install.client.post("/api/auth/setup", json=body | {"token": token}).status_code == 200
    with install.sessions() as session:
        assert not setup_pending(session)
        stored = [row.value for row in session.scalars(select(Setting).where(Setting.key == SETUP_KEY))]
        assert stored == []
    again = install.browser().post("/api/auth/setup", json=body | {"token": token, "email": "eve@example.com"})
    assert again.status_code == 409
    assert [event.actor for event in install.events("auth.setup_link")] == ["pytest", "pytest"]


def test_the_setup_token_is_kept_as_its_sha256(install: Install) -> None:
    token = install.setup_token()
    with install.sessions() as session:
        stored = session.get(Setting, SETUP_KEY)
        assert stored is not None and token not in str(stored.value) and len(stored.value["sha256"]) == 64


@pytest.mark.parametrize(
    ("base", "headers", "secure"),
    [
        ("http://127.0.0.1:8000", {}, False),
        ("http://localhost:8000", {}, False),
        ("http://[::1]:8000", {}, False),
        ("http://localhost:8000", {"Origin": "https://minibrain.corp"}, True),
        ("https://testserver", {}, True),
        ("http://10.0.0.5:8000", {}, True),
    ],
)
def test_the_session_cookie_is_secure_except_on_plain_http_loopback(
    install: Install, base: str, headers: dict[str, str], secure: bool
) -> None:
    body = {"token": install.setup_token(), "email": ADMIN, "password": PASSWORD}
    response = install.browser(base).post("/api/auth/setup", json=body, headers=headers)
    assert response.status_code == 200, response.text
    cookie = response.headers["set-cookie"]
    assert cookie.startswith(f"{SESSION_COOKIE}=") and "HttpOnly" in cookie and "SameSite=lax" in cookie
    assert ("Secure" in cookie) is secure


def test_loopback_names() -> None:
    assert [loopback_name(host) for host in ("localhost", "app.localhost", "127.0.0.2", "::1")] == [True] * 4
    assert [loopback_name(host) for host in ("::", "example.com", "10.0.0.1", None)] == [False] * 4


def test_first_run_creates_the_admin_and_signs_them_in(install: Install) -> None:
    admin = set_up(install)
    cookie = admin.cookies.get(SESSION_COOKIE)
    assert cookie
    info = admin.get("/api/auth/session").json()
    assert info["person"]["email"] == ADMIN and info["person"]["role"] == "admin" and not info["setup"]
    assert len(info["csrf_token"]) == 64
    with install.sessions() as session:
        user = session.scalars(select(User)).one()
        stored = session.scalars(select(LoginSession)).one()
        assert user.password_hash and user.password_hash.startswith("pbkdf2-sha256$600000$")
        assert PASSWORD not in user.password_hash
        assert stored.token_hash != cookie and len(stored.token_hash) == 64
    body = {"token": "x", "email": "eve@example.com", "password": PASSWORD}
    assert install.browser().post("/api/auth/setup", json=body).status_code == 409
    [created] = install.events("account.create")
    assert (created.actor, created.detail["first_admin"], created.detail["via"]) == (ADMIN, True, "setup link")
    [signed] = install.events("auth.sign_in")
    assert (signed.actor, signed.detail["sign_in"]) == (ADMIN, "local")


def test_setup_checks_the_password_and_email(install: Install) -> None:
    token = install.setup_token()
    short = install.client.post("/api/auth/setup", json={"token": token, "email": ADMIN, "password": "short"})
    assert short.status_code == 422 and "12 characters" in short.json()["detail"]
    body = {"token": token, "email": "not an email", "password": PASSWORD}
    assert install.client.post("/api/auth/setup", json=body).status_code == 422
    with install.sessions() as session:
        assert session.scalars(select(User)).all() == []


def test_state_changing_calls_need_the_csrf_token(install: Install) -> None:
    admin = set_up(install)
    refused = admin.post("/api/minibrains", json={"name": "Triage"})
    assert refused.status_code == 403 and "CSRF" in refused.json()["detail"]
    wrong = admin.post("/api/minibrains", json={"name": "Triage"}, headers={"X-CSRF-Token": "0" * 64})
    assert wrong.status_code == 403
    assert admin.get("/api/minibrains").status_code == 200
    created = admin.post("/api/minibrains", json={"name": "Triage"}, headers=csrf(admin))
    assert created.status_code == 201
    assert admin.delete("/api/minibrains/triage", headers=csrf(admin)).status_code == 202
    [event] = install.events("model.delete")
    assert (event.actor, event.detail["sign_in"]) == (ADMIN, "local")


def test_the_csrf_token_belongs_to_one_session(install: Install) -> None:
    admin = set_up(install)
    first = csrf(admin)
    other = install.browser()
    assert other.post("/api/auth/login", json={"email": ADMIN, "password": PASSWORD}).status_code == 200
    assert csrf(other) != first
    assert other.post("/api/minibrains", json={"name": "Triage"}, headers=first).status_code == 403


def test_sign_in_and_out(install: Install) -> None:
    set_up(install, install.browser())
    browser = install.browser()
    wrong = browser.post("/api/auth/login", json={"email": ADMIN, "password": "not the password"})
    assert wrong.status_code == 401 and wrong.json()["detail"] == "Wrong email or password"
    unknown = browser.post("/api/auth/login", json={"email": "nobody@example.com", "password": PASSWORD})
    assert unknown.status_code == 401 and unknown.json()["detail"] == "Wrong email or password"
    signed = browser.post("/api/auth/login", json={"email": " ADA@example.com ", "password": PASSWORD})
    assert signed.status_code == 200 and signed.json()["person"]["email"] == ADMIN
    assert browser.get("/api/minibrains").status_code == 200
    assert browser.post("/api/auth/logout").status_code == 403
    assert browser.post("/api/auth/logout", headers=csrf(browser)).status_code == 204
    assert browser.get("/api/minibrains").status_code == 401
    failed = install.events("auth.sign_in_failed")
    assert [(event.actor, event.detail["sign_in"]) for event in failed] == [
        (ADMIN, "local"),
        ("nobody@example.com", "local"),
    ]
    assert [event.actor for event in install.events("auth.sign_out")] == [ADMIN]


def test_a_signed_out_cookie_stops_working(install: Install) -> None:
    admin = set_up(install)
    stolen = admin.cookies.get(SESSION_COOKIE)
    assert admin.post("/api/auth/logout", headers=csrf(admin)).status_code == 204
    replay = install.browser()
    replay.cookies.set(SESSION_COOKIE, stolen or "")
    assert replay.get("/api/minibrains").status_code == 401


def test_repeated_failures_lock_the_account_for_a_while(install: Install) -> None:
    set_up(install, install.browser())
    browser = install.browser()
    for _ in range(LOCK_AFTER):
        assert (
            browser.post("/api/auth/login", json={"email": ADMIN, "password": "guess guess guess"}).status_code == 401
        )
    locked = browser.post("/api/auth/login", json={"email": ADMIN, "password": PASSWORD})
    assert locked.status_code == 401 and "Too many failed sign-ins" in locked.json()["detail"]
    with install.sessions() as session:
        session.execute(update(User).values(locked_until=now() - timedelta(seconds=1)))
        session.commit()
    assert browser.post("/api/auth/login", json={"email": ADMIN, "password": PASSWORD}).status_code == 200


def test_sessions_end_after_the_idle_and_absolute_lifetimes(install: Install) -> None:
    admin = set_up(install)
    with install.sessions() as session:
        session.execute(update(LoginSession).values(last_seen_at=now() - timedelta(minutes=31)))
        session.commit()
    assert admin.get("/api/minibrains").status_code == 401
    browser = install.browser()
    assert browser.post("/api/auth/login", json={"email": ADMIN, "password": PASSWORD}).status_code == 200
    with install.sessions() as session:
        session.execute(update(LoginSession).values(created_at=now() - timedelta(hours=13)))
        session.commit()
    assert browser.get("/api/minibrains").status_code == 401
    with install.sessions() as session:
        assert session.scalars(select(LoginSession)).all() == []


def test_admins_invite_people_with_a_one_time_link(install: Install) -> None:
    admin = set_up(install)
    link = invite(admin, "bea@example.com", "builder")
    assert link["path"].startswith("/reset-password#token=")
    assert (link["account"]["role"], link["account"]["password_set"], link["account"]["link_pending"]) == (
        "builder",
        False,
        True,
    )
    blank = install.browser().post("/api/auth/login", json={"email": "bea@example.com", "password": ""})
    assert blank.status_code == 401
    bea = redeem(install, link)
    assert bea.get("/api/auth/session").json()["person"]["role"] == "builder"
    used = install.browser().post(
        "/api/auth/reset", json={"token": link["path"].split("=", 1)[1], "password": PASSWORD}
    )
    assert used.status_code == 422 and "expired or was already used" in used.json()["detail"]
    people = admin.get("/api/accounts").json()["people"]
    assert [(person["email"], person["role"], person["password_set"]) for person in people] == [
        (ADMIN, "admin", True),
        ("bea@example.com", "builder", True),
    ]
    duplicate = admin.post("/api/accounts", json={"email": "BEA@example.com", "role": "viewer"}, headers=csrf(admin))
    assert duplicate.status_code == 409
    [created] = install.events("account.create")[1:]
    assert (created.actor, created.target, created.detail["role"], created.detail["sign_in"]) == (
        ADMIN,
        "bea@example.com",
        "builder",
        "local",
    )


def test_a_reset_link_replaces_the_password_and_ends_old_sessions(install: Install) -> None:
    admin = set_up(install)
    bea = redeem(install, invite(admin, "bea@example.com"))
    account = next(person for person in admin.get("/api/accounts").json()["people"] if person["email"] != ADMIN)
    link = admin.post(f"/api/accounts/{account['id']}/password-link", headers=csrf(admin)).json()
    assert bea.get("/api/minibrains").status_code == 200
    redeem(install, link, "a brand new passphrase")
    assert bea.get("/api/minibrains").status_code == 401
    old = install.browser().post("/api/auth/login", json={"email": "bea@example.com", "password": PASSWORD})
    assert old.status_code == 401
    with install.sessions() as session:
        session.execute(update(User).values(reset_expires_at=now() - timedelta(seconds=1)))
        session.commit()
    expired_link = admin.post(f"/api/accounts/{account['id']}/password-link", headers=csrf(admin)).json()
    with install.sessions() as session:
        session.execute(update(User).where(User.id == account["id"]).values(reset_expires_at=now()))
        session.commit()
    token = expired_link["path"].split("#token=", 1)[1]
    late = install.browser().post("/api/auth/reset", json={"token": token, "password": PASSWORD})
    assert late.status_code == 422
    assert [event.action for event in install.events("account.")] == [
        "account.create",
        "account.create",
        "account.password",
        "account.reset",
        "account.password",
        "account.reset",
    ]


def test_turning_an_account_off_ends_its_sessions_at_once(install: Install) -> None:
    admin = set_up(install)
    bea = redeem(install, invite(admin, "bea@example.com"))
    bea_id = bea.get("/api/auth/session").json()["person"]["id"]
    off = admin.patch(f"/api/accounts/{bea_id}", json={"disabled": True}, headers=csrf(admin))
    assert off.status_code == 200 and off.json()["disabled"] is True and off.json()["sessions"] == 0
    assert bea.get("/api/minibrains").status_code == 401
    refused = install.browser().post("/api/auth/login", json={"email": "bea@example.com", "password": PASSWORD})
    assert refused.status_code == 401 and "turned off" in refused.json()["detail"]
    on = admin.patch(f"/api/accounts/{bea_id}", json={"disabled": False, "role": "viewer"}, headers=csrf(admin))
    assert (on.json()["disabled"], on.json()["role"]) == (False, "viewer")
    [_, changed] = install.events("account.update")
    assert changed.detail["from"] == {"role": "builder", "disabled": True}
    assert changed.detail["to"] == {"role": "viewer", "disabled": False}


def test_the_last_admin_stays(install: Install) -> None:
    admin = set_up(install)
    me = admin.get("/api/auth/session").json()["person"]["id"]
    myself = admin.patch(f"/api/accounts/{me}", json={"disabled": True}, headers=csrf(admin))
    assert myself.status_code == 422 and "your own account" in myself.json()["detail"]
    demoted = admin.patch(f"/api/accounts/{me}", json={"role": "builder"}, headers=csrf(admin))
    assert demoted.status_code == 422 and "at least one admin" in demoted.json()["detail"]
    other = redeem(install, invite(admin, "cy@example.com", "admin"))
    assert other.patch(f"/api/accounts/{me}", json={"role": "builder"}, headers=csrf(other)).status_code == 200


def test_signed_in_people_are_recorded_on_reviews_and_keys(install: Install) -> None:
    admin = set_up(install)
    headers = csrf(admin)
    assert admin.post("/api/minibrains", json={"name": "Triage"}, headers=headers).status_code == 201
    body = {"name": "app", "models": [{"kind": "custom", "key": "triage"}]}
    key = admin.post("/api/keys", json=body, headers=headers)
    assert key.status_code == 201
    with install.sessions() as session:
        assert session.scalars(select(ApiKey.created_by)).one() == ADMIN
    body = {"rating": "down", "input": "charged twice", "output": "bug", "version": 0}
    item = admin.post("/api/minibrains/triage/feedback", json=body, headers=headers).json()
    assigned = admin.post(f"/api/feedback/{item['id']}/assign", json={"mine": True}, headers=headers).json()
    assert assigned["assignee"] == ADMIN
    mine = admin.get("/api/feedback", params={"assignee": "me"}).json()
    assert [entry["id"] for entry in mine["items"]] == [item["id"]]


def run_cli(monkeypatch: pytest.MonkeyPatch, *args: str, stdin: str = "") -> None:
    monkeypatch.setattr("sys.stdin", io.StringIO(stdin))
    monkeypatch.setattr("sys.argv", ["minibrain", *args])
    cli.main()


@pytest.fixture
def home(settings: Settings, monkeypatch: pytest.MonkeyPatch) -> Settings:
    settings.home.mkdir(parents=True)
    monkeypatch.setenv("MINIBRAIN_HOME", str(settings.home))
    monkeypatch.delenv("MINIBRAIN_DATABASE_URL", raising=False)
    monkeypatch.delenv("MINIBRAIN_UI_URL", raising=False)
    return settings


def test_admin_create_on_the_command_line(
    home: Settings, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    create = ("admin", "create", "--email", ADMIN, "--password-stdin")
    run_cli(monkeypatch, *create, stdin=f"{PASSWORD}\n")
    assert "Created the admin account ada@example.com" in capsys.readouterr().out
    with pytest.raises(SystemExit, match="already has an account"):
        run_cli(monkeypatch, *create, stdin=f"{PASSWORD}\n")
    with pytest.raises(SystemExit, match="12 characters"):
        run_cli(monkeypatch, *create, stdin="short\n")
    for install in start(home):
        browser = install.browser()
        assert browser.post("/api/auth/login", json={"email": ADMIN, "password": PASSWORD}).status_code == 200
        [created] = install.events("account.create")
        assert (created.actor, created.detail["via"]) == ("command line", "command line")


def test_reset_password_on_the_command_line(
    home: Settings, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    run_cli(monkeypatch, "admin", "create", "--email", ADMIN, "--password-stdin", stdin=f"{PASSWORD}\n")
    for install in start(home):
        browser = install.browser()
        assert browser.post("/api/auth/login", json={"email": ADMIN, "password": PASSWORD}).status_code == 200
        with install.sessions() as session:
            session.execute(update(User).values(locked_until=now() + timedelta(minutes=10)))
            session.commit()
        reset = ("admin", "reset-password", "--email", " ADA@example.com ", "--password-stdin")
        run_cli(monkeypatch, *reset, stdin="a brand new passphrase\n")
        assert "Set a new password for ada@example.com" in capsys.readouterr().out
        assert browser.get("/api/minibrains").status_code == 401
        old = install.browser().post("/api/auth/login", json={"email": ADMIN, "password": PASSWORD})
        assert old.status_code == 401
        new = install.browser().post("/api/auth/login", json={"email": ADMIN, "password": "a brand new passphrase"})
        assert new.status_code == 200
        [changed] = install.events("account.password")
        assert (changed.actor, changed.target, changed.detail["via"]) == ("command line", ADMIN, "command line")
    with pytest.raises(SystemExit, match="no local account"):
        run_cli(monkeypatch, "admin", "reset-password", "--email", "bea@example.com", stdin=f"{PASSWORD}\n")


def test_setup_link_on_the_command_line(
    home: Settings, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    run_cli(monkeypatch, "admin", "setup-link")
    first = capsys.readouterr().out
    assert "http://127.0.0.1:8000/setup?token=" in first and "Earlier setup links no longer work" in first
    run_cli(monkeypatch, "admin", "setup-link", "--url", "https://minibrain.corp/")
    second = capsys.readouterr().out
    old = first.split("token=", 1)[1].split()[0]
    token = second.split("https://minibrain.corp/setup?token=", 1)[1].split()[0]
    for install in start(home):
        body = {"email": ADMIN, "password": PASSWORD}
        assert install.client.post("/api/auth/setup", json=body | {"token": old}).status_code == 403
        assert install.client.post("/api/auth/setup", json=body | {"token": token}).status_code == 200
        assert [event.actor for event in install.events("auth.setup_link")] == ["command line"] * 2
    with pytest.raises(SystemExit, match="already has accounts"):
        run_cli(monkeypatch, "admin", "setup-link")


def first_start(home: Settings, config: AuthConfig, environ: dict[str, str]) -> FirstRun:
    migrate(home.database_url)
    with make_sessions(home.database_url)() as session:
        return prepare(session, config, environ)


def test_first_start_issues_one_setup_token_that_survives_restarts(home: Settings) -> None:
    found = first_start(home, AuthConfig(), {})
    assert found.token is not None and not found.waiting
    assert first_start(home, AuthConfig(), {}) == FirstRun(waiting=True)
    for install in start(home):
        body = {"token": found.token, "email": ADMIN, "password": PASSWORD}
        assert install.client.post("/api/auth/setup", json=body).status_code == 200
        assert [event.actor for event in install.events("auth.setup_link")] == ["system"]
    assert first_start(home, AuthConfig(), {}) == FirstRun()


def test_first_start_creates_the_admin_from_a_secret_file(
    home: Settings, tmp_path: Path, caplog: pytest.LogCaptureFixture
) -> None:
    secret = tmp_path / "admin_password"
    secret.write_text(f"{PASSWORD}\n")
    environ = {"MINIBRAIN_ADMIN_EMAIL": "Ada@Example.com", "MINIBRAIN_ADMIN_PASSWORD_FILE": str(secret)}
    with caplog.at_level(logging.WARNING, logger="minibrain"):
        assert first_start(home, AuthConfig(), environ) == FirstRun(admin=ADMIN)
    assert PASSWORD not in caplog.text and caplog.records == []
    for install in start(home):
        browser = install.browser()
        assert browser.post("/api/auth/login", json={"email": ADMIN, "password": PASSWORD}).status_code == 200
        [created] = install.events("account.create")
        assert (created.actor, created.detail["via"], created.detail["first_admin"]) == (ADMIN, "environment", True)
        with install.sessions() as session:
            assert not setup_pending(session)
    secret.write_text("another long passphrase")
    other = environ | {"MINIBRAIN_ADMIN_EMAIL": "eve@example.com"}
    assert first_start(home, AuthConfig(), other) == FirstRun()
    for install in start(home):
        with install.sessions() as session:
            assert session.scalars(select(User.email)).all() == [ADMIN]


def test_a_plain_admin_password_works_with_a_warning(home: Settings, caplog: pytest.LogCaptureFixture) -> None:
    environ = {"MINIBRAIN_ADMIN_EMAIL": ADMIN, "MINIBRAIN_ADMIN_PASSWORD": PASSWORD}
    with caplog.at_level(logging.WARNING, logger="minibrain"):
        assert first_start(home, AuthConfig(), environ) == FirstRun(admin=ADMIN)
    assert "MINIBRAIN_ADMIN_PASSWORD_FILE" in caplog.text and PASSWORD not in caplog.text


@pytest.mark.parametrize(
    ("environ", "message"),
    [
        ({"MINIBRAIN_ADMIN_EMAIL": ADMIN}, "MINIBRAIN_ADMIN_PASSWORD_FILE"),
        ({"MINIBRAIN_ADMIN_EMAIL": ADMIN, "MINIBRAIN_ADMIN_PASSWORD": "short"}, "12 characters"),
        ({"MINIBRAIN_ADMIN_EMAIL": "not an email", "MINIBRAIN_ADMIN_PASSWORD": PASSWORD}, "Enter an email"),
        ({"MINIBRAIN_ADMIN_EMAIL": ADMIN, "MINIBRAIN_ADMIN_PASSWORD_FILE": "/nowhere/secret"}, "cannot read"),
    ],
)
def test_a_wrong_admin_environment_stops_the_first_start(home: Settings, environ: dict[str, str], message: str) -> None:
    with pytest.raises(FirstRunError, match=message):
        first_start(home, AuthConfig(), environ)


def announced(found: FirstRun, base: str, capsys: pytest.CaptureFixture[str]) -> str:
    server = cast(uvicorn.Server, SimpleNamespace(started=True))
    cli.announce(server, found, base, False)
    return capsys.readouterr().out


def test_serve_prints_the_setup_link_once_it_listens(capsys: pytest.CaptureFixture[str]) -> None:
    link = announced(FirstRun(token="abc"), "http://localhost:5173", capsys)
    assert "\n    http://localhost:5173/setup?token=abc\n" in link
    assert "minibrain admin setup-link" in link
    waiting = announced(FirstRun(waiting=True), "http://127.0.0.1:8000", capsys)
    assert "token=" not in waiting and "minibrain admin setup-link" in waiting
    assert announced(FirstRun(), "http://127.0.0.1:8000", capsys) == ""
    assert cli.desktop_session() is False


def test_passwords_are_salted_pbkdf2_sha256() -> None:
    first, second = hash_password(PASSWORD), hash_password(PASSWORD)
    assert first != second and first.split("$")[:2] == ["pbkdf2-sha256", "600000"]
    assert verify_password(PASSWORD, first) and not verify_password("correct horse battery!", first)
    assert verify_password("ﬁne passphrase!", hash_password("fine passphrase!"))
    assert not verify_password(PASSWORD, None) and not verify_password(PASSWORD, "md5$x")


def test_harness_signs_in_as_an_admin(harness: Harness) -> None:
    info = harness.client.get("/api/auth/session").json()
    assert (info["setup"], info["person"]["email"], info["person"]["role"]) == (False, ADMIN_EMAIL, "admin")
    viewer = harness.person(None)
    assert viewer.get("/api/minibrains").status_code == 403
    assert harness.client.post("/api/minibrains", json={"name": "Triage"}).status_code == 201


def test_accounts_migration_round_trip(tmp_path: Path) -> None:
    engine = make_engine(f"sqlite:///{tmp_path / 'old.db'}", foreign_keys=False)
    config = migration_config(engine)
    command.upgrade(config, "0031")
    with engine.begin() as connection:
        connection.execute(
            text(
                "INSERT INTO api_keys (name, prefix, digest, created_at) VALUES ('app', 'mb_1', 'd', CURRENT_TIMESTAMP)"
            )
        )
    command.upgrade(config, "0032")
    assert {"users", "sessions"} <= set(inspect(engine).get_table_names())
    assert "created_by" in columns_of(engine, "api_keys")
    with engine.begin() as connection:
        table = connection.execute(text("SELECT sql FROM sqlite_master WHERE name = 'users'")).scalar_one()
        assert "AUTOINCREMENT" in table
        assert connection.execute(text("SELECT name, created_by FROM api_keys")).all() == [("app", None)]
    command.downgrade(config, "0031")
    assert not {"users", "sessions"} & set(inspect(engine).get_table_names())
    assert "created_by" not in columns_of(engine, "api_keys")
    with engine.connect() as connection:
        assert connection.execute(text("SELECT name FROM api_keys")).scalars().all() == ["app"]
