import copy
from collections.abc import Iterator
from typing import Any

from fastapi import APIRouter, Depends, FastAPI, Request
from fastapi.routing import APIRoute

from minibrain.api.access import PUBLIC_PATHS, SAFE_METHODS, Guard, viewer
from minibrain.auth.accounts import SESSION_COOKIE
from minibrain.auth.roles import LABELS, Role

router = APIRouter(prefix="/api/openapi", tags=["reference"])

GATEWAY_PREFIX = "/v1"
MANAGEMENT_PREFIX = "/api/"
SCHEMA_REF = "#/components/schemas/"
CSRF_SCHEME = "csrf"
ACCESS_NOTES = {"public": "No sign-in needed.", "signed_in": "Needs a signed-in person."}

GATEWAY_INTRO = """Call minibrain models from any OpenAI client: set its base URL to this install's `/v1` and its \
API key to a minibrain key.

- A custom model's name follows its live version, `name@3` pins version 3, and a served base model goes by its key. \
`GET /models` lists the names a key can call.
- Keys are created on Deployments and cover one or more models; a call to a model the key does not cover gets 403.
- Sampling fields left out keep the model's default; `top_k`, `min_p` and `repetition_penalty` are the engine \
extensions vLLM and SGLang share.
- `tools` work with models whose chat template has a tool-call format (Qwen, Hermes, Llama 3.1 and later, Mistral, \
gpt-oss); answers carry `tool_calls`, and results go back as `tool` messages.
- `reasoning_effort` turns reasoning off (`none`) or sets its effort where the model supports it; the reasoning \
comes back as `reasoning_content`, apart from the answer.
- Send a completion's `id` to `POST /feedback` to rate or correct its answer."""

MANAGEMENT_INTRO = f"""The API the minibrain UI runs on: data, models, training, evaluations, deployments, keys, \
monitoring and settings. Each operation names the role it needs.

Calls carry a signed-in session, not an API key:

1. `POST /api/auth/login` with `email` and `password` sets the `{SESSION_COOKIE}` cookie and returns `csrf_token`.
2. Send the cookie with every call.
3. Send `X-CSRF-Token` with every POST, PUT, PATCH and DELETE.

Apps call models through the OpenAI-compatible `/v1` API with API keys instead."""

CSRF_HELP = "The csrf_token from POST /api/auth/login or GET /api/auth/session, on every POST, PUT, PATCH and DELETE."


def routes_of(routes: list[Any]) -> Iterator[APIRoute]:
    for route in routes:
        included = getattr(route, "original_router", None)
        if included is not None:
            yield from routes_of(included.routes)
        elif isinstance(route, APIRoute):
            yield route


def access_of(app: FastAPI) -> dict[tuple[str, str], str]:
    found: dict[tuple[str, str], str] = {}
    for route in routes_of(app.routes):
        guards = [item.call.name for item in route.dependant.dependencies if isinstance(item.call, Guard)]
        for method in route.methods or ():
            if guards:
                found[(method.lower(), route.path)] = guards[0]
    return found


def named_by_code(app: FastAPI) -> set[tuple[str, str]]:
    return {
        (method.lower(), route.path)
        for route in routes_of(app.routes)
        if route.summary is None
        for method in route.methods or ()
    }


def sentence_case(summary: str) -> str:
    return summary[:1].upper() + summary[1:].lower()


def access_note(access: str | None) -> str | None:
    if access is None:
        return None
    return ACCESS_NOTES.get(access) or f"Needs the {LABELS[Role(access)]} role."


def refs_in(node: Any) -> Iterator[str]:
    if isinstance(node, dict):
        ref = node.get("$ref")
        if isinstance(ref, str) and ref.startswith(SCHEMA_REF):
            yield ref.removeprefix(SCHEMA_REF)
        for value in node.values():
            yield from refs_in(value)
    elif isinstance(node, list):
        for value in node:
            yield from refs_in(value)


def used_schemas(paths: dict[str, Any], schemas: dict[str, Any]) -> dict[str, Any]:
    pending = list(refs_in(paths))
    found: dict[str, Any] = {}
    while pending:
        name = pending.pop()
        if name not in found and name in schemas:
            found[name] = schemas[name]
            pending.extend(refs_in(schemas[name]))
    return dict(sorted(found.items()))


def tags_of(paths: dict[str, Any]) -> list[dict[str, str]]:
    names = dict.fromkeys(
        tag for item in paths.values() for operation in item.values() for tag in operation.get("tags", [])
    )
    return [{"name": name, "x-displayName": name[:1].upper() + name[1:]} for name in names]


def document(
    full: dict[str, Any], title: str, intro: str, server: str, paths: dict[str, Any], schemes: dict[str, Any]
) -> dict[str, Any]:
    return {
        "openapi": full["openapi"],
        "info": {"title": title, "version": full["info"]["version"], "description": intro},
        "servers": [{"url": server}],
        "tags": tags_of(paths),
        "paths": paths,
        "components": {"schemas": used_schemas(paths, full["components"]["schemas"]), "securitySchemes": schemes},
    }


def gateway_document(full: dict[str, Any]) -> dict[str, Any]:
    paths = {
        path.removeprefix(GATEWAY_PREFIX): copy.deepcopy(item)
        for path, item in full["paths"].items()
        if path.startswith(f"{GATEWAY_PREFIX}/")
    }
    schemes = full["components"].get("securitySchemes", {})
    return document(full, "OpenAI-compatible API", GATEWAY_INTRO, GATEWAY_PREFIX, paths, schemes)


def annotated(operation: dict[str, Any], method: str, path: str, access: str | None, renamed: bool) -> dict[str, Any]:
    found = copy.deepcopy(operation)
    if renamed and found.get("summary"):
        found["summary"] = sentence_case(found["summary"])
    note = access_note(access)
    if note is not None:
        found["description"] = f"{note}\n\n{found['description']}" if found.get("description") else note
    if method.upper() not in SAFE_METHODS and path not in PUBLIC_PATHS:
        found["security"] = [{CSRF_SCHEME: []}]
    return found


def management_document(full: dict[str, Any], app: FastAPI) -> dict[str, Any]:
    access = access_of(app)
    renamed = named_by_code(app)
    paths = {
        path: {
            method: annotated(operation, method, path, access.get((method, path)), (method, path) in renamed)
            for method, operation in item.items()
        }
        for path, item in full["paths"].items()
        if path.startswith(MANAGEMENT_PREFIX)
    }
    schemes = {CSRF_SCHEME: {"type": "apiKey", "in": "header", "name": "X-CSRF-Token", "description": CSRF_HELP}}
    return document(full, "Management API", MANAGEMENT_INTRO, "/", paths, schemes)


@router.get("/v1.json", dependencies=[Depends(viewer)], summary="OpenAPI document for /v1")
def gateway_reference(request: Request) -> dict[str, Any]:
    return gateway_document(request.app.openapi())


@router.get("/api.json", dependencies=[Depends(viewer)], summary="OpenAPI document for /api")
def management_reference(request: Request) -> dict[str, Any]:
    return management_document(request.app.openapi(), request.app)
