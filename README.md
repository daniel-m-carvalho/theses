# Phylogenetic tree visualisation

A browser library for exploring large phylogenetic trees side by side, with a
demo application that uses it. Built on [Sigma.js](https://www.sigmajs.org/) and
[graphology](https://graphology.github.io/); part of a master's thesis.

The demo shows two trees of the same *Vibrio* isolates — UPGMA and
Neighbour-Joining — with expand/collapse navigation, per-leaf isolate bar charts,
metadata filtering, and tree-difference colouring.

## Try it

```bash
cd code/lib_demo
npm install
npm start
```

Then open <http://localhost:5173/>. Needs Node 20.19+ / 22.12+ / 23+.

**→ [code/lib_demo/RUNNING.md](code/lib_demo/RUNNING.md) has the full guide**:
requirements, what to look at once it opens, how to run the tests, and
troubleshooting.

## Where things are

| Path | |
|---|---|
| `code/lib_demo/` | the demo application — a self-contained package, and where you install from |
| `code/lib_demo/src/lib/` | the library |
| `code/lib_demo/src/lib/README.md` | its reference documentation |
| `datasets/` | Newick trees and EnteroBase isolate exports, shared by the repository and served by the demo |

`npm run check` — from `code/lib_demo/` — type-checks and runs the test suite
(347 tests).
