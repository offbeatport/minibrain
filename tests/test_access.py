from collections.abc import Iterator
from dataclasses import dataclass
from typing import Any

import pytest
from fastapi.routing import APIRoute
from fastapi.testclient import TestClient

from minibrain.api.access import Guard
from minibrain.auth.roles import Role
from tests.conftest import Harness, blank_dataset
from tests.test_accounts import csrf
from tests.test_flow import SLUG, add_version, create_with_dataset, finish
from tests.test_teardown import BASE, add_base

ROUTE_ROLES = {
    ("GET", "/api/auth/session"): "public",
    ("POST", "/api/auth/login"): "public",
    ("POST", "/api/auth/logout"): "signed_in",
    ("POST", "/api/auth/setup"): "public",
    ("POST", "/api/auth/reset"): "public",
    ("GET", "/api/auth/oidc/start"): "public",
    ("GET", "/api/auth/oidc/callback"): "public",
    ("GET", "/api/accounts"): "admin",
    ("POST", "/api/accounts"): "admin",
    ("PATCH", "/api/accounts/{account_id}"): "admin",
    ("POST", "/api/accounts/{account_id}/password-link"): "admin",
    ("GET", "/api/models"): "viewer",
    ("POST", "/api/models"): "builder",
    ("PATCH", "/api/models/{name}"): "builder",
    ("PUT", "/api/models/{name}/avatar"): "builder",
    ("GET", "/api/models/{name}"): "viewer",
    ("DELETE", "/api/models/{name}"): "builder",
    ("POST", "/api/models/{name}/duplicate"): "builder",
    ("POST", "/api/models/{name}/base"): "builder",
    ("GET", "/api/models/{name}/base-options"): "viewer",
    ("POST", "/api/models/{name}/deploy"): "builder",
    ("POST", "/api/models/sample"): "builder",
    ("GET", "/api/models/name"): "viewer",
    ("GET", "/api/reserved-names/{name}"): "viewer",
    ("POST", "/api/models/{name}/contract/check"): "builder",
    ("PUT", "/api/models/{name}/contract"): "builder",
    ("PUT", "/api/models/{name}/label-proposal/dismissal"): "builder",
    ("PUT", "/api/models/{name}/graders"): "builder",
    ("PUT", "/api/models/{name}/promotion"): "builder",
    ("PUT", "/api/models/{name}/instructions"): "builder",
    ("PUT", "/api/models/{name}/judge"): "builder",
    ("PUT", "/api/models/{name}/safety"): "builder",
    ("GET", "/api/models/{name}/versions/{number}/answers"): "builder",
    ("GET", "/api/settings/judge"): "viewer",
    ("PUT", "/api/settings/judge"): "admin",
    ("GET", "/api/settings/safety"): "viewer",
    ("PUT", "/api/settings/safety"): "admin",
    ("POST", "/api/models/{name}/versions/{number}/test"): "viewer",
    ("GET", "/api/presets"): "viewer",
    ("PUT", "/api/models/{name}/dataset"): "builder",
    ("PUT", "/api/models/{name}/mapping"): "builder",
    ("PUT", "/api/models/{name}/request-bodies"): "builder",
    ("POST", "/api/models/{name}/query"): "builder",
    ("GET", "/api/models/{name}/preview"): "builder",
    ("POST", "/api/models/{name}/dataset-versions"): "builder",
    ("GET", "/api/models/{name}/golden"): "builder",
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
    ("GET", "/api/datasets/{slug}/versions"): "builder",
    ("POST", "/api/datasets/{slug}/versions"): "builder",
    ("GET", "/api/dataset-versions/{dataset_version_id}/diff/{other_id}"): "builder",
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
    ("POST", "/api/sources/delta"): "builder",
    ("POST", "/api/models/inspect"): "admin",
    ("POST", "/api/models/import"): "admin",
    ("POST", "/api/models/{name}/verify"): "admin",
    ("POST", "/api/models/{name}/repair"): "admin",
    ("POST", "/api/models/{name}/reimport"): "admin",
    ("POST", "/api/models/{name}/relocate"): "admin",
    ("POST", "/api/models/{name}/recheck"): "admin",
    ("POST", "/api/models/{name}/retry"): "admin",
    ("POST", "/api/models/{name}/test"): "viewer",
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
    ("GET", "/api/settings/encryption"): "admin",
    ("PUT", "/api/settings/encryption"): "admin",
    ("POST", "/api/settings/encryption/test"): "admin",
    ("POST", "/api/settings/encryption/tasks"): "admin",
    ("GET", "/api/audit"): "admin",
    ("GET", "/api/audit/facets"): "admin",
    ("GET", "/api/audit/export"): "admin",
    ("GET", "/api/audit/chain"): "admin",
    ("GET", "/api/audit/{event_id}"): "admin",
    ("GET", "/api/models/{name}/versions"): "viewer",
    ("POST", "/api/models/{name}/versions"): "builder",
    ("DELETE", "/api/models/{name}/versions/{number}"): "builder",
    ("POST", "/api/models/{name}/versions/{number}/promote"): "builder",
    ("POST", "/api/models/{name}/rescore"): "builder",
    ("GET", "/api/models/{name}/training-plan"): "viewer",
    ("GET", "/api/playground/models"): "viewer",
    ("POST", "/api/playground/chat/completions"): "viewer",
    ("GET", "/api/playground/presets"): "viewer",
    ("POST", "/api/playground/presets"): "viewer",
    ("PUT", "/api/playground/presets/{preset_id}"): "viewer",
    ("DELETE", "/api/playground/presets/{preset_id}"): "viewer",
    ("GET", "/api/playground/sessions"): "viewer",
    ("POST", "/api/playground/sessions"): "viewer",
    ("GET", "/api/playground/sessions/{chat_id}"): "viewer",
    ("PUT", "/api/playground/sessions/{chat_id}"): "viewer",
    ("DELETE", "/api/playground/sessions/{chat_id}"): "viewer",
    ("GET", "/api/models/{name}/versions/{number}/card"): "viewer",
    ("GET", "/api/models/{name}/versions/{number}/card.json"): "viewer",
    ("GET", "/api/models/{name}/versions/{number}/card.md"): "viewer",
    ("GET", "/api/models/{name}/versions/{number}/aibom.json"): "viewer",
    ("GET", "/api/models/{name}/versions/{number}/files"): "viewer",
    ("GET", "/api/models/{name}/overview"): "viewer",
    ("GET", "/api/models/{name}/traffic"): "viewer",
    ("GET", "/api/models/{name}/activity"): "viewer",
    ("PUT", "/api/models/{name}/versions/{number}/card"): "builder",
    ("GET", "/api/feedback"): "builder",
    ("GET", "/api/feedback/facets"): "builder",
    ("GET", "/api/feedback/{feedback_id}"): "builder",
    ("POST", "/api/feedback/{feedback_id}/review"): "builder",
    ("POST", "/api/feedback/{feedback_id}/assign"): "builder",
    ("POST", "/api/models/{name}/feedback"): "viewer",
    ("GET", "/api/models/{name}/feedback/summary"): "viewer",
    ("POST", "/api/models/{name}/test-examples"): "builder",
    ("GET", "/api/models/{name}/test-examples"): "builder",
    ("GET", "/api/keys"): "builder",
    ("POST", "/api/keys"): "builder",
    ("PUT", "/api/keys/{key_id}/models"): "builder",
    ("DELETE", "/api/keys/{key_id}"): "builder",
    ("GET", "/api/jobs"): "viewer",
    ("GET", "/api/jobs/facets"): "viewer",
    ("GET", "/api/jobs/{job_id}"): "viewer",
    ("GET", "/api/jobs/{job_id}/events"): "viewer",
    ("GET", "/api/jobs/{job_id}/metrics"): "viewer",
    ("POST", "/api/jobs/cancel"): "builder",
    ("POST", "/api/jobs/retry"): "builder",
    ("POST", "/api/jobs/delete"): "builder",
    ("DELETE", "/api/jobs/{job_id}"): "builder",
    ("POST", "/api/jobs/{job_id}/cancel"): "builder",
    ("POST", "/api/jobs/{job_id}/retry"): "builder",
    ("GET", "/api/requests"): "viewer",
    ("GET", "/api/requests/facets"): "viewer",
    ("GET", "/api/requests/summary"): "viewer",
    ("GET", "/api/requests/overview"): "viewer",
    ("GET", "/api/requests/{request_id}"): "viewer",
    ("GET", "/api/artifacts/{artifact_id}"): "builder",
    ("GET", "/api/system/install"): "admin",
    ("GET", "/api/system/diagnostics"): "admin",
    ("GET", "/api/system"): "viewer",
    ("GET", "/api/settings/storage"): "admin",
    ("PUT", "/api/settings/storage"): "admin",
    ("POST", "/api/settings/storage/test"): "admin",
    ("GET", "/api/system/infrastructure"): "viewer",
    ("GET", "/api/settings"): "viewer",
    ("GET", "/api/openapi/v1.json"): "viewer",
    ("GET", "/api/openapi/api.json"): "viewer",
}


def api_routes(routes: list[Any]) -> Iterator[APIRoute]:
    for route in routes:
        if hasattr(route, "original_router"):
            yield from api_routes(route.original_router.routes)
        elif isinstance(route, APIRoute) and route.path.startswith("/api/"):
            yield route


def guards_of(route: APIRoute) -> list[str]:
    return [found.call.name for found in route.dependant.dependencies if isinstance(found.call, Guard)]


def test_every_api_route_states_its_role(harness: Harness) -> None:
    found: dict[tuple[str, str], str] = {}
    for route in api_routes(harness.app.routes):
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
    admin: TestClient
    builder: TestClient
    viewer: TestClient
    nobody: TestClient


def team_of(harness: Harness) -> Team:
    return Team(
        admin=harness.client,
        builder=harness.person(Role.BUILDER),
        viewer=harness.person(Role.VIEWER),
        nobody=harness.person(None),
    )


@pytest.fixture
def team(harness: Harness) -> Team:
    return team_of(harness)


def status(client: TestClient, method: str, path: str, body: Any = None) -> int:
    headers = csrf(client) if method != "GET" else {}
    return client.request(method, path, json=body, headers=headers).status_code


def triage_body(client: TestClient) -> dict[str, Any]:
    dataset = blank_dataset(client, csrf(client))
    return {"name": "Triage", "preset": "classify", "labels": ["billing", "bug"], "dataset": dataset}


def test_viewers_see_models_but_change_nothing(team: Team) -> None:
    assert status(team.builder, "POST", "/api/models", triage_body(team.builder)) == 201
    viewer = team.viewer
    assert status(viewer, "GET", "/api/models") == 200
    assert status(viewer, "GET", "/api/models/triage") == 200
    assert status(viewer, "GET", "/api/models") == 200
    assert status(viewer, "GET", "/api/jobs") == 200
    assert status(viewer, "GET", "/api/system/infrastructure") == 200
    refused = viewer.post("/api/models", json=triage_body(team.builder) | {"name": "Other"}, headers=csrf(viewer))
    assert refused.status_code == 403 and refused.json()["detail"] == "This needs the Builder role"
    assert status(viewer, "GET", "/api/sources") == 403
    assert status(viewer, "GET", "/api/models/triage/preview") == 403
    assert status(viewer, "GET", "/api/keys") == 403
    assert status(viewer, "GET", "/api/feedback") == 403
    assert status(viewer, "DELETE", "/api/models/triage") == 403
    assert status(viewer, "GET", "/api/policies") == 403
    assert status(viewer, "GET", "/api/accounts") == 403


def test_builders_build_but_do_not_run_the_install(team: Team) -> None:
    builder = team.builder
    assert status(builder, "POST", "/api/models", triage_body(builder)) == 201
    assert status(builder, "GET", "/api/sources") == 200
    assert status(builder, "GET", "/api/keys") == 200
    body = {"name": "app", "models": [{"kind": "custom", "key": "triage"}]}
    assert status(builder, "POST", "/api/keys", body) == 201
    assert status(builder, "POST", "/api/models/triage/deploy", {"deployed": True}) in {200, 409, 422}
    refused = builder.put("/api/policies/request_bodies", json={"value": True}, headers=csrf(builder))
    assert refused.status_code == 403 and refused.json()["detail"] == "This needs the Admin role"
    assert status(builder, "GET", "/api/audit") == 403
    assert status(builder, "GET", "/api/accounts") == 403
    assert status(builder, "GET", "/api/system/install") == 403
    assert status(builder, "PATCH", "/api/models/triage", {"description": "Tickets"}) == 200
    assert status(builder, "POST", "/api/catalog/sync") == 403
    assert status(builder, "PUT", "/api/settings/data", {"row_limit": 1000}) == 403


def test_base_models_need_an_admin_to_change_or_delete(harness: Harness, team: Team) -> None:
    add_base(harness)
    refused = team.builder.patch(f"/api/models/{BASE}", json={"description": "Mine"}, headers=csrf(team.builder))
    assert refused.status_code == 403 and refused.json()["detail"] == "This needs the Admin role"
    assert status(team.builder, "DELETE", f"/api/models/{BASE}") == 403
    assert status(team.viewer, "GET", f"/api/models/{BASE}") == 200
    assert status(team.admin, "PATCH", f"/api/models/{BASE}", {"description": "Shared"}) == 200


def test_admins_reach_everything(team: Team) -> None:
    admin = team.admin
    assert status(admin, "PUT", "/api/policies/request_bodies", {"value": False}) == 200
    assert status(admin, "GET", "/api/audit") == 200
    assert status(admin, "GET", "/api/system/install") == 200
    assert status(admin, "GET", "/api/accounts") == 200


def test_people_without_a_role_see_nothing(team: Team) -> None:
    nobody = team.nobody
    refused = nobody.get("/api/models")
    assert refused.status_code == 403 and "Ask an admin" in refused.json()["detail"]
    person = nobody.get("/api/auth/session").json()["person"]
    assert (person["email"], person["role"]) == ("nobody@example.com", None)
    assert status(nobody, "POST", "/api/auth/logout") == 204


def finish_with_mistakes(harness: Harness) -> None:
    finish(harness, "eval", accuracy=0.9)


def test_viewers_get_scores_without_data_rows(harness: Harness) -> None:
    create_with_dataset(harness)
    add_version(harness, "prompt")
    finish_with_mistakes(harness)
    people = team_of(harness)
    path = f"/api/models/{SLUG}/versions"
    assert [len(version["mistakes"]) for version in people.admin.get(path).json()] == [3, 0]
    assert [len(version["mistakes"]) for version in people.builder.get(path).json()] == [3, 0]
    seen = people.viewer.get(path).json()
    assert [version["mistakes"] for version in seen] == [[], []]
    assert seen[0]["score"] == 0.9
    job = next(item["id"] for item in people.admin.get("/api/jobs").json()["items"] if item["kind"] == "eval")
    assert people.admin.get(f"/api/jobs/{job}").json()["result"] is not None
    assert people.viewer.get(f"/api/jobs/{job}").json()["result"] is None
    detail = people.viewer.get(f"/api/models/{SLUG}").json()
    assert all(check["examples"] == [] for check in detail["dataset_version"]["checks"])


def test_fastapi_doc_paths_are_not_served(harness: Harness) -> None:
    harness.settings.web_dist.mkdir(parents=True, exist_ok=True)
    (harness.settings.web_dist / "index.html").write_text("<!doctype html>")
    anonymous = TestClient(harness.app)
    for path in ("/docs", "/redoc", "/openapi.json", "/docs/oauth2-redirect"):
        assert anonymous.get(path).status_code == 404
        assert harness.client.get(path).status_code == 404
    assert anonymous.get("/developers").status_code == 200


def test_the_api_reference_needs_a_role(harness: Harness) -> None:
    people = team_of(harness)
    for path in ("/api/openapi/v1.json", "/api/openapi/api.json"):
        assert TestClient(harness.app).get(path).status_code == 401
        assert people.nobody.get(path).status_code == 403
        assert people.viewer.get(path).status_code == 200
