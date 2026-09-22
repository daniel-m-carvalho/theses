"""FastAPI application factory."""

from __future__ import annotations

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from . import errors
from .errors import ErrorResponse
from .routes_comparisons import router as comparisons_router
from .routes_isolates import router as isolates_router
from .routes_meta import API_VERSION, router as meta_router
from .routes_trees import router as trees_router

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
    404: {"model": ErrorResponse, "description": "No such tree, pair, metric, species or node."},
    422: {"model": ErrorResponse, "description": "A parameter or body value is not usable."},
}


def create_app() -> FastAPI:
    app = FastAPI(
        title="PhyloDelta",
        version=API_VERSION,
        summary="Sliced delivery of large phylogenetic tree comparisons.",
        description=DESCRIPTION,
        openapi_tags=TAGS,
        docs_url="/docs",
        redoc_url="/redoc",
        responses=ERROR_RESPONSES,
    )

    # The frontend is a separate origin in development (Vite on :5173) and may
    # be a static bundle elsewhere in production. Every endpoint is a read over
    # public research data and none accepts credentials, so a permissive
    # read-only policy is the honest setting rather than a lax one. If
    # authentication is ever added, this must be narrowed in the same change:
    # `allow_credentials=True` with `allow_origins=["*"]` is refused by browsers
    # anyway, which is a useful tripwire.
    app.add_middleware(
        CORSMiddleware,
        allow_origins=["*"],
        allow_credentials=False,
        allow_methods=["GET", "POST", "OPTIONS"],
        allow_headers=["*"],
        max_age=3600,
    )

    errors.install(app)
    for router in (meta_router, trees_router, comparisons_router, isolates_router):
        app.include_router(router)
    return app


app = create_app()
