import io
from collections.abc import Iterator
from dataclasses import dataclass, replace
from datetime import timedelta
from pathlib import Path
from typing import Any

import pytest
from alembic import command
from fastapi.testclient import TestClient
from sqlalchemy import inspect, select, text, update
from sqlalchemy.orm import Session, sessionmaker

from minibrain import cli
from minibrain.app import create_app
from minibrain.auth.accounts import LOCK_AFTER, SESSION_COOKIE
from minibrain.auth.gate import RequestFacts, loopback_name, reached_locally
from minibrain.auth.passwords import hash_password, verify_password
from minibrain.registry.db import make_engine
from minibrain.registry.models import ApiKey, AuditEvent, LoginSession, User, now
from minibrain.settings import Settings
from tests.conftest import FakeBackend, Harness
from tests.test_data_catalogue import columns_of, migration_config

PASSWORD = "correct horse battery"
ADMIN = "ada@example.com"


@dataclass
class Install:
    client: TestClient
    sessions: sessionmaker[Session]
    settings: Settings

    def browser(self) -> TestClient:
        return TestClient(self.client.app, base_url="https://testserver")

    def events(self, prefix: str) -> list[AuditEvent]:
        with self.sessions() as session:
            query = select(AuditEvent).where(AuditEvent.action.startswith(prefix)).order_by(AuditEvent.id)
            return list(session.scalars(query))


def start(settings: Settings, listen: str) -> Iterator[Install]:
    settings.home.mkdir(parents=True, exist_ok=True)
    chosen = replace(settings, listen=listen)
    app = create_app(settings=chosen, backend=FakeBackend(), background=False, config_max_age=0)
    with TestClient(app, base_url="https://testserver") as client:
        yield Install(client=client, sessions=app.state.sessions, settings=chosen)


@pytest.fixture
def exposed(settings: Settings) -> Iterator[Install]:
    yield from start(settings, "10.0.0.5")


@pytest.fixture
def local(settings: Settings) -> Iterator[Install]:
    yield from start(settings, "127.0.0.1")


def csrf(client: TestClient) -> dict[str, str]:
    token = client.get("/api/auth/session").json()["csrf_token"]
    return {"X-CSRF-Token": token}


def set_up(install: Install, client: TestClient | None = None) -> TestClient:
    browser = client or install.client
    body = {"email": ADMIN, "name": "Ada Lovelace", "password": PASSWORD}
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


def test_single_user_mode_on_loopback_needs_no_sign_in(local: Install) -> None:
    info = local.client.get("/api/auth/session").json()
    assert (info["accounts"], info["setup"], info["csrf_token"]) == (False, True, None)
    assert info["person"] == {
        "id": None,
        "name": "Local user",
        "email": None,
        "source": "single_user",
        "role": "admin",
        "role_locked": False,
    }
    assert local.client.post("/api/minibrains", json={"name": "Triage"}).status_code == 201
    assert local.client.delete("/api/minibrains/triage").status_code == 204
    [deleted] = local.events("model.delete")
    assert deleted.actor == "Local user" and "sign_in" not in deleted.detail


def test_any_other_listen_address_needs_accounts(exposed: Install) -> None:
    info = exposed.client.get("/api/auth/session").json()
    assert (info["accounts"], info["setup"], info["person"], info["reason"]) == (True, True, None, "listen")
    refused = exposed.client.get("/api/minibrains")
    assert refused.status_code == 401 and refused.json()["detail"] == "Sign in to use minibrain"
    assert exposed.client.post("/api/minibrains", json={"name": "Triage"}).status_code == 401


@pytest.mark.parametrize(
    ("listen", "facts", "local"),
    [
        ("127.0.0.1", RequestFacts(path="/api/x", method="GET", server="127.0.0.1", client="127.0.0.1"), True),
        ("localhost", RequestFacts(path="/api/x", method="GET", server="::1", client="::1"), True),
        ("127.0.0.1", RequestFacts(path="/api/x", method="GET", server="127.0.0.1", client="10.0.0.9"), False),
        ("127.0.0.1", RequestFacts(path="/api/x", method="GET", server="192.168.1.4", client="127.0.0.1"), False),
        ("127.0.0.1", RequestFacts(path="/api/x", method="GET", forwarded=True), False),
        ("10.0.0.5", RequestFacts(path="/api/x", method="GET", server="127.0.0.1", client="127.0.0.1"), False),
        ("::", RequestFacts(path="/api/x", method="GET"), False),
        ("::1", RequestFacts(path="/api/x", method="GET", server="::ffff:127.0.0.1"), True),
    ],
)
def test_single_user_mode_needs_a_loopback_listener_and_connection(
    listen: str, facts: RequestFacts, local: bool
) -> None:
    assert reached_locally(listen, facts) is local


def test_loopback_names() -> None:
    assert [loopback_name(host) for host in ("localhost", "app.localhost", "127.0.0.2", "::1")] == [True] * 4
    assert [loopback_name(host) for host in ("::", "example.com", "10.0.0.1", None)] == [False] * 4


def test_a_request_through_a_proxy_on_loopback_needs_accounts(local: Install) -> None:
    forwarded = local.client.get("/api/minibrains", headers={"X-Forwarded-For": "203.0.113.9"})
    assert forwarded.status_code == 401
    info = local.client.get("/api/auth/session", headers={"Forwarded": "for=203.0.113.9"}).json()
    assert (info["accounts"], info["reason"]) == (True, "remote")


def test_first_run_creates_the_admin_and_signs_them_in(exposed: Install) -> None:
    admin = set_up(exposed)
    cookie = admin.cookies.get(SESSION_COOKIE)
    assert cookie
    info = admin.get("/api/auth/session").json()
    assert info["person"]["email"] == ADMIN and info["person"]["role"] == "admin" and not info["setup"]
    assert len(info["csrf_token"]) == 64
    with exposed.sessions() as session:
        user = session.scalars(select(User)).one()
        stored = session.scalars(select(LoginSession)).one()
        assert user.password_hash and user.password_hash.startswith("pbkdf2-sha256$600000$")
        assert PASSWORD not in user.password_hash
        assert stored.token_hash != cookie and len(stored.token_hash) == 64
    again = exposed.browser().post("/api/auth/setup", json={"email": "eve@example.com", "password": PASSWORD})
    assert again.status_code == 409
    [created] = exposed.events("account.create")
    assert (created.actor, created.detail["first_admin"], created.detail["role"]) == (ADMIN, True, "admin")
    [signed] = exposed.events("auth.sign_in")
    assert (signed.actor, signed.detail["sign_in"]) == (ADMIN, "local")


def test_setup_checks_the_password_and_email(exposed: Install) -> None:
    short = exposed.client.post("/api/auth/setup", json={"email": ADMIN, "password": "short"})
    assert short.status_code == 422 and "12 characters" in short.json()["detail"]
    wrong = exposed.client.post("/api/auth/setup", json={"email": "not an email", "password": PASSWORD})
    assert wrong.status_code == 422
    with exposed.sessions() as session:
        assert session.scalars(select(User)).all() == []


def test_state_changing_calls_need_the_csrf_token(exposed: Install) -> None:
    admin = set_up(exposed)
    refused = admin.post("/api/minibrains", json={"name": "Triage"})
    assert refused.status_code == 403 and "CSRF" in refused.json()["detail"]
    wrong = admin.post("/api/minibrains", json={"name": "Triage"}, headers={"X-CSRF-Token": "0" * 64})
    assert wrong.status_code == 403
    assert admin.get("/api/minibrains").status_code == 200
    created = admin.post("/api/minibrains", json={"name": "Triage"}, headers=csrf(admin))
    assert created.status_code == 201
    assert admin.delete("/api/minibrains/triage", headers=csrf(admin)).status_code == 204
    [event] = exposed.events("model.delete")
    assert (event.actor, event.detail["sign_in"]) == (ADMIN, "local")


def test_the_csrf_token_belongs_to_one_session(exposed: Install) -> None:
    admin = set_up(exposed)
    first = csrf(admin)
    other = exposed.browser()
    assert other.post("/api/auth/login", json={"email": ADMIN, "password": PASSWORD}).status_code == 200
    assert csrf(other) != first
    assert other.post("/api/minibrains", json={"name": "Triage"}, headers=first).status_code == 403


def test_sign_in_and_out(exposed: Install) -> None:
    set_up(exposed, exposed.browser())
    browser = exposed.browser()
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
    failed = exposed.events("auth.sign_in_failed")
    assert [(event.actor, event.detail["sign_in"]) for event in failed] == [
        (ADMIN, "local"),
        ("nobody@example.com", "local"),
    ]
    assert [event.actor for event in exposed.events("auth.sign_out")] == [ADMIN]


def test_a_signed_out_cookie_stops_working(exposed: Install) -> None:
    admin = set_up(exposed)
    stolen = admin.cookies.get(SESSION_COOKIE)
    assert admin.post("/api/auth/logout", headers=csrf(admin)).status_code == 204
    replay = exposed.browser()
    replay.cookies.set(SESSION_COOKIE, stolen or "")
    assert replay.get("/api/minibrains").status_code == 401


def test_repeated_failures_lock_the_account_for_a_while(exposed: Install) -> None:
    set_up(exposed, exposed.browser())
    browser = exposed.browser()
    for _ in range(LOCK_AFTER):
        assert (
            browser.post("/api/auth/login", json={"email": ADMIN, "password": "guess guess guess"}).status_code == 401
        )
    locked = browser.post("/api/auth/login", json={"email": ADMIN, "password": PASSWORD})
    assert locked.status_code == 401 and "Too many failed sign-ins" in locked.json()["detail"]
    with exposed.sessions() as session:
        session.execute(update(User).values(locked_until=now() - timedelta(seconds=1)))
        session.commit()
    assert browser.post("/api/auth/login", json={"email": ADMIN, "password": PASSWORD}).status_code == 200


def test_sessions_end_after_the_idle_and_absolute_lifetimes(exposed: Install) -> None:
    admin = set_up(exposed)
    with exposed.sessions() as session:
        session.execute(update(LoginSession).values(last_seen_at=now() - timedelta(minutes=31)))
        session.commit()
    assert admin.get("/api/minibrains").status_code == 401
    browser = exposed.browser()
    assert browser.post("/api/auth/login", json={"email": ADMIN, "password": PASSWORD}).status_code == 200
    with exposed.sessions() as session:
        session.execute(update(LoginSession).values(created_at=now() - timedelta(hours=13)))
        session.commit()
    assert browser.get("/api/minibrains").status_code == 401
    with exposed.sessions() as session:
        assert session.scalars(select(LoginSession)).all() == []


def test_accounts_on_loopback_once_an_admin_exists(local: Install) -> None:
    assert local.client.get("/api/minibrains").status_code == 200
    browser = set_up(local, local.browser())
    assert local.client.get("/api/minibrains").status_code == 401
    assert local.client.get("/api/auth/session").json()["accounts"] is True
    assert browser.get("/api/minibrains").status_code == 200


def test_admins_invite_people_with_a_one_time_link(exposed: Install) -> None:
    admin = set_up(exposed)
    link = invite(admin, "bea@example.com", "builder")
    assert link["path"].startswith("/reset-password#token=")
    assert (link["account"]["role"], link["account"]["password_set"], link["account"]["link_pending"]) == (
        "builder",
        False,
        True,
    )
    blank = exposed.browser().post("/api/auth/login", json={"email": "bea@example.com", "password": ""})
    assert blank.status_code == 401
    bea = redeem(exposed, link)
    assert bea.get("/api/auth/session").json()["person"]["role"] == "builder"
    used = exposed.browser().post(
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
    [created] = exposed.events("account.create")[1:]
    assert (created.actor, created.target, created.detail["role"], created.detail["sign_in"]) == (
        ADMIN,
        "bea@example.com",
        "builder",
        "local",
    )


def test_a_reset_link_replaces_the_password_and_ends_old_sessions(exposed: Install) -> None:
    admin = set_up(exposed)
    bea = redeem(exposed, invite(admin, "bea@example.com"))
    account = next(person for person in admin.get("/api/accounts").json()["people"] if person["email"] != ADMIN)
    link = admin.post(f"/api/accounts/{account['id']}/password-link", headers=csrf(admin)).json()
    assert bea.get("/api/minibrains").status_code == 200
    redeem(exposed, link, "a brand new passphrase")
    assert bea.get("/api/minibrains").status_code == 401
    old = exposed.browser().post("/api/auth/login", json={"email": "bea@example.com", "password": PASSWORD})
    assert old.status_code == 401
    with exposed.sessions() as session:
        session.execute(update(User).values(reset_expires_at=now() - timedelta(seconds=1)))
        session.commit()
    expired_link = admin.post(f"/api/accounts/{account['id']}/password-link", headers=csrf(admin)).json()
    with exposed.sessions() as session:
        session.execute(update(User).where(User.id == account["id"]).values(reset_expires_at=now()))
        session.commit()
    token = expired_link["path"].split("#token=", 1)[1]
    late = exposed.browser().post("/api/auth/reset", json={"token": token, "password": PASSWORD})
    assert late.status_code == 422
    assert [event.action for event in exposed.events("account.")] == [
        "account.create",
        "account.create",
        "account.password",
        "account.reset",
        "account.password",
        "account.reset",
    ]


def test_turning_an_account_off_ends_its_sessions_at_once(exposed: Install) -> None:
    admin = set_up(exposed)
    bea = redeem(exposed, invite(admin, "bea@example.com"))
    bea_id = bea.get("/api/auth/session").json()["person"]["id"]
    off = admin.patch(f"/api/accounts/{bea_id}", json={"disabled": True}, headers=csrf(admin))
    assert off.status_code == 200 and off.json()["disabled"] is True and off.json()["sessions"] == 0
    assert bea.get("/api/minibrains").status_code == 401
    refused = exposed.browser().post("/api/auth/login", json={"email": "bea@example.com", "password": PASSWORD})
    assert refused.status_code == 401 and "turned off" in refused.json()["detail"]
    on = admin.patch(f"/api/accounts/{bea_id}", json={"disabled": False, "role": "viewer"}, headers=csrf(admin))
    assert (on.json()["disabled"], on.json()["role"]) == (False, "viewer")
    [_, changed] = exposed.events("account.update")
    assert changed.detail["from"] == {"role": "builder", "disabled": True}
    assert changed.detail["to"] == {"role": "viewer", "disabled": False}


def test_the_last_admin_stays(exposed: Install) -> None:
    admin = set_up(exposed)
    me = admin.get("/api/auth/session").json()["person"]["id"]
    myself = admin.patch(f"/api/accounts/{me}", json={"disabled": True}, headers=csrf(admin))
    assert myself.status_code == 422 and "your own account" in myself.json()["detail"]
    demoted = admin.patch(f"/api/accounts/{me}", json={"role": "builder"}, headers=csrf(admin))
    assert demoted.status_code == 422 and "at least one admin" in demoted.json()["detail"]
    other = redeem(exposed, invite(admin, "cy@example.com", "admin"))
    assert other.patch(f"/api/accounts/{me}", json={"role": "builder"}, headers=csrf(other)).status_code == 200


def test_signed_in_people_are_recorded_on_reviews_and_keys(exposed: Install) -> None:
    admin = set_up(exposed)
    headers = csrf(admin)
    assert admin.post("/api/minibrains", json={"name": "Triage"}, headers=headers).status_code == 201
    body = {"name": "app", "models": [{"kind": "custom", "key": "triage"}]}
    key = admin.post("/api/keys", json=body, headers=headers)
    assert key.status_code == 201
    with exposed.sessions() as session:
        assert session.scalars(select(ApiKey.created_by)).one() == ADMIN
    body = {"rating": "down", "input": "charged twice", "output": "bug", "version": 0}
    item = admin.post("/api/minibrains/triage/feedback", json=body, headers=headers).json()
    assigned = admin.post(f"/api/feedback/{item['id']}/assign", json={"mine": True}, headers=headers).json()
    assert assigned["assignee"] == ADMIN
    mine = admin.get("/api/feedback", params={"assignee": "me"}).json()
    assert [entry["id"] for entry in mine["items"]] == [item["id"]]


def test_admin_create_on_the_command_line(
    settings: Settings, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    settings.home.mkdir(parents=True)
    monkeypatch.setenv("MINIBRAIN_HOME", str(settings.home))
    monkeypatch.delenv("MINIBRAIN_DATABASE_URL", raising=False)
    monkeypatch.setattr("sys.stdin", io.StringIO(f"{PASSWORD}\n"))
    monkeypatch.setattr("sys.argv", ["minibrain", "admin", "create", "--email", ADMIN, "--password-stdin"])
    cli.main()
    assert "Created the admin account ada@example.com" in capsys.readouterr().out
    monkeypatch.setattr("sys.stdin", io.StringIO(f"{PASSWORD}\n"))
    with pytest.raises(SystemExit, match="already has an account"):
        cli.main()
    monkeypatch.setattr("sys.stdin", io.StringIO("short\n"))
    with pytest.raises(SystemExit, match="12 characters"):
        cli.main()
    for install in start(settings, "10.0.0.5"):
        browser = install.browser()
        assert browser.post("/api/auth/login", json={"email": ADMIN, "password": PASSWORD}).status_code == 200
        [created] = install.events("account.create")
        assert (created.actor, created.detail["via"]) == ("command line", "command line")


def test_passwords_are_salted_pbkdf2_sha256() -> None:
    first, second = hash_password(PASSWORD), hash_password(PASSWORD)
    assert first != second and first.split("$")[:2] == ["pbkdf2-sha256", "600000"]
    assert verify_password(PASSWORD, first) and not verify_password("correct horse battery!", first)
    assert verify_password("ﬁne passphrase!", hash_password("fine passphrase!"))
    assert not verify_password(PASSWORD, None) and not verify_password(PASSWORD, "md5$x")


def test_harness_stays_in_single_user_mode(harness: Harness) -> None:
    assert harness.client.get("/api/auth/session").json()["accounts"] is False


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
