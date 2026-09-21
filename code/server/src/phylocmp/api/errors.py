"""One error shape, for every failure.

A frontend has to branch on failures, and branching on prose is how clients end
up matching substrings. Every error from this API carries:

``detail``
    A sentence for a human, naming the thing that went wrong and, where there
    is one, the way out. Kept under this name because it is what FastAPI and
    most OpenAPI tooling expect.
``code``
    A stable machine-readable identifier. This is what a client should switch
    on; ``detail`` may be reworded, ``code`` will not be.
``hint``
    Optional: the request that would answer the question. A 404 for an
    uncomputed comparison points at the CLI command that computes it.

Validation failures (422) are given the same shape, so there is exactly one
error contract rather than one for the application and another for the
framework.
"""

from __future__ import annotations

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field
from starlette.exceptions import HTTPException as StarletteHTTPException


class ErrorResponse(BaseModel):
    """The body of every non-2xx response."""

    detail: str = Field(description="Human-readable explanation.")
    code: str = Field(
        description="Stable identifier to branch on, e.g. 'tree_not_found'.",
        examples=["tree_not_found"],
    )
    hint: str | None = Field(
        None, description="Where to look next, or the command that fixes it."
    )


class ApiError(Exception):
    """Raised by routes. Carries the whole shape rather than only a message."""

    def __init__(self, status: int, code: str, detail: str, hint: str | None = None):
        super().__init__(detail)
        self.status = status
        self.code = code
        self.detail = detail
        self.hint = hint


def not_found(code: str, detail: str, hint: str | None = None) -> ApiError:
    return ApiError(404, code, detail, hint)


def bad_request(code: str, detail: str, hint: str | None = None) -> ApiError:
    return ApiError(400, code, detail, hint)


def unprocessable(code: str, detail: str, hint: str | None = None) -> ApiError:
    return ApiError(422, code, detail, hint)


def _body(detail: str, code: str, hint: str | None) -> dict:
    out = {"detail": detail, "code": code}
    if hint:
        out["hint"] = hint
    return out


#: Where pydantic says a value came from. Not part of the parameter's name.
_LOCATIONS = frozenset({"body", "query", "path", "header", "cookie"})


def _field(problem: dict) -> str:
    parts = [str(p) for p in problem.get("loc", ())]
    if parts and parts[0] in _LOCATIONS:
        parts = parts[1:]
    return ".".join(parts)


def install(app: FastAPI) -> None:
    """Attach handlers so every failure leaves by the same door."""

    @app.exception_handler(ApiError)
    async def _api_error(_: Request, exc: ApiError) -> JSONResponse:
        return JSONResponse(
            status_code=exc.status, content=_body(exc.detail, exc.code, exc.hint)
        )

    @app.exception_handler(StarletteHTTPException)
    async def _http_error(_: Request, exc: StarletteHTTPException) -> JSONResponse:
        # Raised by the framework itself (an unrouted path, a wrong method) and
        # by any HTTPException still in the codebase.
        code = {404: "not_found", 405: "method_not_allowed"}.get(
            exc.status_code, "http_error"
        )
        return JSONResponse(
            status_code=exc.status_code, content=_body(str(exc.detail), code, None)
        )

    @app.exception_handler(RequestValidationError)
    async def _validation_error(_: Request, exc: RequestValidationError) -> JSONResponse:
        # Pydantic prefixes each location with where it came from. The client
        # named the parameter, not "query.budget", so report it their way.
        # Pydantic reports a list of problems; the first is almost always the
        # one to act on, and the rest stay available under `errors`.
        problems = exc.errors()
        first = problems[0] if problems else {}
        where = _field(first)
        message = first.get("msg", "invalid request")
        body = _body(
            f"{where}: {message}" if where else message,
            "invalid_request",
            "See /docs for the parameter's accepted values.",
        )
        body["errors"] = [
            {
                "field": _field(problem),
                "message": problem.get("msg", ""),
            }
            for problem in problems
        ]
        return JSONResponse(status_code=422, content=body)
