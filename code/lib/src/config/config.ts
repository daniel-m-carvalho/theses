import { TreeViewer, type TreeViewerOptions } from "../presentation/viewer/tree_viewer";
import type { LayoutMode, NewickNode } from "../presentation/tree/types";
import { ExpandCollapseOperator, type ExpandMode } from "../presentation/operators/expand_collapse";
import { CladeShapePresenter } from "../presentation/operators/clade_shape";
import { SelectionOperator } from "../presentation/operators/selection";
import { BarChartPresenter, type BarScale } from "../presentation/operators/barchart_presenter";
import { ComparisonOperator, type ComparisonMode } from "../presentation/operators/comparison";
import { CategoricalColorScale, SequentialColorScale } from "../presentation/color/color_scale";
import { keyByClade, keyByName } from "../presentation/data/comparison";
import type {
  ComparisonValueProvider,
  DifferencePredicate,
  NodeKeyOf,
} from "../presentation/data/comparison";
import type { LeafDataProvider, LeafDatum } from "../presentation/data/leaf_data";

/**
 * Config-driven bootstrap for the tree library.
 *
 * The library never fetches and never reads a file: this layer takes an
 * **already-parsed** plain config object (the app decides where it comes from —
 * a bundled JSON file today, an endpoint later) plus a `providers` bundle
 * carrying the non-serializable parts (parsed trees + data callbacks), and
 * wires up the viewer(s) and operators.
 *
 * Two factory shapes, and the config's shape chooses between them:
 *  - a single `viewer`/`operators` block → one panel ({@link createViewer});
 *  - a `panels` array → the linked comparison view ({@link createComparison}),
 *    which is N-capable (build + link every panel, share the color scales).
 * {@link createFromConfig} dispatches on which is present.
 *
 * Everything about *where data comes from* (API calls, response shapes, config
 * loading) and *page layout* (the container elements, CSS) stays in the app.
 */

// --- Config (the serializable slice the library reads) ---

/** Viewer options, serializable subset of {@link TreeViewerOptions}. */
export interface ViewerConfig {
  layoutMode?: LayoutMode;
  maxNodes?: number;
  hideInternalNodes?: boolean;
  reflect?: boolean;
  rerootOn?: string;
  fitPadding?: number;
  /** See {@link TreeViewerOptions.labelDensity}. */
  labelDensity?: number;
  labelGridCellSize?: number;
  /** Swallow the native context menu inside this panel (default true). */
  suppressContextMenu?: boolean;
}

export interface ExpandCollapseConfig {
  /** Attach the expand/collapse operator (default true). */
  enabled?: boolean;
  /**
   * How expanding presents the result (default "incremental"):
   *  - "incremental" — grow the same tree in place; collapse folds it back.
   *  - "subtree" — open the clade as a new tree (it becomes the root); collapsing
   *    that root goes back to the previous view.
   */
  mode?: ExpandMode;
  /** Subtree mode: don't drill into clades smaller than this (default 2). */
  minLeaves?: number;
  /** Minimum displayed subtree leaves for a clade to be collapsible (default 3). */
  collapseMinLeaves?: number;
  /**
   * The depth knob: how many levels of any clade you see at a time. Sets both
   * the opening cut (root = 0) and the levels each expand reveals, so a fresh
   * tree, an expanded clade, and a focused subtree all show the same structure.
   */
  depth?: number;
  /** Override the opening depth alone (root = 0); defaults to `depth`. */
  initialDepth?: number;
  /** Override the per-expand depth alone; defaults to `depth`, else 1. */
  expandDepth?: number;
  /** Toggle (or drill in, per `mode`) on double-click. Default true. */
  toggleOnDoubleClick?: boolean;
}

/** Draw collapsed clades as triangular wedges scaled by the leaves they hide. */
export interface CladeShapeConfig {
  /** Attach the clade-shape presenter (default true). */
  enabled?: boolean;
  /** Point the wedge back toward the root (default true; auto-mirrored). */
  towardRoot?: boolean;
  /** Wedge length along the branch axis, px (default 14). */
  length?: number;
  /** Half-height of the smallest / largest wedge, px (default 4 / 13). */
  minHalfHeight?: number;
  maxHalfHeight?: number;
  /**
   * Top of the size scale: the leaf count drawn at `maxHalfHeight` (log2 growth).
   * Defaults to the leaf count of the tree in view, so the scale calibrates
   * itself. Set it only to share one scale across different trees.
   */
  saturateAt?: number;
  /** Fixed wedge color; default follows the node's own color. */
  color?: string;
  /** Replace the collapsed node's circular marker (default true). */
  hideMarker?: boolean;
}

export interface SelectionConfig {
  /** Attach the selection operator (default true). */
  enabled?: boolean;
  dragSelectEnabled?: boolean;
}

export interface BarChartConfig {
  /** Start visible (default false). */
  enabled?: boolean;
  scale?: BarScale;
  maxBarWidth?: number;
  barHeight?: number;
  offset?: number;
}

/**
 * Comparison settings. Declared **once, at the top level** of {@link Config} —
 * never per panel: a comparison is a statement about the panels *together*, so
 * every panel must present it identically. Splitting it per panel allowed
 * incoherent states (one side coloring differences while the other doesn't) and,
 * worse, mismatched `keyBy` values — keys from different keyers can never
 * correspond, which silently broke cross-tree highlighting.
 */
export interface ComparisonConfig {
  /** Start visible (default false). */
  enabled?: boolean;
  mode?: ComparisonMode;
  /** Serializable form of `keyOf`: canonical clade leaf-set, or node name. */
  keyBy?: "clade" | "name";
  /** Sequential (gradient) scale domain and stops — shared across panels. */
  domain?: [number, number];
  stops?: string[];
  colorEdges?: boolean;
  edgeWidth?: number;
  /** Gradient mode: also color node markers (default false — branches only). */
  colorNodes?: boolean;
  leafColor?: string;
  /** Legend row for branches the backend gave no value for. Unset = no row. */
  absentLabel?: string;
  absentColor?: string;
  equalColor?: string;
  markerSize?: number;
  /** Times a located node flashes before the highlight goes (default 3). */
  flashes?: number;
  /** Milliseconds per on- or off-phase of that flashing (default 300). */
  flashInterval?: number;
  membershipLabels?: [string, string];
  legend?: boolean;
  legendLabels?: [string, string];
}

export interface OperatorsConfig {
  /** Attach expand/collapse (default true). `true` = defaults; object = tuned. */
  expandCollapse?: boolean | ExpandCollapseConfig;
  /** Draw collapsed clades as wedges (default true). */
  cladeShape?: boolean | CladeShapeConfig;
  selection?: SelectionConfig;
  barcharts?: BarChartConfig;
  // No `comparison` here on purpose — it lives at the top level of `Config`,
  // shared by every panel. See {@link ComparisonConfig}.
}

/** One panel's config in a comparison view. */
export interface PanelConfig {
  /** Optional label, for the app's own reference (e.g. matching a data source). */
  id?: string;
  viewer?: ViewerConfig;
  operators?: OperatorsConfig;
}

/**
 * The library's slice of the (possibly larger) application config. A general
 * config file may also carry app-owned keys (API routes, file sources, values);
 * the library simply ignores anything it doesn't read.
 */
export interface Config {
  /** Single-viewer form — use this OR `panels`. */
  viewer?: ViewerConfig;
  operators?: OperatorsConfig;
  /** Comparison form — a panel per tree. Its presence selects the linked view. */
  panels?: PanelConfig[];
  /**
   * Tree-difference presentation, applied identically to **every** panel
   * (see {@link ComparisonConfig}). Omit to attach no comparison operator.
   */
  comparison?: ComparisonConfig;
  /** Link panels for cross-tree navigation (default true when >1 panel). */
  link?: boolean;
  /** Shared categorical palette for the bar-chart presenters across panels. */
  palette?: string[];
}

// --- Providers (the non-serializable parts the app supplies) ---

/** Data callbacks shared across panels (the app owns fetching + shaping). */
export interface DataProviders {
  /** Per-leaf data (bar composition). A leaf with no datum simply gets no bar. */
  dataOf?: LeafDataProvider;
  /**
   * Tooltip wording for a leaf's bar. The library states bare magnitudes by
   * default; naming the unit ("isolates", "reads", "speakers") is the app's,
   * since only it knows what the numbers count.
   */
  tooltipOf?: (identifier: string, datum: LeafDatum) => string;
  /** Gradient-mode comparison value, by node key. */
  valueFor?: ComparisonValueProvider;
  /** Membership-mode predicate: does this node (by key) differ? */
  isDifferent?: DifferencePredicate;
  /** Membership-mode set of differing node keys. */
  differing?: Iterable<string>;
}

export interface ViewerProviders extends DataProviders {
  /** The parsed tree for this viewer (the library never parses/fetches it). */
  tree: NewickNode;
  onSelectionChange?: (selected: string[]) => void;
  onNodeClick?: (node: string) => void;
}

export interface ComparisonProviders extends DataProviders {
  /** Parsed trees, index-aligned with `panels` / `containers`. */
  trees: NewickNode[];
  onSelectionChange?: (selected: string[], panelIndex: number) => void;
  onNodeClick?: (node: string, panelIndex: number) => void;
}

// --- Handles (runtime control surface returned to the app) ---

export interface PanelOperators {
  expandCollapse?: ExpandCollapseOperator;
  cladeShape?: CladeShapePresenter;
  selection?: SelectionOperator;
  barcharts?: BarChartPresenter;
  comparison?: ComparisonOperator;
}

export interface ViewerHandle {
  viewer: TreeViewer;
  /** The attached operators, for dynamic changes (setMode, setEnabled, …). */
  operators: PanelOperators;
  /**
   * The categorical scale (segment key → color) this panel draws with. The app
   * needs it to render a legend for the leaf data: the library assigns the
   * colors, so it is the only place that mapping exists. Read it with
   * `colorScale.assignments()`; `prime()` it up front for a complete legend.
   */
  colorScale: CategoricalColorScale;
  /** The sequential scale this panel's comparison operator colors with. */
  diffScale: SequentialColorScale;
  destroy(): void;
}

export interface ComparisonHandle {
  panels: ViewerHandle[];
  /** The categorical scale shared by every panel, so colors agree across them. */
  colorScale: CategoricalColorScale;
  /**
   * The sequential scale the comparison operators color with, and that their
   * legend is drawn from. Exposed so a caller can paint something the operator
   * does not reach — a clade wedge, a table of values — in the *same* ramp;
   * building a second scale here would agree only by coincidence.
   */
  diffScale: SequentialColorScale;
  destroy(): void;
}

// --- Internals ---

interface Shared {
  colorScale: CategoricalColorScale;
  diffScale: SequentialColorScale;
  /** The one comparison config, applied to every panel. */
  comparison?: ComparisonConfig;
}

function resolveKeyOf(keyBy: "clade" | "name" | undefined): NodeKeyOf {
  return keyBy === "name" ? keyByName : keyByClade;
}

/**
 * Everything every panel must agree on: the categorical scale (bar categories),
 * the sequential scale (comparison gradient), and the comparison settings
 * themselves. Built once and threaded into each panel, which is what makes
 * "same colors, same comparison" structural rather than a convention.
 */
function makeShared(config: Config): Shared {
  const colorScale = new CategoricalColorScale(config.palette);
  const cmp = config.comparison;
  const diffScale = new SequentialColorScale({ stops: cmp?.stops, domain: cmp?.domain });
  return { colorScale, diffScale, comparison: cmp };
}

interface PanelProviders extends DataProviders {
  tree: NewickNode;
  onSelectionChange?: (selected: string[]) => void;
  onNodeClick?: (node: string) => void;
}

/** Construct one viewer + its operators from a panel config. */
function buildPanel(
  container: HTMLElement,
  panel: PanelConfig,
  providers: PanelProviders,
  shared: Shared
): ViewerHandle {
  const v = panel.viewer ?? {};
  const ops = panel.operators ?? {};

  const viewerOptions: TreeViewerOptions = {
    layoutMode: v.layoutMode,
    maxNodes: v.maxNodes,
    hideInternalNodes: v.hideInternalNodes,
    reflect: v.reflect,
    rerootOn: v.rerootOn,
    fitPadding: v.fitPadding,
    labelDensity: v.labelDensity,
    labelGridCellSize: v.labelGridCellSize,
    suppressContextMenu: v.suppressContextMenu,
  };
  const viewer = new TreeViewer(container, viewerOptions);
  const operators: PanelOperators = {};

  // Expand/collapse — on unless explicitly disabled (`false` or `{enabled:false}`).
  const ec = ops.expandCollapse;
  const ecEnabled = ec !== false && (typeof ec !== "object" || ec.enabled !== false);
  if (ecEnabled) {
    const o = typeof ec === "object" ? ec : {};
    const collapse = new ExpandCollapseOperator({
      mode: o.mode,
      minLeaves: o.minLeaves,
      collapseMinLeaves: o.collapseMinLeaves,
      depth: o.depth,
      initialDepth: o.initialDepth,
      expandDepth: o.expandDepth,
      toggleOnDoubleClick: o.toggleOnDoubleClick,
    });
    collapse.attach(viewer);
    operators.expandCollapse = collapse;
  }

  // Clade wedges — on unless explicitly disabled. Reads collapsed state off the
  // layout nodes, so it needs no link to whatever drives collapse.
  const cs = ops.cladeShape;
  const csEnabled = cs !== false && (typeof cs !== "object" || cs === null || cs.enabled !== false);
  if (csEnabled) {
    const o = typeof cs === "object" && cs !== null ? cs : {};
    const shape = new CladeShapePresenter({
      towardRoot: o.towardRoot,
      length: o.length,
      minHalfHeight: o.minHalfHeight,
      maxHalfHeight: o.maxHalfHeight,
      saturateAt: o.saturateAt,
      color: o.color,
      hideMarker: o.hideMarker,
    });
    shape.attach(viewer);
    operators.cladeShape = shape;
  }


  // Selection — on unless explicitly disabled.
  if (!ops.selection || ops.selection.enabled !== false) {
    const selection = new SelectionOperator({
      dragSelectEnabled: ops.selection?.dragSelectEnabled ?? false,
      onSelectionChange: providers.onSelectionChange,
    });
    selection.attach(viewer);
    operators.selection = selection;
  }

  // Bar charts — attached only when configured.
  if (ops.barcharts) {
    const bc = ops.barcharts;
    const barcharts = new BarChartPresenter({
      scale: bc.scale,
      maxBarWidth: bc.maxBarWidth,
      barHeight: bc.barHeight,
      offset: bc.offset,
      colorScale: shared.colorScale,
      dataOf: providers.dataOf,
      tooltipOf: providers.tooltipOf,
      enabled: bc.enabled ?? false,
    });
    barcharts.attach(viewer);
    operators.barcharts = barcharts;
  }

  // Comparison — attached only when configured, from the one shared block, so
  // every panel gets identical settings (notably the same `keyBy`, without which
  // keys from different panels could never correspond).
  if (shared.comparison) {
    const c = shared.comparison;
    const comparison = new ComparisonOperator({
      scale: shared.diffScale,
      keyOf: resolveKeyOf(c.keyBy),
      valueFor: providers.valueFor,
      isDifferent: providers.isDifferent,
      differing: providers.differing,
      mode: c.mode,
      colorEdges: c.colorEdges,
      edgeWidth: c.edgeWidth,
      colorNodes: c.colorNodes,
      leafColor: c.leafColor,
      absentLabel: c.absentLabel,
      absentColor: c.absentColor,
      equalColor: c.equalColor,
      markerSize: c.markerSize,
      flashes: c.flashes,
      flashInterval: c.flashInterval,
      membershipLabels: c.membershipLabels,
      legend: c.legend,
      legendLabels: c.legendLabels,
      enabled: c.enabled ?? false,
    });
    comparison.attach(viewer);
    operators.comparison = comparison;
  }

  const unsub: Array<() => void> = [];
  if (providers.onNodeClick) {
    const cb = providers.onNodeClick;
    unsub.push(viewer.events.on("clickNode", ({ node }) => cb(node)));
  }

  // Feed the tree in last, so the just-attached operators bind on first render.
  viewer.setTree(providers.tree);

  return {
    viewer,
    operators,
    colorScale: shared.colorScale,
    diffScale: shared.diffScale,
    destroy() {
      unsub.forEach((u) => u());
      operators.comparison?.detach();
      operators.barcharts?.detach();
      operators.selection?.detach();
      operators.cladeShape?.detach();
      operators.expandCollapse?.detach();
      viewer.destroy();
    },
  };
}

// --- Public factories ---

/** Build a single viewer + its operators from a config block. */
export function createViewer(
  container: HTMLElement,
  config: {
    viewer?: ViewerConfig;
    operators?: OperatorsConfig;
    palette?: string[];
    comparison?: ComparisonConfig;
  },
  providers: ViewerProviders
): ViewerHandle {
  const shared = makeShared({
    palette: config.palette,
    operators: config.operators,
    comparison: config.comparison,
  });
  return buildPanel(
    container,
    { viewer: config.viewer, operators: config.operators },
    { ...providers },
    shared
  );
}

/**
 * Build the comparison view: one viewer per panel, linked for cross-tree
 * navigation, sharing the color scales. N-capable; used with two panels here.
 */
export function createComparison(
  containers: HTMLElement[],
  config: Config,
  providers: ComparisonProviders
): ComparisonHandle {
  const panelCfgs = config.panels ?? [];
  if (containers.length < panelCfgs.length) {
    throw new Error(
      `createComparison: config has ${panelCfgs.length} panels but only ${containers.length} containers were provided`
    );
  }
  const shared = makeShared(config);

  const panels = panelCfgs.map((panel, i) =>
    buildPanel(
      containers[i],
      panel,
      {
        tree: providers.trees[i],
        dataOf: providers.dataOf,
        valueFor: providers.valueFor,
        isDifferent: providers.isDifferent,
        differing: providers.differing,
        onSelectionChange: providers.onSelectionChange
          ? (sel) => providers.onSelectionChange!(sel, i)
          : undefined,
        onNodeClick: providers.onNodeClick
          ? (node) => providers.onNodeClick!(node, i)
          : undefined,
      },
      shared
    )
  );

  // Link comparison operators for cross-tree navigation. The peer model is 1:1
  // (each operator holds a single peer) — exactly right for two panels. For
  // N>2 we link consecutive neighbors; full N-way linking would need a peer
  // registry (see README §9.4 / limitations).
  if (config.link !== false) {
    for (let i = 0; i + 1 < panels.length; i++) {
      const a = panels[i].operators.comparison;
      const b = panels[i + 1].operators.comparison;
      if (a && b) {
        a.link(b);
        b.link(a);
      }
    }
  }

  return {
    panels,
    colorScale: shared.colorScale,
    diffScale: shared.diffScale,
    destroy() {
      panels.forEach((p) => p.destroy());
    },
  };
}

/**
 * Umbrella factory — the config's shape chooses: a `panels` array builds the
 * linked comparison view; a bare `viewer`/`operators` block builds a single
 * panel (returned as a one-element {@link ComparisonHandle} for a uniform API).
 */
export function createFromConfig(
  containers: HTMLElement[],
  config: Config,
  providers: ComparisonProviders
): ComparisonHandle {
  if (config.panels && config.panels.length > 0) {
    return createComparison(containers, config, providers);
  }
  const handle = createViewer(
    containers[0],
    {
      viewer: config.viewer,
      operators: config.operators,
      palette: config.palette,
      comparison: config.comparison,
    },
    {
      tree: providers.trees[0],
      dataOf: providers.dataOf,
      valueFor: providers.valueFor,
      isDifferent: providers.isDifferent,
      differing: providers.differing,
      onSelectionChange: providers.onSelectionChange
        ? (sel) => providers.onSelectionChange!(sel, 0)
        : undefined,
      onNodeClick: providers.onNodeClick
        ? (node) => providers.onNodeClick!(node, 0)
        : undefined,
    }
  );
  return {
    panels: [handle],
    colorScale: handle.colorScale,
    diffScale: handle.diffScale,
    destroy: () => handle.destroy(),
  };
}
