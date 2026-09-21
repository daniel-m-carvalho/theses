import {
  createFromConfig,
  parseNewick,
  type Config,
  type LeafDatum,
  type NewickNode,
  type ViewerHandle,
  DIFF_PALETTE,
} from "phylo-tree-viewer";
import iwanthue from "iwanthue";
import rawConfigText from "./config.example.jsonc?raw";
import {
  composeLeaf,
  isFilterEmpty,
  parseIsolateTsv,
  totals,
  valuesOf,
  type FilterSelection,
  type IsolateIndex,
  type ParseOptions,
} from "./isolates";
import { renderComparisonLegend, renderLegend } from "./legend";

/**
 * Entry point (application glue). Everything project-specific lives here:
 *  - loading the config object (from the shipped example JSON),
 *  - fetching + parsing the dataset trees,
 *  - fetching + parsing the isolate metadata (TSV) into per-leaf compositions,
 *  - synthesizing the tree-difference values (the one remaining stand-in),
 *  - the two-panel DOM layout and the toolbar.
 *
 * The library owns the rest: from the config object + parsed trees + data
 * providers, `createFromConfig` builds the two viewers, attaches every operator,
 * links the panels for cross-tree navigation, and shares the color scales. The
 * library never fetches, never reads the config file, and never touches this
 * page's layout — those are the app's job (see lib/README §15/§16).
 */

/**
 * Strip `//` and block comments from JSONC, respecting string contents (so a
 * "http://..." value survives) and escapes. Tiny and dependency-free — the
 * example config ships as .jsonc so every field can be annotated with its
 * allowed values; the library itself only ever receives the parsed object.
 */
function stripJsonComments(text: string): string {
  let out = "";
  let inString = false;
  let inLine = false;
  let inBlock = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    const next = text[i + 1];
    if (inLine) {
      if (ch === "\n") { inLine = false; out += ch; }
    } else if (inBlock) {
      if (ch === "*" && next === "/") { inBlock = false; i++; }
    } else if (inString) {
      out += ch;
      if (ch === "\\") { out += next ?? ""; i++; }
      else if (ch === '"') inString = false;
    } else if (ch === '"') {
      inString = true;
      out += ch;
    } else if (ch === "/" && next === "/") {
      inLine = true;
      i++;
    } else if (ch === "/" && next === "*") {
      inBlock = true;
      i++;
    } else {
      out += ch;
    }
  }
  return out;
}

// The library reads its slice (`panels`/`link`/`palette`); the `app` section is
// ours (see config.example.jsonc). Cast because a parsed JSON widens literals.
const rawConfig = JSON.parse(stripJsonComments(rawConfigText)) as Record<string, unknown>;
const config = rawConfig as unknown as Config;
const appConfig = (rawConfig as { app: AppConfig }).app;

interface AppConfig {
  sources: {
    /** Tree files, keyed by panel id; `species` selects the isolate file. */
    trees: Record<string, { file: string; species?: string }>;
    /** Isolate metadata files — a list so multiple species can be supplied. */
    isolated_data: Array<{ species: string; file: string }>;
    /**
     * TSV columns to load: the segment key plus every filterable key. Exactly
     * one of them colours the bars at a time (`segmentBy`); the rest restrict
     * which isolates count.
     */
    keys?: string[];
    /** Which of `keys` colours the bars initially. */
    segmentBy?: string;
    /** TSV column that joins an isolate row to a tree leaf label. */
    joinColumn?: string;
  };
  api?: { baseUrl: string; routes: Record<string, string> };
  values: { diffThreshold: number; missingValues?: string[] };
}

/**
 * Phase timings for the benchmark harness, exposed on `window.__demoPhases`.
 *
 * The headline measurement is the library's work, not this app's: `fetch` is
 * recorded separately and excluded from it, because in production the trees come
 * from a backend API rather than a local file, so only `parse`/`layout`/`paint`
 * transfer to the final frontend. Costs nothing when nobody reads it.
 */
const phases: Record<string, number> = {};
(window as unknown as { __demoPhases: Record<string, number> }).__demoPhases = phases;

async function timed<T>(name: string, fn: () => Promise<T> | T): Promise<T> {
  const t0 = performance.now();
  const result = await fn();
  phases[name] = (phases[name] ?? 0) + (performance.now() - t0);
  return result;
}

/** App-side loader: fetch a tree file from the site root and parse via the lib. */
async function loadTree(path: string): Promise<NewickNode> {
  const text = await timed("fetch", () =>
    fetch(path).then((r) => {
      if (!r.ok) throw new Error(`Failed to load tree "${path}" (${r.status})`);
      return r.text();
    })
  );
  return timed("parse", () => parseNewick(text));
}

// --- Isolate metadata (real data; model + parsing live in ./isolates) ---

/** App-side loader: fetch an isolate TSV from the site root and index it. */
async function loadIsolates(path: string, opts: ParseOptions): Promise<IsolateIndex> {
  const text = await fetch(path).then((r) => {
    if (!r.ok) throw new Error(`Failed to load isolate data "${path}" (${r.status})`);
    return r.text();
  });
  return parseIsolateTsv(text, opts);
}


// --- Stand-in backend data (replace with real FastAPI responses) ---

/**
 * Deterministic per-clade difference value in [0,1] — the ONLY fabricated input
 * left in the demo, kept to exercise the comparison operator. It cannot come
 * from the isolate export: that file's own "Differences" column is entirely NaN,
 * and a tree-vs-tree metric (RF, Jaccard, …) is the backend's job — see the
 * `/compare/{a}/{b}` route in the config.
 */
function differenceValue(cladeKey: string): number {
  let h = 0;
  for (const ch of cladeKey) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return (h % 1000) / 1000;
}

// --- Toolbars (app glue; calls the library's public setters) ---
//
// Controls are split by one question: *does this depend on the panel's own
// config?*
//  - No  → the top bar, acting on every panel at once. These are settings that
//    only make sense held in common: the comparison is now configured once for
//    all panels (lib/README §9.5), and bar length/scale must match for bars to
//    be comparable across trees at all.
//  - Yes → the panel header, next to the tree it belongs to: the expand/collapse
//    controls differ by that panel's `mode` (incremental vs subtree), and the
//    selection count is that panel's own state.

/** The operators of `key` across panels that actually have one. */
function collect<T>(panels: ViewerHandle[], pick: (h: ViewerHandle) => T | undefined): T[] {
  return panels.map(pick).filter((x): x is T => x != null);
}

/** The metadata model the top bar drives (owned by `main`, not the library). */
interface FilterUI {
  /** Every configured key: one may colour, all may filter. */
  keys: string[];
  segmentBy: () => string;
  setSegmentBy: (key: string) => void;
  /** Mutable selection per key — the UI ticks values in place. */
  selection: Map<string, Set<string>>;
  /** Distinct values of a key with dataset-wide counts, most frequent first. */
  valuesFor: (key: string) => Array<[string, number]>;
  onFilterChange: () => void;
}

/** Top bar: everything that applies to all panels alike. */
function buildGlobalControls(
  host: HTMLElement,
  panels: ViewerHandle[],
  filters?: FilterUI,
  onComparisonToggle?: (enabled: boolean) => void
): void {
  const controls: HTMLElement[] = [];

  if (filters) controls.push(...buildFilterControls(filters));

  const bars = collect(panels, (p) => p.operators.barcharts);
  if (bars.length) {
    controls.push(
      toggleButton("Bar charts", bars[0].isEnabled(), (on) =>
        bars.forEach((b) => b.setEnabled(on))
      )
    );
    // One scale for every panel: bars across trees are only comparable if the
    // same magnitude maps to the same length.
    const scaleBtn = button(`Scale: ${bars[0].getScale()}`, () => {
      const next = bars[0].getScale() === "linear" ? "log" : "linear";
      bars.forEach((b) => b.setScale(next));
      scaleBtn.textContent = `Scale: ${next}`;
    });
    controls.push(scaleBtn);
  }

  const selections = collect(panels, (p) => p.operators.selection);
  if (selections.length) {
    // The gesture mode is a preference, not per-tree state; the resulting
    // selection (and its count) stays with each panel.
    controls.push(
      toggleButton("Select box", selections[0].isDragSelectEnabled(), (on) =>
        selections.forEach((s) => s.setDragSelectEnabled(on))
      )
    );
  }

  const comparisons = collect(panels, (p) => p.operators.comparison);
  if (comparisons.length) {
    // Mode (gradient / membership) comes from the one top-level config block.
    // Enabling per panel would let the two sides disagree about the comparison
    // they jointly present, so this drives all of them — and the footer legend,
    // which must not advertise colours that are currently switched off.
    controls.push(
      toggleButton("Differences", comparisons[0].isEnabled(), (on) => {
        comparisons.forEach((c) => c.setEnabled(on));
        onComparisonToggle?.(on);
      })
    );
  }

  host.append(...controls);
}

/**
 * Colour-by selector + one value picker per key.
 *
 * The model is "one key colours, the rest restrict": exactly one key can be the
 * segment key, while every key may carry a value selection. Values within a key
 * are OR-ed, keys are AND-ed (see `isolates.ts`). A `<details>` popover keeps
 * 144 countries out of the bar until asked for, without hand-rolled popup logic.
 */
function buildFilterControls(f: FilterUI): HTMLElement[] {
  const out: HTMLElement[] = [];

  const colourBy = document.createElement("label");
  colourBy.className = "field";
  colourBy.textContent = "Colour by ";
  const select = document.createElement("select");
  for (const key of f.keys) {
    const opt = document.createElement("option");
    opt.value = key;
    opt.textContent = key;
    opt.selected = key === f.segmentBy();
    select.appendChild(opt);
  }
  select.addEventListener("change", () => f.setSegmentBy(select.value));
  colourBy.appendChild(select);
  out.push(colourBy);

  const summaries = new Map<string, HTMLElement>();
  const paintSummary = (key: string): void => {
    const n = f.selection.get(key)?.size ?? 0;
    const el = summaries.get(key);
    if (el) el.textContent = n ? `${key} (${n})` : key;
  };

  for (const key of f.keys) {
    const details = document.createElement("details");
    details.className = "filter";

    const summary = document.createElement("summary");
    summaries.set(key, summary);
    details.appendChild(summary);
    paintSummary(key);

    const list = document.createElement("div");
    list.className = "filter-list";
    for (const [value, count] of f.valuesFor(key)) {
      const row = document.createElement("label");
      const box = document.createElement("input");
      box.type = "checkbox";
      box.checked = f.selection.get(key)?.has(value) ?? false;
      box.addEventListener("change", () => {
        const set = f.selection.get(key)!;
        if (box.checked) set.add(value);
        else set.delete(value);
        paintSummary(key);
        f.onFilterChange();
      });
      row.append(box, document.createTextNode(` ${value} `));
      const n = document.createElement("span");
      n.className = "count";
      n.textContent = String(count);
      row.appendChild(n);
      list.appendChild(row);
    }
    details.appendChild(list);
    out.push(details);
  }

  const clear = button("Clear filters", () => {
    for (const set of f.selection.values()) set.clear();
    f.keys.forEach(paintSummary);
    // Re-tick every box: the lists are built once and stay in the DOM.
    for (const box of document.querySelectorAll<HTMLInputElement>(".filter-list input")) {
      box.checked = false;
    }
    f.onFilterChange();
  });
  out.push(clear);

  return out;
}

/** Panel header: what depends on this panel's own config or state. */
function buildPanelControls(host: HTMLElement, handle: ViewerHandle): void {
  const { operators } = handle;

  const controls: HTMLElement[] = [];

  if (operators.expandCollapse) {
    const ec = operators.expandCollapse;

    if (ec.getMode() === "subtree") {
      // Subtree mode: the trail + Back mirror the operator's drill-in stack.
      const backBtn = button("← Back", () => ec.back());
      const trail = document.createElement("span");
      trail.className = "sel-count";
      trail.title = "Double-click a clade to open it as a new tree; Back returns";

      const paintTrail = (path = ec.getPath()) => {
        backBtn.disabled = !ec.canGoBack();
        trail.textContent = path.map((s) => s.label).join(" › ");
      };
      ec.setOnPathChange(paintTrail);
      paintTrail();

      controls.push(backBtn, trail);
    } else {
      // Incremental mode: depth is config-driven; the toolbar only resets to it.
      controls.push(button("Expand all", () => ec.expandAll()));
      controls.push(button("Collapse all", () => ec.resetDepth()));
    }
  }

  if (operators.selection) {
    // The count is this panel's own state — the box-select *toggle* is global.
    const selCount = document.createElement("span");
    selCount.className = "sel-count";
    selCount.textContent = "0 selected";
    operators.selection.setOnChange((s) => (selCount.textContent = `${s.length} selected`));
    controls.push(selCount);
  }

  host.append(...controls);
}

function button(label: string, onClick: () => void): HTMLButtonElement {
  const b = document.createElement("button");
  b.textContent = label;
  b.addEventListener("click", onClick);
  return b;
}

function toggleButton(
  label: string,
  initial: boolean,
  onToggle: (on: boolean) => void
): HTMLButtonElement {
  let on = initial;
  const b = document.createElement("button");
  const paint = () => {
    b.textContent = `${label}: ${on ? "on" : "off"}`;
    b.classList.toggle("active", on);
  };
  b.addEventListener("click", () => {
    on = !on;
    onToggle(on);
    paint();
  });
  paint();
  return b;
}

// --- Bootstrap ---

async function main(): Promise<void> {
  const containers = [
    requireEl("panel-left"),
    requireEl("panel-right"),
  ];
  const controlHosts = [requireEl("controls-left"), requireEl("controls-right")];

  // App owns fetching: resolve each panel's tree file from the app config, then
  // fetch + parse it. The library gets already-parsed trees via `providers`.
  //
  // `?left=…&right=…` overrides the configured tree files. This exists for the
  // benchmark harness, which must point the SAME build at many different tree
  // sizes; without it every measurement would need a rebuilt config. It changes
  // only which file is fetched — not how anything renders — so the build under
  // measurement is the build that ships.
  const panelIds = (config.panels ?? []).map((p) => p.id!);
  const treeCfgs = panelIds.map((id) => appConfig.sources.trees[id]);
  const override = new URLSearchParams(location.search);
  const overrides = [override.get("left"), override.get("right")];
  const treeFiles = treeCfgs.map((t, i) => overrides[i] ?? t.file);
  const trees = await Promise.all(treeFiles.map((f) => loadTree(f)));

  // `?maxNodes=N` (or `unlimited`) overrides the per-panel leaf budget.
  // The benchmark sweeps this because the demo and phylo.io otherwise draw very
  // different amounts: at the shipped budget the demo renders a summary while
  // phylo.io renders far more, so a single comparison point would be measuring
  // two different pictures. Sweeping it gives one like-for-like setting
  // ("unlimited") plus a curve showing what summarisation actually buys.
  const budget = override.get("maxNodes");
  if (budget) {
    const value = budget === "unlimited" ? Number.MAX_SAFE_INTEGER : Number(budget);
    if (Number.isFinite(value) && value > 0) {
      for (const panel of config.panels ?? []) {
        panel.viewer = { ...panel.viewer, maxNodes: value };
      }
    }
  }

  // Signal for the benchmark: resolved once the first frame after render has
  // painted, so time-to-first-render is measured against pixels, not a load event.
  const markPainted = (layoutEnd: number) =>
    requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        phases.paint = performance.now() - layoutEnd;
        (window as unknown as { __demoPainted?: boolean }).__demoPainted = true;
      })
    );

  // Isolate metadata, fetched ONCE per distinct species even when several panels
  // share it (the two vibrio panels here fetch ~9 MB once, not twice).
  const { joinColumn = "ST" } = appConfig.sources;
  const keys = appConfig.sources.keys ?? ["Country"];
  const missing = new Set(appConfig.values.missingValues ?? ["", "NaN"]);
  const parseOpts: ParseOptions = { joinColumn, keys, missing };
  const files = new Map(appConfig.sources.isolated_data.map((d) => [d.species, d.file]));
  // `?isolates=0` skips the isolate metadata entirely. The benchmark's headline
  // comparison is tree rendering, and phylo.io has no equivalent of the bar
  // charts or the metadata filter — measuring a ~9 MB TSV fetch against a tool
  // that never makes it would understate this build. The cost of the isolate
  // features is measured separately, with the flag on.
  const withIsolates = override.get("isolates") !== "0";
  const wanted = withIsolates
    ? [...new Set(treeCfgs.map((t) => t.species).filter((s): s is string => !!s))]
    : [];
  const indices = new Map<string, IsolateIndex>(
    await Promise.all(
      wanted.map(async (species) => {
        const file = files.get(species);
        if (!file) throw new Error(`No isolated_data entry for species "${species}"`);
        return [species, await loadIsolates(file, parseOpts)] as const;
      })
    )
  );

  // --- Filter state (app policy) ---
  // One key colours the bars; the others restrict which isolates count. Held
  // here rather than in the library: the library's `setFilter` only asks
  // "does this leaf pass?", and the composition it draws comes from `dataOf`,
  // so both are just views of this state.
  let segmentBy = appConfig.sources.segmentBy ?? keys[0];
  const selection = new Map<string, Set<string>>(keys.map((k) => [k, new Set<string>()]));

  // Which species a leaf belongs to is a *per-panel* fact, but the library takes
  // one shared `dataOf`. Resolve it by node identity: index each tree's nodes to
  // its species. The library hands back a possibly-cloned node (pruning clones,
  // leaving `origin` pointing at the parsed node), so unwrap that first — this is
  // what keeps two species whose ST numbers collide from mixing.
  const speciesOfNode = new WeakMap<object, string>();
  trees.forEach((tree, i) => {
    const species = treeCfgs[i].species;
    if (!species) return;
    const walk = (n: NewickNode): void => {
      speciesOfNode.set(n, species);
      n.branchset?.forEach(walk);
    };
    walk(tree);
  });
  /**
   * One leaf's state under the *current* segment key and filter. Memoized per
   * (species, leaf): the presenter re-resolves on every render, and recomputing
   * 17k compositions per frame is wasted work. The cache is dropped wholesale
   * whenever the filter or segment key changes (see `applyFilter`) — stale bars
   * showing a pre-filter composition would be the obvious bug here.
   */
  interface LeafState {
    datum: LeafDatum | undefined;
    unrecorded: number;
    matched: number;
  }
  const cache = new Map<string, LeafState>();
  // `tooltipOf` receives only (identifier, datum), so the unrecorded count —
  // per-leaf, not per-identifier — rides along keyed by the datum object.
  const unrecordedOf = new WeakMap<LeafDatum, number>();

  const stateOf = (id: string, leaf: NewickNode): LeafState => {
    // `id` is the library's leaf identifier (`category ?? name`) — the join key.
    // The node is used only to decide which species' index to look in.
    const species = speciesOfNode.get(leaf.origin ?? leaf) ?? wanted[0];
    const cacheKey = `${species} ${id}`;
    const hit = cache.get(cacheKey);
    if (hit) return hit;

    const index = indices.get(species);
    const composed = index
      ? composeLeaf(index, id, segmentBy, selection)
      : { counts: new Map<string, number>(), unrecorded: 0, matched: 0 };

    // No bar when nothing is left to draw: a zero-length bar would read as a real
    // measurement of zero, and the library would otherwise fall back to a single
    // segment keyed by the leaf id — a colour the data never justified.
    const datum: LeafDatum | undefined =
      composed.counts.size === 0
        ? undefined
        : {
            // `total` stays implicit: the library sums the segments, so the bar's
            // length is exactly the isolates whose segment value is known.
            segments: [...composed.counts]
              .map(([key, value]) => ({ key, value }))
              .sort((a, b) => b.value - a.value || a.key.localeCompare(b.key)),
          };
    if (datum && composed.unrecorded) unrecordedOf.set(datum, composed.unrecorded);

    const state = { datum, unrecorded: composed.unrecorded, matched: composed.matched };
    cache.set(cacheKey, state);
    return state;
  };

  // 144 countries, 83 collection years, 24 source types... vs DEFAULT_PALETTE's 16.
  // The scale assigns colours cumulatively as keys are primed, so size the palette
  // for the *union* over every configured key — otherwise switching the segment key
  // would wrap around and hand two values the same colour. Seeded, so a value keeps
  // its colour across reloads (and across screenshots).
  const allValues = new Set<string>();
  for (const index of indices.values()) {
    for (const key of keys) for (const [value] of valuesOf(index, key)) allValues.add(value);
  }
  const palette = iwanthue(Math.max(1, allValues.size), { seed: 1234 });

  const threshold = appConfig.values.diffThreshold;

  const layoutStart = performance.now();
  const comparison = createFromConfig(containers, { ...config, palette }, {
    trees,
    dataOf: (id, leaf) => stateOf(id, leaf).datum,
    // The unit noun is the app's: the library only knows magnitudes. The bar
    // counts isolates whose segment value is recorded; unrecorded ones are
    // reported alongside rather than folded in, so the tooltip states the truth.
    tooltipOf: (id, datum) => {
      const segs = datum.segments ?? [];
      const counted = segs.reduce((s, seg) => s + seg.value, 0);
      const unrecorded = unrecordedOf.get(datum) ?? 0;
      const head = `ST ${id}: ${counted} isolate${counted === 1 ? "" : "s"}`;
      const tail = unrecorded ? ` · +${unrecorded} without ${segmentBy}` : "";
      const breakdown =
        segs.length > 1 ? ` (${segs.map((s) => `${s.key}: ${s.value}`).join(", ")})` : "";
      return `${head}${breakdown}${tail}`;
    },
    valueFor: (key) => differenceValue(key),
    // Membership stand-in: low-similarity clades count as "different".
    isDifferent: (key) => differenceValue(key) < threshold,
  });

  /**
   * Re-apply the segment key + filter everywhere. Order matters: drop the cache
   * first, or every consumer below would recompute from stale compositions.
   *
   * The two effects are deliberately separate library calls, because they answer
   * different questions: `dataOf` decides what a bar is *made of*, `setFilter`
   * decides which leaves still belong on screen. A leaf whose isolates are all
   * filtered out is dimmed rather than silently emptied.
   */
  const applyFilter = (): void => {
    cache.clear();
    comparison.colorScale.prime(activeValues());
    for (const panel of comparison.panels) {
      if (isFilterEmpty(selection)) {
        panel.viewer.clearFilter(); // nothing constrained: every leaf stays lit
      } else {
        panel.viewer.setFilter((_meta, leaf) => stateOf(leaf.name ?? "", leaf).matched > 0);
      }
    }
    paintLegend();
  };

  /** Rebuild the footer legend for the active key + filter. */
  const paintLegend = (): void => {
    // Merge across species: one legend, and the scale is shared anyway.
    const merged = new Map<string, number>();
    let unrecorded = 0;
    for (const index of indices.values()) {
      const t = totals(index, segmentBy, selection);
      for (const [value, n] of t.counts) merged.set(value, (merged.get(value) ?? 0) + n);
      unrecorded += t.unrecorded;
    }
    const entries = [...merged]
      .filter(([, n]) => n > 0)
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));

    renderLegend(requireEl("legend-values"), {
      segmentBy,
      entries,
      unrecorded,
      colorOf: (value) => comparison.colorScale.color(value),
    });
  };

  /**
   * The comparison ramp, in the same footer row. Built from the same config
   * block the library builds its scale from, so it matches the branches by
   * construction; the panels' own legends are turned off in that block.
   */
  const paintComparisonLegend = (enabled: boolean): void => {
    const c = config.comparison ?? {};
    renderComparisonLegend(requireEl("legend-comparison"), {
      enabled,
      mode: c.mode ?? "gradient",
      stops: c.stops && c.stops.length >= 2 ? c.stops : DIFF_PALETTE,
      labels: c.legendLabels ?? ["different", "similar"],
      equalColor: c.equalColor ?? "#0077bb",
      membershipLabel: c.membershipLabels?.[1] ?? "equal",
    });
  };

  /** Values of the active segment key, most frequent first (legend order). */
  function activeValues(): string[] {
    const seen = new Set<string>();
    for (const index of indices.values()) {
      for (const [value] of valuesOf(index, segmentBy)) seen.add(value);
    }
    return [...seen];
  }

  // Prime the shared scale with every value of the active key (not just the ones
  // currently on screen) so colours are stable as the tree collapses/expands and
  // a legend would be complete.
  comparison.colorScale.prime(activeValues());
  paintLegend();
  paintComparisonLegend(comparison.panels.some((p) => p.operators.comparison?.isEnabled()));

  buildGlobalControls(requireEl("controls-global"), comparison.panels, {
    keys,
    segmentBy: () => segmentBy,
    setSegmentBy: (key) => {
      segmentBy = key;
      applyFilter();
    },
    selection,
    valuesFor: (key) => {
      const merged = new Map<string, number>();
      for (const index of indices.values()) {
        for (const [value, n] of valuesOf(index, key)) merged.set(value, (merged.get(value) ?? 0) + n);
      }
      return [...merged].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
    },
    onFilterChange: applyFilter,
  }, paintComparisonLegend);
  comparison.panels.forEach((panel, i) => buildPanelControls(controlHosts[i], panel));

  phases.layout = performance.now() - layoutStart;

  // Benchmark readout: how much of the tree actually reached the renderer.
  // `graphNodes` is the honest measure of what was drawn — the leaf budget is a
  // request, and `prepareTree` may return fewer. Reporting both is what keeps a
  // maxNodes sweep interpretable.
  (window as unknown as { __demoStats: unknown }).__demoStats = {
    maxNodes: config.panels?.[0]?.viewer?.maxNodes ?? null,
    graphNodes: comparison.panels.map((p) => p.viewer.getGraph()?.order ?? 0),
  };

  markPainted(performance.now());

  const totalRows = [...indices.values()].reduce((s, ix) => s + ix.rows, 0);
  console.info(
    `[isolates] ${totalRows} rows, keys [${keys.join(", ")}], colouring by ${segmentBy}, ` +
      `${wanted.join(", ")} (join on ${joinColumn})`
  );
}

function requireEl(id: string): HTMLElement {
  const el = document.getElementById(id);
  if (!el) throw new Error(`Missing #${id}`);
  return el;
}

main().catch((err) => {
  console.error(err);
  document.body.insertAdjacentHTML(
    "beforeend",
    `<pre style="color:#c00;padding:12px">${String(err)}</pre>`
  );
});
