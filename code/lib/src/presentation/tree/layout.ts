import Graph from "graphology";
import type { ChildOrder, IsCollapsed, LayoutMode, NewickNode } from "./types";
import { NEVER_COLLAPSED } from "./types";
import {
  countLeaves,
  maxDepth,
  maxRootDist,
  orderByName,
  prepareTree,
  rerootTree,
} from "./model";

/**
 * Default branch (edge) color. Black is the phylogenetics convention — the tree's
 * structure is the figure, so branches read as ink rather than as a grey
 * background. Operators that color branches (e.g. ComparisonOperator's gradient
 * mode, §9.5) override this per-edge through the edge-reducer pipeline; this is
 * only what an unstyled branch looks like.
 */
export const BRANCH_COLOR = "#000000";

/**
 * The dotted-line colour of a phylogram's leaders: the stretch from where a
 * tip's branch really ends to the aligned column of tips. Light, because it is
 * layout and not length — reading it as branch would be reading a distance the
 * tree does not have.
 */
export const LEADER_COLOR = "#d4d4d4";

/**
 * Turns a {@link NewickNode} tree into a renderable graphology Graph plus a
 * lookup from real graph-node IDs to their {@link LayoutNode}. This is the
 * shared substrate the viewer renders and every operator reads from — it does
 * not know about Sigma, interaction, or DOM.
 */

/** A positioned node in the computed layout tree. */
export interface LayoutNode {
  id: string;
  label: string;
  x: number;
  y: number;
  isLeaf: boolean;
  isCollapsed: boolean;
  named: boolean;
  children: LayoutNode[];
  /** The (pruned) source tree node this layout node was derived from. */
  source: NewickNode;
  /**
   * Phylogram tips only: the x where the branch actually ends. Tips are drawn
   * at the aligned column `x` so labels and bar charts share a baseline; the
   * branch stops here and a leader covers the rest. Absent in a cladogram,
   * where the tip and the branch end coincide.
   */
  branchX?: number;
}

/** Shared precomputed stats passed to layout engines. */
export interface LayoutContext {
  maxDepth: number;
  totalLeaves: number;
  maxDist: number; // clamped max root-to-leaf distance (phylogram)
  clampLength: (len: number) => number;
}

/**
 * A LayoutEngine computes positions for a prepared tree and renders it into a
 * graphology Graph. To add a new layout style, implement this interface and
 * register it in {@link LAYOUT_ENGINES} — the rest of the pipeline needs no
 * changes.
 */
export interface LayoutEngine {
  layout(prepared: NewickNode, ctx: LayoutContext): LayoutNode;
  render(graph: Graph, root: LayoutNode, hideInternalNodes: boolean, ctx: LayoutContext): void;
}

/** Result of {@link buildGraph}: the renderable graph + real-node lookup. */
export interface BuiltGraph {
  graph: Graph;
  /** Maps real graph-node IDs (leaves, collapsed clades, named internals) to
   * their LayoutNode. Invisible connector nodes (v_*, h_*) are excluded. */
  nodeMap: Map<string, LayoutNode>;
}

export function buildGraph(
  tree: NewickNode,
  isCollapsed: IsCollapsed = NEVER_COLLAPSED,
  maxNodes: number = Infinity,
  layoutMode: LayoutMode = "cladogram",
  hideInternalNodes: boolean = true,
  rerootOn?: string,
  reflect: boolean = false,
  order: ChildOrder = orderByName,
  clampBranches: boolean = false
): BuiltGraph {
  const graph = new Graph();

  const rootedTree = rerootOn ? rerootTree(tree, rerootOn) || tree : tree;

  // Prune to a maxNodes leaf budget (honouring collapse) and rotate siblings
  // into the requested order — a structure-preserving branch rotation.
  const prepared = prepareTree(rootedTree, isCollapsed, maxNodes, order) || rootedTree;

  const maxDRaw = maxRootDist(prepared) || 1;
  const maxD = maxDepth(prepared) || 1;
  const totalLeaves = countLeaves(prepared);

  // Optionally cap any single branch's length contribution so one long branch
  // (e.g. an outgroup stem) can't dominate the distance-based scale.
  //
  // Off by default: a phylogram is a promise that lengths are to scale, and a
  // capped branch is drawn at a distance the tree does not have, with nothing
  // on screen to say so. It was on by default, and on a server-summarised
  // UPGMA slice it was badly wrong — the few long branches near the root hold
  // almost all of the height, and "8x the median" of a slice full of short tip
  // branches cut 16 of 99 of them: leaves that are all 564 from the root were
  // drawn at 12, 12 and 16, in a tree squashed to a height of 20.
  const medianBranch = (() => {
    const lens: number[] = [];
    (function collect(n: NewickNode) {
      if (n.length) lens.push(n.length);
      (n.branchset || []).forEach(collect);
    })(prepared);
    if (lens.length === 0) return 0;
    lens.sort((a, b) => a - b);
    return lens[Math.floor(lens.length / 2)];
  })();
  const branchCap = medianBranch * 8 || maxDRaw;
  const clampLength = clampBranches
    ? (len: number) => Math.min(len, branchCap)
    : (len: number) => len;

  function clampedMaxRootDist(node: NewickNode, dist = 0): number {
    const d = dist + clampLength(node.length || 0);
    if (!node.branchset?.length) return d;
    return Math.max(...node.branchset.map((c) => clampedMaxRootDist(c, d)));
  }

  const ctx: LayoutContext = {
    maxDepth: maxD,
    totalLeaves,
    maxDist: clampedMaxRootDist(prepared) || 1,
    clampLength,
  };

  const engine = LAYOUT_ENGINES[layoutMode] || LAYOUT_ENGINES.cladogram;
  const root = engine.layout(prepared, ctx);

  // Reflect horizontally by negating every node's x. Connector nodes (v_*, h_*)
  // are created during render() from these x values, so negating before render
  // flips the whole dendrogram (root ends up on the right, tips on the left).
  if (reflect) {
    (function negate(n: LayoutNode) {
      n.x = -n.x;
      if (n.branchX !== undefined) n.branchX = -n.branchX;
      n.children.forEach(negate);
    })(root);
  }

  engine.render(graph, root, hideInternalNodes, ctx);

  const nodeMap = new Map<string, LayoutNode>();
  (function collect(n: LayoutNode) {
    nodeMap.set(n.id, n);
    n.children.forEach(collect);
  })(root);

  return { graph, nodeMap };
}

// --- Rectangular (phylogram / cladogram) layout ---

/**
 * Rectangular dendrogram engine. `mode` controls the x-coordinate: "cladogram"
 * uses depth (equal spacing per level), "phylogram" uses cumulative (clamped)
 * branch length. Collapsed clades arrive from prepareTree as terminal nodes
 * flagged `collapsed`, and are placed/styled like leaves but marked distinctly.
 */
function makeRectEngine(mode: LayoutMode): LayoutEngine {
  return {
    layout(prepared, ctx) {
      const yScale = ctx.totalLeaves > 1 ? 100 / (ctx.totalLeaves - 1) : 1;
      let leafCounter = 0;
      let nodeSeq = 0;
      const usedNames = new Set<string>();

      const computeX = (distFromRoot: number, depth: number): number =>
        mode === "cladogram"
          ? (depth / ctx.maxDepth) * 100
          : (distFromRoot / ctx.maxDist) * 100;

      function layout(node: NewickNode, distFromRoot: number, depth: number): LayoutNode {
        let id: string;
        if (node.name && node.name.trim() !== "" && !usedNames.has(node.name)) {
          id = `named_${node.name}`;
          usedNames.add(node.name);
        } else {
          id = `n${nodeSeq++}`;
        }

        const myDist = distFromRoot + ctx.clampLength(node.length || 0);
        const hasChildren = !!node.branchset?.length;
        const isCollapsed = !!node.collapsed;
        const isLeaf = !hasChildren && !isCollapsed;
        const isTerminal = !hasChildren; // leaf or collapsed clade

        if (isTerminal) {
          // Align every leaf / collapsed tip to a common x (the right edge of
          // the 0..100 layout span), so all terminals line up vertically and
          // the bar charts start from a shared baseline regardless of depth or
          // branch length. Internal nodes keep their depth/distance-based x.
          //
          // In a phylogram that alignment used to stretch every terminal
          // branch to the edge, so a tip's length was drawn as whatever was
          // left over — not a phylogram. The branch now ends at its real
          // distance (`branchX`) and a leader carries it to the column.
          const x = 100;
          const y = -(leafCounter++ * yScale);
          const branchX = mode === "phylogram" ? computeX(myDist, depth) : undefined;
          return { id, label: node.name || "", x, y, isLeaf, isCollapsed, named: !!node.name, children: [], source: node, branchX };
        }

        const x = computeX(myDist, depth);

        const children = (node.branchset || []).map((child) => layout(child, myDist, depth + 1));
        const y = (children[0].y + children[children.length - 1].y) / 2;
        return { id, label: node.name || "", x, y, isLeaf: false, isCollapsed: false, named: !!node.name, children, source: node };
      }

      const root = layout(prepared, -ctx.clampLength(prepared.length || 0), 0);

      // Center vertically so root.y === 0.
      (function shift(n: LayoutNode, dy: number) {
        n.y += dy;
        n.children.forEach((c) => shift(c, dy));
      })(root, -root.y);

      return root;
    },

    render(graph, root, hideInternalNodes) {
      let connSeq = 0;

      function renderNode(n: LayoutNode) {
        const isVisible = n.isLeaf || n.isCollapsed || !hideInternalNodes;

        graph.addNode(n.id, {
          label: isVisible ? n.label : "",
          x: n.x,
          y: n.y,
          size: isVisible ? (n.isCollapsed ? 8 : n.isLeaf ? 3 : n.named ? 6 : 2) : 0,
          color: isVisible
            ? n.isCollapsed
              ? "#e05c5c"
              : n.isLeaf
                ? "#69b3a2"
                : n.named
                  ? "#e8a838"
                  : "#aaa"
            : "rgba(0,0,0,0)",
          collapsed: n.isCollapsed,
        });

        if (n.children.length === 0) return;

        // `nodeId` tags each edge with the real node it visually belongs to, so
        // operators (e.g. comparison coloring) can style connector edges — whose
        // endpoints are invisible v_*/h_* helpers, not real nodes. The vertical
        // fork belongs to the parent clade `n`; each horizontal belongs to its child.
        if (n.children.length > 1) {
          const ys = n.children.map((c) => c.y);
          const vTop = `v_${connSeq++}`;
          const vBot = `v_${connSeq++}`;
          graph.addNode(vTop, { label: "", x: n.x, y: Math.max(...ys), size: 0, color: "rgba(0,0,0,0)" });
          graph.addNode(vBot, { label: "", x: n.x, y: Math.min(...ys), size: 0, color: "rgba(0,0,0,0)" });
          graph.addEdge(vTop, vBot, { color: BRANCH_COLOR, size: 1, nodeId: n.id });
        }

        for (const child of n.children) {
          renderNode(child);
          const hStart = `h_${connSeq++}`;
          graph.addNode(hStart, { label: "", x: n.x, y: child.y, size: 0, color: "rgba(0,0,0,0)" });
          if (child.branchX !== undefined && child.branchX !== child.x) {
            // Phylogram tip: the branch to its true length, then a leader.
            // The leader has no `nodeId` and is flagged, so a colouring
            // operator leaves it alone rather than painting layout as data.
            const hEnd = `t_${connSeq++}`;
            graph.addNode(hEnd, { label: "", x: child.branchX, y: child.y, size: 0, color: "rgba(0,0,0,0)" });
            graph.addEdge(hStart, hEnd, { color: BRANCH_COLOR, size: 1, nodeId: child.id });
            graph.addEdge(hEnd, child.id, { color: LEADER_COLOR, size: 1, leader: true });
          } else {
            graph.addEdge(hStart, child.id, { color: BRANCH_COLOR, size: 1, nodeId: child.id });
          }
        }
      }

      renderNode(root);
    },
  };
}

/** Registry of available layouts (add a new LayoutMode + engine here). */
export const LAYOUT_ENGINES: Record<LayoutMode, LayoutEngine> = {
  phylogram: makeRectEngine("phylogram"),
  cladogram: makeRectEngine("cladogram"),
};
