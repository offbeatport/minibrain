from collections.abc import Iterator
from dataclasses import dataclass, replace
from typing import Any

import pytest
from fastapi import FastAPI
from fastapi.routing import APIRoute
from fastapi.testclient import TestClient

from minibrain.api.access import Guard
from minibrain.settings import Settings
from tests.conftest import Harness
from tests.test_accounts import Install, csrf, invite, redeem, set_up, start
from tests.test_flow import SLUG, add_version, create_with_dataset

MISTAKE = {"input": "I was charged twice", "gold": "billing", "output": "bug"}

ROUTE_ROLES = {
    ("GET", "/api/auth/session"): "public",
    ("POST", "/api/auth/login"): "public",
    ("POST", "/api/auth/logout"): "signed_in",
    ("POST", "/api/auth/setup"): "public",
    ("POST", "/api/auth/reset"): "public",
    ("GET", "/api/accounts"): "admin",
    ("POST", "/api/accounts"): "admin",
    ("PATCH", "/api/accounts/{account_id}"): "admin",
    ("POST", "/api/accounts/{account_id}/password-link"): "admin",
    ("GET", "/api/minibrains"): "viewer",
    ("POST", "/api/minibrains"): "builder",
    ("GET", "/api/minibrains/bases"): "viewer",
    ("PATCH", "/api/minibrains/{slug}"): "builder",
    ("GET", "/api/minibrains/{slug}"): "viewer",
    ("DELETE", "/api/minibrains/{slug}"): "builder",
    ("POST", "/api/minibrains/{slug}/deploy"): "builder",
    ("POST", "/api/minibrains/{slug}/source"): "builder",
    ("POST", "/api/minibrains/sample"): "builder",
    ("PUT", "/api/minibrains/{slug}/dataset"): "builder",
    ("PUT", "/api/minibrains/{slug}/mapping"): "builder",
    ("POST", "/api/minibrains/{slug}/query"): "builder",
    ("GET", "/api/minibrains/{slug}/preview"): "builder",
    ("POST", "/api/minibrains/{slug}/snapshots"): "builder",
    ("GET", "/api/minibrains/{slug}/golden"): "builder",
    ("GET", "/api/sources"): "builder",
    ("POST", "/api/sources"): "builder",
    ("GET", "/api/data/folders"): "builder",
    ("POST", "/api/sources/folders"): "builder",
    ("GET", "/api/samples"): "builder",
    ("POST", "/api/samples/{file}"): "builder",
    ("GET", "/api/sources/{source_id}"): "builder",
    ("PATCH", "/api/sources/{source_id}"): "builder",
    ("GET", "/api/sources/{source_id}/rows"): "builder",
    ("GET", "/api/sources/{source_id}/stats"): "builder",
    ("POST", "/api/sources/{source_id}/query"): "builder",
    ("POST", "/api/query"): "builder",
    ("DELETE", "/api/sources/{source_id}"): "builder",
    ("GET", "/api/datasets"): "builder",
    ("POST", "/api/datasets"): "builder",
    ("GET", "/api/datasets/{slug}"): "builder",
    ("PATCH", "/api/datasets/{slug}"): "builder",
    ("PUT", "/api/datasets/{slug}/mapping"): "builder",
    ("GET", "/api/datasets/{slug}/preview"): "builder",
    ("POST", "/api/datasets/{slug}/query"): "builder",
    ("DELETE", "/api/datasets/{slug}"): "builder",
    ("GET", "/api/datasets/{slug}/snapshots"): "builder",
    ("POST", "/api/datasets/{slug}/snapshots"): "builder",
    ("GET", "/api/snapshots/{snapshot_id}"): "builder",
    ("GET", "/api/snapshots/{snapshot_id}/diff/{other_id}"): "builder",
    ("PUT", "/api/datasets/{slug}/checks/{check}/dismissal"): "builder",
    ("DELETE", "/api/datasets/{slug}/checks/{check}/dismissal"): "builder",
    ("GET", "/api/settings/data"): "builder",
    ("PUT", "/api/settings/data"): "admin",
    ("GET", "/api/dataset-folders"): "builder",
    ("POST", "/api/dataset-folders"): "builder",
    ("PATCH", "/api/dataset-folders/{folder_id}"): "builder",
    ("PUT", "/api/dataset-folders/{folder_id}/parent"): "builder",
    ("DELETE", "/api/dataset-folders/{folder_id}"): "builder",
    ("PUT", "/api/datasets/{slug}/folder"): "builder",
    ("GET", "/api/connections"): "builder",
    ("POST", "/api/connections"): "admin",
    ("PUT", "/api/connections/{connection_id}"): "admin",
    ("DELETE", "/api/connections/{connection_id}"): "admin",
    ("POST", "/api/connections/test"): "admin",
    ("POST", "/api/connections/{connection_id}/test"): "admin",
    ("GET", "/api/connections/{connection_id}/tables"): "builder",
    ("GET", "/api/extensions"): "builder",
    ("POST", "/api/sources/s3"): "builder",
    ("POST", "/api/sources/database"): "builder",
    ("POST", "/api/sources/iceberg"): "builder",
    ("GET", "/api/models"): "viewer",
    ("GET", "/api/models/sources"): "viewer",
    ("POST", "/api/models/inspect"): "admin",
    ("POST", "/api/models/import"): "admin",
    ("GET", "/api/models/base/{key}"): "viewer",
    ("PATCH", "/api/models/base/{key}"): "admin",
    ("DELETE", "/api/models/base/{key}"): "admin",
    ("POST", "/api/models/base/{key}/verify"): "admin",
    ("POST", "/api/models/base/{key}/repair"): "admin",
    ("POST", "/api/models/base/{key}/reimport"): "admin",
    ("POST", "/api/models/base/{key}/relocate"): "admin",
    ("POST", "/api/models/base/{key}/recheck"): "admin",
    ("POST", "/api/models/base/{key}/retry"): "admin",
    ("POST", "/api/models/base/{key}/pin"): "admin",
    ("POST", "/api/models/base/{key}/deploy"): "builder",
    ("POST", "/api/models/base/{key}/test"): "viewer",
    ("GET", "/api/settings/model-cache"): "viewer",
    ("PUT", "/api/settings/model-cache"): "admin",
    ("GET", "/api/models/cache"): "viewer",
    ("POST", "/api/models/cache/estimate"): "viewer",
    ("POST", "/api/models/cache/free"): "admin",
    ("GET", "/api/catalog"): "viewer",
    ("POST", "/api/catalog/{catalog_id}/download"): "admin",
    ("POST", "/api/catalog/hub"): "admin",
    ("DELETE", "/api/catalog/{catalog_id}"): "admin",
    ("POST", "/api/catalog/sync"): "admin",
    ("GET", "/api/catalog/settings"): "viewer",
    ("PUT", "/api/catalog/settings"): "admin",
    ("GET", "/api/compute/pools"): "viewer",
    ("GET", "/api/compute/prices"): "viewer",
    ("PUT", "/api/compute/prices"): "admin",
    ("GET", "/api/policies"): "admin",
    ("PUT", "/api/policies/{name}"): "admin",
    ("GET", "/api/audit"): "admin",
    ("GET", "/api/audit/facets"): "admin",
    ("GET", "/api/audit/export"): "admin",
    ("GET", "/api/audit/chain"): "admin",
    ("GET", "/api/audit/{event_id}"): "admin",
    ("GET", "/api/minibrains/{slug}/versions"): "viewer",
    ("POST", "/api/minibrains/{slug}/versions"): "builder",
    ("DELETE", "/api/minibrains/{slug}/versions/{number}"): "builder",
    ("POST", "/api/minibrains/{slug}/versions/{number}/promote"): "builder",
    ("POST", "/api/minibrains/{slug}/complete"): "viewer",
    ("GET", "/api/minibrains/{slug}/versions/{number}/card"): "viewer",
    ("GET", "/api/minibrains/{slug}/versions/{number}/card.json"): "viewer",
    ("GET", "/api/minibrains/{slug}/versions/{number}/card.md"): "viewer",
    ("GET", "/api/minibrains/{slug}/versions/{number}/aibom.json"): "viewer",
    ("PUT", "/api/minibrains/{slug}/versions/{number}/card"): "builder",
    ("GET", "/api/feedback"): "builder",
    ("GET", "/api/feedback/facets"): "builder",
    ("GET", "/api/feedback/{feedback_id}"): "builder",
    ("POST", "/api/feedback/{feedback_id}/review"): "builder",
    ("POST", "/api/feedback/{feedback_id}/assign"): "builder",
    ("POST", "/api/minibrains/{slug}/feedback"): "viewer",
    ("GET", "/api/minibrains/{slug}/feedback/summary"): "viewer",
    ("GET", "/api/keys"): "builder",
    ("POST", "/api/keys"): "builder",
    ("PUT", "/api/keys/{key_id}/models"): "builder",
    ("DELETE", "/api/keys/{key_id}"): "builder",
    ("GET", "/api/jobs"): "viewer",
    ("GET", "/api/jobs/facets"): "viewer",
    ("GET", "/api/jobs/{job_id}"): "viewer",
    ("GET", "/api/jobs/{job_id}/events"): "viewer",
    ("POST", "/api/jobs/{job_id}/cancel"): "builder",
    ("POST", "/api/jobs/{job_id}/retry"): "builder",
    ("GET", "/api/artifacts/{artifact_id}"): "builder",
    ("GET", "/api/system/install"): "admin",
    ("GET", "/api/system/diagnostics"): "admin",
    ("GET", "/api/system"): "viewer",
    ("GET", "/api/settings/storage"): "admin",
    ("PUT", "/api/settings/storage"): "admin",
    ("POST", "/api/settings/storage/test"): "admin",
    ("GET", "/api/system/infrastructure"): "viewer",
    ("GET", "/api/settings"): "viewer",
}


def api_routes(routes: list[Any]) -> Iterator[APIRoute]:
    for route in routes:
        if hasattr(route, "original_router"):
            yield from api_routes(route.original_router.routes)
        elif isinstance(route, APIRoute) and route.path.startswith("/api/"):
            yield route


def guards_of(route: APIRoute) -> list[str]:
    return [found.call.name for found in route.dependant.dependencies if isinstance(found.call, Guard)]


def test_every_api_route_states_its_role(exposed: Install) -> None:
    app = exposed.client.app
    assert isinstance(app, FastAPI)
    found: dict[tuple[str, str], str] = {}
    for route in api_routes(app.routes):
        guards = guards_of(route)
        methods = sorted(route.methods or ())
        assert len(guards) == 1, f"{methods} {route.path} needs one access guard, has {guards}"
        for method in methods:
            found[(method, route.path)] = guards[0]
    unlisted = sorted(set(found) - set(ROUTE_ROLES))
    assert not unlisted, f"add these routes and their roles to ROUTE_ROLES: {unlisted}"
    assert sorted(set(ROUTE_ROLES) - set(found)) == []
    assert {key: found[key] for key in ROUTE_ROLES} == ROUTE_ROLES


@dataclass
class Team:
    install: Install
    admin: TestClient
    builder: TestClient
    viewer: TestClient
    nobody: TestClient


def team_of(install: Install, admin: TestClient | None = None) -> Team:
    admin = set_up(install, admin or install.browser())
    builder = redeem(install, invite(admin, "bea@example.com", "builder"))
    viewer = redeem(install, invite(admin, "vic@example.com", "viewer"))
    nobody = redeem(install, invite(admin, "nia@example.com", "viewer"))
    nia = nobody.get("/api/auth/session").json()["person"]["id"]
    assert admin.patch(f"/api/accounts/{nia}", json={"role": "none"}, headers=csrf(admin)).status_code == 200
    return Team(install=install, admin=admin, builder=builder, viewer=viewer, nobody=nobody)


@pytest.fixture
def exposed(settings: Settings) -> Iterator[Install]:
    yield from start(settings, "10.0.0.5")


@pytest.fixture
def team(exposed: Install) -> Team:
    return team_of(exposed)


def status(client: TestClient, method: str, path: str, body: Any = None) -> int:
    headers = csrf(client) if method != "GET" else {}
    return client.request(method, path, json=body, headers=headers).status_code


def test_viewers_see_models_but_change_nothing(team: Team) -> None:
    assert status(team.builder, "POST", "/api/minibrains", {"name": "Triage"}) == 201
    viewer = team.viewer
    assert status(viewer, "GET", "/api/minibrains") == 200
    assert status(viewer, "GET", "/api/minibrains/triage") == 200
    assert status(viewer, "GET", "/api/models") == 200
    assert status(viewer, "GET", "/api/jobs") == 200
    assert status(viewer, "GET", "/api/system/infrastructure") == 200
    refused = viewer.post("/api/minibrains", json={"name": "Other"}, headers=csrf(viewer))
    assert refused.status_code == 403 and refused.json()["detail"] == "This needs the Builder role"
    assert status(viewer, "GET", "/api/sources") == 403
    assert status(viewer, "GET", "/api/minibrains/triage/preview") == 403
    assert status(viewer, "GET", "/api/keys") == 403
    assert status(viewer, "GET", "/api/feedback") == 403
    assert status(viewer, "DELETE", "/api/minibrains/triage") == 403
    assert status(viewer, "GET", "/api/policies") == 403
    assert status(viewer, "GET", "/api/accounts") == 403


def test_builders_build_but_do_not_run_the_install(team: Team) -> None:
    builder = team.builder
    assert status(builder, "POST", "/api/minibrains", {"name": "Triage"}) == 201
    assert status(builder, "GET", "/api/sources") == 200
    assert status(builder, "GET", "/api/keys") == 200
    body = {"name": "app", "models": [{"kind": "custom", "key": "triage"}]}
    assert status(builder, "POST", "/api/keys", body) == 201
    assert status(builder, "POST", "/api/minibrains/triage/deploy", {"deployed": True}) in {200, 409, 422}
    refused = builder.put("/api/policies/request_logs", json={"value": False}, headers=csrf(builder))
    assert refused.status_code == 403 and refused.json()["detail"] == "This needs the Admin role"
    assert status(builder, "GET", "/api/audit") == 403
    assert status(builder, "GET", "/api/accounts") == 403
    assert status(builder, "GET", "/api/system/install") == 403
    assert status(builder, "DELETE", "/api/models/base/qwen") == 403
    assert status(builder, "POST", "/api/catalog/sync") == 403
    assert status(builder, "PUT", "/api/settings/data", {"row_limit": 1000}) == 403


def test_admins_reach_everything(team: Team) -> None:
    admin = team.admin
    assert status(admin, "PUT", "/api/policies/request_logs", {"value": False}) == 200
    assert status(admin, "GET", "/api/audit") == 200
    assert status(admin, "GET", "/api/system/install") == 200
    assert status(admin, "GET", "/api/accounts") == 200


def test_people_without_a_role_see_nothing(team: Team) -> None:
    nobody = team.nobody
    refused = nobody.get("/api/minibrains")
    assert refused.status_code == 403 and "Ask an admin" in refused.json()["detail"]
    person = nobody.get("/api/auth/session").json()["person"]
    assert (person["email"], person["role"]) == ("nia@example.com", None)
    assert status(nobody, "POST", "/api/auth/logout") == 204


def finish_with_mistakes(harness: Harness) -> None:
    claim = harness.claim(["eval"])
    assert claim is not None
    scores = {"examples": 30, "accuracy": 0.9, "macro_f1": 0.9, "invalid_rate": 0, "mistakes": [MISTAKE]}
    body = {"token": claim["token"], "result": {"metrics": {"eval": scores}}, "outputs": {}}
    assert harness.internal(f"/jobs/{claim['job_id']}/complete", body).status_code == 204


def test_viewers_get_scores_without_data_rows(harness: Harness) -> None:
    create_with_dataset(harness)
    add_version(harness, "prompt")
    finish_with_mistakes(harness)
    harness.app.state.settings = replace(harness.settings, listen="10.0.0.5")
    install = Install(client=harness.client, sessions=harness.sessions, settings=harness.app.state.settings)
    people = team_of(install, TestClient(harness.app, base_url="https://testserver"))
    path = f"/api/minibrains/{SLUG}/versions"
    assert [version["mistakes"] for version in people.admin.get(path).json()] == [[MISTAKE]]
    assert [version["mistakes"] for version in people.builder.get(path).json()] == [[MISTAKE]]
    seen = people.viewer.get(path).json()
    assert [version["mistakes"] for version in seen] == [[]]
    assert seen[0]["held_out"]["accuracy"] == 0.9
    job = next(item["id"] for item in people.admin.get("/api/jobs").json()["items"] if item["kind"] == "eval")
    assert people.admin.get(f"/api/jobs/{job}").json()["result"] is not None
    assert people.viewer.get(f"/api/jobs/{job}").json()["result"] is None
    detail = people.viewer.get(f"/api/minibrains/{SLUG}").json()
    assert all(check["examples"] == [] for check in detail["snapshot"]["checks"])
