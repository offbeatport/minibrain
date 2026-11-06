from typing import Any

from fastapi import Request
from fastapi.exception_handlers import request_validation_exception_handler
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse, Response

CHAT_PATHS = frozenset({"/v1/chat/completions", "/api/playground/chat/completions"})


class OpenAIError(Exception):
    def __init__(
        self, status_code: int, message: str, param: str | None = None, code: str | None = None, kind: str = ""
    ) -> None:
        super().__init__(message)
        self.status_code = status_code
        self.message = message
        self.param = param
        self.code = code
        self.kind = kind or "invalid_request_error"

    def body(self) -> dict[str, Any]:
        return {"error": {"message": self.message, "type": self.kind, "param": self.param, "code": self.code}}


def invalid(param: str, message: str, code: str = "invalid_value") -> OpenAIError:
    return OpenAIError(400, message, param, code)


async def openai_error(_request: Request, error: Exception) -> JSONResponse:
    found = error if isinstance(error, OpenAIError) else OpenAIError(500, str(error), kind="server_error")
    return JSONResponse(status_code=found.status_code, content=found.body())


def openai_validation(error: RequestValidationError) -> OpenAIError:
    first = error.errors()[0] if error.errors() else {"loc": (), "msg": "The body is not valid."}
    parts = [str(part) for part in first.get("loc", ()) if part != "body"]
    param = ".".join(parts) or None
    message = f"{param}: {first.get('msg')}" if param else str(first.get("msg"))
    return OpenAIError(400, message, param, "invalid_value")


async def invalid_body(request: Request, error: Exception) -> Response:
    if not isinstance(error, RequestValidationError):
        return await openai_error(request, error)
    if request.url.path not in CHAT_PATHS:
        return await request_validation_exception_handler(request, error)
    return await openai_error(request, openai_validation(error))
