import type Sigma from "sigma";
import type { NewickNode } from "../tree/types";
import type { TreeViewer } from "../viewer/tree_viewer";
import { CategoricalColorScale } from "../color/color_scale";
import {
  type LeafDatum,
  type LeafDataProvider,
  type LeafSegment,
  datumSegments,
  datumTotal,
} from "../data/leaf_data";
import type { TreeOperator } from "./operator";

export type BarScale = "linear" | "log";

export interface BarChartOptions {
  /**
   * Per-leaf data (single value or composition), keyed by identifier. The
   * primary backend-driven source. Falls back to {@link dataOf}, then the count
   * shorthands. A leaf no source has data for simply gets no bar.
   */
  data?: Map<string, LeafDatum>;
  /** Function form of {@link data}; consulted when `data` has no entry. */
  dataOf?: LeafDataProvider;
  /**
   * Single-value shorthand: a per-identifier count map. Equivalent to a
   * {@link LeafDatum} with just `total`. Consulted after `data`/`dataOf`.
   */
  counts?: Map<string, number>;
  /** Function form of {@link counts}. */
  countOf?: (identifier: string, leaf: NewickNode) => number;
  /** Bar length mapping: "linear" or "log" (algorithmic). Default "linear". */
  scale?: BarScale;
  /** Maximum bar length in pixels (for the most abundant leaf). Default 60. */
  maxBarWidth?: number;
  /** Bar thickness in pixels. Default 8. */
  barHeight?: number;
  /** Gap in pixels between the leaf node and the start of its bar. Default 8. */
  offset?: number;
  /**
   * Shared color scale. Pass the SAME instance to several presenters (e.g. two
   * side-by-side trees) so the same category is the same color in all of them.
   * Defaults to a private scale when omitted.
   */
  colorScale?: CategoricalColorScale;
  /** Custom color function (keyed by segment/category key); overrides `colorScale`. */
  colorOf?: (key: string) => string;
  /**
   * Tooltip text for a leaf's bar. The library is domain-agnostic, so the
   * default states bare magnitudes (`"ST12: 34 (PT: 20, ES: 14)"`) — naming the
   * unit ("isolates", "reads", "speakers") is the app's business, since only it
   * knows what the numbers are. Supply this to provide that wording.
   */
  tooltipOf?: (identifier: string, datum: LeafDatum) => string;
  /** Start hidden (default false). */
  enabled?: boolean;
}

interface LeafBar {
  /** Container element; holds one child div per composition segment. */
  el: HTMLDivElement;
  /** Overlay label element. */
  labelEl: HTMLDivElement | null;
  identifier: string;
  /** Total magnitude (drives bar length). */
  total: number;
  /** Rendered label width in px, so the bar can start *after* the leaf name. */
  labelWidth: number;
}

/**
 * Bar-charts presenter.
 *
 * Renders a small horizontal bar in front of every leaf node, whose length is
 * proportional to that leaf's magnitude. The bars live in a DOM overlay above
 * the Sigma canvas (pointer-events: none, so selection/collapse still work
 * through them) and are repositioned on every Sigma frame, so they track
 * pan/zoom.
 *
 * Identifier of a leaf = `leaf.category ?? leaf.name`. Per-leaf data comes from
 * `options.data`, then `options.dataOf`, then the `counts`/`countOf`
 * single-value shorthands. If none has data for a leaf, that leaf gets **no
 * bar** — the presenter never invents a value, since a fabricated bar is
 * indistinguishable from a real one (§2: the app owns the data).
 *
 * What the data *means* is likewise the app's: the default tooltip states bare
 * magnitudes, and `tooltipOf` supplies domain wording (e.g. "12 isolates").
 *
 * Each bar is a stacked composition: one segment per category, colored
 * semantically from the shared color scale (so the same category is the same
 * color in every tree). A single-value datum renders as one segment.
 *
 * The "linear or algorithmic" sizing requirement is exposed as `scale`:
 * "linear" maps total -> width proportionally; "log" maps log1p(total), which
 * compresses heavy-tailed abundance distributions.
 */
export class BarChartPresenter implements TreeOperator {
  readonly name = "barchart-presenter";

  private viewer: TreeViewer | null = null;
  private overlay: HTMLDivElement;

  private scale: BarScale;
  private maxBarWidth: number;
  private barHeight: number;
  private offset: number;
  private enabled: boolean;
  private data?: Map<string, LeafDatum>;
  private dataOf?: LeafDataProvider;
  private counts?: Map<string, number>;
  private countOf?: (identifier: string, leaf: NewickNode) => number;
  private colorScale: CategoricalColorScale;
  private colorOf: (key: string) => string;

  private bars = new Map<string, LeafBar>();
  private maxTotal = 1;
  /** Widest leaf label in px — all bars start after it, forming one column. */
  private maxLabelWidth = 0;
  /** Total px the labels+bars extend right of the leaf column (for centering). */
  private bandPx = 0;

  /** Offscreen 2D context used to measure leaf-label widths in pixels. */
  private measureCtx: CanvasRenderingContext2D | null = null;
  /** Gap in px between the node marker and the start of its label. */
  private readonly markerGap = 10;

  private unsubscribe: Array<() => void> = [];
  private removeReducer: (() => void) | null = null;
  private renderer: Sigma | null = null;
  private afterRenderHandler = () => this.positionBars();

  constructor(options: BarChartOptions = {}) {
    this.scale = options.scale ?? "linear";
    this.maxBarWidth = options.maxBarWidth ?? 60;
    this.barHeight = options.barHeight ?? 8;
    this.offset = options.offset ?? 8;
    this.enabled = options.enabled ?? true;
    this.data = options.data;
    this.dataOf = options.dataOf;
    this.counts = options.counts;
    this.countOf = options.countOf;
    this.colorScale = options.colorScale ?? new CategoricalColorScale();
    this.colorOf = options.colorOf ?? ((key) => this.colorScale.color(key));

    this.overlay = document.createElement("div");
    Object.assign(this.overlay.style, {
      position: "absolute",
      inset: "0",
      pointerEvents: "none",
      overflow: "hidden",
      zIndex: "12",
    } as CSSStyleDeclaration);
  }

  attach(viewer: TreeViewer): void {
    this.viewer = viewer;
    viewer.getContainer().appendChild(this.overlay);
    this.overlay.style.display = this.enabled ? "block" : "none";
    this.unsubscribe.push(
      viewer.events.on("render", ({ renderer }) => this.onRender(renderer)),
      // Re-draw the bars when the metadata filter changes: a filtered-out leaf
      // gets no bar, matching the dimming the viewer applies to its node. No
      // graph rebuild — just this overlay's DOM.
      viewer.events.on("filterChanged", () => {
        if (this.renderer) this.rebuild();
      })
    );
    // We draw leaf labels ourselves in the overlay (no culling, so every tip
    // is labeled, on either side depending on reflecting). Blank Sigma's native
    // leaf labels while bars are on to avoid duplicates and its collision
    // culling. When bars are off, native labels return.
    this.removeReducer = viewer.addNodeReducer((node, data) => {
      if (!this.enabled) return data;
      return viewer.getNodeMap().get(node)?.isLeaf ? { ...data, label: "" } : data;
    });
  }

  detach(): void {
    this.unsubscribe.forEach((u) => u());
    this.unsubscribe = [];
    this.removeReducer?.();
    this.removeReducer = null;
    this.renderer?.off("afterRender", this.afterRenderHandler);
    this.renderer = null;
    this.overlay.remove();
    this.viewer = null;
  }

  // --- Public controls ---

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
    this.overlay.style.display = enabled ? "block" : "none";
    this.viewer?.setRightReservePx(enabled ? this.bandPx : 0);
    // Re-apply reducers so the reflected leaf-label hiding turns on/off with us.
    this.viewer?.applyReducers();
    if (enabled) this.positionBars();
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  /**
   * The categorical scale mapping segment keys → colors. Exposed so an app can
   * build a legend from `getColorScale().assignments()` — the mapping lives here
   * and nowhere else, so without this the app would have to duplicate the
   * palette-walking and hope it stayed in sync.
   */
  getColorScale(): CategoricalColorScale {
    return this.colorScale;
  }

  setScale(scale: BarScale): void {
    this.scale = scale;
    this.positionBars();
  }

  getScale(): BarScale {
    return this.scale;
  }

  /** Replace the per-leaf data (backend-driven) and rebuild. */
  setData(data: Map<string, LeafDatum> | undefined): void {
    this.data = data;
    if (this.viewer && this.renderer) this.rebuild();
  }

  /** Replace the single-value count shorthand and rebuild. */
  setCounts(counts: Map<string, number> | undefined): void {
    this.counts = counts;
    if (this.viewer && this.renderer) this.rebuild();
  }

  // --- Rebuild + positioning ---

  private onRender(renderer: Sigma): void {
    // Sigma.kill() empties the container (`while (firstChild) removeChild`),
    // so our overlay is detached on every rebuild. Re-attach it after Sigma
    // has recreated its canvases, keeping it as the last child (on top).
    const container = this.viewer?.getContainer();
    if (container && this.overlay.parentElement !== container) {
      container.appendChild(this.overlay);
      this.overlay.style.display = this.enabled ? "block" : "none";
    }

    this.renderer?.off("afterRender", this.afterRenderHandler);
    this.renderer = renderer;
    renderer.on("afterRender", this.afterRenderHandler);
    this.rebuild();
  }

  /** Recreate one bar element per leaf from the current node map. */
  private rebuild(): void {
    const map = this.viewer?.getNodeMap();
    if (!map) return;

    this.overlay.innerHTML = "";
    this.bars.clear();
    this.maxTotal = 1;
    this.maxLabelWidth = 0;

    const reflected = !!this.viewer?.isReflected();

    for (const layoutNode of map.values()) {
      if (!layoutNode.isLeaf) continue;
      // Skip leaves filtered out by the viewer's metadata filter, so bars match
      // the dimmed nodes and `maxTotal` rescales to the leaves still shown.
      if (!this.viewer?.passesFilter(layoutNode.source)) continue;
      const identifier = this.identifierOf(layoutNode.source);
      const datum = this.resolveDatum(identifier, layoutNode.source);
      if (!datum) continue; // no data for this leaf ⇒ no bar (never a fabricated one)
      const segments = datumSegments(datum, identifier);
      const total = datumTotal(datum);
      this.maxTotal = Math.max(this.maxTotal, total);

      // Stacked composition bar: container + one flex child per segment, sized
      // proportionally to its value. Segment order reverses when reflected so
      // the stack mirrors too. Colors are semantic (shared scale by key).
      const el = document.createElement("div");
      Object.assign(el.style, {
        position: "absolute",
        height: `${this.barHeight}px`,
        display: "flex",
        flexDirection: reflected ? "row-reverse" : "row",
        borderRadius: "1px",
        overflow: "hidden",
        transformOrigin: "left center",
        willChange: "transform, width",
      } as CSSStyleDeclaration);
      el.title = this.tooltip(identifier, total, segments);
      for (const seg of segments) {
        const segEl = document.createElement("div");
        Object.assign(segEl.style, {
          flex: `${Math.max(0, seg.value)} 1 0`,
          background: seg.color ?? this.colorOf(seg.key),
          height: "100%",
        } as CSSStyleDeclaration);
        el.appendChild(segEl);
      }
      this.overlay.appendChild(el);

      // We render every leaf label ourselves (Sigma's native labels are blanked
      // while bars are on), so there's no collision culling — each tip gets a
      // label, on the left when reflected, on the right otherwise.
      let labelEl: HTMLDivElement | null = null;
      if (layoutNode.label) {
        labelEl = document.createElement("div");
        Object.assign(labelEl.style, {
          position: "absolute",
          whiteSpace: "nowrap",
          textAlign: reflected ? "right" : "left",
          color: "#222",
          font: this.labelFont(),
          lineHeight: `${this.barHeight}px`,
        } as CSSStyleDeclaration);
        labelEl.textContent = layoutNode.label;
        this.overlay.appendChild(labelEl);
      }

      const labelWidth = this.measureLabel(layoutNode.label);
      this.maxLabelWidth = Math.max(this.maxLabelWidth, labelWidth);
      this.bars.set(layoutNode.id, { el, labelEl, identifier, total, labelWidth });
    }

    // Right-side band = gap + widest label + offset + the longest bar. Tell the
    // viewer so it can shift the tree left and center tree + bars together.
    this.bandPx = this.markerGap + this.maxLabelWidth + this.offset + this.maxBarWidth;
    this.viewer?.setRightReservePx(this.enabled ? this.bandPx : 0);

    this.positionBars();
  }

  /** Reposition + resize every bar from current screen coordinates. */
  private positionBars(): void {
    if (!this.enabled || !this.renderer) return;
    const renderer = this.renderer;
    const graph = renderer.getGraph();
    const reflected = !!this.viewer?.isReflected();

    for (const [id, bar] of this.bars) {
      if (!graph.hasNode(id)) {
        bar.el.style.display = "none";
        if (bar.labelEl) bar.labelEl.style.display = "none";
        continue;
      }
      // graph coords -> viewport (pixel) coords relative to the container.
      // getNodeDisplayData returns *framed* (normalized) coords, not pixels,
      // so graphToViewport is what actually places a DOM overlay on a node.
      const attrs = graph.getNodeAttributes(id) as { x: number; y: number };
      const pos = renderer.graphToViewport({ x: attrs.x, y: attrs.y });
      const width = this.barWidth(bar.total);
      const top = pos.y - this.barHeight / 2;

      // Keep the container a flex row — must NOT be "block", or the stacked
      // composition segments collapse (they lay out via flex-grow), leaving only
      // the first segment's color visible.
      bar.el.style.display = "flex";
      bar.el.style.width = `${width}px`;

      if (reflected) {
        // Tip is on the left; draw label then bar extending leftward, all
        // sharing a column so the bars' right edges line up. Layout (right to
        // left): leaf · label · bar.
        const labelRight = pos.x - this.markerGap;
        if (bar.labelEl) {
          bar.labelEl.style.display = "block";
          bar.labelEl.style.left = `${labelRight - bar.labelWidth}px`;
          bar.labelEl.style.top = `${top}px`;
          bar.labelEl.style.width = `${bar.labelWidth}px`;
        }
        const barRight = pos.x - this.markerGap - this.maxLabelWidth - this.offset;
        bar.el.style.transform = `translate(${barRight - width}px, ${top}px)`;
      } else {
        // Tip is on the left; draw label then bar extending rightward, all
        // sharing a column so the bars' left edges line up. Layout (left to
        // right): leaf · label · bar.
        if (bar.labelEl) {
          bar.labelEl.style.display = "block";
          bar.labelEl.style.left = `${pos.x + this.markerGap}px`;
          bar.labelEl.style.top = `${top}px`;
          bar.labelEl.style.width = `${bar.labelWidth}px`;
        }
        const startX = pos.x + this.markerGap + this.maxLabelWidth + this.offset;
        bar.el.style.transform = `translate(${startX}px, ${top}px)`;
      }
    }
  }

  /** A CSS `font` shorthand matching Sigma's label rendering. */
  private labelFont(): string {
    const size = (this.renderer?.getSetting("labelSize") as number) ?? 11;
    const font = (this.renderer?.getSetting("labelFont") as string) ?? "Arial";
    const weight = (this.renderer?.getSetting("labelWeight") as string) ?? "normal";
    return `${weight} ${size}px ${font}`;
  }

  /** Measure a label's rendered width in px, using Sigma's label font/size. */
  private measureLabel(text: string): number {
    if (!text) return 0;
    if (!this.measureCtx) {
      this.measureCtx = document.createElement("canvas").getContext("2d");
    }
    const ctx = this.measureCtx;
    if (!ctx) return text.length * 7; // rough fallback
    ctx.font = this.labelFont();
    return ctx.measureText(text).width;
  }

  // --- Sizing ---

  private barWidth(total: number): number {
    const max = this.maxTotal;
    const normalized =
      this.scale === "log"
        ? Math.log1p(total) / Math.log1p(max)
        : total / max;
    const MIN_WIDTH = 3;
    return MIN_WIDTH + normalized * (this.maxBarWidth - MIN_WIDTH);
  }

  // --- Identifier / data / color resolution ---

  private identifierOf(leaf: NewickNode): string {
    return leaf.category && leaf.category.trim() !== "" ? leaf.category : leaf.name || "—";
  }

  /**
   * Resolve a leaf's datum, in priority order: explicit `data` map, `dataOf`
   * provider, then the `counts`/`countOf` single-value shorthands.
   *
   * Returns **null** when no source has data for this leaf, and the caller draws
   * no bar. The library deliberately does *not* invent a value: a fabricated bar
   * is indistinguishable from a real one, so a broken provider would render a
   * plausible chart of nothing. Absent data should look absent.
   */
  private resolveDatum(identifier: string, leaf: NewickNode): LeafDatum | null {
    const fromMap = this.data?.get(identifier);
    if (fromMap) return fromMap;
    const fromFn = this.dataOf?.(identifier, leaf);
    if (fromFn) return fromFn;
    const count = this.counts?.get(identifier);
    if (typeof count === "number") return { total: Math.max(0, count) };
    if (this.countOf) return { total: Math.max(0, this.countOf(identifier, leaf)) };
    return null;
  }

  /**
   * Default tooltip: identifier, magnitude, and the segment breakdown — no unit
   * noun, because the library does not know what is being counted. Apps name the
   * unit via `tooltipOf`.
   */
  private tooltip(identifier: string, total: number, segments: LeafSegment[]): string {
    const head = `${identifier}: ${total}`;
    if (segments.length <= 1) return head;
    const parts = segments.map((s) => `${s.key}: ${s.value}`).join(", ");
    return `${head} (${parts})`;
  }
}
