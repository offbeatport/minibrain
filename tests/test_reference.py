from typing import Any

from minibrain.api.reference import refs_in
from minibrain.versions import library_version
from tests.conftest import Harness
from tests.test_flow import SLUG, add_key, create_on_data, deploy, finish

UNSAFE = ("post", "put", "patch", "delete")


def dangling(document: dict[str, Any]) -> set[str]:
    return set(refs_in(document)) - set(document["components"]["schemas"])


def test_the_gateway_reference_covers_v1_from_its_base_url(harness: Harness) -> None:
    document = harness.client.get("/api/openapi/v1.json").json()
    assert document["servers"] == [{"url": "/v1"}]
    assert set(document["paths"]) == {"/models", "/chat/completions", "/completions", "/feedback"}
    assert document["info"]["version"] == library_version("minibrain")
    assert document["components"]["securitySchemes"]["apiKey"] == {
        "type": "http",
        "scheme": "bearer",
        "bearerFormat": "mb_...",
        "description": "A minibrain API key, created on the API keys page. "
        "It covers one or more models, or all models.",
    }
    operations = [operation for item in document["paths"].values() for operation in item.values()]
    assert all(operation["security"] == [{"apiKey": []}] for operation in operations)
    chat = document["paths"]["/chat/completions"]["post"]
    assert chat["responses"]["200"]["content"]["application/json"]["schema"] == {
        "$ref": "#/components/schemas/ChatCompletion"
    }
    assert "text/event-stream" in chat["responses"]["200"]["content"]
    assert dangling(document) == set()


def test_the_management_reference_names_roles_and_csrf(harness: Harness) -> None:
    document = harness.client.get("/api/openapi/api.json").json()
    assert all(path.startswith("/api/") for path in document["paths"])
    paths = document["paths"]
    assert paths["/api/models"]["post"]["description"].startswith("Needs the Builder role.")
    assert paths["/api/models"]["get"]["description"].startswith("Needs the Viewer role.")
    assert paths["/api/policies"]["get"]["description"].startswith("Needs the Admin role.")
    assert paths["/api/auth/login"]["post"]["description"] == "No sign-in needed."
    assert "security" not in paths["/api/auth/login"]["post"]
    unsafe = [operation for item in paths.values() for method, operation in item.items() if method in UNSAFE]
    guarded = [operation for operation in unsafe if operation["description"] != "No sign-in needed."]
    assert guarded and all(operation["security"] == [{"csrf": []}] for operation in guarded)
    assert document["components"]["securitySchemes"]["csrf"]["name"] == "X-CSRF-Token"
    assert dangling(document) == set()


def test_v1_models_keeps_its_openai_shape(harness: Harness) -> None:
    create_on_data(harness)
    finish(harness, "eval", accuracy=0.4)
    deploy(harness)
    secret = add_key(harness)["secret"]
    listed = harness.client.get("/v1/models", headers={"Authorization": f"bearer {secret}"})
    assert listed.json() == {
        "object": "list",
        "data": [
            {"id": name, "object": "model", "created": 0, "owned_by": "minibrain"} for name in (SLUG, f"{SLUG}@0")
        ],
    }
    assert harness.client.get("/v1/models", headers={"Authorization": f"Basic {secret}"}).status_code == 401
    assert harness.client.get("/v1/models").status_code == 401


def test_internal_and_operator_routes_stay_out_of_the_schema(harness: Harness) -> None:
    paths = set(harness.app.openapi()["paths"])
    assert paths and all(path.startswith(("/v1/", "/api/")) for path in paths)
    assert harness.client.get("/healthz").status_code == 200


def test_the_two_references_say_who_they_are_for(harness: Harness) -> None:
    gateway = harness.client.get("/api/openapi/v1.json").json()["info"]
    management = harness.client.get("/api/openapi/api.json").json()["info"]
    assert gateway["title"] == "OpenAI-compatible API"
    assert gateway["description"].startswith("**Stable. For apps. Drop-in for the OpenAI API.**")
    assert all(term in gateway["description"] for term in ("Base URL", "API name", "name@N", "Keys"))
    assert management["title"] == "Management API"
    assert management["description"].startswith("**For the minibrain UI and automation. May change between versions.**")


def test_every_management_route_has_one_section(harness: Harness) -> None:
    document = harness.client.get("/api/openapi/api.json").json()
    paths = document["paths"]
    operations = [operation for item in paths.values() for operation in item.values()]
    assert all(len(operation["tags"]) == 1 for operation in operations)
    names = [tag["name"] for tag in document["tags"]]
    assert {operation["tags"][0] for operation in operations} == set(names)
    groups = document["x-tagGroups"]
    assert [group["name"] for group in groups] == ["Build", "Operate", "Administer"]
    assert sorted(tag for group in groups for tag in group["tags"]) == sorted(names)
    assert paths["/api/models/{name}"]["get"]["tags"] == ["Models"]
    assert paths["/api/models/{name}/versions"]["get"]["tags"] == ["Versions"]
    assert paths["/api/models/{name}/dataset"]["put"]["tags"] == ["Data"]
    assert paths["/api/models/{name}/traffic"]["get"]["tags"] == ["Monitoring"]
    assert paths["/api/settings/data"]["put"]["tags"] == ["Settings"]
    assert paths["/api/models/{name}"]["patch"]["description"].startswith("Needs the Builder role.")
