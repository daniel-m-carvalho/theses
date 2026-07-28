import type { NewickNode } from "../tree/types";
import type { TreeViewer } from "../viewer/tree_viewer";
import { countLeaves } from "../tree/model";

/** A step in the subtree trail: the clade, and a label for a breadcrumb UI. */
export interface SubtreeStep {
  node: NewickNode;
  label: string;
}

/**
 * The engine behind ExpandCollapseOperator's **subtree** mode: a stack of the
 * clades drilled through, and the `setTree` calls that swap the view between
 * them.
 *
 * Deliberately *not* a TreeOperator — it is a helper owned by
 * ExpandCollapseOperator rather than something an app attaches. That keeps
 * navigation a **single** operator with two modes (no two operators competing
 * for the same gestures), while leaving the stack mechanics in their own file.
 *
 * Works purely through `viewer.setTree()`, so every other operator reacts to a
 * drill-in exactly as it would to a freshly loaded tree — notably the owning
 * operator re-applies its depth cut, which is what makes a subtree open
 * summarized like a new tree. Never mutates the tree: the stack holds references
 * to nodes of the *original* tree.
 */
export class SubtreeNavigator {
  /** Clades drilled through, outermost first. The last entry is the view root. */
  private stack: SubtreeStep[] = [];
  private unsubscribe: Array<() => void> = [];
  private onChangeCb: ((path: SubtreeStep[]) => void) | null = null;
  /** True while we are the one calling setTree, so we don't reset our own stack. */
  private setting = false;

  constructor(
    private viewer: TreeViewer,
    private minLeaves = 2
  ) {}

  attach(): void {
    const current = this.viewer.getTree();
    if (current) this.stack = [{ node: current, label: this.labelOf(current) }];
    this.unsubscribe.push(
      this.viewer.events.on("treeChanged", ({ tree }) => this.onTreeChanged(tree))
    );
  }

  detach(): void {
    this.unsubscribe.forEach((u) => u());
    this.unsubscribe = [];
    this.stack = [];
    this.onChangeCb = null;
  }

  /**
   * A tree we didn't set is a genuinely new dataset, so the trail restarts from
   * it. Our own setTree() calls are guarded by `setting`.
   */
  private onTreeChanged(tree: NewickNode): void {
    if (this.setting) return;
    this.stack = [{ node: tree, label: this.labelOf(tree) }];
    this.emit();
  }

  /**
   * Drill into `node`, making it the root of the view. Accepts a display node —
   * including a *collapsed* clade, which renders as a terminal but still carries
   * an `origin` back-reference to the original branching node. No-op for leaves,
   * for the current root, and for clades under `minLeaves`.
   */
  focus(node: NewickNode): boolean {
    const origin = node.origin ?? node;
    if (!origin.branchset?.length) return false; // leaf
    if (origin === this.currentRoot()) return false; // already the root
    if (countLeaves(origin) < this.minLeaves) return false;

    this.stack.push({ node: origin, label: this.labelOf(origin) });
    this.apply();
    return true;
  }

  /** Return to the previous view. Returns false at the original tree. */
  back(): boolean {
    if (this.stack.length <= 1) return false;
    this.stack.pop();
    this.apply();
    return true;
  }

  /** Return to the original tree. Returns false if already there. */
  reset(): boolean {
    if (this.stack.length <= 1) return false;
    this.stack = [this.stack[0]];
    this.apply();
    return true;
  }

  /**
   * Jump to a step of the trail by index (0 = the original tree) — what a
   * breadcrumb click does.
   */
  goTo(index: number): boolean {
    if (index < 0 || index >= this.stack.length - 1) return false;
    this.stack = this.stack.slice(0, index + 1);
    this.apply();
    return true;
  }

  /** The node currently serving as the view's root, if any. */
  currentRoot(): NewickNode | undefined {
    return this.stack[this.stack.length - 1]?.node;
  }

  /** True if `node` (display or original) is the current view root. */
  isRoot(node: NewickNode): boolean {
    return (node.origin ?? node) === this.currentRoot();
  }

  /** The trail, outermost first; the last entry is the current view. */
  getPath(): SubtreeStep[] {
    return [...this.stack];
  }

  /** How deep we have drilled (0 = the original tree). */
  getDepth(): number {
    return Math.max(0, this.stack.length - 1);
  }

  /** True when {@link back} would do something. */
  canGoBack(): boolean {
    return this.stack.length > 1;
  }

  /** Called whenever the trail changes — for a breadcrumb / back button. */
  setOnChange(cb: ((path: SubtreeStep[]) => void) | null): void {
    this.onChangeCb = cb;
  }

  /** Render the current stack top, without letting it reset our own stack. */
  private apply(): void {
    const top = this.currentRoot();
    if (!top) return;
    this.setting = true;
    try {
      this.viewer.setTree(top);
    } finally {
      this.setting = false;
    }
    this.emit();
  }

  private emit(): void {
    this.onChangeCb?.(this.getPath());
  }

  /** Clade name if it has one, else a leaf-count summary for a breadcrumb. */
  private labelOf(node: NewickNode): string {
    if (node.name && /[A-Za-z0-9]/.test(node.name)) return node.name;
    return `${countLeaves(node)} leaves`;
  }
}
