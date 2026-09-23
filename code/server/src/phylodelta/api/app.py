"""FastAPI application factory."""

from __future__ import annotations

import os
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from . import errors
from .auth import PUBLIC_PATHS, AuthenticationMiddleware, mode, select
from .errors import ErrorResponse
from .routes_comparisons import router as comparisons_router
from .routes_isolates import router as isolates_router
from .routes_meta import API_VERSION, router as meta_router
from .routes_trees import router as trees_router
from .routes_uploads import router as uploads_router

DESCRIPTION = """
Serves **slices** of large phylogenetic trees, the comparison values that go
with them, and isolate metadata for the leaves currently on screen.

Everything expensive is computed **once, offline** (`phylodelta ingest-trees`,
`compute-pairs`, `ingest-isolates`); a request is a memory-mapped read.

### Three conventions hold everywhere

**Node identity is the pre-order index.** A single integer addresses a node in
the topology, in a comparison, and in the next request. A subtree is the
contiguous range `[id, subtree_end)`, which is what makes slicing free.

**Payloads are positional.** Parallel arrays in one agreed order: entry *k* of
every array describes the same node. Topology and comparison values for one
slice line up index for index, with no key and no join.

**A slice defers detail, it never discards it.** Every leaf is either shown or
counted inside exactly one wedge, so `displayed_leaves - wedges +
hidden_leaves == total_leaves`. A wedge carries the id to expand it with.

### A first request

    GET /api/v1/datasets
    GET /api/v1/trees/vibrio-upgma/slice?budget=500&compare=vibrio-nj__vibrio-upgma

The second returns topology and comparison values together, already reduced to
500 tips. See the README for a full walkthrough.

### Versioning

Every route lives under `/api/v1`. The version is in the path so that two
versions can be served side by side during a migration, and so that which one a
client used is visible in a log.

**These are not breaking changes and will not bump the version.** Clients must
tolerate them:

* a new endpoint, or a new field on an existing response
* a new metric, or a new per-node column from an existing metric — which is why
  metrics *declare* their outputs at `/api/v1/metrics` rather than the set being
  fixed

**These are breaking, and will bump it:**

* removing or renaming a field, or changing what one means
* changing what a **node id** denotes

That last deserves emphasis. `id` is the join key across topology, comparison
values and isolate composition; a client holding ids across a change of meaning
would silently misalign rather than fail. Node ids are pre-order positions in
this server's canonical form, which is stable for a given store, and a store
that changes shape declares a new `format_version` rather than reusing the old
one.
"""

TAGS = [
    {
        "name": "meta",
        "description": "What this server holds, and whether it is ready to serve it.",
    },
    {
        "name": "trees",
        "description": (
            "Tree headers and slices. A slice is a subtree summarised to a leaf "
            "budget; pass `compare=` to get comparison values in the same response."
        ),
    },
    {
        "name": "comparisons",
        "description": (
            "Computed comparisons: the scalars, and per-node values aligned to a "
            "slice. Values are stored, not computed per request."
        ),
    },
    {
        "name": "isolates",
        "description": (
            "Isolate metadata, per species. One key segments and colours, the "
            "rest filter; filters combine with AND across keys and OR within one."
        ),
    },
]

#: Documented on every route, so a client sees the error contract in /docs
#: rather than discovering it by failing.
ERROR_RESPONSES = {
    400: {"model": ErrorResponse, "description": "The request cannot be answered as asked."},
    401: {"model": ErrorResponse, "description": "Missing, expired or invalid credentials."},
    404: {"model": ErrorResponse, "description": "No such tree, pair, metric, species or node."},
    413: {"model": ErrorResponse, "description": "An uploaded file is larger than this server accepts."},
    422: {"model": ErrorResponse, "description": "A parameter or body value is not usable."},
}


@asynccontextmanager
async def _lifespan(app: FastAPI):
    """Startup work.

    The listing reads comparison rows (§24.7), so the API needs its tables to
    exist even on a store nothing has been written to yet. Without this a fresh
    deployment answers /health happily and 500s on /datasets, which is the
    least helpful pair of answers available.
    """
    from .. import db

    db.create_schema()
    yield


def create_app() -> FastAPI:
    app = FastAPI(
        lifespan=_lifespan,
        title="PhyloDelta",
        version=API_VERSION,
        summary="Sliced delivery of large phylogenetic tree comparisons.",
        description=DESCRIPTION,
        openapi_tags=TAGS,
        docs_url="/docs",
        redoc_url="/redoc",
        responses=ERROR_RESPONSES,
    )

    # Built here rather than left to the middleware, because Starlette
    # assembles its stack lazily on the first request: a misconfigured JWT
    # setup would otherwise start cleanly and fail per-request, which is the
    # worst moment to discover it. This way the process refuses to start.
    interceptor = select()

    # Authentication, before anything routes. Added before CORS so that CORS
    # ends up the outer layer: a preflight carries no credentials by design,
    # and refusing it would surface in the browser as a CORS failure instead
    # of the 401 the real request is about to get.
    app.add_middleware(AuthenticationMiddleware, interceptor=interceptor)

    # The frontend is a separate origin in development (Vite on :5173) and may
    # be a static bundle elsewhere in production.
    #
    # `*` is the default and is not the hazard it would be with cookies.
    # Credentials are bearer tokens, which a browser never attaches on its own,
    # so a hostile page can reach this API but has nothing to send — CORS is
    # not what protects the data here; the token is. Narrow it anyway once the
    # frontend's origin is known, via PHYLODELTA_CORS_ORIGINS, because a
    # smaller surface is still worth having.
    #
    # `allow_credentials` stays False deliberately. Turning it on with `*` is
    # refused by browsers, and turning it on at all would mean cookie auth,
    # which brings CSRF that bearer tokens do not have.
    origins = [
        origin.strip()
        for origin in os.environ.get("PHYLODELTA_CORS_ORIGINS", "*").split(",")
        if origin.strip()
    ]
    app.add_middleware(
        CORSMiddleware,
        allow_origins=origins,
        allow_credentials=False,
        allow_methods=["GET", "POST", "DELETE", "OPTIONS"],
        allow_headers=["*"],
        max_age=3600,
    )

    errors.install(app)
    for router in (
        meta_router,
        trees_router,
        comparisons_router,
        uploads_router,
        isolates_router,
    ):
        app.include_router(router)

    _document_security(app)
    return app


def _document_security(app: FastAPI) -> None:
    """Advertise the bearer scheme in the OpenAPI document.

    Authentication is middleware, so FastAPI cannot infer it from the route
    signatures — without this the generated contract would show an API that
    needs no credentials, and whoever writes the client would find out by
    getting 401s. Applied globally with the public paths carved out, which is
    the same shape as the middleware's own rule.
    """
    generated = app.openapi

    def with_security():
        document = generated()
        if "PhyloDeltaBearer" in document.get("components", {}).get(
            "securitySchemes", {}
        ):
            return document
        document.setdefault("components", {}).setdefault("securitySchemes", {})[
            "PhyloDeltaBearer"
        ] = {
            "type": "http",
            "scheme": "bearer",
            "bearerFormat": "JWT",
            "description": (
                "A JWT issued by the identity provider this deployment trusts. "
                "In the demo the mock interceptor is active and any request is "
                "accepted, whatever it carries."
            ),
        }
        for path, operations in document.get("paths", {}).items():
            if path in PUBLIC_PATHS:
                continue
            for operation in operations.values():
                if isinstance(operation, dict):
                    operation.setdefault("security", [{"PhyloDeltaBearer": []}])
        document["info"]["x-authentication-mode"] = mode()
        app.openapi_schema = document
        return document

    app.openapi = with_security


app = create_app()
