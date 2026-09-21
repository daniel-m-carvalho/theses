import type { NewickNode } from "../tree/types";
import type { TreeViewer } from "../viewer/tree_viewer";
import { countLeaves } from "../tree/model";
import type { TreeOperator } from "./operator";
import { SubtreeNavigator, type SubtreeStep } from "./subtree_navigator";

/**
 * How expanding a clade presents the result.
 *
 * - `"incremental"` — grow the tree you are looking at. The clade opens
 *   `expandDepth` levels **in place**; its siblings and the rest of the tree stay
 *   on screen. Collapsing folds it back into a tip. Context is kept, at the cost
 *   of panel space (and of the viewer's `maxNodes` budget, shared by everything
 *   on screen).
 * - `"subtree"` — open the clade as a new tree. It becomes the **root** of the
 *   view and fills the panel, opened at the depth cut, as if it had just been
 *   loaded from a file; the rest of the tree is hidden, not collapsed. Collapsing
 *   that root **goes back** to the previous view. Context is lost, but the clade
 *   gets the whole panel — and the whole budget — so you can drill much deeper.
 */
export type ExpandMode = "incremental" | "subtree";

export interface ExpandCollapseOptions {
  /**
   * Which expand model to use (default `"incremental"`). See {@link ExpandMode}.
   * Switchable at runtime via {@link ExpandCollapseOperator.setMode}.
   */
  mode?: ExpandMode;
  /**
   * Subtree mode: don't drill into clades smaller than this many leaves
   * (default 2) — a two-leaf fork doesn't warrant the whole panel.
   */
  minLeaves?: number;
  /**
   * Only offer *collapse* on expanded clades whose (displayed) subtree has at
   * least this many leaves, so a two-leaf fork isn't a collapse target. Collapsed
   * clades are always expandable regardless. Default 3.
   */
  collapseMinLeaves?: number;
  /**
   * **The depth knob.** One number meaning "how many levels of any clade do I
   * see at a time", applied consistently to both:
   *  - the *opening* view — the tree opens cut at this depth (root = 0), and
   *  - every *expand* — a clade opens this many levels below itself.
   *
   * So a freshly opened tree, an expanded clade, and a subtree drilled into in
   * `"subtree"` mode all show the same amount of structure. Omit to open fully
   * expanded and reveal one level per expand.
   *
   * {@link initialDepth} / {@link expandDepth} override each half individually
   * if you really want them to differ.
   */
  depth?: number;
  /**
   * Override the *opening* depth alone (root = 0); defaults to {@link depth}.
   * Re-applied whenever a new tree is loaded — including a subtree focused into,
   * which is what makes it open summarized like a new tree.
   */
  initialDepth?: number;
  /**
   * Override the *per-expand* depth alone; defaults to {@link depth}, else 1.
   * Expanding opens the clade this many levels *in place* — the surrounding tree
   * stays on screen — and re-folds below. On strictly binary trees (UPGMA/NJ) 1
   * level is a single bifurcation, so this is rarely what you want on its own.
   *
   * Only meaningful in `"incremental"` {@link mode}: in `"subtree"` mode a clade
   * becomes the view's root and is cut at {@link initialDepth} instead.
   */
  expandDepth?: number;
  /**
   * Act on the clade under the cursor on double-click (default true) — expanding
   * or collapsing it per {@link mode}. This is the operator's own trigger; set
   * false to free the gesture for the app, which then drives the operator through
   * its public methods ({@link ExpandCollapseOperator.collapseNodes}, a context
   * menu, a toolbar).
   */
  toggleOnDoubleClick?: boolean;
}

/**
 * Expandor / Collapsor operator.
 *
 * Enables collapse/expand on **every** internal node of the tree, not only the
 * named clades. The operator's own trigger is double-click; everything else is
 * driven by the app through its public methods (a toolbar, a context menu,
 * {@link ExpandCollapseOperator.collapseNodes} over a selection).
 *
 * Collapse state is keyed on a stable, path-based **structural ID** (root "r",
 * i-th child of `p` is `p.i`), assigned to every node of the *original* tree.
 * The layout prunes and clones the tree for display, so a displayed node is not
 * identity-equal to its source; each display node carries an `origin`
 * back-reference (set by {@link prepareTree}) so a clicked node maps back to its
 * original for the ID lookup. This keeps the collapse *predicate* (evaluated on
 * original nodes during pruning) and the *toggle* (triggered from display
 * nodes) consistent, for named and unnamed nodes alike.
 *
 * Two expand models, chosen by `mode` (see {@link ExpandMode}) — the single
 * navigation operator, rather than two operators competing for one gesture:
 *  - `"incremental"` grows the tree in place (collapse folds it back);
 *  - `"subtree"` opens a clade as a new tree via {@link SubtreeNavigator}
 *    (collapsing that root goes back).
 *
 * Integration with the viewer:
 *  - on attach it installs an `isCollapsed` predicate (used by the layout), binds
 *    stable IDs to the current tree, and registers a node reducer giving every
 *    actionable clade an invisible hit area (see {@link ensureHitArea});
 *  - it rebinds (and re-applies `initialDepth`) whenever the tree changes —
 *    including on a subtree drill-in, which is what makes it open summarized;
 *  - it acts on a clade on double-click and rerenders.
 *
 * Note: re-rooting clones the tree into fresh node objects, so ID-based collapse
 * of *unnamed* nodes does not carry across a reroot (named clades still do).
 */
export class ExpandCollapseOperator implements TreeOperator {
  readonly name = "expand-collapse";

  /** Set of stable node IDs that are currently collapsed. */
  private collapsed = new Set<string>();
  /** Maps each source NewickNode to its stable structural ID. */
  private ids = new WeakMap<NewickNode, string>();

  private viewer: TreeViewer | null = null;
  private unsubscribe: Array<() => void> = [];

  private collapseMinLeaves: number;
  private initialDepth?: number;
  private expandDepth: number;
  private toggleOnDoubleClick: boolean;
  private mode: ExpandMode;
  private minLeaves: number;
  /** Subtree mode's drill-in stack. Created on attach; null in incremental mode. */
  private navigator: SubtreeNavigator | null = null;
  private onPathChangeCb: ((path: SubtreeStep[]) => void) | null = null;
  /** Depth the view uniformly shows, or null once clades are toggled by hand. */
  private currentDepth: number | null = null;

  private removeHitReducer: (() => void) | null = null;

  constructor(options: ExpandCollapseOptions = {}) {
    this.collapseMinLeaves = options.collapseMinLeaves ?? 3;
    // One knob by default; either half can still be overridden explicitly.
    this.initialDepth = options.initialDepth ?? options.depth;
    this.expandDepth = Math.max(1, Math.floor(options.expandDepth ?? options.depth ?? 1));
    this.toggleOnDoubleClick = options.toggleOnDoubleClick ?? true;
    this.mode = options.mode ?? "incremental";
    this.minLeaves = options.minLeaves ?? 2;
  }

  attach(viewer: TreeViewer): void {
    this.viewer = viewer;
    viewer.setCollapseFn((node) => this.isCollapsed(node));

    // Double-click is the operator's trigger, but Sigma hit-tests by marker size
    // and `hideInternalNodes` draws internal nodes at size 0 — so without this
    // there would be nothing to click. Give every actionable clade an invisible
    // hit area.
    this.removeHitReducer = viewer.addNodeReducer((node, data) =>
      this.ensureHitArea(node, data)
    );

    const current = viewer.getTree();
    if (current) this.bind(current);

    // Subtree mode needs the drill-in stack; it subscribes to treeChanged
    // itself, so create it before we feed the tree in.
    this.navigator = new SubtreeNavigator(viewer, this.minLeaves);
    this.navigator.attach();
    if (this.onPathChangeCb) this.navigator.setOnChange(this.onPathChangeCb);

    this.unsubscribe.push(
      viewer.events.on("treeChanged", ({ tree }) => this.onTreeChanged(tree)),
      viewer.events.on("doubleClickNode", ({ node }) => this.onDoubleClick(node))
    );
  }

  detach(): void {
    this.unsubscribe.forEach((u) => u());
    this.unsubscribe = [];
    this.navigator?.detach();
    this.navigator = null;
    this.removeHitReducer?.();
    this.removeHitReducer = null;
    this.viewer?.setCollapseFn(null);
    this.viewer = null;
  }

  // --- Triggers ---

  private onTreeChanged(tree: NewickNode): void {
    this.bind(tree);
    this.currentDepth = null;
    // Summarize on load; the viewer's own setTree() rerender will pick up the
    // collapse state, so don't rerender again here.
    if (this.initialDepth != null) this.setDepth(this.initialDepth, false);
  }

  private onDoubleClick(node: string): void {
    if (!this.toggleOnDoubleClick) return; // gesture yielded to another operator
    const layoutNode = this.viewer?.getNodeMap().get(node);
    if (!layoutNode) return; // invisible connector node
    if (this.toggleFromSource(layoutNode)) this.viewer?.rerender();
  }

  // --- Collapse-state core (stable structural IDs) ---

  /**
   * Bind to a tree, assigning a stable ID to every node. Called on attach and
   * whenever the tree is replaced. Preserves collapse state whose IDs still
   * exist in the new topology.
   */
  bind(tree: NewickNode): void {
    this.ids = new WeakMap<NewickNode, string>();
    const seen = new Set<string>();
    const assign = (node: NewickNode, id: string) => {
      this.ids.set(node, id);
      seen.add(id);
      (node.branchset || []).forEach((child, i) => assign(child, `${id}.${i}`));
    };
    assign(tree, "r");
    for (const id of [...this.collapsed]) {
      if (!seen.has(id)) this.collapsed.delete(id);
    }
  }

  /** Resolve a (possibly pruned/cloned) node to the original it came from. */
  private originOf(node: NewickNode): NewickNode {
    return node.origin ?? node;
  }

  /** Stable structural ID for a source node (empty string if not bound). */
  idOf(node: NewickNode): string {
    return this.ids.get(this.originOf(node)) ?? "";
  }

  /** True if `node` is an internal node currently marked collapsed. */
  isCollapsed(node: NewickNode): boolean {
    if (!node.branchset?.length) return false; // leaves are never collapsed
    return this.collapsed.has(this.idOf(node));
  }

  /** Collapse a specific internal node. No-op for leaves. */
  collapse(node: NewickNode): void {
    if (!node.branchset?.length) return;
    const id = this.idOf(node);
    if (id) {
      this.collapsed.add(id);
      this.currentDepth = null;
    }
  }

  /** Expand (un-collapse) a specific node. */
  expand(node: NewickNode): void {
    const id = this.idOf(node);
    if (id) {
      this.collapsed.delete(id);
      this.currentDepth = null;
    }
  }

  /**
   * Collapse every selected clade at once. `ids` are **graph-node ids** (the
   * keys the selection operator returns), resolved to their source nodes via the
   * viewer's node map. Leaves, already-collapsed clades, and unknown ids are
   * ignored. Batches into a single rerender — so "collapse only the selected
   * clades" costs one rebuild, not one per node. No-op if nothing changed.
   *
   * To fold the clade around a *leaf* selection instead, pass the viewer's
   * `mrcaOf(ids)` result: `collapseNodes([viewer.mrcaOf(sel)!])`.
   */
  collapseNodes(ids: Iterable<string>): void {
    this.applyToNodes(ids, (source) => this.collapse(source));
  }

  /** Expand every selected clade at once. The inverse of {@link collapseNodes}. */
  expandNodes(ids: Iterable<string>): void {
    this.applyToNodes(ids, (source) => this.expand(source));
  }

  /**
   * Resolve graph ids to source nodes, apply a per-node mutation to each, and
   * rerender once — but only if the collapsed set actually changed.
   */
  private applyToNodes(ids: Iterable<string>, act: (source: NewickNode) => void): void {
    const map = this.viewer?.getNodeMap();
    if (!map) return;
    const before = this.collapsed.size;
    for (const id of ids) {
      const ln = map.get(id);
      if (ln) act(ln.source);
    }
    if (this.collapsed.size !== before) this.viewer?.rerender();
  }

  /**
   * Toggle collapse for the clade the user clicked (a LayoutNode carrying
   * `source` + `isLeaf`). Leaves are no-ops. Returns true when state changed
   * (i.e. the caller should rerender).
   */
  toggleFromSource(layoutNode: { source: NewickNode; isLeaf: boolean }): boolean {
    if (layoutNode.isLeaf) return false;

    // Subtree mode: expanding opens the clade as a new tree, and collapsing the
    // clade you drilled into goes back. The navigator re-renders via setTree(),
    // so return false either way — there is nothing for the caller to rerender.
    if (this.mode === "subtree" && this.navigator) {
      const nav = this.navigator;
      if (nav.isRoot(layoutNode.source)) nav.back();
      else nav.focus(layoutNode.source);
      return false;
    }

    // A collapsed clade is shown as a terminal (no branchset) but must remain
    // togglable, so resolve the original node (and its children) via origin.
    const origin = this.originOf(layoutNode.source);
    const id = this.idOf(origin);
    if (!id) return false;
    // The view stops being a uniform depth cut once a single clade is toggled.
    this.currentDepth = null;
    if (this.collapsed.has(id)) {
      // Expand `expandDepth` levels in place, re-folding below, so you drill
      // down in controlled steps instead of exploding the subtree to the leaves.
      this.openSubtree(origin, this.expandDepth);
    } else {
      // Collapse: fold the entire subtree into a single tip (one click).
      this.collapsed.add(id);
    }
    return true;
  }

  /**
   * Open `origin` `levels` deep *relative to itself*: everything above that
   * relative depth is expanded, every clade at it is collapsed. The local
   * counterpart of {@link setDepth} (which does the same from the root), and
   * what an in-place expand runs. Walks only as deep as `levels`, so it stays
   * cheap on large subtrees. Exposed so an app can offer "open this clade N
   * levels" directly.
   */
  openSubtree(node: NewickNode, levels = this.expandDepth, rerender = false): void {
    const origin = this.originOf(node);
    const walk = (n: NewickNode, d: number): void => {
      if (!n.branchset?.length) return; // leaf
      const id = this.idOf(n);
      if (d >= levels) {
        if (id) this.collapsed.add(id);
        return; // re-folded here; don't descend
      }
      if (id) this.collapsed.delete(id);
      n.branchset.forEach((c) => walk(c, d + 1));
    };
    walk(origin, 0);
    this.currentDepth = null;
    if (rerender) this.viewer?.rerender();
  }

  /** How many levels a single expand reveals (see `expandDepth`). */
  getExpandDepth(): number {
    return this.expandDepth;
  }

  /** Change how many levels a single expand reveals. Clamped to >= 1. */
  setExpandDepth(levels: number): void {
    this.expandDepth = Math.max(1, Math.floor(levels));
  }

  // --- Mode ---

  /** Which expand model is active. See {@link ExpandMode}. */
  getMode(): ExpandMode {
    return this.mode;
  }

  /**
   * Switch expand model at runtime. Leaving subtree mode returns to the original
   * tree first, so you never strand the view inside a subtree with no way out.
   */
  setMode(mode: ExpandMode): void {
    if (mode === this.mode) return;
    if (this.mode === "subtree") this.navigator?.reset();
    this.mode = mode;
    this.viewer?.rerender(); // cues differ per mode
  }

  // --- Subtree navigation (no-ops in incremental mode) ---

  /** Go back one step in the subtree trail. Returns true if the view changed. */
  back(): boolean {
    return this.navigator?.back() ?? false;
  }

  /** Return to the original tree from any depth of the subtree trail. */
  resetSubtree(): boolean {
    return this.navigator?.reset() ?? false;
  }

  /** Jump to a step of the subtree trail by index (0 = the original tree). */
  goTo(index: number): boolean {
    return this.navigator?.goTo(index) ?? false;
  }

  /**
   * The subtree trail, outermost first; the last entry is the current view.
   * A single entry (the original tree) means we haven't drilled in.
   */
  getPath(): SubtreeStep[] {
    return this.navigator?.getPath() ?? [];
  }

  /** True when {@link back} would do something. */
  canGoBack(): boolean {
    return this.navigator?.canGoBack() ?? false;
  }

  /** Called whenever the subtree trail changes — for a breadcrumb / back button. */
  setOnPathChange(cb: ((path: SubtreeStep[]) => void) | null): void {
    this.onPathChangeCb = cb;
    this.navigator?.setOnChange(cb);
  }

  /**
   * Show the tree down to `depth` (root = 0): every clade at that depth is
   * collapsed, everything above it is expanded. This is the single depth
   * primitive — it both *summarizes* (a smaller depth than the current view
   * folds clades back up) and *drills down* (a larger depth opens them), since
   * it rebuilds the collapse set from scratch rather than only adding to it.
   *
   * Walks the *original* tree, so it is unaffected by the display-side pruning.
   * Depth is clamped to >= 0; depth 0 folds the whole tree into the root tip.
   */
  setDepth(depth: number, rerender = true): void {
    const tree = this.viewer?.getTree();
    if (!tree) return;
    const target = Math.max(0, Math.floor(depth));
    this.collapsed.clear();
    const walk = (node: NewickNode, d: number): void => {
      if (!node.branchset?.length) return; // leaf
      if (d >= target) {
        const id = this.idOf(node);
        if (id) this.collapsed.add(id);
        return; // collapsed here; don't descend
      }
      node.branchset.forEach((c) => walk(c, d + 1));
    };
    walk(tree, 0);
    this.currentDepth = target;
    if (rerender) this.viewer?.rerender();
  }

  /**
   * The depth the view is currently showing, or null when it no longer matches
   * a uniform depth because clades were toggled individually (or fully
   * expanded). Lets a UI keep a depth control in sync and know when it's stale.
   */
  getDepth(): number | null {
    return this.currentDepth;
  }

  /** The configured opening depth, if any (see {@link ExpandCollapseOptions}). */
  getInitialDepth(): number | undefined {
    return this.initialDepth;
  }

  /**
   * Return to the configured opening view (`initialDepth`). Falls back to
   * {@link collapseAll} when no initial depth was configured.
   */
  resetDepth(): void {
    if (this.initialDepth != null) this.setDepth(this.initialDepth);
    else this.collapseAll();
  }

  /**
   * @deprecated Use {@link setDepth} — same behaviour, name reflects that it
   * expands as well as collapses.
   */
  collapseToDepth(depth: number, rerender = true): void {
    this.setDepth(depth, rerender);
  }

  /** Collapse to the top level (everything below the root's children). */
  collapseAll(): void {
    this.setDepth(1);
  }

  /** Expand every collapsed node and rerender. */
  expandAll(): void {
    this.currentDepth = null;
    if (this.collapsed.size === 0) return;
    this.collapsed.clear();
    this.viewer?.rerender();
  }

  /** Read-only snapshot of collapsed IDs (for persistence / debugging). */
  getCollapsed(): Set<string> {
    return new Set(this.collapsed);
  }

  // --- Actionability (which clades a gesture may act on) ---

  /**
   * Whether a node is an expand/collapse target, and in which direction — the
   * per-mode rule shared by the hit-area reducer and any app-drawn affordance
   * (menu item, toolbar, tooltip):
   *
   * - incremental — `"expand"` on every collapsed clade (open it in place),
   *   `"collapse"` on expanded clades big enough to be worth folding
   *   ({@link ExpandCollapseOptions.collapseMinLeaves}).
   * - subtree — `"expand"` on every collapsed clade (open it *as a new tree*),
   *   and `"collapse"` on the view's root meaning *go back*. Expanded clades get
   *   nothing: folding one in place isn't this mode's model.
   */
  actionFor(layoutNode: {
    id: string;
    source: NewickNode;
    isLeaf: boolean;
    isCollapsed: boolean;
  }): "expand" | "collapse" | null {
    if (layoutNode.isLeaf) return null;

    if (this.mode === "subtree") {
      if (this.navigator?.isRoot(layoutNode.source)) {
        return this.navigator.canGoBack() ? "collapse" : null; // nothing to go back to
      }
      return layoutNode.isCollapsed ? "expand" : null;
    }

    if (layoutNode.isCollapsed) return "expand";
    return countLeaves(layoutNode.source) >= this.collapseMinLeaves ? "collapse" : null;
  }

  /** Minimum marker size that Sigma can reliably hit-test. */
  static readonly HIT_SIZE = 6;

  /**
   * Give a clade an invisible-but-clickable marker when it would otherwise have
   * no hit area (`hideInternalNodes` draws internal nodes at size 0), so
   * double-click — and Sigma's `rightClickNode`, which hit-tests the same way —
   * have something to land on. Leaves are untouched: they are never
   * expand/collapse targets.
   */
  private ensureHitArea(
    node: string,
    data: Record<string, unknown>
  ): Record<string, unknown> {
    const layoutNode = this.viewer?.getNodeMap().get(node);
    if (!layoutNode || layoutNode.isLeaf) return data;
    if (this.actionFor(layoutNode) === null) return data; // not actionable in this mode

    const size = Number(data.size) || 0;
    if (size >= ExpandCollapseOperator.HIT_SIZE) return data; // already clickable
    return {
      ...data,
      size: ExpandCollapseOperator.HIT_SIZE,
      // It was invisible; keep it that way — we only want the hit area.
      color: size > 0 ? data.color : "rgba(0,0,0,0)",
    };
  }

}
