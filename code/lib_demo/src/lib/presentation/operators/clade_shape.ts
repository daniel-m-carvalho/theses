import type Sigma from "sigma";
import type { NewickNode } from "../tree/types";
import type { TreeViewer } from "../viewer/tree_viewer";
import { countLeaves } from "../tree/model";
import type { TreeOperator } from "./operator";

export interface CladeShapeOptions {
  /**
   * Draw the wedge pointing back toward the root, so it reads as "the tree
   * continues this way" (default true). Automatically mirrored on reflected
   * panels. Set false to point outward, away from the root.
   */
  towardRoot?: boolean;
  /** Wedge length along the branch axis, in px (default 14). */
  length?: number;
  /** Half-height of the smallest wedge, in px (default 4). */
  minHalfHeight?: number;
  /** Half-height of the largest wedge, in px (default 13). */
  maxHalfHeight?: number;
  /**
   * The top of the size scale: the leaf count that draws at `maxHalfHeight`.
   * Height grows with log2(leaves), and every clade at or above this count
   * saturates at the maximum — hence the name.
   *
   * **Defaults to the leaf count of the tree in view**, which calibrates the
   * scale to the data: the largest possible clade maps to the tallest wedge, so
   * the differences spread across the full pixel range. A fixed number risks
   * being far below the tree's scale, which flattens every wedge to the maximum
   * and destroys the encoding. Set it explicitly only to compare wedge heights
   * across *different* trees on a shared scale.
   */
  saturateAt?: number;
  /** Override the wedge color. Default: the node's own color from the graph. */
  color?: string;
  /** Replace the collapsed node's circular marker with the wedge (default true). */
  hideMarker?: boolean;
}

interface Wedge {
  el: HTMLDivElement;
  halfHeight: number;
}

/**
 * Draws each **collapsed clade as a triangular wedge** — the standard
 * phylogenetics convention for "a clade is folded up here" — instead of the
 * generic circular marker, and scales the wedge with the number of leaves it
 * hides, so the summary carries a sense of how much tree is behind it.
 *
 * Pure presentation, and deliberately decoupled from ExpandCollapseOperator: it
 * reads `isCollapsed` off the layout nodes the viewer already publishes
 * (`getNodeMap()`), so it needs no reference to whatever put them in that state,
 * and it works even if collapse is driven by a bare `setCollapseFn`. Attach it
 * or don't; nothing else changes.
 *
 * Uses the library's DOM-overlay technique (as BarChartPresenter does): a div
 * positioned per frame on `afterRender` from `graphToViewport`, rather than a
 * custom WebGL node program — far less code, and it composes with the other
 * overlays. The wedge keeps a constant screen size while zooming.
 *
 * Wedges point toward the root (mirrored automatically on reflected panels), so
 * on a reflected right-hand panel they point right, as the tree does.
 */
export class CladeShapePresenter implements TreeOperator {
  readonly name = "clade-shape";

  private viewer: TreeViewer | null = null;
  private renderer: Sigma | null = null;
  private unsubscribe: Array<() => void> = [];
  private removeReducer: (() => void) | null = null;

  private layer: HTMLDivElement;
  private wedges = new Map<string, Wedge>();
  private afterRenderHandler = () => this.position();

  private towardRoot: boolean;
  private length: number;
  private minHalfHeight: number;
  private maxHalfHeight: number;
  /** Explicit override; when undefined the scale calibrates to the tree (see options). */
  private saturateAt?: number;
  /** Memoized auto-calibration, keyed on the tree it was computed from. */
  private autoSaturate: { tree: NewickNode; value: number } | null = null;
  private color?: string;
  private hideMarker: boolean;

  constructor(options: CladeShapeOptions = {}) {
    this.towardRoot = options.towardRoot ?? true;
    this.length = options.length ?? 14;
    this.minHalfHeight = options.minHalfHeight ?? 4;
    this.maxHalfHeight = options.maxHalfHeight ?? 13;
    this.saturateAt = options.saturateAt != null ? Math.max(2, options.saturateAt) : undefined;
    this.color = options.color;
    this.hideMarker = options.hideMarker ?? true;

    this.layer = document.createElement("div");
    Object.assign(this.layer.style, {
      position: "absolute",
      inset: "0",
      pointerEvents: "none", // decorative: clicks belong to the Sigma canvas below
      overflow: "hidden",
      zIndex: "12",
    } as CSSStyleDeclaration);
  }

  attach(viewer: TreeViewer): void {
    this.viewer = viewer;
    viewer.getContainer().appendChild(this.layer);

    // Hand the marker's job to the wedge, rather than drawing both. Make it
    // *transparent* rather than size 0: Sigma hit-tests by size, so zeroing it
    // would also destroy the node's click target, and this overlay is
    // pointer-events:none. The marker stays clickable, the wedge is what shows.
    if (this.hideMarker) {
      this.removeReducer = viewer.addNodeReducer((_node, data) =>
        data.collapsed ? { ...data, color: "rgba(0,0,0,0)" } : data
      );
    }

    this.unsubscribe.push(viewer.events.on("render", ({ renderer }) => this.onRender(renderer)));
  }

  detach(): void {
    this.unsubscribe.forEach((u) => u());
    this.unsubscribe = [];
    this.removeReducer?.();
    this.removeReducer = null;
    this.renderer?.off("afterRender", this.afterRenderHandler);
    this.renderer = null;
    this.layer.remove();
    this.wedges.clear();
    this.viewer = null;
  }

  private onRender(renderer: Sigma): void {
    // Sigma.kill() empties the container on rebuild; re-attach the overlay.
    const container = this.viewer?.getContainer();
    if (container && this.layer.parentElement !== container) {
      container.appendChild(this.layer);
    }
    this.renderer?.off("afterRender", this.afterRenderHandler);
    this.renderer = renderer;
    renderer.on("afterRender", this.afterRenderHandler);
    this.rebuild();
  }

  /** One wedge per collapsed clade, sized by the leaves it hides. */
  private rebuild(): void {
    this.layer.innerHTML = "";
    this.wedges.clear();

    const map = this.viewer?.getNodeMap();
    const graph = this.renderer?.getGraph();
    if (!map || !graph) return;

    const saturateAt = this.resolveSaturateAt();

    for (const node of map.values()) {
      if (!node.isCollapsed) continue;

      // The displayed clade is a pruned clone; `origin` (set by prepareTree)
      // leads back to the real subtree, so the wedge reflects the true leaf
      // count rather than the truncated one.
      const source = node.source.origin ?? node.source;
      const halfHeight = this.heightFor(countLeaves(source), saturateAt);
      const color =
        this.color ??
        (graph.hasNode(node.id)
          ? ((graph.getNodeAttribute(node.id, "color") as string) ?? "#e05c5c")
          : "#e05c5c");

      const el = this.makeWedge(halfHeight, color);
      el.title = `${countLeaves(source)} leaves`;
      this.layer.appendChild(el);
      this.wedges.set(node.id, { el, halfHeight });
    }

    this.position();
  }

  /**
   * The top of the size scale. An explicit option wins; otherwise calibrate to
   * the tree currently in view, so the biggest clade it can hold maps to the
   * tallest wedge. Memoized on tree identity — the tree is walked once per load,
   * not per frame. In subtree mode the view root changes on drill-in, so the
   * scale re-calibrates to the subtree: heights stay relative to what you are
   * looking at.
   */
  private resolveSaturateAt(): number {
    if (this.saturateAt != null) return this.saturateAt;

    const tree = this.viewer?.getTree();
    if (!tree) return 512; // no tree yet; any value, nothing is drawn
    if (this.autoSaturate?.tree === tree) return this.autoSaturate.value;

    const value = Math.max(2, countLeaves(tree));
    this.autoSaturate = { tree, value };
    return value;
  }

  /**
   * Half-height for a clade of `leaves`, growing with log2 so small and huge
   * clades stay distinguishable across orders of magnitude.
   */
  private heightFor(leaves: number, saturateAt: number): number {
    const t = Math.min(1, Math.log2(Math.max(1, leaves)) / Math.log2(saturateAt));
    return this.minHalfHeight + t * (this.maxHalfHeight - this.minHalfHeight);
  }

  /** A CSS-border triangle: apex on the tree side, base facing the tips. */
  private makeWedge(halfHeight: number, color: string): HTMLDivElement {
    const el = document.createElement("div");
    // Reflected panels have the root on the right, so the apex flips with them.
    const apexLeft = this.towardRoot !== !!this.viewer?.isReflected();
    Object.assign(el.style, {
      position: "absolute",
      width: "0",
      height: "0",
      borderTop: `${halfHeight}px solid transparent`,
      borderBottom: `${halfHeight}px solid transparent`,
    } as CSSStyleDeclaration);
    // Set the apex side separately: a computed key would widen the object to an
    // index signature, which no longer matches CSSStyleDeclaration.
    const apexSide = apexLeft ? "borderRight" : "borderLeft";
    el.style[apexSide] = `${this.length}px solid ${color}`;
    return el;
  }

  /** Place each wedge's apex on its node's current screen position. */
  private position(): void {
    if (!this.renderer) return;
    const renderer = this.renderer;
    const graph = renderer.getGraph();
    const apexLeft = this.towardRoot !== !!this.viewer?.isReflected();

    for (const [id, { el, halfHeight }] of this.wedges) {
      if (!graph.hasNode(id)) {
        el.style.display = "none";
        continue;
      }
      const attrs = graph.getNodeAttributes(id) as { x: number; y: number };
      const pos = renderer.graphToViewport({ x: attrs.x, y: attrs.y });
      el.style.display = "block";
      el.style.left = `${apexLeft ? pos.x : pos.x - this.length}px`;
      el.style.top = `${pos.y - halfHeight}px`;
    }
  }
}
