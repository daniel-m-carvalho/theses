# Phylogenetic tree visualisation

A browser library for exploring large phylogenetic trees side by side, with a
demo application that uses it. Built on [Sigma.js](https://www.sigmajs.org/) and
[graphology](https://graphology.github.io/); part of a master's thesis.

The demo shows two trees of the same *Vibrio* isolates — UPGMA and
Neighbour-Joining — with expand/collapse navigation, per-leaf isolate bar charts,
metadata filtering, and tree-difference colouring.

## Try it

```bash
cd code
npm install
npm start
```

Then open <http://localhost:5173/>. Needs Node 20.19+ / 22.12+ / 23+.

**→ [code/lib_demo/RUNNING.md](code/lib_demo/RUNNING.md) has the full guide**:
requirements, what to look at once it opens, how to run the tests, and
troubleshooting.

## The design record

**[DECISIONS.md](DECISIONS.md)** holds the reasoning for the whole project — library, backend and
frontend — with the alternatives weighed against each decision and the measurement that settled it,
including the ones that were tried and withdrawn.

## Where things are

| Path | |
|---|---|
| `code/` | npm workspace root — **install from here** |
| `code/lib/` | the library, published as `phylo-tree-viewer` |
| `code/lib/README.md` | its reference documentation |
| `code/lib_demo/` | the demo application that consumes it |
| `datasets/` | Newick trees and EnteroBase isolate exports, shared by the repository and served by the demo |

`npm run check` — from `code/` — type-checks and runs the test suite in both
packages (347 tests: 306 library, 41 demo).
