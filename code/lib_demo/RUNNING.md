# Running the demo

A side-by-side phylogenetic tree viewer: two trees of the same *Vibrio* isolates
(UPGMA and Neighbour-Joining), with per-leaf isolate bar charts, metadata
filtering, and tree-difference colouring.

This directory is a self-contained package. The visualisation library is in
`src/lib/`; everything around it (`src/main.ts`, `src/isolates.ts`,
`src/legend.ts`) is the demo application that uses it. The library's own
reference documentation is [`src/lib/README.md`](src/lib/README.md).

---

## 1. Requirements

| | |
|---|---|
| **Node.js** | **20.19+**, or **22.12+**, or 23 and newer. Node 21.x and 22.0–22.11 will **not** work (Vite 8 excludes them). `node -v` to check; [nodejs.org](https://nodejs.org) for the installer — the 22 LTS build is the safe choice. |
| **npm** | Ships with Node. Any version from 9 up. |
| **Browser** | Any current Chrome, Firefox, Edge or Safari. Rendering uses WebGL, which all of them have on by default. |
| **Disk** | ~100 MB of `node_modules` after install, plus ~24 MB of datasets already in the repository. |
| **Network** | Needed once, for `npm install`. The demo itself runs entirely offline — no backend, no API keys, no external requests. |

Nothing else has to be installed: no database, no Python, no build toolchain.

---

## 2. Quick start

```bash
git clone <repository-url>
cd theses/code/lib_demo
npm install      # once, ~20 seconds
npm start
```

Then open the URL it prints — **http://localhost:5173/**.

On macOS or Linux you can instead run `./run.sh`, which does the same three
steps and checks your Node version first.

To stop the server: `Ctrl+C`.

> **The datasets live outside this package**, at `<repo>/datasets/`, and are
> served from there by `vite.config.ts` (`publicDir: "../../datasets"`). They are
> shared repository data rather than application assets, so keep this directory
> inside its repository — copying it out on its own will start, but every tree
> will fail to load.

---

## 3. What you should see

A page with a control bar at the top, two tree panels side by side, and a legend
strip along the bottom.

* **Left panel — `vibrio · UPGMA`.** Opens cut at depth 4 and grows *in place*:
  double-click a clade to expand it, double-click again to fold it back.
  `Expand all` / `Collapse all` are in the panel header.
* **Right panel — `vibrio · NJ`.** Mirrored so the two trees face each other, and
  it navigates differently: double-clicking a clade opens it **as a new tree**,
  and the `← Back` button plus the breadcrumb trail walk back out.
* **Footer.** What the colours mean: the five most common countries with their
  isolate counts, a `See all 144 …` button for the rest, and — on the right — the
  `different → similar` ramp used for the branch colouring.

Loading is near-instant; the two 9 MB isolate files are parsed in roughly 100 ms.

### Worth trying

1. **Filter the isolates.** In the top bar, open `Country` and tick *Bangladesh*,
   then open `Source Niche` and tick *Human*. The bars re-compose to just those
   isolates, and leaves with nothing left matching are dimmed. Values are OR-ed
   within one key and AND-ed across keys, so that reads as "Bangladeshi **and**
   human-sourced". `Clear filters` resets everything.
2. **Recolour.** Change `Colour by` from `Country` to `Collection Year`. The same
   isolates are now partitioned a different way, and the footer legend follows.
3. **Compare the two methods.** `Differences: on` colours each branch by how well
   that clade agrees with the other tree. Both panels always share one setting —
   a comparison is a statement about the pair, so it cannot be half-enabled.
4. **Select.** `Select box: on`, then drag a rectangle over some tips; the panel
   header counts what you picked.
5. **Bar scale.** `Scale: log` ↔ `linear`. Isolate counts per ST run from 1 to
   312, so the linear scale flattens the tail — this is why log is the default.

### Two things that are intentionally not there

* **Right-click does nothing visible yet.** The library emits right-click events
  and suppresses the browser's own menu inside the panels, but the context menu
  that will consume them is not built. Right-clicking a tip is therefore silent —
  that is the current state, not a fault.
* **The difference values are synthetic.** Isolate data is real, parsed from the
  EnteroBase exports in `datasets/`. The tree-vs-tree metric is not: the export's
  own `Differences` column is entirely `NaN`, and computing a real metric (RF,
  Jaccard, …) is a backend's job. The demo generates a deterministic stand-in so
  the colouring can be demonstrated. Everything else on screen comes from the data.

---

## 4. Checking it works

```bash
npm run check
```

Type-checks the whole package and runs the test suite — **347 tests across 20
files**, in about 4 seconds. Expect `Test Files 20 passed (20)`.

That includes a test that reads all six real `.nwk` files end-to-end, so a pass
also confirms the datasets are present and parse correctly.

Individually: `npm run typecheck`, `npm test`, or `./run.sh test`.

---

## 5. Troubleshooting

**`npm install` fails with `EEXIST` / `EACCES` mentioning `_cacache`.**
Parts of the npm cache are owned by `root`, typically after an earlier
`sudo npm install`. Either work around it —
`npm install --cache /tmp/npm-cache` — or fix it once with
`sudo chown -R "$(whoami)" ~/.npm`. (`./run.sh` retries this way automatically.)

**A syntax error deep inside a dependency, or `Unsupported engine`.**
Node is too old or on an unsupported line. See the version table in §1.

**Port 5173 is already in use.** Vite picks the next free port and prints it —
use that URL. To force one: `npm start -- --port 5180`.

**The page is blank, or shows a red error box.** Open the browser console
(F12). A `Failed to load tree …` message means the datasets are not reachable:
confirm `<repo>/datasets/gen_trees/` holds six `.nwk` files and
`<repo>/datasets/isolated_data/` two `.tsv` files, and that this package is still
inside its repository (see the note in §2).

**The trees look off-centre after resizing.** They should re-centre themselves;
if one does not, reload the page and please mention it.

---

## 6. Layout

```
theses/
├── datasets/                  shared repository data, served at the site root
│   ├── gen_trees/             6 Newick trees (vibrio, clostridium, salmonella)
│   └── isolated_data/         EnteroBase isolate exports, tab-separated
└── code/lib_demo/             ← this package
    ├── run.sh                 convenience launcher (macOS / Linux)
    ├── package.json           the only manifest; install from here
    ├── index.html             the page shell and its styling
    └── src/
        ├── main.ts            application glue: config, fetching, toolbars
        ├── isolates.ts        isolate parsing, filtering, composition
        ├── legend.ts          the footer legend
        └── lib/               ← the library itself
            ├── README.md         its reference documentation
            ├── config.example.jsonc   every option, annotated with its allowed values
            ├── presentation/     tree model, layout, viewer, operators
            ├── config/           config-driven bootstrap
            └── performance/      byte-budgeted LRU cache
```

The split between `src/lib/` and the rest is deliberate and one-way: the library
never fetches, never reads a config file, and never touches the page layout — the
application does all three and hands the library parsed trees plus data
callbacks. `config.example.jsonc` doubles as the configuration schema, with every
field's allowed values in a comment beside it.

---

## 7. Building a static copy (optional)

```bash
npm run build      # writes dist/
npm run preview    # serves it at http://localhost:4173/
```

`dist/` holds the page, one ~230 kB JavaScript bundle, and a copy of the
datasets. It still has to be served over HTTP — ES modules and `fetch` do not
work from `file://` — which is what `npm run preview` does.

For handing the demo over, the repository plus `npm install` is simpler and is
what §2 describes. Note that `npm run build` does not type-check; `npm run check`
is the gate that does.
