import type Sigma from "sigma";
import type Graph from "graphology";
import { Emitter } from "../viewer/emitter";
import { buildGraph, type LayoutNode } from "../tree/layout";
import type { IsCollapsed, NewickNode } from "../tree/types";
import type {
  EdgeReducer,
  LeafFilter,
  NodeReducer,
  TreeViewer,
  ViewerEvents,
} from "../viewer/tree_viewer";

/**
 * Shared test harness: a fake TreeViewer + Sigma renderer.
 *
 * Not a test file (no `.test.ts`), so the runner doesn't collect it.
 *
 * Operators talk to the viewer only through its published channels — events,
 * the reducer pipelines, and a few handles — which is exactly what makes them
 * unit-testable without a GPU. This builds a *real* graph and node map via
 * `buildGraph`, so operators see genuine layout data, and fakes only the two
 * things that need hardware: the Sigma instance and coordinate projection.
 *
 * `graphToViewport` is identity-ish (a simple offset), so overlay positions are
 * predictable in assertions rather than dependent on a camera.
 */
export interface Harness {
  viewer: TreeViewer;
  /** Rebuild the graph from the current tree/collapse state and emit "render". */
  render(): void;
  /** Compose the registered node reducers over a node's current attributes. */
  styleOf(nodeId: string): Record<string, unknown>;
  /**
   * Compose the registered edge reducers over the branch belonging to `nodeId`
   * (edges carry `nodeId`, since their endpoints are invisible connectors).
   */
  edgeStyleOf(nodeId: string): Record<string, unknown> | null;
  /** Fire Sigma's afterRender, which overlay operators use to reposition. */
  afterRender(): void;
  container: HTMLDivElement;
  graph(): Graph;
  nodeMap(): Map<string, LayoutNode>;
  /** Ids of leaves in the current layout, for convenience in assertions. */
  leafIds(): string[];
  /** Set the metadata filter the fake viewer reports through passesFilter. */
  setFilter(filter: LeafFilter | null): void;
  rerenderCount(): number;
  setTreeCalls(): NewickNode[];
}

export interface HarnessOptions {
  maxNodes?: number;
  reflect?: boolean;
  hideInternalNodes?: boolean;
}

export function makeHarness(tree: NewickNode, options: HarnessOptions = {}): Harness {
  const maxNodes = options.maxNodes ?? 100;
  const reflect = options.reflect ?? false;
  const hideInternal = options.hideInternalNodes ?? true;

  const container = document.createElement("div");
  document.body.appendChild(container);

  const events = new Emitter<ViewerEvents>();
  const reducers: NodeReducer[] = [];
  const edgeReducers: EdgeReducer[] = [];
  const afterRenderHandlers = new Set<() => void>();

  let currentTree = tree;
  let collapseFn: IsCollapsed = () => false;
  let filter: LeafFilter | null = null;
  let rerenders = 0;
  const setTreeCalls: NewickNode[] = [];

  let built = buildGraph(currentTree, collapseFn, maxNodes, "cladogram", hideInternal, undefined, reflect);

  const renderer = {
    on(event: string, handler: () => void) {
      if (event === "afterRender") afterRenderHandlers.add(handler);
    },
    off(event: string, handler: () => void) {
      if (event === "afterRender") afterRenderHandlers.delete(handler);
    },
    getGraph: () => built.graph,
    getNodeDisplayData: (id: string) =>
      built.graph.hasNode(id)
        ? (built.graph.getNodeAttributes(id) as { x: number; y: number })
        : undefined,
    // Deterministic projection: graph coords straight through, so a test can
    // assert an overlay landed on its node without simulating a camera.
    graphToViewport: ({ x, y }: { x: number; y: number }) => ({ x, y }),
    getSetting: (key: string) =>
      ({ labelSize: 11, labelFont: "Arial", labelWeight: "normal" })[key],
    refresh: () => {},
    setSetting: () => {},
    kill: () => {},
    getCamera: () => ({
      getState: () => ({ x: 0.5, y: 0.5, angle: 0, ratio: 1 }),
      setState: () => {},
      animate: (_state: unknown, _opts: unknown, cb?: () => void) => cb?.(),
    }),
  } as unknown as Sigma;

  const viewer = {
    events,
    getContainer: () => container,
    getRenderer: () => renderer,
    getGraph: () => built.graph,
    getNodeMap: () => built.nodeMap,
    getTree: () => currentTree,
    isReflected: () => reflect,
    setCollapseFn: (fn: IsCollapsed | null) => {
      collapseFn = fn ?? (() => false);
    },
    setTree: (next: NewickNode) => {
      setTreeCalls.push(next);
      currentTree = next;
      events.emit("treeChanged", { tree: next });
      rebuild();
    },
    rerender: () => {
      rerenders++;
      rebuild();
    },
    addNodeReducer: (reducer: NodeReducer) => {
      reducers.push(reducer);
      return () => {
        const i = reducers.indexOf(reducer);
        if (i >= 0) reducers.splice(i, 1);
      };
    },
    addEdgeReducer: (reducer: EdgeReducer) => {
      edgeReducers.push(reducer);
      return () => {
        const i = edgeReducers.indexOf(reducer);
        if (i >= 0) edgeReducers.splice(i, 1);
      };
    },
    applyReducers: () => {},
    applyEdgeReducers: () => {},
    setRightReservePx: () => {},
    passesFilter: (leaf: NewickNode) => (filter ? filter(leaf.metadata ?? {}, leaf) : true),
    getFilter: () => filter,
  } as unknown as TreeViewer;

  function rebuild(): void {
    built = buildGraph(
      currentTree,
      collapseFn,
      maxNodes,
      "cladogram",
      hideInternal,
      undefined,
      reflect
    );
    events.emit("render", {
      renderer,
      graph: built.graph,
      nodeMap: built.nodeMap,
    });
  }

  return {
    viewer,
    render: rebuild,
    container,
    graph: () => built.graph,
    nodeMap: () => built.nodeMap,
    leafIds: () =>
      [...built.nodeMap.values()].filter((n) => n.isLeaf).map((n) => n.id),
    styleOf(nodeId) {
      const base = { ...built.graph.getNodeAttributes(nodeId) } as Record<string, unknown>;
      return reducers.reduce((acc, r) => r(nodeId, acc), base);
    },
    edgeStyleOf(nodeId) {
      let edgeId: string | null = null;
      built.graph.forEachEdge((edge, attrs) => {
        if (attrs.nodeId === nodeId) edgeId = edge;
      });
      if (!edgeId) return null;
      const base = { ...built.graph.getEdgeAttributes(edgeId) } as Record<string, unknown>;
      return edgeReducers.reduce((acc, r) => r(edgeId as string, acc), base);
    },
    afterRender() {
      for (const h of afterRenderHandlers) h();
    },
    setFilter(next) {
      filter = next;
      events.emit("filterChanged", { filter: next });
    },
    rerenderCount: () => rerenders,
    setTreeCalls: () => setTreeCalls,
  };
}

/** A balanced binary tree with named leaves; internals unnamed (NJ/UPGMA shape). */
export function binaryTree(depth: number, path = ""): NewickNode {
  if (depth === 0) return { name: `L${path}`, length: 1 };
  return {
    name: "",
    length: 1,
    branchset: [binaryTree(depth - 1, `${path}0`), binaryTree(depth - 1, `${path}1`)],
  };
}

/** A small named tree: root(a, b(c, d)). */
export function namedTree(): NewickNode {
  return {
    name: "root",
    branchset: [
      { name: "a", length: 1 },
      { name: "b", length: 1, branchset: [{ name: "c", length: 1 }, { name: "d", length: 1 }] },
    ],
  };
}
