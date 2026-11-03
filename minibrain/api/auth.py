from typing import Literal
from urllib.parse import quote

from fastapi import APIRouter, Depends, Request, Response
from fastapi.responses import RedirectResponse
from pydantic import BaseModel, Field

from minibrain.api.access import IdentityDep, public, signed_in
from minibrain.api.deps import SessionDep
from minibrain.auth.accounts import (
    LOCAL,
    OIDC,
    SESSION_COOKIE,
    TURNED_OFF,
    SignInError,
    claim_first_admin,
    commit_first_admin,
    create_local,
    csrf_for,
    end_session,
    external_user,
    lifetimes,
    person_for,
    person_of,
    redeem_reset,
    sign_in,
    start_session,
)
from minibrain.auth.addresses import loopback_name
from minibrain.auth.config import AuthConfig
from minibrain.auth.gate import Identity
from minibrain.auth.identity import Person
from minibrain.auth.oidc import PENDING_COOKIE, PENDING_PATH, PENDING_SECONDS, OidcClient, OidcError, seal, unseal
from minibrain.auth.roles import Role
from minibrain.registry.models import AuditEvent, LoginSession, User, peer_address

router = APIRouter(prefix="/api/auth", tags=["auth"])

FAILED_ACTOR_LENGTH = 200


class PersonInfo(BaseModel):
    id: int | None
    name: str
    email: str | None
    source: str
    role: Role | None
    role_locked: bool


class SignInMethods(BaseModel):
    local: bool = True
    oidc: str | None = None
    proxy: bool = False


class SessionInfo(BaseModel):
    accounts: bool
    setup: bool
    person: PersonInfo | None
    csrf_token: str | None
    methods: SignInMethods
    reason: Literal["listen", "remote", "sign_in"] | None


class SignInBody(BaseModel):
    email: str = Field(max_length=FAILED_ACTOR_LENGTH)
    password: str = Field(max_length=1024)


class SetupBody(BaseModel):
    email: str
    name: str = ""
    password: str


class ResetBody(BaseModel):
    token: str = Field(min_length=1, max_length=200)
    password: str


def person_info(person: Person | None) -> PersonInfo | None:
    if person is None:
        return None
    return PersonInfo(
        id=person.id,
        name=person.name,
        email=person.email,
        source=person.source,
        role=person.role,
        role_locked=person.role_locked,
    )


def methods_of(request: Request) -> SignInMethods:
    config: AuthConfig = request.app.state.auth
    return SignInMethods(proxy=config.proxy is not None, oidc=config.oidc.label if config.oidc else None)


def session_info(request: Request, found: Identity, person: Person | None, csrf_subject: str | None) -> SessionInfo:
    key: bytes = request.app.state.csrf_key
    return SessionInfo(
        accounts=found.accounts,
        setup=not found.users,
        person=person_info(person),
        csrf_token=csrf_for(key, csrf_subject) if csrf_subject else None,
        methods=methods_of(request),
        reason=found.reason,
    )


def secure_cookie(request: Request) -> bool:
    return request.url.scheme == "https" or not loopback_name(request.url.hostname)


def set_session_cookie(request: Request, response: Response, token: str, seconds: int) -> None:
    response.set_cookie(
        SESSION_COOKIE,
        token,
        max_age=seconds,
        httponly=True,
        secure=secure_cookie(request),
        samesite="lax",
        path="/",
    )


def clear_session_cookie(request: Request, response: Response) -> None:
    response.delete_cookie(SESSION_COOKIE, httponly=True, secure=secure_cookie(request), samesite="lax", path="/")


def signed_in_info(request: Request, response: Response, session: SessionDep, user: User) -> SessionInfo:
    row, token = start_session(session, user, peer_address(), request.headers.get("user-agent"))
    audit_sign_in(session, user, row)
    session.commit()
    set_session_cookie(request, response, token, int(lifetimes(session).absolute.total_seconds()))
    signed = Identity(person=person_for(session, user, request.app.state.auth), accounts=True, users=True)
    return session_info(request, signed, signed.person, f"session:{row.token_hash}")


def audit_sign_in(session: SessionDep, user: User, row: LoginSession) -> None:
    person = person_of(user)
    detail = {"sign_in": user.source, "session": row.id}
    session.add(AuditEvent(actor=person.actor, action="auth.sign_in", target=person.actor, detail=detail))


@router.get("/session", dependencies=[Depends(public)])
def current_session(request: Request, found: IdentityDep) -> SessionInfo:
    return session_info(request, found, found.person, found.csrf_subject)


@router.post("/login", dependencies=[Depends(public)])
def login(body: SignInBody, request: Request, response: Response, session: SessionDep) -> SessionInfo:
    try:
        user = sign_in(session, body.email, body.password)
    except SignInError as error:
        typed = body.email.strip().lower()[:FAILED_ACTOR_LENGTH] or "unknown"
        detail = {"sign_in": LOCAL, "reason": str(error)}
        session.add(AuditEvent(actor=typed, action="auth.sign_in_failed", target=typed, detail=detail))
        session.commit()
        raise
    return signed_in_info(request, response, session, user)


@router.post("/logout", status_code=204, dependencies=[Depends(signed_in)])
def logout(request: Request, response: Response, session: SessionDep, found: IdentityDep) -> None:
    token = request.cookies.get(SESSION_COOKIE)
    person = found.person
    if token:
        end_session(session, token)
    if person is not None and person.signed_in:
        session.add(AuditEvent(actor=person.actor, action="auth.sign_out", target=person.actor, detail={}))
    session.commit()
    clear_session_cookie(request, response)


@router.post("/setup", dependencies=[Depends(public)])
def setup(body: SetupBody, request: Request, response: Response, session: SessionDep) -> SessionInfo:
    claim_first_admin(session)
    user = create_local(session, body.email, body.name, Role.ADMIN, body.password)
    person = person_of(user)
    detail = {"name": user.name, "role": Role.ADMIN.value, "source": LOCAL, "first_admin": True}
    session.add(AuditEvent(actor=person.actor, action="account.create", target=person.actor, detail=detail))
    commit_first_admin(session)
    return signed_in_info(request, response, session, user)


@router.post("/reset", dependencies=[Depends(public)])
def reset(body: ResetBody, request: Request, response: Response, session: SessionDep) -> SessionInfo:
    user = redeem_reset(session, body.token, body.password)
    person = person_of(user)
    session.add(AuditEvent(actor=person.actor, action="account.password", target=person.actor, detail={}))
    session.flush()
    return signed_in_info(request, response, session, user)


def oidc_client(request: Request) -> OidcClient:
    client: OidcClient | None = request.app.state.oidc
    if client is None:
        raise OidcError("Single sign-on is not set up on this install")
    return client


def callback_url(request: Request, client: OidcClient) -> str:
    return client.config.redirect_url or str(request.url_for("oidc_callback"))


def failed_sign_in(message: str) -> RedirectResponse:
    response = RedirectResponse(f"/?sign_in_error={quote(message)}", status_code=303)
    response.delete_cookie(PENDING_COOKIE, path=PENDING_PATH)
    return response


@router.get("/oidc/start", dependencies=[Depends(public)], response_class=RedirectResponse)
def oidc_start(request: Request, next: str = "/") -> RedirectResponse:
    try:
        client = oidc_client(request)
        url, pending = client.start(callback_url(request, client), next)
    except OidcError as error:
        return failed_sign_in(str(error))
    response = RedirectResponse(url, status_code=303)
    response.set_cookie(
        PENDING_COOKIE,
        seal(request.app.state.csrf_key, pending),
        max_age=PENDING_SECONDS,
        httponly=True,
        secure=secure_cookie(request),
        samesite="lax",
        path=PENDING_PATH,
    )
    return response


@router.get("/oidc/callback", dependencies=[Depends(public)], response_class=RedirectResponse, name="oidc_callback")
def oidc_callback(
    request: Request,
    session: SessionDep,
    code: str = "",
    state: str = "",
    error: str = "",
    error_description: str = "",
) -> RedirectResponse:
    try:
        client = oidc_client(request)
        if error or not code:
            raise OidcError(error_description or error or "The identity provider sent no sign-in code")
        pending = unseal(request.app.state.csrf_key, request.cookies.get(PENDING_COOKIE))
        claims = client.finish(callback_url(request, client), pending, code, state)
    except OidcError as failure:
        return failed_sign_in(str(failure))
    user, created = external_user(session, OIDC, claims.subject, claims.email, claims.name, claims.groups)
    person = person_of(user)
    if created:
        detail = {"name": user.name, "source": OIDC, "groups": list(user.groups or [])}
        session.add(AuditEvent(actor=person.actor, action="account.create", target=person.actor, detail=detail))
    if user.disabled:
        detail = {"sign_in": OIDC, "reason": TURNED_OFF}
        session.add(AuditEvent(actor=person.actor, action="auth.sign_in_failed", target=person.actor, detail=detail))
        session.commit()
        return failed_sign_in(TURNED_OFF)
    response = RedirectResponse(pending.next, status_code=303)
    signed_in_info(request, response, session, user)
    response.delete_cookie(PENDING_COOKIE, path=PENDING_PATH)
    return response
