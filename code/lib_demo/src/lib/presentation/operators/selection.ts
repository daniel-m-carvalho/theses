import type { TreeViewer } from "../viewer/tree_viewer";
import type { TreeOperator } from "./operator";

export interface SelectionOptions {
  /** Start with rectangular drag-select enabled (default false). */
  dragSelectEnabled?: boolean;
  /** Called whenever the selection changes. */
  onSelectionChange?: (selected: string[]) => void;
}

/**
 * Selector operator (select-box).
 *
 * Combines two selection gestures, ported and generalized from the reference
 * `select_nodes.ts` / `selectBox.ts`:
 *  - single click on a node selects just that node;
 *  - when drag-select is enabled, a click-drag-click on empty canvas selects
 *    every real (non-connector) node whose graph coordinates fall inside the
 *    rectangle.
 *
 * Selection highlight is contributed via the viewer's composable node-reducer
 * pipeline, so it coexists with other operators. Each viewer gets its own
 * SelectionOperator instance, so the two side-by-side panels select
 * independently.
 */
export class SelectionOperator implements TreeOperator {
  readonly name = "selection";

  private viewer: TreeViewer | null = null;
  private selected = new Set<string>();
  private dragEnabled: boolean;
  private onChange?: (selected: string[]) => void;

  private removeReducer: (() => void) | null = null;
  private unsubscribe: Array<() => void> = [];

  private box: HTMLDivElement;
  private dragStart: { x: number; y: number } | null = null;
  private onMouseMoveBound = (e: MouseEvent) => this.onMouseMove(e);

  constructor(options: SelectionOptions = {}) {
    this.dragEnabled = options.dragSelectEnabled ?? false;
    this.onChange = options.onSelectionChange;

    this.box = document.createElement("div");
    Object.assign(this.box.style, {
      position: "absolute",
      border: "1px dashed #007bff",
      background: "rgba(0, 123, 255, 0.1)",
      pointerEvents: "none",
      display: "none",
      zIndex: "15",
    } as CSSStyleDeclaration);
  }

  attach(viewer: TreeViewer): void {
    this.viewer = viewer;
    viewer.getContainer().appendChild(this.box);

    this.removeReducer = viewer.addNodeReducer((node, data) =>
      this.selected.has(node) ? { ...data, color: "#d9480f", zIndex: 10 } : data
    );

    this.unsubscribe.push(
      viewer.events.on("clickNode", ({ node }) => this.onClickNode(node)),
      viewer.events.on("clickStage", (p) => this.onClickStage(p)),
      viewer.events.on("render", () => this.onRender())
    );
  }

  detach(): void {
    this.unsubscribe.forEach((u) => u());
    this.unsubscribe = [];
    this.removeReducer?.();
    this.removeReducer = null;
    this.viewer?.getContainer().removeEventListener("mousemove", this.onMouseMoveBound);
    this.box.remove();
    this.viewer = null;
  }

  // --- Public controls ---

  /** Set/replace the selection-change callback. */
  setOnChange(fn: (selected: string[]) => void): void {
    this.onChange = fn;
  }

  setDragSelectEnabled(enabled: boolean): void {
    this.dragEnabled = enabled;
    if (!enabled) {
      this.box.style.display = "none";
      this.dragStart = null;
      this.viewer?.getContainer().removeEventListener("mousemove", this.onMouseMoveBound);
    }
  }

  isDragSelectEnabled(): boolean {
    return this.dragEnabled;
  }

  getSelected(): Set<string> {
    return new Set(this.selected);
  }

  clearSelection(): void {
    this.selected.clear();
    this.viewer?.applyReducers();
    this.onChange?.([]);
  }

  // --- Event handlers ---

  /** Drop selections that no longer exist after a rebuild, then re-highlight. */
  private onRender(): void {
    // Sigma.kill() empties the container on every rebuild, detaching our
    // selection box — re-attach it so the drag rectangle still renders.
    const container = this.viewer?.getContainer();
    if (container && this.box.parentElement !== container) container.appendChild(this.box);

    const map = this.viewer?.getNodeMap();
    if (map) for (const id of [...this.selected]) if (!map.has(id)) this.selected.delete(id);
    this.viewer?.applyReducers();
  }

  private onClickNode(node: string): void {
    if (!this.viewer?.getNodeMap().has(node)) return; // skip invisible connectors
    this.selected = new Set([node]);
    this.viewer.applyReducers();
    this.onChange?.([...this.selected]);
  }

  private onClickStage(point: { x: number; y: number }): void {
    if (this.dragEnabled) {
      this.handleDragClick(point);
      return;
    }
    this.clearSelection();
  }

  // --- Drag-select rectangle (two-click) ---

  private handleDragClick(point: { x: number; y: number }): void {
    const container = this.viewer?.getContainer();
    if (!container) return;

    if (!this.dragStart) {
      this.dragStart = { x: point.x, y: point.y };
      this.updateBox(this.dragStart, point);
      container.addEventListener("mousemove", this.onMouseMoveBound);
      return;
    }

    const start = this.dragStart;
    const end = point;
    this.updateBox(start, end);

    const selected = this.selectInRect(start, end);
    container.removeEventListener("mousemove", this.onMouseMoveBound);
    this.dragStart = null;
    this.box.style.display = "none";

    this.selected = new Set(selected);
    this.viewer?.applyReducers();
    this.onChange?.([...this.selected]);
  }

  private onMouseMove(event: MouseEvent): void {
    if (!this.dragStart) return;
    this.updateBox(this.dragStart, { x: event.offsetX, y: event.offsetY });
  }

  private updateBox(start: { x: number; y: number }, end: { x: number; y: number }): void {
    this.box.style.left = `${Math.min(start.x, end.x)}px`;
    this.box.style.top = `${Math.min(start.y, end.y)}px`;
    this.box.style.width = `${Math.abs(start.x - end.x)}px`;
    this.box.style.height = `${Math.abs(start.y - end.y)}px`;
    this.box.style.display = "block";
  }

  private selectInRect(start: { x: number; y: number }, end: { x: number; y: number }): string[] {
    const renderer = this.viewer?.getRenderer();
    const graph = this.viewer?.getGraph();
    const map = this.viewer?.getNodeMap();
    if (!renderer || !graph || !map) return [];

    const a = renderer.viewportToGraph(start);
    const b = renderer.viewportToGraph(end);
    const x1 = Math.min(a.x, b.x);
    const x2 = Math.max(a.x, b.x);
    const y1 = Math.min(a.y, b.y);
    const y2 = Math.max(a.y, b.y);

    const selected: string[] = [];
    graph.forEachNode((node, attrs) => {
      if (!map.has(node)) return; // skip invisible connector nodes
      const x = attrs.x as number;
      const y = attrs.y as number;
      if (x >= x1 && x <= x2 && y >= y1 && y <= y2) selected.push(node);
    });
    return selected;
  }
}
