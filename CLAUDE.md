# PhyloDelta — working notes

A master's thesis project: **comparing phylogenetic trees of 500k+ leaves in a browser**, against
the observation that phylo.io overwhelms browsers by loading complete trees. The claim is that a
server should send a *summary sized to the viewport* and never the whole tree.

**[DECISIONS.md](DECISIONS.md)** at the root is the design record for all three parts — library,
backend, frontend — with alternatives, measurements, and the decisions that were tried and
withdrawn. Read the section that covers what you are about to change; code comments reference it as
`§n`.

## Layout

| Path | What it is |
|---|---|
| `code/lib/` | `phylo-tree-viewer` — the rendering library. Backend-agnostic, never fetches. Its README is the module map and API surface. |
| `code/lib_demo/` | The original static-file demo. **Deliberately frozen** — it proves the library works without a server. |
| `code/web/` | The thesis frontend: React 19 + Vite, two panels driven by the slicing API. |
| `code/server/` | FastAPI + SQLAlchemy, Python 3.12, `uv`. Trees in a columnar store, metrics as plugins. |
| `code/server/native/` | C++ extension: Newick parser, succinct store, parallel correspondence search. |
| `datasets/` | The vibrio and clostridium trees and typing data. |

`code/` is an npm workspace — install from there. `code/lib` is symlinked into `node_modules`, so
the web app builds the library from source and Vite hot-reloads changes to it.

## Running it

```bash
cd code/server && uv run uvicorn phylodelta.api.app:app --port 8000 --reload   # API
cd code/server && uv run phylodelta worker                                      # builds uploads
cd code && npm start                                                            # web on :5173
```

Point the API at a built store with `PHYLODELTA_STORE=<dir>`; `uv run phylodelta build-all` fills
one from `datasets/`. **Start the API with `--reload`.** A server started before a route existed
serves a 404 for it, and the frontend's error handling has already hidden that once — a whole
debugging session spent on a fix that was live in the tests and not in the browser.

## Tests and tools

```bash
cd code/server && uv run pytest -q          # 453
cd code/lib     && npm test                 # 350
cd code/web     && npm test                 # 58
cd code/lib_demo && npm test                # 41
```

Two tools beyond the suites, different in kind and both worth re-running after changing slicing,
correspondence or the jump:

* `code/server/tools/validate_navigation.py <pair> <left> <right>` — expands every wedge until the
  tree is exhausted, then jumps **every leaf in both directions**, against the real route functions.
* `code/server/tools/simulate_usage.py` — walks the HTTP API the way the frontend does, mostly
  testing what a client can get wrong. Needs the API **and a worker** up.

## How this project is worked on

- **Measure before concluding.** Most of the real bugs here were found by counting, not by reading:
  400 of 400 jumps landing on one leaf, 27% landing below the floor, 1,127 of 17,646 leaves lost by
  an allocator. An assertion should encode the promise being made, not the last bug seen — a test
  written to the symptom passed while the defect was still there.
- **Absent data must look absent.** No fabricated mid-scale colour, no invented value. `null` from
  the API means "no counterpart", and it is drawn and keyed as its own thing.
- **Refuse by name, not by falling back.** An unknown metric, a missing tree, a bad node: say what
  was wrong and what exists. A silent default produces a result the user did not ask for and cannot
  tell apart from one they did.
- **Unsigned sentinels.** `parent` and `corresponds` are unsigned columns: "none" is `0xFFFFFFFF`,
  not `-1`. A `< 0` test never fires. This has caused a real bug, a broken test and a false negative
  in three separate places — translate before comparing.
- **Comments are dense on purpose** while the reasoning is live. There is a deferred pass to strip
  them to what a new reader needs, once the project is done; the `§n` pointers are what make that
  cut safe.

## Open threads

- **The central measurement is still not taken**: this frontend against phylo.io on equal terms.
  Everything else exists to support that claim.
- **No metric returns a list of differing leaves.** `phangorn::mast()` — in the user's own R script
  at `../../examples/04_trees_spr_metrics_and_trace.R` — does exactly that, and the library's
  `membership` comparison mode was written for it. MAST is O(n²), so it would be a metric that
  declines large pairs, which is itself a finding.
- The comment-density pass, above.
