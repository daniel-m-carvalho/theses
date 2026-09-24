import Sigma from "sigma";
import type {
  MouseCoords,
  SigmaNodeEventPayload,
  SigmaStageEventPayload,
} from "sigma/types";
import type Graph from "graphology";
import type { ChildOrder, IsCollapsed, LayoutMode, NewickNode } from "../tree/types";
import { NEVER_COLLAPSED } from "../tree/types";
import { orderByName } from "../tree/model";
import { buildGraph, BRANCH_COLOR, type LayoutNode } from "../tree/layout";
import { leafNamesOf, mrcaId } from "../tree/navigation";
import { Emitter } from "./emitter";

/** Gap in pixels between a tip and its label. Matches Sigma's own spacing. */
const LABEL_GAP = 3;

/**
 * Extra clearance for a collapsed clade's label.
 *
 * A wedge is a DOM overlay, not a Sigma marker, so the node's `size` says
 * nothing about how much room the triangle takes. Without this the label was
 * drawn under it and lost its last character — "598 leave".
 *
 * Matches {@link CladeShapeOptions.length}'s default. The two are not wired
 * together because the label is drawn by the renderer and the wedge by an
 * operator that may not even be attached; a consumer tuning `length` far from
 * the default should expect to nudge this.
 */
const COLLAPSED_LABEL_GAP = 17;

/**
 * Draw a node's label clear of its wedge, on the side the tree grows away from.
 *
 * Two things Sigma's own drawer gets wrong for a dendrogram.
 *
 * **Side.** Sigma always writes to the right of the node. That is correct for
 * the left-hand panel of a comparison, whose tree grows leftward so the label
 * sits outside it — and wrong for a mirrored panel, where it put every label
 * inside the tree, over the branches.
 *
 * **Clearance.** A collapsed clade is drawn as a wedge by an *operator*, as a
 * DOM overlay, so the node's `size` says nothing about how much room the
 * triangle takes. Both panels drew the label under it and lost the leading
 * characters: a clade of 13,349 read "3,349 leaves".
 */
function labelDrawer(reflect: boolean) {
  return function drawNodeLabel(
    context: CanvasRenderingContext2D,
    data: { x: number; y: number; size: number; label: string | null; collapsed?: boolean },
    settings: {
      labelFont: string;
      labelSize: number;
      labelWeight: string;
      labelColor: { color?: string };
    },
  ): void {
    if (!data.label) return;
    context.font = `${settings.labelWeight} ${settings.labelSize}px ${settings.labelFont}`;
    context.fillStyle = settings.labelColor.color ?? "#000";

    const gap = data.size + (data.collapsed ? COLLAPSED_LABEL_GAP : LABEL_GAP);
    const y = data.y + settings.labelSize / 3;

    if (reflect) {
      context.textAlign = "right";
      context.fillText(data.label, data.x - gap, y);
      // Restored: the context is shared with every other label this frame.
      context.textAlign = "left";
    } else {
      context.fillText(data.label, data.x + gap, y);
    }
  };
}

/** A node reducer in the composable pipeline (see {@link TreeViewer.addNodeReducer}). */
export type NodeReducer = (
  node: string,
  data: Record<string, unknown>
) => Record<string, unknown>;

/** An edge reducer in the composable pipeline (see {@link TreeViewer.addEdgeReducer}). */
export type EdgeReducer = (
  edge: string,
  data: Record<string, unknown>
) => Record<string, unknown>;

/**
 * Predicate deciding whether a leaf passes the active metadata filter (see
 * {@link TreeViewer.setFilter}). Receives the leaf's {@link NewickNode.metadata}
 * (an empty object when the leaf carries none) — and the leaf node itself, for
 * predicates that also want `name`/`category`. Return `true` to keep the leaf,
 * `false` to filter it out (dimmed, and given no bar by the bar-chart operator).
 */
export type LeafFilter = (
  metadata: Record<string, string | number | null>,
  leaf: NewickNode
) => boolean;

/** Node color for a leaf filtered out by the active metadata filter. */
export const FILTER_DIM_COLOR = "rgba(120,120,120,0.22)";

/** Events emitted by a {@link TreeViewer}. Operators subscribe to these. */
export interface ViewerEvents extends Record<string, unknown> {
  /** Fired after every rebuild + (re)mount of Sigma. Carries the fresh handles. */
  render: { renderer: Sigma; graph: Graph; nodeMap: Map<string, LayoutNode> };
  /** Fired when the underlying tree is replaced via setTree(). */
  treeChanged: { tree: NewickNode };
  clickNode: { node: string };
  doubleClickNode: { node: string };
  clickStage: { x: number; y: number };
  enterNode: { node: string };
  leaveNode: Record<string, never>;
  /**
   * Right-click (contextmenu) on a node — the seam an app-drawn context menu
   * hangs off. `x`/`y` are viewport coordinates for positioning the menu;
   * `original` is the DOM event.
   *
   * **The browser's own context menu is not suppressed.** Sigma's right-click
   * handler, unlike its double-click one, never calls `preventDefault()`, and
   * the library does not either — whether a page keeps the native menu is
   * application policy. An app drawing its own menu calls
   * `original.preventDefault()` in its handler (the emit is synchronous within
   * the DOM dispatch, so that still works).
   *
   * Hit-testing is Sigma's `getNodeAtPosition`, i.e. by marker size: with
   * `hideInternalNodes` the reachable nodes are leaves and collapsed clade
   * markers, exactly as for {@link ViewerEvents.clickNode}.
   */
  rightClickNode: { node: string; x: number; y: number; original: MouseEvent | TouchEvent };
  /** Right-click on empty stage (no node hit) — e.g. to dismiss a menu. */
  rightClickStage: { x: number; y: number; original: MouseEvent | TouchEvent };
  /**
   * Fired when the active metadata filter changes (set or cleared). Overlay
   * operators that draw per-leaf (e.g. the bar-chart presenter) listen so they
   * can hide/show without a full graph rebuild.
   */
  filterChanged: { filter: LeafFilter | null };
  destroy: Record<string, never>;
}

export interface TreeViewerOptions {
  layoutMode?: LayoutMode; // default "cladogram"
  maxNodes?: number; // default 200
  hideInternalNodes?: boolean; // default true
  /**
   * How many labels Sigma will draw per grid cell, and how big a cell is in
   * pixels.
   *
   * Sigma thins labels by dividing the viewport into cells and keeping the
   * largest node in each. That suits a force-directed graph, whose nodes are
   * spread over two dimensions. A dendrogram is the opposite: every tip is
   * pinned to one x, so the whole column of them falls inside a single column
   * of cells — at the 100px default a 550px-tall panel showed *one* label for
   * fifty tips.
   *
   * Defaults leave Sigma's own behaviour untouched; a dendrogram consumer
   * wants a much smaller cell.
   */
  labelDensity?: number;
  labelGridCellSize?: number;
  rerootOn?: string;
  /**
   * Extra zoom-out applied after auto-fit so the tree sits centered with a
   * margin (Sigma fits node positions edge-to-edge, which otherwise clips the
   * right-side leaf labels and bar charts). Fraction of the fitted size; e.g.
   * 0.25 leaves ~12% margin on each side. Default 0.25.
   */
  fitPadding?: number;
  /**
   * Reflect the tree horizontally (root on the right, tips on the left).
   * Useful for facing two trees toward each other. Operators that draw to one
   * side (e.g. the bar-chart presenter) read this via
   * {@link TreeViewer.isReflected} and flip their side accordingly.
   * Default false.
   */
  reflect?: boolean;
  /**
   * Order of sibling clades (a structure-preserving branch rotation). Defaults
   * to ascending lexicographic order ({@link orderByName}). Swap for a
   * different policy, e.g. {@link orderByNumeric} or {@link orderBySizeDesc}.
   */
  childOrder?: ChildOrder;
  /**
   * Suppress the browser's native context menu **inside this viewer's
   * container** (default true), so a right-click can drive an app-drawn menu
   * without the native one appearing on top of it.
   *
   * Scoped deliberately: the listener sits on the viewer's own container, so
   * right-clicks on the surrounding page — toolbars, headers, a footer — keep
   * the native menu. It is bound to the *container* rather than to Sigma's
   * right-click event because Sigma listens on its own mouse layer, which is a
   * **sibling** of the operator overlays: anything that opts into pointer events
   * (`pointerEvents: "auto"`) swallows the event before Sigma sees it, and the
   * native menu would still pop there. Every overlay is currently click-through,
   * so this is insurance against the next one that isn't — and it also covers
   * container padding the mouse layer does not span.
   *
   * Independent of {@link ViewerEvents.rightClickNode}, which is emitted either
   * way — set this to false to keep the native menu (e.g. for "Save image as…").
   */
  suppressContextMenu?: boolean;
}

/**
 * Core, interaction-agnostic viewer for one phylogenetic tree.
 *
 * The viewer owns the Sigma renderer, the graphology graph, the layout state
 * (mode / pruning / re-rooting), and a composable node-reducer pipeline. It
 * does NOT implement collapse, selection or bar charts itself — those are
 * provided by independent operators that attach to it and communicate purely
 * through {@link ViewerEvents}, the node-reducer pipeline, and the collapse
 * predicate hook. This keeps each operation in its own file and lets two
 * side-by-side viewers be fully independent.
 */
export class TreeViewer {
  readonly events = new Emitter<ViewerEvents>();

  private container: HTMLElement;
  private tree: NewickNode | null = null;

  private layoutMode: LayoutMode;
  private maxNodes: number;
  private hideInternalNodes: boolean;
  private rerootOn?: string;
  private fitPadding: number;
  private reflect: boolean;
  private childOrder: ChildOrder;
  private labelDensity?: number;
  private labelGridCellSize?: number;

  /**
   * Pixels of content that extend to the right of the node bounding box (e.g.
   * the bar-chart presenter's labels + bars). The viewer pans the tree left by
   * half of this so the tree *and* the right-side band are centered together
   * instead of the band overflowing the window. Reported by operators via
   * {@link setRightReservePx}.
   */
  private rightReservePx = 0;
  /** Set when the camera still needs the right-reserve pan applied. */
  private pendingRecenter = false;

  private renderer: Sigma | null = null;
  private graph: Graph | null = null;
  private nodeMap: Map<string, LayoutNode> = new Map();

  /** Collapse predicate, supplied by the Expandor/Collapsor operator. */
  private collapseFn: IsCollapsed = NEVER_COLLAPSED;

  /** Active leaf metadata filter, or null when none is set. */
  private leafFilter: LeafFilter | null = null;

  /** Composable node reducers (selection highlight, hover labels, ...). */
  private reducers: NodeReducer[] = [];
  /** Composable edge reducers (comparison/difference coloring, ...). */
  private edgeReducers: EdgeReducer[] = [];

  // Double-click synthesis (Sigma emits no node-level dblclick — only a raw
  // "doubleClick" on the mouse captor, with no node attached).
  private lastClick: { node: string; time: number } | null = null;
  private static DOUBLE_CLICK_MS = 350;
  /** Node under the cursor, tracked so the captor's doubleClick can be attributed. */
  private hoveredNode: string | null = null;

  /** Whether the container-level context-menu listener is installed. */
  private contextMenuSuppressed = false;

  /**
   * Keeps the view centered when the *container* changes size.
   *
   * Sigma measures the container once at construction and binds only
   * `window.resize`, so a size change that isn't a window resize — a footer
   * appearing, a panel splitter moving, a sidebar opening — leaves it rendering
   * against stale dimensions, and the tree drifts off-center in the new box.
   * Re-measuring is enough to restore centering: the camera sits at x=y=0.5 and
   * Sigma normalizes the node bounding box around that point, so the tree is
   * centered *by construction* at whatever size the container happens to be.
   * Deliberately does not reset the camera — that would throw away the user's
   * pan/zoom every time the window moved.
   */
  private resizeObserver: ResizeObserver | null = null;

  constructor(container: HTMLElement, options: TreeViewerOptions = {}) {
    this.container = container;
    this.layoutMode = options.layoutMode ?? "cladogram";
    this.maxNodes = options.maxNodes ?? 200;
    this.hideInternalNodes = options.hideInternalNodes ?? true;
    this.rerootOn = options.rerootOn;
    this.fitPadding = options.fitPadding ?? 0.3;
    this.reflect = options.reflect ?? false;
    this.childOrder = options.childOrder ?? orderByName;
    this.labelDensity = options.labelDensity;
    this.labelGridCellSize = options.labelGridCellSize;

    if (getComputedStyle(container).position === "static") {
      container.style.position = "relative";
    }

    if (options.suppressContextMenu ?? true) {
      this.container.addEventListener("contextmenu", this.onContextMenu);
      this.contextMenuSuppressed = true;
    }

    if (typeof ResizeObserver !== "undefined") {
      this.resizeObserver = new ResizeObserver(() => this.onContainerResize());
      this.resizeObserver.observe(this.container);
    }
  }

  /**
   * Whether the container can currently be drawn into.
   *
   * Sigma throws from `resize()` when the container has no width, and a
   * refresh resizes. That is exactly the state during teardown: operators
   * detach and ask for one last refresh *after* the container has been taken
   * out of the document, so the throw escaped a React effect cleanup and took
   * the whole tree down — the app went blank instead of returning to the
   * chooser.
   *
   * Keyed on being detached rather than on measuring zero. A detached
   * container is unambiguously not worth drawing into, whereas a zero
   * measurement is also what every element reports under jsdom, where the
   * tests do very much expect rendering to happen.
   */
  private canRender(): boolean {
    return this.container.isConnected;
  }

  /**
   * Re-measure after a container resize. The right-side reserve pan is in
   * *pixels*, so its camera offset depends on the viewport scale and has to be
   * recomputed — hence re-arming `pendingRecenter` rather than only resizing.
   */
  private onContainerResize(): void {
    if (!this.renderer || !this.canRender()) return;
    this.renderer.resize();
    if (this.rightReservePx > 0) this.pendingRecenter = true;
    this.renderer.refresh();
  }

  /**
   * Swallows the native context menu for the whole container (see
   * {@link TreeViewerOptions.suppressContextMenu}). A stable reference so
   * {@link destroy} can remove it — an anonymous arrow could never be unbound,
   * leaving the page's menu broken after the viewer is gone.
   */
  private readonly onContextMenu = (event: Event): void => {
    event.preventDefault();
  };

  // --- Data / config ---

  setTree(tree: NewickNode): void {
    this.tree = tree;
    this.events.emit("treeChanged", { tree });
    this.rerender();
  }

  getTree(): NewickNode | null {
    return this.tree;
  }

  setLayoutMode(mode: LayoutMode): void {
    this.layoutMode = mode;
    this.rerender();
  }

  getLayoutMode(): LayoutMode {
    return this.layoutMode;
  }

  /** Reflect the tree horizontally (root right, tips left). */
  setReflect(reflect: boolean): void {
    this.reflect = reflect;
    this.rerender();
  }

  /** True when the tree is drawn reflected (root on the right). */
  isReflected(): boolean {
    return this.reflect;
  }

  /** Set the sibling-ordering policy (branch rotation). */
  setChildOrder(order: ChildOrder): void {
    this.childOrder = order;
    this.rerender();
  }

  reroot(name: string | undefined): void {
    this.rerootOn = name;
    this.rerender();
  }

  setMaxNodes(n: number): void {
    this.maxNodes = n;
    this.rerender();
  }

  setHideInternalNodes(hide: boolean): void {
    this.hideInternalNodes = hide;
    this.rerender();
  }

  /** Install the collapse predicate (called by the Expandor/Collapsor operator). */
  setCollapseFn(fn: IsCollapsed | null): void {
    this.collapseFn = fn ?? NEVER_COLLAPSED;
  }

  // --- Metadata filtering ---

  /**
   * Filter the **currently rendered** leaves by a predicate over their
   * {@link NewickNode.metadata}. Leaves that fail are dimmed (and get no bar);
   * matching leaves, internal nodes and connectors are untouched.
   *
   * This is a pure *presentation* filter: it re-applies the node-reducer
   * pipeline and refreshes the overlays — it does **not** rebuild or re-layout
   * the graph, so it only ever affects the leaves already on screen (a leaf
   * pruned by the `maxNodes` budget or hidden inside a collapsed clade is not
   * "unhidden" by a filter). The backend keeps the full isolate store; the
   * predicate runs against the metadata each visible leaf already carries.
   */
  setFilter(predicate: LeafFilter): void {
    this.leafFilter = predicate;
    this.applyReducers();
    this.events.emit("filterChanged", { filter: this.leafFilter });
  }

  /** Remove the active metadata filter and restore all leaves. */
  clearFilter(): void {
    if (!this.leafFilter) return;
    this.leafFilter = null;
    this.applyReducers();
    this.events.emit("filterChanged", { filter: null });
  }

  /** The active leaf filter, or null when none is set. */
  getFilter(): LeafFilter | null {
    return this.leafFilter;
  }

  /**
   * Whether a leaf passes the active filter — `true` when no filter is set.
   * Overlay operators (e.g. the bar-chart presenter) call this so their
   * per-leaf drawing matches the dimming the reducer applies to the nodes.
   */
  passesFilter(leaf: NewickNode): boolean {
    if (!this.leafFilter) return true;
    return this.leafFilter(leaf.metadata ?? {}, leaf);
  }

  // --- Handles for operators ---

  getContainer(): HTMLElement {
    return this.container;
  }
  getRenderer(): Sigma | null {
    return this.renderer;
  }
  getGraph(): Graph | null {
    return this.graph;
  }
  getNodeMap(): Map<string, LayoutNode> {
    return this.nodeMap;
  }

  /**
   * The concrete leaf names a set of selected node ids stands for, unfolding any
   * collapsed clades to the hidden isolates they represent (see
   * {@link leafNamesOf}). The clean input for "fetch/aggregate the selection":
   * pass `selection.getSelected()` straight in.
   */
  leavesOf(ids: Iterable<string>): string[] {
    return leafNamesOf(this.nodeMap, ids);
  }

  /**
   * The graph id of the most-recent common ancestor of the given displayed
   * nodes, or `null`. Feed a leaf selection in and the result straight to
   * {@link ExpandCollapseOperator.collapseNodes} to fold the clade around it.
   */
  mrcaOf(ids: Iterable<string>): string | null {
    return mrcaId(this.nodeMap, ids);
  }

  /**
   * Register a node reducer. All registered reducers are folded (in order)
   * into Sigma's single nodeReducer setting, so independent operators can
   * each contribute styling without clobbering one another. Returns an
   * unregister function.
   */
  addNodeReducer(reducer: NodeReducer): () => void {
    this.reducers.push(reducer);
    this.applyReducers();
    return () => {
      this.reducers = this.reducers.filter((r) => r !== reducer);
      this.applyReducers();
    };
  }

  /**
   * Register an edge reducer. All registered edge reducers are folded (in
   * order) into Sigma's single edgeReducer, so operators can color branches
   * (e.g. by comparison value) without clobbering one another. Returns an
   * unregister function.
   */
  addEdgeReducer(reducer: EdgeReducer): () => void {
    this.edgeReducers.push(reducer);
    this.applyEdgeReducers();
    return () => {
      this.edgeReducers = this.edgeReducers.filter((r) => r !== reducer);
      this.applyEdgeReducers();
    };
  }

  /** Re-apply the composed node-reducer pipeline (operators call this after state changes). */
  applyReducers(): void {
    if (!this.renderer) return;
    this.renderer.setSetting("nodeReducer", (node: string, data: Record<string, unknown>) => {
      const styled = this.reducers.reduce((acc, reducer) => reducer(node, acc), data);
      // Filter dimming runs last so it overrides operator styling for a
      // filtered-out leaf (a selection highlight shouldn't un-dim it).
      return this.leafFilter ? this.dimIfFiltered(node, styled) : styled;
    });
    // The setting is kept whatever happens; only the draw is skipped, so the
    // next real render picks it up.
    if (this.canRender()) this.renderer.refresh();
  }

  /** Fade a leaf that fails the active filter; leave everything else as-is. */
  private dimIfFiltered(node: string, data: Record<string, unknown>): Record<string, unknown> {
    const layoutNode = this.nodeMap.get(node);
    if (!layoutNode?.isLeaf) return data; // only leaves are filtered
    if (this.passesFilter(layoutNode.source)) return data;
    return { ...data, color: FILTER_DIM_COLOR, label: "" };
  }

  /** Re-apply the composed edge-reducer pipeline. */
  applyEdgeReducers(): void {
    if (!this.renderer) return;
    this.renderer.setSetting("edgeReducer", (edge: string, data: Record<string, unknown>) =>
      this.edgeReducers.reduce((acc, reducer) => reducer(edge, acc), data)
    );
    if (this.canRender()) this.renderer.refresh();
  }

  // --- Rendering ---

  /** Rebuild the graph from current state and (re)mount Sigma. Emits "render". */
  rerender(): void {
    if (!this.tree) return;

    const { graph, nodeMap } = buildGraph(
      this.tree,
      this.collapseFn,
      this.maxNodes,
      this.layoutMode,
      this.hideInternalNodes,
      this.rerootOn,
      this.reflect,
      this.childOrder
    );
    this.graph = graph;
    this.nodeMap = nodeMap;

    this.renderer?.kill();
    this.renderer = new Sigma(graph, this.container, {
      defaultNodeType: "circle",
      defaultEdgeType: "line",
      renderLabels: true,
      renderEdgeLabels: false,
      labelSize: 11,
      labelRenderedSizeThreshold: 0,
      // Both panels: Sigma's drawer neither picks the outward side nor clears
      // a wedge. See labelDrawer.
      defaultDrawNodeLabel: labelDrawer(this.reflect),
      ...(this.labelDensity != null ? { labelDensity: this.labelDensity } : {}),
      ...(this.labelGridCellSize != null
        ? { labelGridCellSize: this.labelGridCellSize }
        : {}),
      labelColor: { color: "#222" },
      defaultEdgeColor: BRANCH_COLOR, // fallback for any edge without its own color
      minCameraRatio: 0.02,
      maxCameraRatio: 10,
    });

    this.centerCamera();
    this.wireSigmaEvents(this.renderer);
    this.applyReducers();
    this.applyEdgeReducers();

    this.events.emit("render", { renderer: this.renderer, graph, nodeMap });
  }

  /**
   * Center the tree with a margin. Sigma's auto-fit (default camera) maps the
   * node bounding box edge-to-edge; zooming out by `fitPadding` while keeping
   * the camera centered (x=y=0.5) leaves symmetric margins so the leaf labels
   * and bar charts aren't clipped against the viewport edges. The right-side
   * reserve pan is applied later, on afterRender, when the matrix is valid.
   */
  private centerCamera(): void {
    const camera = this.renderer?.getCamera();
    if (!camera) return;
    camera.setState({ x: 0.5, y: 0.5, angle: 0, ratio: 1 + this.fitPadding });
    this.pendingRecenter = this.rightReservePx > 0;
  }

  /**
   * Report how many pixels of content sit on the leaf side of the node
   * bounding box (labels + bars). The viewer shifts the tree by half of it so
   * the combined content is centered. The leaf side is the right when not
   * reflected, the left when reflected. Safe to call from a "render" handler.
   */
  setRightReservePx(px: number): void {
    if (px === this.rightReservePx) return;
    this.rightReservePx = px;
    this.pendingRecenter = true;
    this.renderer?.refresh(); // trigger an afterRender to apply the pan
  }

  /** Apply the right-reserve pan once the matrix is valid (on afterRender). */
  private maybeRecenter(): void {
    if (!this.pendingRecenter || !this.renderer) return;
    this.pendingRecenter = false;

    const camera = this.renderer.getCamera();
    // px spanned by one framed-graph x-unit at the current camera state.
    const p0 = this.renderer.framedGraphToViewport({ x: 0, y: 0.5 });
    const p1 = this.renderer.framedGraphToViewport({ x: 1, y: 0.5 });
    const pxPerFramed = Math.abs(p1.x - p0.x);
    if (pxPerFramed <= 0) return;

    // Shift content by half the reserve to center tree + band. Increasing
    // camera.x moves the view center right, so fixed content moves left on
    // screen. The band is on the right normally (shift left), or on the left
    // when reflected (shift right) — hence the sign flip.
    const dCx = this.rightReservePx / 2 / pxPerFramed;
    const sign = this.reflect ? -1 : 1;
    const state = camera.getState();
    camera.setState({ ...state, x: 0.5 + sign * dCx });
  }

  private wireSigmaEvents(renderer: Sigma): void {
    renderer.on("afterRender", () => this.maybeRecenter());
    renderer.on("clickNode", ({ node }: SigmaNodeEventPayload) => this.onClickNode(node));
    renderer.on("clickStage", ({ event }: SigmaStageEventPayload) =>
      this.events.emit("clickStage", { x: event.x, y: event.y })
    );
    renderer.on("rightClickNode", ({ node, event }: SigmaNodeEventPayload) =>
      this.events.emit("rightClickNode", {
        node,
        x: event.x,
        y: event.y,
        original: event.original,
      })
    );
    renderer.on("rightClickStage", ({ event }: SigmaStageEventPayload) =>
      this.events.emit("rightClickStage", {
        x: event.x,
        y: event.y,
        original: event.original,
      })
    );
    renderer.on("enterNode", ({ node }: SigmaNodeEventPayload) => {
      this.hoveredNode = node;
      this.events.emit("enterNode", { node });
    });
    renderer.on("leaveNode", () => {
      this.hoveredNode = null;
      this.events.emit("leaveNode", {});
    });

    // Sigma zooms on double-click unless the gesture is claimed: its mouse
    // captor emits "doubleClick", then zooms `if (!sigmaDefaultPrevented)`.
    // Double-clicking a *node* is our gesture (operators expand/collapse or
    // drill in on it), so claim it — otherwise every toggle also zooms, which
    // reads as the view lurching on each click. Double-clicking empty stage
    // still zooms, which is the useful half of Sigma's default.
    //
    // Sigma has no `doubleClickNode` event (only the raw captor one), which is
    // also why `onClickNode` synthesises double-clicks; the captor gives us no
    // node, so we use the hovered node to decide whether this one is ours.
    renderer.getMouseCaptor().on("doubleClick", (coords: MouseCoords) => {
      if (this.hoveredNode !== null) coords.preventSigmaDefault();
    });
  }

  /** Single vs double click synthesis, then re-emit as viewer events. */
  private onClickNode(node: string): void {
    const now = Date.now();
    const isDouble =
      this.lastClick !== null &&
      this.lastClick.node === node &&
      now - this.lastClick.time < TreeViewer.DOUBLE_CLICK_MS;

    this.lastClick = { node, time: now };

    if (isDouble) {
      this.lastClick = null;
      this.events.emit("doubleClickNode", { node });
      return;
    }
    this.events.emit("clickNode", { node });
  }

  destroy(): void {
    this.events.emit("destroy", {});
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
    if (this.contextMenuSuppressed) {
      // Undo the suppression, or the container keeps swallowing right-clicks
      // after the viewer is gone (the element may outlive it).
      this.container.removeEventListener("contextmenu", this.onContextMenu);
      this.contextMenuSuppressed = false;
    }
    this.renderer?.kill();
    this.renderer = null;
    this.events.clear();
  }
}
