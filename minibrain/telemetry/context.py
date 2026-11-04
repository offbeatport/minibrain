import re
import time
import uuid
from typing import Any

from opentelemetry.trace import Span, Status, StatusCode
from starlette.datastructures import Headers
from starlette.types import ASGIApp, Message, Receive, Scope, Send

from minibrain.telemetry.call import CURRENT, Call
from minibrain.telemetry.instruments import Outcome
from minibrain.telemetry.runtime import Telemetry

REQUEST_ID_HEADER = "x-request-id"
REQUEST_ID = re.compile(r"[A-Za-z0-9._:-]{1,128}")
GATEWAY_PREFIX = "/v1/"
MODEL_MAX = 200
CLIENT_ERROR = 400
SERVER_ERROR = 500


def request_id_of(headers: Headers) -> str:
    incoming = headers.get(REQUEST_ID_HEADER, "").strip()
    return incoming if REQUEST_ID.fullmatch(incoming) else uuid.uuid4().hex


def server_of(scope: Scope, headers: Headers) -> tuple[str | None, int | None]:
    host = headers.get("host")
    if host:
        name, _, port = host.rpartition(":") if not host.endswith("]") and ":" in host else (host, "", "")
        return name.strip("[]"), int(port) if port.isdigit() else None
    server = scope.get("server")
    return (server[0], server[1]) if server else (None, None)


def route_of(scope: Scope) -> str:
    route = scope.get("route")
    return str(getattr(route, "path", "")) or scope["path"]


def span_attributes(call: Call, outcome: Outcome) -> dict[str, Any]:
    found: dict[str, Any] = {
        "http.request.method": outcome.method,
        "http.route": outcome.route,
        "http.response.status_code": outcome.status,
    }
    if call.operation:
        found |= {"gen_ai.operation.name": call.operation, "gen_ai.provider.name": "minibrain"}
    optional = {
        "gen_ai.request.model": call.request_model[:MODEL_MAX] if call.request_model else None,
        "gen_ai.response.model": call.response_model,
        "gen_ai.response.id": call.response_id,
        "gen_ai.request.max_tokens": call.max_tokens,
        "gen_ai.usage.input_tokens": call.input_tokens,
        "gen_ai.usage.output_tokens": call.output_tokens,
        "gen_ai.response.finish_reasons": list(call.finish_reasons) or None,
        "error.type": outcome.error_type,
    }
    found |= {key: value for key, value in optional.items() if value is not None}
    found |= {key: value for key, value in call.labels.items() if value is not None}
    return found


def span_name(call: Call, outcome: Outcome) -> str:
    if call.operation and call.request_model:
        return f"{call.operation} {call.request_model[:MODEL_MAX]}"
    return f"{outcome.method} {outcome.route}"


def finish(span: Span | None, call: Call, outcome: Outcome, failure: BaseException | None) -> None:
    if span is None:
        return
    span.update_name(span_name(call, outcome))
    span.set_attributes(span_attributes(call, outcome))
    if failure is not None:
        span.record_exception(failure)
    if outcome.status >= SERVER_ERROR or failure is not None:
        span.set_status(Status(StatusCode.ERROR))
    span.end()


def error_type(call: Call, status: int, failure: BaseException | None) -> str | None:
    if failure is not None:
        return type(failure).__qualname__
    if status < CLIENT_ERROR:
        return None
    return call.error_type or str(status)


class RequestContext:
    def __init__(self, app: ASGIApp) -> None:
        self.app = app

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return
        headers = Headers(scope=scope)
        call = Call(request_id=request_id_of(headers))
        token = CURRENT.set(call)
        telemetry: Telemetry | None = getattr(scope["app"].state, "telemetry", None)
        watched = telemetry is not None and scope["path"].startswith(GATEWAY_PREFIX) and telemetry.watching()
        started = time.monotonic()
        span = None
        if watched and telemetry is not None:
            address, port = server_of(scope, headers)
            first = {"server.address": address, "server.port": port, "url.scheme": scope.get("scheme")}
            carrier = {key: value for key, value in headers.items()}
            name = f"{scope['method']} {scope['path']}"
            span = telemetry.start_span(name, carrier, {key: value for key, value in first.items() if value})
        status = SERVER_ERROR

        async def tagged(message: Message) -> None:
            nonlocal status
            if message["type"] == "http.response.start":
                status = int(message["status"])
                extra = [(REQUEST_ID_HEADER.encode(), call.request_id.encode())]
                message = {**message, "headers": [*message.get("headers", []), *extra]}
            await send(message)

        failure: BaseException | None = None
        try:
            await self.app(scope, receive, tagged)
        except BaseException as error:
            failure = error
            raise
        finally:
            if watched and telemetry is not None:
                seconds = time.monotonic() - started
                kind = error_type(call, status, failure)
                outcome = Outcome(route_of(scope), scope["method"], status, seconds, kind)
                telemetry.record(call, outcome)
                finish(span, call, outcome, failure)
            CURRENT.reset(token)
