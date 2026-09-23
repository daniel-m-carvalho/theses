"""Who a request is for.

**This is still the only place that answers that question** — it just no longer
does the work. Authentication happens once, in `auth.AuthenticationMiddleware`,
before routing; what remains here is the dependency routes use to read the
answer.

That split is the point. A route asks for `owner: str = Depends(current_owner)`
and gets an opaque id. It does not know whether a token was verified, a header
was trusted, or a mock returned a constant, and it cannot be made to care.
Replacing the interceptor — with one that validates PHYLOViZ's tokens, for
instance — changes `auth/interceptors.py` and nothing else: no route, no
service, no model.

`current_owner` keeps its name and its shape from before the middleware
existed, so the eight endpoints that already depend on it were not touched.
"""

from __future__ import annotations

from fastapi import Request

from . import errors
from .auth import AUTH_HEADER, MOCK_SUBJECT, Principal, mode

#: Retained under its original name: the offline pipeline attributes what it
#: builds to this owner, and the mock interceptor resolves to the same value,
#: so a catalogue built by `build-all` is readable by the demo.
SINGLE_OWNER = MOCK_SUBJECT

__all__ = ["AUTH_HEADER", "SINGLE_OWNER", "current_owner", "current_principal", "mode"]


def current_principal(request: Request) -> Principal:
    """The authenticated caller.

    For anything that needs more than an id — an endpoint reporting who you
    are, or a log line. Most routes want `current_owner`.
    """
    principal = getattr(request.state, "principal", None)
    if principal is None:
        # Only reachable if the middleware is missing, which would mean
        # unauthenticated requests are reaching routes. Refuse loudly rather
        # than invent an owner: inventing one would silently serve somebody
        # else's data.
        raise errors.ApiError(
            500,
            "auth_not_installed",
            "This request reached a route without being authenticated.",
            "AuthenticationMiddleware is not installed on this application.",
        )
    return principal


def current_owner(request: Request) -> str:
    """The opaque id of the owner this request is for.

    Returns an id or raises; never returns None, so no caller has to decide
    what an absent owner means.
    """
    return current_principal(request).owner_id
