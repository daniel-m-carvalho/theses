# PhyloDelta — backend for dynamic tree comparison

Serves **slices** of large phylogenetic trees, the comparison values that go with them, and isolate
metadata for the leaves currently on screen.

The design goal is client-side: keep browser time and memory bounded while navigating trees of
500k+ nodes. Everything expensive is computed **once, offline**; a request is a memory-mapped read.
Backend computation time is explicitly not what this project measures — see
**[DECISIONS.md](DECISIONS.md)** for that argument and every other design decision, with the
evidence behind it.

What that buys, measured on the real data:

| | loaded whole | served per view |
|---|---|---|
| tree (17,646 leaves) | 534 KB | 36 KB |
| + comparison values | 621 KB more | included — 65 KB total |
| + isolate metadata | 8.4 MB | 25 KB |
| **total** | **~9.5 MB** | **~90 KB**, in 3–7 ms |

---

## Running it

```sh
uv sync                        # create .venv, install deps (Python 3.12)
uv run phylodelta build-all      # datasets/ -> store/  (a few minutes, once)
uv run uvicorn phylodelta.api.app:app --reload
uv run phylodelta worker         # in a second terminal, to process uploads
```

The worker is only needed for **uploaded** comparisons. `build-all` precomputes the catalogue and
the API serves it without one; an upload, though, is accepted and left `pending` until a worker
picks it up, so without one nothing ever leaves that state. `GET /api/v1/health` reports the queue
depth, which is how that looks from outside.

### Authentication

Out of the box the server runs the **mock interceptor**: every request is treated as one hardcoded
user and nothing is checked, so the demo works with no identity provider and no configuration. It
logs a warning at startup while that is on, and `GET /api/v1/me` reports `"mock": true` so a client
can say so rather than presenting a demo user as signed in.

Authentication is **middleware, in front of every route** — not a check each handler remembers to
make. Only `/api/v1/health` and the documentation routes are public, and that list lives in one
place (`api/auth/middleware.py`). Route handlers contain no auth logic at all; they ask for an owner
id and receive one.

For real authentication:

```sh
export PHYLODELTA_AUTH=jwt
export PHYLODELTA_JWT_ISSUER=https://accounts.google.com
export PHYLODELTA_JWT_AUDIENCE=<this service's client id>
export PHYLODELTA_JWT_JWKS_URL=https://www.googleapis.com/oauth2/v3/certs   # RS256
# or, for a shared secret (>= 32 bytes):
# export PHYLODELTA_JWT_SECRET=... PHYLODELTA_JWT_ALGORITHMS=HS256
```

Clients then send `Authorization: Bearer <token>`. Incomplete configuration is refused **at
startup**, not per request.

**Integrating with PHYLOViZ** means writing one class — an `Interceptor` that validates PHYLOViZ's
tokens — and selecting it in `api/auth/interceptors.py`. Routes, business logic and data models do
not change, because none of them can see which interceptor is running.

### The native extension is optional

`./native/build.sh` fetches sdsl-lite v3 (header-only, BSD-3-Clause) and compiles one file with
`clang++`. It makes Newick parsing 17–19x faster and nothing else changes: every native component
has a Python counterpart, checked against it column for column, and those are the reference
implementations. **Without a compiler the whole backend still runs from `uv sync` alone** — the
suite passes either way, skipping only the native-specific tests.

Then <http://127.0.0.1:8000/docs> for the generated OpenAPI contract.

`build-all` runs the three offline stages; they can also be run separately:

| command | reads | writes | cost |
|---|---|---|---|
| `phylodelta ingest-trees` | `datasets/gen_trees/*.nwk` | `store/trees/` | ~130 ms per tree |
| `phylodelta compute-pairs` | `store/trees/` | `store/pairs/` | ~13 s per pair |
| `phylodelta ingest-isolates` | `datasets/isolated_data/*.tsv` | `store/isolates/` | ~5 s per species |
| `phylodelta list-metrics` | — | — | — |
| `phylodelta worker` | the queue | `store/trees/`, `store/pairs/` | runs until stopped |

`store/` is generated and gitignored; it is always rebuildable from `datasets/`.

---

## Three conventions

**Node identity is the pre-order index.** One integer addresses a node in the topology, in a
comparison and in your next request. A subtree is the contiguous range `[id, subtree_end)`, which is
what makes slicing free.

**Payloads are positional.** Parallel arrays in one agreed order — entry *k* of every array
describes the same node. Topology and comparison values for a slice line up index for index, so
there is no key and no join.

**A slice defers detail, it never discards it.** Every leaf is either displayed or counted inside
exactly one wedge:

```
displayed_leaves - (wedges) + hidden_leaves == total_leaves
```

A wedge carries the `id` you expand it with. That is the whole navigation model.

---

## A walkthrough

Every command below is runnable against a freshly built store.

### 1. What is here

```sh
curl -s localhost:8000/api/v1/datasets | jq '{trees: [.trees[].id], pairs: [.pairs[].id]}'
```

```json
{
  "trees": ["clostridium-upgma", "vibrio-nj", "vibrio-upgma"],
  "pairs": ["clostridium-upgma__vibrio-nj", "clostridium-upgma__vibrio-upgma",
            "vibrio-nj__vibrio-upgma"]
}
```

Each pair reports the evidence for its own comparability — `shared_leaves`, `shared_fraction`,
`same_species`, and a `caution` when leaf matching is suspect. Cross-species pairs are offered, not
blocked: sequence types are numbered per species, so vibrio and clostridium overlap on 99.1% of
labels while sharing no organism. The server says so and lets you decide.

### 2. A tree, summarised to what you can draw

```sh
curl -s 'localhost:8000/api/v1/trees/vibrio-upgma/slice?budget=500' | jq '{
  displayed_leaves, hidden_leaves, total_leaves, nodes: (.nodes.id | length)}'
```

```json
{"displayed_leaves": 500, "hidden_leaves": 17236, "total_leaves": 17646, "nodes": 999}
```

500 tips represent all 17,646 leaves. `nodes.truncated[k]` marks the tips that stand for clades you
have not expanded, and `nodes.true_leaf_count[k]` says how many leaves are behind each.

### 3. Expanding a wedge

Take any truncated tip's id and slice again at it:

```sh
curl -s 'localhost:8000/api/v1/trees/vibrio-upgma/slice?root=31212&budget=50' | jq '{root, total_leaves}'
```

```json
{"root": 31212, "total_leaves": 2040}
```

No session, no cursor — the id is enough.

### 4. Topology and comparison in one request

```sh
curl -s 'localhost:8000/api/v1/trees/vibrio-nj/slice?budget=200&compare=vibrio-nj__vibrio-upgma' \
  | jq '{aligned: (.comparison.id == .nodes.id), first_similarity: .comparison.similarity[0:3]}'
```

```json
{"aligned": true, "first_similarity": [1.0, 0.9999433159828186, 0.9998866319656372]}
```

Per node, aligned by position:

| field | meaning |
|---|---|
| `similarity` | 0..1 overlap with the best corresponding clade, or `null` if it has no counterpart |
| `corresponds` | node id in the **other** tree, or `null` |
| `exact` | the Robinson-Foulds verdict: is this clade present identically? |

A leaf whose `corresponds` is `null` exists in only one of the two trees — that is what an
equal/different leaf colouring keys off. `similarity` is a measurement, not a colour: what it looks
like is entirely yours.

**`exact` saturates and should not drive a colour scale.** 98.3% of clades above 1,000 leaves come
back "different", because one misplaced leaf invalidates every ancestor. Use `similarity` for the
gradient and `exact` as an overlay or filter. §2.7 of DECISIONS.md has the measurements.

### 5. Navigating toward the differences

```sh
curl -s 'localhost:8000/api/v1/trees/vibrio-nj/slice?budget=100&compare=vibrio-nj__vibrio-upgma&order=difference' \
  | jq '[.comparison.similarity[] | select(. != null)] | min'
```

```json
0.03921568766236305
```

Against `order=size`, which reaches only `0.23255814611911774` at the same budget. `size` gives an overview;
`difference` descends towards the worst disagreement. It needs `compare=`, since the ranking comes
from the comparison values.

### 6. The comparison's scalars

```sh
curl -s localhost:8000/api/v1/comparisons/vibrio-nj__vibrio-upgma | jq '{summary, shared_leaves, dropped_from_right}'
```

```json
{
  "summary": {"rf": 6825.0, "rf_normalised": 0.193, "shared_clusters": 10819, ...},
  "shared_leaves": 17645,
  "dropped_from_right": ["211"]
}
```

Robinson-Foulds is defined only over a shared leaf set, so pairs are reconciled before comparison
and the dropped labels are reported rather than silently absorbed. This RF value matches the
reference implementation (`TreeDiff`, by the authors of the algorithm) exactly.

### 7. Isolate metadata for the leaves on screen

What can be filtered on:

```sh
curl -s localhost:8000/api/v1/isolates/vibrio/keys | jq '.facets[] | select(.segmentable) | .name' | head -5
```

The values behind one key:

```sh
curl -s 'localhost:8000/api/v1/isolates/vibrio/values?key=Continent' | jq '.[0].values[0:3]'
```

And the composition of the leaves you are showing — one key segments, the rest filter:

```sh
curl -s -X POST localhost:8000/api/v1/isolates/vibrio/compositions \
  -H 'content-type: application/json' \
  -d '{"leaves": ["1","3","15"], "segment_by": "Continent",
       "filter": {"Source Niche": ["Human","Environment"]}}' \
  | jq '.leaves'
```

```json
[
  {"leaf": "1",  "total": 0, "available": 1, "segments": []},
  {"leaf": "3",  "total": 1, "available": 1, "segments": [{"value": "North America", "count": 1}]},
  {"leaf": "15", "total": 1, "available": 1, "segments": [{"value": "Asia", "count": 1}]}
]
```

`total` passed the filter; `available` had data at all. **The difference matters**: `total == 0 <
available` means your filter excluded everything, while `available == 0` means the leaf has no
isolate data — true of 3.9% of vibrio leaves and 10.9% of clostridium's. A `value` of `null` is a
blank cell, which is a real state, not a zero count.

Filters combine **AND across keys, OR within a key**. A filter value that matches nothing is a 422,
not an empty result, because the two are otherwise indistinguishable.

---

## Errors

Every failure has the same shape:

```json
{
  "detail": "No tree 'nope'.",
  "code": "tree_not_found",
  "hint": "GET /api/v1/datasets lists the ingested trees."
}
```

Branch on **`code`**; it is stable. `detail` is for humans and may be reworded. `hint`, when
present, is the request or command that answers the question. Validation failures use the same
shape with `code: "invalid_request"` and an `errors` array naming each bad field.

---

## Layout

| path | what |
|---|---|
| `src/phylodelta/trees/` | Newick parsing, canonicalisation, the columnar store, slicing |
| `src/phylodelta/metrics/` | Metric contract and registry; `plugins/rf_python/` is Robinson-Foulds |
| `src/phylodelta/isolates/` | Isolate ingest and filtered composition queries |
| `src/phylodelta/api/v1/` | FastAPI routes; `schemas.py` is the wire contract |
| `src/phylodelta/precompute/` | The offline CLI |
| `native/` | The optional C++ extension (`build.sh`), and `build_treediff.sh` for the conformance oracle |
| `tests/fixtures/` | A 6 KB dataset so the suite runs without the real 20 MB |

## Tests

```sh
uv run pytest
```

Tests needing the real datasets skip cleanly without them;
`tests/test_pipeline_end_to_end.py` runs the whole pipeline on the committed fixture and works
anywhere.

## Metrics

| name | kind | contributes |
|---|---|---|
| `rf` | python | Robinson-Foulds distance, plus a per-clade `exact` column |
| `rf-treediff` | subprocess | The same distance from TreeDiff, as an independent check |
| `triplet` | subprocess | Triplet distance — a finer-grained signal that does not saturate on large clades |

`rf` and `rf-treediff` should always agree; a disagreement means one of them is wrong. The
subprocess metrics need `./native/build_treediff.sh`; `/api/v1/metrics` reports `available: false`
until then.

Several metrics in one run share the expensive work:

```sh
uv run phylodelta compute-pairs --metric rf --metric triplet
```

## Adding a metric

A metric is a directory under `src/phylodelta/metrics/plugins/` with a `metric.json` manifest and an
implementation. Two invocation kinds are defined: `python` (imported in-process) and `subprocess`
(trees in, results out, as JSON on stdio) — the second so a metric can be written in **any**
language. Every metric returns the same shape, so neither the API nor the frontend knows which
produced a result. See `metrics/contract.py`.
