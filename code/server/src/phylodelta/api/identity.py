"""Who a request is for.

**This is the only place that answers that question**, and it is deliberately
one function. Whether identity comes from a token PhyloViz issued or from
accounts PhyloDelta keeps itself is not decided (§19.5), and every endpoint
downstream needs the same thing regardless: an opaque owner id. Putting the
decision behind a dependency means resolving it changes this module and nothing
else — rather than the eight endpoints that consume it.

Three modes, chosen by ``PHYLODELTA_AUTH``:

``none`` (default)
    Every request belongs to a single fixed owner. This is what the current
    single-operator deployment is — `build-all` writes, the API reads, and
    there is nobody to distinguish. It keeps the system runnable with no
    identity provider at all, which is what `uv sync` and a directory buys.

``header``
    The owner id is read from a header, trusted as given. **Not
    authentication** — anyone can set a header — but it makes multi-tenant
    behaviour testable and lets a frontend be developed against it before the
    identity question is settled. Refused unless explicitly enabled.

``token``
    The intended production mode: verify a signed token and take its subject.
    Deliberately unimplemented rather than half-implemented — a verifier that
    does not verify is worse than an honest error, because it looks like
    security.
"""

from __future__ import annotations

import os

from fastapi import Header

from . import errors

#: The owner everything belongs to when authentication is off. A recognisable
#: constant, so data created in this mode is obvious in the database rather
#: than looking like a real account.
SINGLE_OWNER = "local"

AUTH_HEADER = "X-PhyloDelta-Owner"


def mode() -> str:
    return os.environ.get("PHYLODELTA_AUTH", "none").strip().lower() or "none"


async def current_owner(
    owner_header: str | None = Header(default=None, alias=AUTH_HEADER),
    authorization: str | None = Header(default=None),
) -> str:
    """The opaque id of the owner this request is for.

    Returns an id or raises; never returns None, so no caller has to decide
    what an absent owner means.
    """
    active = mode()

    if active == "none":
        return SINGLE_OWNER

    if active == "header":
        if not owner_header:
            raise errors.ApiError(
                401,
                "owner_required",
                f"This server identifies requests by the {AUTH_HEADER} header "
                "and none was sent.",
                f"Send {AUTH_HEADER}: <owner id>.",
            )
        return owner_header.strip()

    if active == "token":
        raise errors.ApiError(
            501,
            "auth_not_implemented",
            "Token authentication is configured but not implemented.",
            "Whether tokens are issued by PhyloViz or by this service is not "
            "yet decided; until it is, run with PHYLODELTA_AUTH=none or "
            "=header. A verifier that does not verify would be worse than "
            "this error.",
        )

    raise errors.ApiError(
        500,
        "auth_misconfigured",
        f"PHYLODELTA_AUTH is {active!r}; expected 'none', 'header' or 'token'.",
    )
