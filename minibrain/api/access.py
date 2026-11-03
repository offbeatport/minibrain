from dataclasses import dataclass
from functools import partial
from typing import Annotated, Any

import anyio
from fastapi import Depends, HTTPException, Request
from fastapi.responses import JSONResponse
from starlette.datastructures import Headers
from starlette.requests import cookie_parser
from starlette.types import ASGIApp, Receive, Scope, Send

from minibrain.auth.accounts import CSRF_HEADER, SESSION_COOKIE, csrf_matches
from minibrain.auth.addresses import ip_of
from minibrain.auth.config import ProxyConfig
from minibrain.auth.gate import Identity, RequestFacts, identify
from minibrain.auth.identity import CURRENT, Person, current_role
from minibrain.auth.roles import LABELS, Role, allows
from minibrain.registry.models import SIGNED_IN

API_PREFIX = "/api/"
VIA_PROXY = "minibrain.via_proxy"
FORWARDED_SCHEMES = {"http": ("http", "https"), "websocket": ("ws", "wss")}
SAFE_METHODS = frozenset({"GET", "HEAD", "OPTIONS"})
PUBLIC_PATHS = frozenset(
    {
        "/api/auth/session",
        "/api/auth/login",
        "/api/auth/setup",
        "/api/auth/reset",
        "/api/auth/oidc/start",
        "/api/auth/oidc/callback",
    }
)
SIGN_IN_NEEDED = "Sign in to use minibrain"
CSRF_MISSING = "This request has no valid CSRF token. Reload the page and try again."
NO_ROLE = "You do not have access yet. Ask an admin to give you a role."


def forwarded_client(value: str | None, proxy: ProxyConfig) -> str | None:
    hops = [hop.strip() for hop in (value or "").split(",") if hop.strip()]
    for hop in reversed(hops):
        if not proxy.trusts(hop):
            return hop if ip_of(hop) is not None else None
    return hops[0] if hops else None


class TrustedProxy:
    def __init__(self, app: ASGIApp) -> None:
        self.app = app

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        proxy = scope["app"].state.auth.proxy if scope["type"] in ("http", "websocket") else None
        client = scope.get("client")
        if proxy is not None and client and proxy.trusts(client[0]):
            headers = Headers(scope=scope)
            scope = dict(scope)
            scope[VIA_PROXY] = True
            forwarded = forwarded_client(headers.get("x-forwarded-for"), proxy)
            if forwarded:
                scope["client"] = (forwarded, 0)
            scheme = headers.get("x-forwarded-proto", "").split(",")[0].strip().lower()
            if scheme in FORWARDED_SCHEMES[scope["type"]]:
                scope["scheme"] = scheme
        await self.app(scope, receive, send)


def facts_of(scope: Scope) -> RequestFacts:
    headers = Headers(scope=scope)
    cookies = cookie_parser(headers.get("cookie", ""))
    return RequestFacts(
        path=scope["path"],
        method=scope["method"],
        token=cookies.get(SESSION_COOKIE) or None,
        csrf=headers.get(CSRF_HEADER),
        via_proxy=bool(scope.get(VIA_PROXY)),
        headers={name.decode("latin-1").lower(): value.decode("latin-1") for name, value in scope["headers"]},
    )


def resolve(state: Any, facts: RequestFacts) -> Identity:
    with state.sessions() as session:
        found = identify(session, facts, state.auth)
        session.commit()
    return found


def refusal(found: Identity, facts: RequestFacts, key: bytes) -> tuple[int, str] | None:
    if found.refused is not None:
        return 403, found.refused
    if facts.path in PUBLIC_PATHS:
        return None
    if found.person is None:
        return 401, SIGN_IN_NEEDED
    unsafe = facts.method not in SAFE_METHODS
    if unsafe and (found.csrf_subject is None or not csrf_matches(key, found.csrf_subject, facts.csrf)):
        return 403, CSRF_MISSING
    return None


class Identify:
    def __init__(self, app: ASGIApp) -> None:
        self.app = app

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http" or not scope["path"].startswith(API_PREFIX):
            await self.app(scope, receive, send)
            return
        state = scope["app"].state
        facts = facts_of(scope)
        found = await anyio.to_thread.run_sync(partial(resolve, state, facts))
        refused = refusal(found, facts, state.csrf_key)
        if refused is not None:
            await JSONResponse(status_code=refused[0], content={"detail": refused[1]})(scope, receive, send)
            return
        scope.setdefault("state", {})["identity"] = found
        person = found.person
        signed_in = (person.actor, person.source) if person is not None else None
        person_token = CURRENT.set(person)
        signed_token = SIGNED_IN.set(signed_in)
        try:
            await self.app(scope, receive, send)
        finally:
            SIGNED_IN.reset(signed_token)
            CURRENT.reset(person_token)


def identity_of(request: Request) -> Identity:
    found = getattr(request.state, "identity", None)
    if found is None:
        raise HTTPException(status_code=401, detail=SIGN_IN_NEEDED)
    return found


@dataclass(frozen=True)
class Guard:
    level: Role | None
    public: bool = False

    @property
    def name(self) -> str:
        if self.public:
            return "public"
        return self.level.value if self.level is not None else "signed_in"

    def __call__(self, request: Request) -> Person | None:
        found = identity_of(request)
        if self.public:
            return found.person
        person = found.person
        if person is None:
            raise HTTPException(status_code=401, detail=SIGN_IN_NEEDED)
        if self.level is None:
            return person
        if person.role is None:
            raise HTTPException(status_code=403, detail=NO_ROLE)
        if not allows(person.role, self.level):
            raise HTTPException(status_code=403, detail=f"This needs the {LABELS[self.level]} role")
        return person


def sees_rows() -> bool:
    return allows(current_role(), Role.BUILDER)


public = Guard(level=None, public=True)
signed_in = Guard(level=None)
viewer = Guard(level=Role.VIEWER)
builder = Guard(level=Role.BUILDER)
admin = Guard(level=Role.ADMIN)

IdentityDep = Annotated[Identity, Depends(identity_of)]
