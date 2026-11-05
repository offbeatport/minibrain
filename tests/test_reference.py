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
    assert set(document["paths"]) == {"/models", "/chat/completions", "/feedback"}
    assert document["info"]["version"] == library_version("minibrain")
    assert document["components"]["securitySchemes"]["apiKey"] == {
        "type": "http",
        "scheme": "bearer",
        "bearerFormat": "mb_...",
        "description": "A minibrain API key, created on Deployments. It covers one or more models.",
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
    assert paths["/api/minibrains"]["post"]["description"].startswith("Needs the Builder role.")
    assert paths["/api/minibrains"]["get"]["description"].startswith("Needs the Viewer role.")
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
