import type { NewickNode } from "../tree/types";
import type { TreeViewer } from "../viewer/tree_viewer";
import { SequentialColorScale } from "../color/color_scale";
import {
  type ComparisonValueProvider,
  type ComparisonValues,
  type CorrespondenceMap,
  type DifferencePredicate,
  type DifferenceSet,
  type NodeKeyOf,
  keyByClade,
} from "../data/comparison";
import { BRANCH_COLOR } from "../tree/layout";
import type { TreeOperator } from "./operator";

/**
 * Difference presentation strategy:
 *  - `"gradient"` — color **branches** by a continuous value scale; node markers
 *    are left alone (the value describes a branch, and the edge already carries
 *    it — see `colorNodes` to opt in). For metrics that give a per-clade
 *    magnitude (RF, BCN, weighted RF, …).
 *  - `"membership"` — mark the **leaves shared by both trees** with `equalColor`.
 *    Keys come from `keyOf`; {@link keyByName} is usually the natural choice here,
 *    since the unit of comparison is a tip, not a clade.
 *    Leaves the backend lists as differing are left unmarked, and internal nodes
 *    are untouched: the mode describes tips, and encodes *agreement only*, so the
 *    view answers "what do these two trees have in common?". For metrics that
 *    report *which* leaves differ, rather than how much.
 */
export type ComparisonMode = "gradient" | "membership";

export interface ComparisonOptions {
  /** Per-key comparison values (backend-provided). */
  values?: ComparisonValues;
  /** Function form of `values`; consulted when `values` has no entry. */
  valueFor?: ComparisonValueProvider;
  /** How a node is keyed. Default {@link keyByClade}; pass {@link keyByName} to key by name. */
  keyOf?: NodeKeyOf;
  /** Value → color scale. Share one instance across panels for consistent coloring. */
  scale?: SequentialColorScale;
  /** Color branches by their child node's value (default true). */
  colorEdges?: boolean;
  /** Width (px) of colored branches, so the vivid color reads clearly. Default 3. */
  edgeWidth?: number;
  /**
   * Also color node markers by their value, in gradient mode (default **false**).
   *
   * Off by default because a gradient value describes a **branch**: the edge
   * already carries it, so coloring the node too double-encodes one number and
   * adds noise. It also fights other operators — this operator attaches last, so
   * its node styling overrides theirs (e.g. it would repaint the marker that
   * CladeShapePresenter deliberately makes transparent, resurrecting a circle
   * underneath the wedge). Turn on only if you want markers to carry the value
   * *instead of* relying on branch color.
   *
   * No effect in membership mode, which has its own leaf-marking rule.
   */
  colorNodes?: boolean;
  /**
   * Neutral color for leaf markers when {@link colorNodes} is on — comparison
   * metrics describe internal clades/bipartitions, not leaves, so leaves are kept
   * neutral (not colored by the value scale). Default "#212529" (near-black).
   * Unused while `colorNodes` is false, since leaves keep their own color then.
   */
  leafColor?: string;
  /**
   * Legend row for nodes the backend gave **no value** for, in gradient mode.
   *
   * Those nodes are not on the scale at all: no counterpart means no score,
   * which is not a score of zero. They therefore need a colour of their own and
   * a row of their own, and the row is shown **whenever this is set**, not only
   * when such a node happens to be in view. A key that appears and disappears
   * as you navigate is a key you cannot learn, and its absence would read as
   * "this view has none" only to someone who already knew the rule.
   *
   * Unset means no row and no special colour.
   */
  absentLabel?: string;
  /**
   * Colour for those branches. Unset leaves them exactly as the tree drew them.
   *
   * Worth setting to something loud. The default tree colour is also what an
   * unstyled branch looks like, so "no data" and "nothing has happened here"
   * become the same picture. Drawn at {@link edgeWidth}, like a branch that
   * does carry a value: the two are different answers, not different amounts
   * of confidence, so neither should look fainter than the other.
   */
  absentColor?: string;
  /**
   * Colour a located node blinks in (default "#ff0000").
   *
   * Set it to something no other colour in the view claims. It has to be read
   * as "look here" rather than as a value, so it must sit outside the value
   * ramp **and** outside {@link absentColor} — sharing a hue with either makes
   * a momentary signal look like a permanent statement about the node.
   */
  highlightColor?: string;
  /** Presentation strategy (default "gradient"). See {@link ComparisonMode}. */
  mode?: ComparisonMode;
  /** Membership mode: set of node keys that DIFFER between the two trees. */
  differing?: Iterable<string>;
  /** Function form of `differing`; consulted when the set has no matching entry. */
  isDifferent?: DifferencePredicate;
  /**
   * Membership: color for a leaf shared by both trees. Default "#0077bb"
   * (CVD-safe blue). The mode paints agreement only, so there is no
   * "different" color — differing leaves are simply left unmarked.
   */
  equalColor?: string;
  /** Membership marker size (px) so the leaf color reads clearly. Default 6. */
  markerSize?: number;
  /**
   * How many times a located node shows itself before the highlight goes away
   * (default 3). One flash is one on-phase; the node is dark between them, so
   * what draws the eye is the change, not the colour.
   *
   * The highlight is deliberately temporary. A permanent mark would say "this
   * node is special" for as long as the panel is open, when what actually
   * happened is that the view moved here once.
   */
  flashes?: number;
  /** Milliseconds each on- or off-phase lasts (default 300). */
  flashInterval?: number;
  /**
   * Membership hover wording, `[different, equal]`. Default
   * `["different", "equal"]`. Both are still used by the tooltip — hovering says
   * which state a leaf is in — even though only "equal" is *painted*; the legend
   * shows the equal swatch alone.
   */
  membershipLabels?: [string, string];
  /**
   * Show a legend in the corner (default true): a gradient bar, or — in
   * membership mode — the single `equalColor` swatch, since that is the only
   * color the mode paints.
   */
  legend?: boolean;
  /** Gradient legend end labels [low, high]. Default ["different", "similar"]. */
  legendLabels?: [string, string];
  /** Cross-tree node correspondence for navigation; omit to assume same-key. */
  correspondence?: CorrespondenceMap;
  /** Start enabled (default true). */
  enabled?: boolean;
}

/**
 * Comparison operator — presents backend-computed tree differences.
 *
 * The branch-coloring model (color a branch by the comparison value of the
 * clade at its end, via a sequential value→color scale) is adapted from
 * phylo.io (Robinson et al. 2016; © Clement Train & the Dessimoz Lab, MIT
 * license; https://github.com/DessimozLab/phylo-io). This is an independent
 * reimplementation for the Sigma/graphology renderer — no phylo.io code is
 * used; only the visual approach is credited.
 *
 * Colors each branch — and, opt-in via `colorNodes`, each node marker — by a
 * comparison value stored on its child node, via a shared
 * {@link SequentialColorScale}. The value is looked up
 * by a configurable node key (`keyOf`: clade leaf-set or name), so it works
 * whether the backend keys differences by edge/clade or by leaf/name.
 *
 * Supports cross-tree navigation: linking two operators (one per panel) lets a
 * click on a node center and highlight its corresponding node in the other
 * tree. Correspondence comes from the backend (`correspondence`) or defaults to
 * an exact key match.
 *
 * Communicates only through the viewer's public surface — the edge/node-reducer
 * pipelines, events, and renderer handle — so it composes with the other
 * operators and leaves two viewers independent except for the explicit link.
 */
export class ComparisonOperator implements TreeOperator {
  readonly name = "comparison";

  private viewer: TreeViewer | null = null;
  private values?: ComparisonValues;
  private valueFor?: ComparisonValueProvider;
  private keyOf: NodeKeyOf;
  private scale: SequentialColorScale;
  private colorEdges: boolean;
  private edgeWidth: number;
  private colorNodes: boolean;
  private leafColor: string;
  private absentLabel?: string;
  private absentColor?: string;
  private highlightColor: string;
  private mode: ComparisonMode;
  private differing?: DifferenceSet;
  private isDifferentFn?: DifferencePredicate;
  private equalColor: string;
  private markerSize: number;
  private membershipLabels: [string, string];
  private showLegend: boolean;
  private legendLabels: [string, string];
  private correspondence?: CorrespondenceMap;
  private enabled: boolean;

  private peer: ComparisonOperator | null = null;
  private highlightedId: string | null = null;
  private blinkOn = true;
  private blinkTimer: ReturnType<typeof setInterval> | null = null;
  private flashes: number;
  private flashInterval: number;

  private legendEl: HTMLDivElement;
  private tooltipEl: HTMLDivElement;

  private removeNodeReducer: (() => void) | null = null;
  private removeEdgeReducer: (() => void) | null = null;
  private unsubscribe: Array<() => void> = [];

  constructor(options: ComparisonOptions = {}) {
    this.values = options.values;
    this.valueFor = options.valueFor;
    this.keyOf = options.keyOf ?? keyByClade;
    this.scale = options.scale ?? new SequentialColorScale();
    this.colorEdges = options.colorEdges ?? true;
    this.edgeWidth = options.edgeWidth ?? 3;
    this.colorNodes = options.colorNodes ?? false;
    this.leafColor = options.leafColor ?? "#212529";
    this.absentLabel = options.absentLabel;
    this.absentColor = options.absentColor;
    this.highlightColor = options.highlightColor ?? "#ff0000";
    this.mode = options.mode ?? "gradient";
    this.differing = options.differing ? new Set(options.differing) : undefined;
    this.isDifferentFn = options.isDifferent;
    this.equalColor = options.equalColor ?? "#0077bb";
    this.markerSize = options.markerSize ?? 6;
    this.flashes = Math.max(1, Math.round(options.flashes ?? 3));
    this.flashInterval = Math.max(50, options.flashInterval ?? 300);
    this.membershipLabels = options.membershipLabels ?? ["Different", "Equal"];
    this.showLegend = options.legend ?? true;
    this.legendLabels = options.legendLabels ?? ["Different", "Similar"];
    this.correspondence = options.correspondence;
    this.enabled = options.enabled ?? true;

    this.legendEl = this.buildLegendBox();
    this.tooltipEl = this.buildTooltip();
    this.renderLegend();
  }

  // --- Lifecycle ---

  attach(viewer: TreeViewer): void {
    this.viewer = viewer;

    this.removeEdgeReducer = viewer.addEdgeReducer((edge, data) => this.edgeStyle(edge, data));
    this.removeNodeReducer = viewer.addNodeReducer((node, data) => this.nodeStyle(node, data));

    this.unsubscribe.push(
      viewer.events.on("clickNode", ({ node }) => this.onClickNode(node)),
      viewer.events.on("enterNode", ({ node }) => this.onEnterNode(node)),
      viewer.events.on("leaveNode", () => this.hideTooltip()),
      viewer.events.on("render", () => this.onRender())
    );

    this.attachOverlays();
  }

  detach(): void {
    this.stopBlink();
    this.unsubscribe.forEach((u) => u());
    this.unsubscribe = [];
    this.removeEdgeReducer?.();
    this.removeNodeReducer?.();
    this.removeEdgeReducer = null;
    this.removeNodeReducer = null;
    this.legendEl.remove();
    this.tooltipEl.remove();
    this.viewer = null;
    this.peer = null;
  }

  // --- Public controls ---

  /** Replace the comparison values and re-color. */
  setValues(values: ComparisonValues | undefined): void {
    this.values = values;
    this.refresh();
  }

  /** Replace the cross-tree correspondence used for navigation. */
  setCorrespondence(map: CorrespondenceMap | undefined): void {
    this.correspondence = map;
  }

  /**
   * Move the gradient between the **branches** and the **node markers** at
   * runtime, without rebuilding the panel.
   *
   * The two answer slightly different questions. A branch carries the value of
   * the node it leads to, so a coloured path reads as "the disagreement lies
   * along here"; a marker puts the value on the clade itself, which is where a
   * per-clade metric is actually defined. Neither is wrong, and which reads
   * better depends on how much of the tree is expanded — hence a switch rather
   * than a fixed choice.
   *
   * Turning both off leaves the operator attached and its values intact but
   * draws nothing, which is what {@link setEnabled} is for; prefer that.
   */
  setColorTargets(targets: { edges?: boolean; nodes?: boolean }): void {
    if (targets.edges !== undefined) this.colorEdges = targets.edges;
    if (targets.nodes !== undefined) this.colorNodes = targets.nodes;
    this.refresh();
  }

  /** Where the gradient is currently drawn. */
  getColorTargets(): { edges: boolean; nodes: boolean } {
    return { edges: this.colorEdges, nodes: this.colorNodes };
  }

  /** Switch presentation strategy (gradient value scale ↔ same/different set). */
  setMode(mode: ComparisonMode): void {
    this.mode = mode;
    this.renderLegend();
    this.refresh();
  }

  getMode(): ComparisonMode {
    return this.mode;
  }

  /** Replace the membership-mode set of differing node keys and re-color. */
  setDiffering(differing: Iterable<string> | undefined): void {
    this.differing = differing ? new Set(differing) : undefined;
    this.refresh();
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
    if (!enabled) this.clearHighlight();
    this.legendEl.style.display = enabled && this.showLegend ? "block" : "none";
    this.refresh();
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  /** Pair this operator with the other tree's operator for navigation. */
  link(peer: ComparisonOperator): void {
    this.peer = peer;
  }

  // --- Reducers (coloring) ---

  private edgeStyle(edge: string, data: Record<string, unknown>): Record<string, unknown> {
    // Only the gradient presentation colors branches; membership paints nodes.
    if (!this.enabled || this.mode !== "gradient" || !this.colorEdges || !this.viewer) return data;
    // A phylogram's leader is layout, not branch: it has no length to score.
    if (data.leader) return data;
    // `nodeId` (set in layout) is the real node this edge belongs to — covers
    // both the horizontal branch into a child and the vertical fork of a clade.
    const nodeId = (data.nodeId as string | undefined) ?? this.viewer.getGraph()?.target(edge);
    if (!nodeId) return data;
    const layoutNode = this.viewer.getNodeMap().get(nodeId);
    if (!layoutNode) return data;
    // Color every branch by its node's value, terminal leaf branches included,
    // so the colored path continues all the way to the tips. (Only the leaf
    // *marker* stays neutral — see nodeStyle.)
    const value = this.valueForNode(layoutNode.source);
    // Never coloured from the ramp — a node with no counterpart has no score,
    // and a fabricated mid-scale value would be a lie. `absentColor` gives it
    // a colour of its own instead; see the option.
    if (value == null) {
      return this.absentColor
        ? { ...data, color: this.absentColor, size: this.edgeWidth }
        : data;
    }
    return { ...data, color: this.scale.color(value), size: this.edgeWidth };
  }

  private nodeStyle(node: string, data: Record<string, unknown>): Record<string, unknown> {
    let result = data;

    if (this.enabled) {
      const layoutNode = this.viewer?.getNodeMap().get(node);
      if (layoutNode && this.mode === "membership") {
        // Mark agreement, on leaves only: a leaf the backend does NOT list as
        // differing is shared by both trees, and gets `equalColor` plus a visible
        // marker. Everything else is left exactly as other operators styled it —
        // differing leaves keep their normal color, and internal nodes are not
        // touched at all (this mode describes tips, not clades). See the class
        // doc for why the mode encodes only agreement.
        if (layoutNode.isLeaf && !this.isNodeDifferent(layoutNode.source)) {
          const size = Math.max((result.size as number) || 0, this.markerSize);
          result = { ...result, color: this.equalColor, size };
        }
      } else if (layoutNode && this.colorNodes) {
        // Opt-in (see `colorNodes`): by default gradient mode colors branches
        // only, leaving node markers to whatever other operators decided.
        if (layoutNode.isLeaf) {
          // Leaves are kept neutral (a per-clade magnitude isn't defined on a
          // single leaf); only internal clade markers are colored.
          result = { ...result, color: this.leafColor };
        } else {
          const value = this.valueForNode(layoutNode.source);
          if (value != null) result = { ...result, color: this.scale.color(value) };
        }
      }
    }

    // Navigation highlight overrides coloring while blinking.
    if (node === this.highlightedId && this.blinkOn) {
      const size = (result.size as number) || 4;
      result = { ...result, color: this.highlightColor, size: size + 4, zIndex: 10 };
    }

    return result;
  }

  private valueForNode(node: NewickNode): number | undefined {
    const key = this.keyOf(node);
    const v = this.values?.get(key);
    if (typeof v === "number") return v;
    return this.valueFor?.(key, node);
  }

  /** Membership test: is this node among the backend's differing nodes? */
  private isNodeDifferent(node: NewickNode): boolean {
    const key = this.keyOf(node);
    if (this.differing?.has(key)) return true;
    return this.isDifferentFn?.(key, node) ?? false;
  }

  private refresh(): void {
    this.viewer?.applyReducers();
    this.viewer?.applyEdgeReducers();
  }

  // --- Navigation ---

  private onClickNode(node: string): void {
    if (!this.enabled || !this.peer || !this.viewer) return;
    const layoutNode = this.viewer.getNodeMap().get(node);
    if (!layoutNode) return;
    const myKey = this.keyOf(layoutNode.source);
    const peerKey = this.correspondence?.get(myKey) ?? myKey;
    this.peer.highlightByKey(peerKey);
  }

  /**
   * Find the node with this key and blink-highlight it, centering by default.
   *
   * Pass `center: false` when the view was *already* arranged around the node
   * — a panel re-rooted on it, say. Centering zooms in to `ratio` 0.7, which
   * on a freshly fitted subtree crops the surrounding structure: exactly the
   * context that made the node worth pointing at.
   */
  highlightByKey(key: string, options: { center?: boolean } = {}): void {
    if (!this.viewer) return;
    let foundId: string | null = null;
    for (const [id, layoutNode] of this.viewer.getNodeMap()) {
      if (this.keyOf(layoutNode.source) === key) {
        foundId = id;
        break;
      }
    }
    if (!foundId) return;
    this.highlightedId = foundId;
    if (options.center ?? true) this.centerOn(foundId);
    this.startBlink();
  }

  private centerOn(id: string): void {
    const renderer = this.viewer?.getRenderer();
    if (!renderer) return;
    const d = renderer.getNodeDisplayData(id);
    if (!d) return;
    const camera = renderer.getCamera();
    camera.animate(
      { x: d.x, y: d.y, ratio: Math.min(camera.ratio, 0.7) },
      { duration: 500 }
    );
  }

  /**
   * Flash the highlighted node `flashes` times, then remove the highlight.
   *
   * The first on-phase is immediate, so two ticks buy one further flash: the
   * node goes dark on the odd tick and lights up again on the even one. The
   * last off-phase clears the highlight rather than lighting it a final time,
   * which is why the count is exactly `flashes * 2`.
   */
  private startBlink(): void {
    this.stopBlink();
    let ticks = 0;
    const last = this.flashes * 2;
    this.blinkOn = true;
    this.viewer?.applyReducers();
    this.blinkTimer = setInterval(() => {
      ticks += 1;
      if (ticks >= last) {
        this.clearHighlight();
        return;
      }
      this.blinkOn = !this.blinkOn;
      this.viewer?.applyReducers();
    }, this.flashInterval);
  }

  private stopBlink(): void {
    if (this.blinkTimer) {
      clearInterval(this.blinkTimer);
      this.blinkTimer = null;
    }
  }

  private clearHighlight(): void {
    this.stopBlink();
    this.highlightedId = null;
    this.blinkOn = true;
    this.viewer?.applyReducers();
  }

  // --- Overlays (legend + tooltip) ---

  /** Re-attach overlays after a rebuild (Sigma.kill empties the container). */
  private onRender(): void {
    this.attachOverlays();
    this.refresh();
    this.renderLegend();
  }

  private attachOverlays(): void {
    const container = this.viewer?.getContainer();
    if (!container) return;
    if (this.legendEl.parentElement !== container) container.appendChild(this.legendEl);
    if (this.tooltipEl.parentElement !== container) container.appendChild(this.tooltipEl);
    this.legendEl.style.display = this.enabled && this.showLegend ? "block" : "none";
  }

  private onEnterNode(node: string): void {
    if (!this.enabled || !this.viewer) return;
    const layoutNode = this.viewer.getNodeMap().get(node);
    if (!layoutNode) return;
    let detail: string;
    if (this.mode === "membership") {
      detail = this.isNodeDifferent(layoutNode.source)
        ? this.membershipLabels[0]
        : this.membershipLabels[1];
    } else {
      const value = this.valueForNode(layoutNode.source);
      if (value == null) return;
      detail = value.toFixed(2);
    }
    const renderer = this.viewer.getRenderer();
    const graph = this.viewer.getGraph();
    if (!renderer || !graph) return;
    const attrs = graph.getNodeAttributes(node) as { x: number; y: number };
    const pos = renderer.graphToViewport({ x: attrs.x, y: attrs.y });
    this.tooltipEl.textContent = `${this.keyOf(layoutNode.source)} · ${detail}`;
    this.tooltipEl.style.left = `${pos.x + 8}px`;
    this.tooltipEl.style.top = `${pos.y + 8}px`;
    this.tooltipEl.style.display = "block";
  }

  private hideTooltip(): void {
    this.tooltipEl.style.display = "none";
  }

  private buildLegendBox(): HTMLDivElement {
    const el = document.createElement("div");
    Object.assign(el.style, {
      position: "absolute",
      left: "10px",
      bottom: "10px",
      padding: "6px 8px",
      background: "rgba(255,255,255,0.9)",
      border: "1px solid #d0d4d8",
      borderRadius: "4px",
      font: "11px sans-serif",
      color: "#333",
      pointerEvents: "none",
      zIndex: "14",
      display: "none",
    } as CSSStyleDeclaration);
    return el;
  }

  /**
   * (Re)fill the legend for the current mode: a gradient bar for value coloring,
   * or two labeled swatches (different / equal) for membership coloring.
   */
  private renderLegend(): void {
    this.legendEl.innerHTML = "";

    if (this.mode === "membership") {
      // One swatch: the mode paints agreement only, so a "different" swatch
      // would advertise a color that never appears.
      this.legendEl.appendChild(this.swatchRow(this.equalColor, this.membershipLabels[1]));
      return;
    }

    const gradient = document.createElement("div");
    Object.assign(gradient.style, {
      width: "120px",
      height: "8px",
      borderRadius: "2px",
      background: `linear-gradient(to right, ${this.scale.stopsHex().join(",")})`,
    } as CSSStyleDeclaration);

    const labels = document.createElement("div");
    Object.assign(labels.style, {
      display: "flex",
      justifyContent: "space-between",
      marginTop: "2px",
    } as CSSStyleDeclaration);
    const [lo, hi] = this.legendLabels;
    labels.innerHTML = `<span>${lo}</span><span>${hi}</span>`;

    this.legendEl.appendChild(gradient);
    this.legendEl.appendChild(labels);

    if (this.absentLabel) {
      this.legendEl.appendChild(
        this.swatchRow(this.absentColor ?? BRANCH_COLOR, this.absentLabel),
      );
    }
  }

  /** One membership legend row: a colored swatch followed by its label. */
  private swatchRow(color: string, label: string): HTMLDivElement {
    const row = document.createElement("div");
    Object.assign(row.style, {
      display: "flex",
      alignItems: "center",
      gap: "5px",
      marginTop: "2px",
    } as CSSStyleDeclaration);

    const sw = document.createElement("span");
    Object.assign(sw.style, {
      width: "10px",
      height: "10px",
      borderRadius: "2px",
      background: color,
      display: "inline-block",
      flex: "0 0 auto",
    } as CSSStyleDeclaration);

    const txt = document.createElement("span");
    txt.textContent = label;

    row.appendChild(sw);
    row.appendChild(txt);
    return row;
  }

  private buildTooltip(): HTMLDivElement {
    const el = document.createElement("div");
    Object.assign(el.style, {
      position: "absolute",
      padding: "2px 6px",
      background: "rgba(33,37,41,0.92)",
      color: "#fff",
      font: "11px sans-serif",
      borderRadius: "3px",
      pointerEvents: "none",
      whiteSpace: "nowrap",
      zIndex: "16",
      display: "none",
    } as CSSStyleDeclaration);
    return el;
  }
}
