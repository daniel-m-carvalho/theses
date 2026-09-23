"""One interceptor, in front of every route.

**Why middleware and not a dependency on each route.** The previous design put
`Depends(current_owner)` on every endpoint, and that is exactly how an endpoint
gets missed: threading ownership through seven routes by hand, one was left
unscoped (§22.3), and it was found by enumerating the OpenAPI document rather
than by reading the diff. A check you have to remember to add is a check that
will eventually not be added.

Middleware inverts it. Authentication happens before routing, so a new route is
protected by existing, and forgetting is not possible — the only way to make an
endpoint public is to name it in `PUBLIC_PATHS`, which is a visible, reviewable
list rather than an absence.

**Route handlers contain no authentication logic.** They receive an owner id
through a dependency that does nothing but read what this middleware already
resolved. Nothing downstream — routes, services, models — can tell which
interceptor ran.

**It fails closed.** Any error becomes a refusal. An interceptor that throws
must not produce an unauthenticated request that routes then treat as
ordinary.
"""

from __future__ import annotations

import logging

from starlette.middleware.base import BaseHTTPMiddleware
from starlette.responses import JSONResponse

from .. import errors
from .interceptors import Interceptor, select

log = logging.getLogger("phylodelta.auth")

#: Reachable without a principal. Deliberately short, and deliberately a
#: literal list: an endpoint is public because it is written here, never
#: because a decorator was forgotten.
#:
#: `/health` is public so an orchestrator can check liveness without holding
#: credentials — it reports that the service is up and how deep the queue is,
#: and nothing about anyone's data. The documentation routes describe the
#: contract, which is public by intent.
PUBLIC_PATHS = frozenset(
    {
        "/api/v1/health",
        "/docs",
        "/docs/oauth2-redirect",
        "/redoc",
        "/openapi.json",
        "/favicon.ico",
    }
)


def _refuse(error: errors.ApiError) -> JSONResponse:
    """The same body shape every other failure uses.

    Built here rather than raised, because middleware runs outside the
    application's exception handlers — raising would produce a bare 500 and
    lose the contract that a client branches on.
    """
    body = {"detail": error.detail, "code": error.code, "hint": error.hint}
    headers = {}
    if error.status == 401:
        # So a browser or client library knows what to present. Named as a
        # scheme rather than a provider: which issuer is a deployment's choice.
        headers["WWW-Authenticate"] = "Bearer"
    return JSONResponse(body, status_code=error.status, headers=headers)


class AuthenticationMiddleware(BaseHTTPMiddleware):
    """Resolves every request to a principal before it reaches a route."""

    def __init__(self, app, interceptor: Interceptor | None = None):
        super().__init__(app)
        # Built once, at startup. A misconfigured JWT setup therefore fails
        # when the process starts rather than on the first request that needed
        # it to work.
        self._interceptor = interceptor or select()
        if getattr(self._interceptor, "name", "") == "mock":
            log.warning(
                "PhyloDelta is running with the MOCK interceptor: every request "
                "is treated as %r and no credentials are checked. Set "
                "PHYLODELTA_AUTH=jwt for real authentication.",
                getattr(self._interceptor, "subject", "?"),
            )

    @property
    def interceptor(self) -> Interceptor:
        return self._interceptor

    async def dispatch(self, request, call_next):
        # Preflight carries no credentials by design; refusing it would make
        # the browser report a CORS failure instead of the 401 that follows on
        # the real request.
        if request.method == "OPTIONS" or request.url.path in PUBLIC_PATHS:
            return await call_next(request)

        try:
            principal = self._interceptor.authenticate(request)
        except errors.ApiError as refused:
            return _refuse(refused)
        except Exception:
            # Fail closed. An interceptor that breaks must not hand the
            # application an unauthenticated request it will treat as normal.
            log.exception("interceptor %r failed", getattr(self._interceptor, "name", "?"))
            return _refuse(
                errors.ApiError(
                    503,
                    "auth_unavailable",
                    "Authentication is temporarily unavailable.",
                    "This is a server-side fault, not a problem with your "
                    "credentials. Retry shortly.",
                )
            )

        request.state.principal = principal
        return await call_next(request)
