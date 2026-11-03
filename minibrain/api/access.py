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
from minibrain.auth.gate import FORWARDED_HEADERS, Identity, RequestFacts, identify
from minibrain.auth.identity import CURRENT, Person
from minibrain.auth.roles import LABELS, Role, allows
from minibrain.registry.models import SIGNED_IN

API_PREFIX = "/api/"
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


def facts_of(scope: Scope) -> RequestFacts:
    headers = Headers(scope=scope)
    cookies = cookie_parser(headers.get("cookie", ""))
    server = scope.get("server")
    client = scope.get("client")
    return RequestFacts(
        path=scope["path"],
        method=scope["method"],
        token=cookies.get(SESSION_COOKIE) or None,
        csrf=headers.get(CSRF_HEADER),
        server=server[0] if server else None,
        client=client[0] if client else None,
        user_agent=headers.get("user-agent"),
        forwarded=any(name in headers for name in FORWARDED_HEADERS),
    )


def resolve(state: Any, facts: RequestFacts) -> Identity:
    with state.sessions() as session:
        found = identify(session, state.settings.listen, state.accounts_on, facts)
        session.commit()
    if found.users:
        state.accounts_on = True
    return found


def refusal(found: Identity, facts: RequestFacts, key: bytes) -> tuple[int, str] | None:
    if facts.path in PUBLIC_PATHS:
        return None
    if found.person is None:
        return 401, SIGN_IN_NEEDED
    unsafe = facts.method not in SAFE_METHODS
    if unsafe and found.csrf_subject is not None and not csrf_matches(key, found.csrf_subject, facts.csrf):
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
        signed_in = (person.actor, person.source) if person is not None and person.signed_in else None
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


public = Guard(level=None, public=True)
signed_in = Guard(level=None)
viewer = Guard(level=Role.VIEWER)
builder = Guard(level=Role.BUILDER)
admin = Guard(level=Role.ADMIN)

IdentityDep = Annotated[Identity, Depends(identity_of)]
