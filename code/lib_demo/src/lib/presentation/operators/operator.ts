import type { TreeViewer } from "../viewer/tree_viewer";

/**
 * A TreeOperator encapsulates one independent tree operation (collapse,
 * selection, bar charts, ...) in its own file. It attaches to a
 * {@link TreeViewer} and communicates only through the viewer's public surface
 * (events, the node-reducer pipeline, the collapse hook), so operators are
 * mutually independent and any subset can be attached to any viewer. Attaching
 * the same set of operators to two side-by-side viewers gives two fully
 * independent panels that both support every operation.
 */
export interface TreeOperator {
  /** Short, human-readable operator name (for debugging / toolbars). */
  readonly name: string;
  attach(viewer: TreeViewer): void;
  detach(): void;
}
