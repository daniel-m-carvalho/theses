/**
 * Two trees, side by side, driven by server slices.
 *
 * The library owns rendering and the operators; this owns navigation and the
 * menus. The seam is narrow on purpose: `createComparison` is called **once**
 * and the trees are replaced with `setTree` afterwards, because rebuilding
 * both panels on every navigation would tear down and re-create two Sigma
 * renderers for what is a change of contents.
 *
 * Providers are read through refs rather than captured. The library keeps the
 * provider functions it was given at construction; a closure over `gradient`
 * would keep serving the first slice's values forever.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import {
  createComparison,
  type ComparisonHandle,
  type Config,
} from "phylo-tree-viewer";
import type { PairSummary } from "../api/types";
import { ContextMenu } from "../menu/ContextMenu";
import { TypingLegend } from "../typing/TypingLegend";
import { datumFor, useTypingData } from "../typing/useTypingData";
import { buildMenu, menuTitle, type PendingMenu } from "./menuItems";
import {
  PIXELS_PER_LEAF,
  readableBudget,
  useSide,
  type SideActions,
  type SideState,
} from "./useSide";

/**
 * Panels are identical except for their label: the same budget, the same
 * gradient, the same shaping. Anything asymmetric would make the two sides
 * incomparable by eye, which is the entire task.
 */
/**
 * `maxNodes` is raised deliberately.
 *
 * The viewer carries its own budget (default 200) and prunes with
 * `prepareTree`. Here the **server** already budgeted, and it did so with
 * information the client does not have — which clades diverge — so a second,
 * blinder pruning on top would throw most of that away. The server's slice is
 * shown as it arrived.
 *
 * `expandCollapse` is off for the same reason: collapsing is the server's job
 * in this app, and a client-side operator with its own collapse state would be
 * a second opinion about what is collapsed.
 */
const VIEWER = {
  layoutMode: "cladogram",
  hideInternalNodes: true,
  maxNodes: 100_000,
} as const;

/**
 * Wedge size, tied to the row spacing rather than left at the library default.
 *
 * The default tops out at a half-height of 13 — a 26px triangle. The budget
 * puts a tip every `PIXELS_PER_LEAF` pixels, so at that size neighbouring
 * clades overlapped by more than double and the column of them read as one
 * black bar. Deriving the two from each other keeps them in step if either is
 * retuned.
 */
const CLADE_SHAPE = {
  enabled: true,
  // Black, as in the library's own demo: the wedge is structure, and colouring
  // it competes with the divergence gradient, which is the thing on screen
  // that actually carries a value.
  color: "#000000",
  minHalfHeight: Math.max(1, PIXELS_PER_LEAF * 0.12),
  maxHalfHeight: PIXELS_PER_LEAF * 0.42,
} as const;

const CONFIG: Config = {
  panels: [
    {
      id: "left",
      viewer: { ...VIEWER },
      operators: {
        expandCollapse: false,
        selection: { enabled: true },
        cladeShape: { ...CLADE_SHAPE },
        // Attached always, enabled on demand: the presenter can be switched
        // without rebuilding the panels, and a leaf with no datum simply gets
        // no bar.
        barcharts: { enabled: false, scale: "log" },
      },
    },
    {
      id: "right",
      // Mirrored so the two trees face each other and corresponding clades sit
      // opposite rather than both running left to right.
      viewer: { ...VIEWER, reflect: true },
      operators: {
        expandCollapse: false,
        selection: { enabled: true },
        cladeShape: { ...CLADE_SHAPE },
        barcharts: { enabled: false, scale: "log" },
      },
    },
  ],
  comparison: {
    enabled: true,
    mode: "gradient",
    keyBy: "name",
    colorEdges: true,
    // Edges only. The clade presenter already hides a collapsed node's circular
    // marker so the wedge stands alone, and colouring markers put the ball
    // straight back — every clade showed a coloured dot beside its triangle.
    // The gradient reads on the branches, which is where a divergence between
    // two topologies actually lives.
    colorNodes: false,
    legend: true,
    legendLabels: ["identical", "diverged"],
  },
  /**
   * Panels are NOT linked.
   *
   * Linking makes a click highlight the "corresponding" node in the other
   * panel, keyed by `keyOf`. With `keyBy: "name"` an unnamed internal node
   * keys to the empty string — and every clade in a slice is unnamed, because
   * the source Newick labels them `_` and we blank it. So `highlightByKey("")`
   * matched the first empty-named node on the other side, which is its root:
   * clicking any clade tracked to the other tree's root, every time.
   *
   * Supplying a correspondence map would fix the aim, but not the idea. A
   * clade's counterpart is a best-overlap match, and following it on every
   * click moves the view the user is comparing against, using an
   * approximation they did not ask for. Locating something in the other tree
   * is a deliberate act, so it lives in the menu — and only for leaves, where
   * the match is exact (§ the menu's "Find this leaf in the other tree").
   */
  link: false,
};

export function ComparisonView({
  pair,
  initial,
  onNavigate,
  isolateSets = [null, null],
  showTyping = false,
  showGradient = true,
}: {
  pair: PairSummary;
  initial?: { left: number[]; right: number[] };
  onNavigate?: (left: number[], right: number[]) => void;
  /** Isolate-set id per side; null where that tree has no typing data. */
  isolateSets?: [string | null, string | null];
  showTyping?: boolean;
  showGradient?: boolean;
}) {
  // Both panels are the same height, so one measurement serves both — and
  // both must ask for the same detail or the two sides stop being comparable
  // by eye, which is the entire task.
  const [panelHeight, setPanelHeight] = useState(0);
  const autoBudget = readableBudget(panelHeight);

  const [left, leftActions] = useSide(pair.left, pair.id, "rf", initial?.left, autoBudget);
  const [right, rightActions] = useSide(pair.right, pair.id, "rf", initial?.right, autoBudget);

  // Which typing columns to show. Several at once is allowed; see
  // `useTypingData` for what that does to a bar's length.
  const [segmentKeys, setSegmentKeys] = useState<string[]>([]);
  const leftTyping = useTypingData(isolateSets[0], left.tree, showTyping, segmentKeys);
  const rightTyping = useTypingData(isolateSets[1], right.tree, showTyping, segmentKeys);

  // Start on the first column the store offers, once it is known.
  const offered = leftTyping.keys.length ? leftTyping.keys : rightTyping.keys;
  useEffect(() => {
    if (segmentKeys.length === 0 && offered.length > 0) setSegmentKeys([offered[0]]);
  }, [offered, segmentKeys]);
  const typing = useRef([leftTyping, rightTyping]);
  typing.current = [leftTyping, rightTyping];
  const [swatches, setSwatches] = useState<ReadonlyMap<string, string>>(new Map());

  const leftHost = useRef<HTMLDivElement>(null);
  const rightHost = useRef<HTMLDivElement>(null);
  const handle = useRef<ComparisonHandle | null>(null);
  const [menu, setMenu] = useState<PendingMenu | null>(null);
  // What is selected in each panel. The menu acts on this when opened away
  // from a node, which is the interaction the library's selection operator is
  // there for: pick a node, then ask what can be done with it.
  const [selected, setSelected] = useState<[number | null, number | null]>([null, null]);
  /**
   * The last clade actually chosen, per panel — kept alive across the clear
   * that opening a menu causes.
   *
   * Right-clicking empty canvas makes the selection operator drop the
   * selection, and it does so before the menu is built. Reading the live
   * selection therefore always found nothing, and "select a clade, then
   * right-click to act on it" — the whole interaction — silently degraded to
   * the view menu. This holds the choice until the user makes another one or
   * explicitly clears it with a left click on empty canvas.
   */
  const lastSelected = useRef<[number | null, number | null]>([null, null]);
  /**
   * Sigma key → the backend's stored id, per panel.
   *
   * Built from the library's own node map, because the key is the library's to
   * choose: it prefixes names (`named_10049`) and generates `n47` for anything
   * unnamed. Reconstructing that format here would be a guess that silently
   * stops matching the day it changes; the node map is the library telling us
   * directly, and `source.metadata` carries the id through `prepareTree`'s
   * cloning.
   */
  const keyToStoredId = useRef<[Map<string, number>, Map<string, number>]>([
    new Map(),
    new Map(),
  ]);

  /**
   * Re-read a panel's key mapping.
   *
   * Pulled from `getNodeMap()` rather than taken from the `render` event
   * payload alone, because `createComparison` renders during construction —
   * before there is anything to subscribe with. Listening only for the event
   * left the map empty until the next re-render, so on first load selecting a
   * clade resolved to nothing and the menu fell back to the view.
   */
  const refreshKeys = useCallback((side: 0 | 1, viewer: { getNodeMap: () => Map<string, { source: { metadata?: Record<string, unknown> } }> }) => {
    const resolved = new Map<string, number>();
    for (const [key, layoutNode] of viewer.getNodeMap()) {
      const storedId = layoutNode.source.metadata?.storedId;
      if (typeof storedId === "number") resolved.set(key, storedId);
    }
    keyToStoredId.current[side] = resolved;
  }, []);

  // Read by the library's providers on every lookup, so they always see the
  // slice currently displayed rather than the one present at construction.
  const sides = useRef<[SideState, SideState]>([left, right]);
  sides.current = [left, right];

  const bothLoaded = Boolean(left.tree && right.tree);

  // --- build the panels, once ------------------------------------------
  useEffect(() => {
    if (!bothLoaded || handle.current) return;
    if (!leftHost.current || !rightHost.current) return;

    const built = createComparison([leftHost.current, rightHost.current], CONFIG, {
      trees: [sides.current[0].tree!.root, sides.current[1].tree!.root],
      onSelectionChange: (keys: string[], panelIndex: number) => {
        const key = keys[keys.length - 1];
        const storedId =
          key === undefined ? null : (keyToStoredId.current[panelIndex].get(key) ?? null);
        if (storedId !== null) lastSelected.current[panelIndex] = storedId;
        setSelected((current) => {
          const next: [number | null, number | null] = [...current];
          next[panelIndex] = storedId;
          return next;
        });
      },
      // Typing data for one leaf. Read through a ref so it follows the slice
      // rather than staying whatever was loaded when the panels were built.
      dataOf: (identifier: string) => {
        const [l, r] = typing.current;
        return datumFor(l.byLeaf.get(identifier) ?? r.byLeaf.get(identifier));
      },
      tooltipOf: (identifier: string, datum) => {
        const [l, r] = typing.current;
        const found = l.byLeaf.get(identifier) ?? r.byLeaf.get(identifier);
        const hidden = found ? found.available - found.total : 0;
        const total = datum.total ?? 0;
        return `${identifier}: ${total.toLocaleString()} isolates${
          hidden > 0 ? ` (+${hidden.toLocaleString()} unrecorded)` : ""
        }`;
      },
      // The provider is handed the node as well as the key; the node carries
      // the backend's id, which is the only identifier both sides agree on.
      // Keying by name would break on the unnamed internal nodes that make up
      // most of a slice.
      valueFor: (_key: string, node) => {
        const storedId = node.metadata?.storedId;
        if (typeof storedId !== "number") return undefined;
        const [l, r] = sides.current;
        return l.gradient.similarityOf(storedId) ?? r.gradient.similarityOf(storedId);
      },
    });
    handle.current = built;

    const unsubscribe = built.panels.map((panel, index) => {
      const side = index as 0 | 1;
      // Once now, because the first render already happened inside
      // createComparison, and again on every later one: pruning and re-layout
      // mint new keys.
      refreshKeys(side, panel.viewer);
      const off = [
        panel.viewer.events.on("render", () => refreshKeys(side, panel.viewer)),
        panel.viewer.events.on("rightClickNode", ({ node, x, y, original }) => {
          // The emit is synchronous inside the DOM dispatch, so this still
          // suppresses the browser's own menu.
          original.preventDefault?.();
          setMenu({ side, at: { x, y }, storedId: keyToStoredId.current[side].get(node) });
        }),
        panel.viewer.events.on("rightClickStage", ({ x, y, original }) => {
          original.preventDefault?.();
          setMenu({ side, at: { x, y }, storedId: lastSelected.current[side] ?? undefined });
        }),
        // A left click on empty canvas is the deliberate "never mind".
        // Measured: Sigma emits `clickStage` only when no node was hit, so
        // this does not fire on the click that made a selection.
        panel.viewer.events.on("clickStage", () => {
          lastSelected.current[side] = null;
          setSelected((current) => {
            const next: [number | null, number | null] = [...current];
            next[side] = null;
            return next;
          });
        }),
      ];
      return () => off.forEach((fn) => fn());
    });

    return () => {
      unsubscribe.forEach((fn) => fn());
      built.destroy();
      handle.current = null;
    };
  }, [bothLoaded]);

  // --- replace contents on navigation -----------------------------------
  useEffect(() => {
    if (left.tree) handle.current?.panels[0]?.viewer.setTree(left.tree.root);
  }, [left.tree]);

  useEffect(() => {
    if (right.tree) handle.current?.panels[1]?.viewer.setTree(right.tree.root);
  }, [right.tree]);

  // Report where we are, so the URL names it and a refresh comes back here.
  useEffect(() => {
    onNavigate?.(left.path, right.path);
  }, [left.path, right.path, onNavigate]);

  // The divergence gradient is a presentation, not a fact about the data, so
  // it is switched rather than rebuilt: the operator keeps its values and
  // simply stops colouring. Turning it off also hides its own legend, which
  // the operator handles.
  useEffect(() => {
    handle.current?.panels.forEach((panel) => {
      panel.operators.comparison?.setEnabled(showGradient);
    });
  }, [showGradient]);

  // Feed the bar charts, and keep the legend in step with the scale that is
  // actually colouring them. The scale is primed with every category present
  // so the legend is complete before a bar for that category is drawn.
  useEffect(() => {
    const built = handle.current;
    if (!built) return;
    const categories = [...new Set([...leftTyping.categories, ...rightTyping.categories])];
    built.colorScale.prime(categories);
    built.panels.forEach((panel, index) => {
      const bars = panel.operators.barcharts;
      if (!bars) return;
      const source = index === 0 ? leftTyping : rightTyping;
      const data = new Map<string, ReturnType<typeof datumFor> & object>();
      for (const [leaf, composition] of source.byLeaf) {
        const datum = datumFor(composition);
        // Leaves with nothing are left out rather than passed as empty: an
        // empty datum makes the library key the bar by the leaf's own name.
        if (datum) data.set(leaf, datum);
      }
      bars.setData(data);
      bars.setEnabled(showTyping);
    });
    // Built from the categories **currently** shown, not from every assignment
    // the scale has ever made. The scale accumulates across segment keys and
    // is never reset, so reading it wholesale left the legend listing "Human"
    // and "Food" after switching to Continent.
    //
    // Only set when it actually changed: this is a fresh Map each time, so
    // assigning it unconditionally is a state change on every render.
    const next = new Map(
      categories.map((category) => [category, built.colorScale.color(category)]),
    );
    setSwatches((current) =>
      current.size === next.size && [...next].every(([k, v]) => current.get(k) === v)
        ? current
        : next,
    );
  }, [showTyping, leftTyping, rightTyping]);

  // Re-measure on resize, so the detail tracks the window rather than a
  // constant chosen for whatever window it was written on.
  useEffect(() => {
    const host = leftHost.current;
    if (!host || typeof ResizeObserver === "undefined") return;
    const measure = () => setPanelHeight(host.clientHeight);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(host);
    return () => observer.disconnect();
  }, []);

  const dismiss = useCallback(() => setMenu(null), []);

  // A menu opened on empty canvas still acts on the selected node, if there is
  // one — selecting and then right-clicking is the flow the menus were asked
  // for, and it is also the only way to reach a node too small to hit.
  const resolved: PendingMenu | null = menu
    ? {
        ...menu,
        storedId:
          menu.storedId ?? selected[menu.side] ?? lastSelected.current[menu.side] ?? undefined,
      }
    : null;

  const items = resolved
    ? buildMenu(resolved, [left, right], [leftActions, rightActions])
    : [];

  return (
    <div className="comparison">
      <header className="comparison-bar">
        <Side label="Left" state={left} actions={leftActions} selected={selected[0]} />
        <Side label="Right" state={right} actions={rightActions} selected={selected[1]} />
      </header>

      <div className="panels">
        <Panel host={leftHost} state={left} />
        <Panel host={rightHost} state={right} />
      </div>

      {showTyping ? (
        <TypingLegend
          assignments={swatches}
          segmentKeys={segmentKeys}
          keys={offered}
          onSegmentKeys={setSegmentKeys}
          inflation={Math.max(leftTyping.inflation, rightTyping.inflation)}
          loading={leftTyping.loading || rightTyping.loading}
          error={leftTyping.error ?? rightTyping.error}
        />
      ) : null}

      {resolved ? (
        <ContextMenu
          at={resolved.at}
          title={menuTitle(resolved, [left, right])}
          items={items}
          onDismiss={dismiss}
        />
      ) : null}
    </div>
  );
}

function Panel({
  host,
  state,
}: {
  host: React.RefObject<HTMLDivElement | null>;
  state: SideState;
}) {
  return (
    <section className="panel">
      <div className="sigma-host" ref={host} />
      {state.loading ? <p className="panel-note">Loading slice…</p> : null}
      {state.error ? <p className="panel-note error">{state.error}</p> : null}
    </section>
  );
}

function Side({
  label,
  state,
  actions,
  selected,
}: {
  label: string;
  state: SideState;
  actions: SideActions;
  selected: number | null;
}) {
  const slice = state.slice;
  return (
    <div className="side-summary">
      <p className="side-name">
        {label}: <strong>{state.treeId}</strong>
        {selected !== null ? (
          <span className="selected-node"> · node {selected} selected</span>
        ) : null}
      </p>
      {slice ? (
        <p className="side-counts">
          {/* The claim, on screen: what is drawn against what it stands for. */}
          showing <strong>{slice.displayed_leaves.toLocaleString()}</strong> of{" "}
          {slice.total_leaves.toLocaleString()} leaves
          {slice.hidden_leaves > 0
            ? ` · ${slice.hidden_leaves.toLocaleString()} behind wedges`
            : null}
          {state.canGoBack ? ` · ${state.path.length} level(s) in` : null}
        </p>
      ) : null}
      {state.canGoBack ? (
        <button type="button" className="link-button" onClick={actions.reset}>
          Back to whole tree
        </button>
      ) : null}
    </div>
  );
}
