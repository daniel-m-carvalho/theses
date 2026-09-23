/**
 * Two trees, side by side, driven by server slices.
 *
 * The library owns rendering and the operators; this owns navigation and the
 * menus. The seam is narrow on purpose: `createComparison` is called **once**
 * and the trees are replaced with `setTree` afterwards, because rebuilding
 * both panels on every navigation would tear down and re-create two Sigma
 * renderers for what is a change of contents.
 *
 * Providers are read through refs rather than captured. The library keeps the
 * provider functions it was given at construction; a closure over `gradient`
 * would keep serving the first slice's values forever.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import {
  createComparison,
  type ComparisonHandle,
  type Config,
} from "phylo-tree-viewer";
import type { PairSummary } from "../api/types";
import { ContextMenu } from "../menu/ContextMenu";
import { buildMenu, menuTitle, type PendingMenu } from "./menuItems";
import { useSide, type SideActions, type SideState } from "./useSide";

/**
 * Panels are identical except for their label: the same budget, the same
 * gradient, the same shaping. Anything asymmetric would make the two sides
 * incomparable by eye, which is the entire task.
 */
/**
 * `maxNodes` is raised deliberately.
 *
 * The viewer carries its own budget (default 200) and prunes with
 * `prepareTree`. Here the **server** already budgeted, and it did so with
 * information the client does not have — which clades diverge — so a second,
 * blinder pruning on top would throw most of that away. The server's slice is
 * shown as it arrived.
 *
 * `expandCollapse` is off for the same reason: collapsing is the server's job
 * in this app, and a client-side operator with its own collapse state would be
 * a second opinion about what is collapsed.
 */
const VIEWER = {
  layoutMode: "cladogram",
  hideInternalNodes: true,
  maxNodes: 100_000,
} as const;

const CONFIG: Config = {
  panels: [
    {
      id: "left",
      viewer: { ...VIEWER },
      operators: { expandCollapse: false, selection: { enabled: true } },
    },
    {
      id: "right",
      // Mirrored so the two trees face each other and corresponding clades sit
      // opposite rather than both running left to right.
      viewer: { ...VIEWER, reflect: true },
      operators: { expandCollapse: false, selection: { enabled: true } },
    },
  ],
  comparison: {
    enabled: true,
    mode: "gradient",
    keyBy: "name",
    colorEdges: true,
    colorNodes: true,
    legend: true,
    legendLabels: ["identical", "diverged"],
  },
  link: true,
};

export function ComparisonView({
  pair,
  initial,
  onNavigate,
}: {
  pair: PairSummary;
  initial?: { left: number[]; right: number[] };
  onNavigate?: (left: number[], right: number[]) => void;
}) {
  const [left, leftActions] = useSide(pair.left, pair.id, "rf", initial?.left);
  const [right, rightActions] = useSide(pair.right, pair.id, "rf", initial?.right);

  const leftHost = useRef<HTMLDivElement>(null);
  const rightHost = useRef<HTMLDivElement>(null);
  const handle = useRef<ComparisonHandle | null>(null);
  const [menu, setMenu] = useState<PendingMenu | null>(null);
  // What is selected in each panel. The menu acts on this when opened away
  // from a node, which is the interaction the library's selection operator is
  // there for: pick a node, then ask what can be done with it.
  const [selected, setSelected] = useState<[number | null, number | null]>([null, null]);
  /**
   * Sigma key → the backend's stored id, per panel.
   *
   * Built from the library's own node map on every render, because the key is
   * the library's to choose: it prefixes names (`named_10049`) and generates
   * `n47` for anything unnamed. Reconstructing that format here would be a
   * guess that silently stops matching the day it changes; the node map is the
   * library telling us directly, and `source.metadata` carries the id through
   * `prepareTree`'s cloning.
   */
  const keyToStoredId = useRef<[Map<string, number>, Map<string, number>]>([
    new Map(),
    new Map(),
  ]);

  // Read by the library's providers on every lookup, so they always see the
  // slice currently displayed rather than the one present at construction.
  const sides = useRef<[SideState, SideState]>([left, right]);
  sides.current = [left, right];

  const bothLoaded = Boolean(left.tree && right.tree);

  // --- build the panels, once ------------------------------------------
  useEffect(() => {
    if (!bothLoaded || handle.current) return;
    if (!leftHost.current || !rightHost.current) return;

    const built = createComparison([leftHost.current, rightHost.current], CONFIG, {
      trees: [sides.current[0].tree!.root, sides.current[1].tree!.root],
      onSelectionChange: (keys: string[], panelIndex: number) => {
        const key = keys[keys.length - 1];
        const storedId =
          key === undefined ? null : (keyToStoredId.current[panelIndex].get(key) ?? null);
        setSelected((current) => {
          const next: [number | null, number | null] = [...current];
          next[panelIndex] = storedId;
          return next;
        });
      },
      // The provider is handed the node as well as the key; the node carries
      // the backend's id, which is the only identifier both sides agree on.
      // Keying by name would break on the unnamed internal nodes that make up
      // most of a slice.
      valueFor: (_key: string, node) => {
        const storedId = node.metadata?.storedId;
        if (typeof storedId !== "number") return undefined;
        const [l, r] = sides.current;
        return l.gradient.similarityOf(storedId) ?? r.gradient.similarityOf(storedId);
      },
    });
    handle.current = built;

    const unsubscribe = built.panels.map((panel, index) => {
      const side = index as 0 | 1;
      const off = [
        // Rebuilt on every render: pruning and re-layout mint new keys.
        panel.viewer.events.on("render", ({ nodeMap }) => {
          const resolved = new Map<string, number>();
          for (const [key, layoutNode] of nodeMap) {
            const storedId = layoutNode.source.metadata?.storedId;
            if (typeof storedId === "number") resolved.set(key, storedId);
          }
          keyToStoredId.current[side] = resolved;
        }),
        panel.viewer.events.on("rightClickNode", ({ node, x, y, original }) => {
          // The emit is synchronous inside the DOM dispatch, so this still
          // suppresses the browser's own menu.
          original.preventDefault?.();
          setMenu({ side, at: { x, y }, storedId: keyToStoredId.current[side].get(node) });
        }),
        panel.viewer.events.on("rightClickStage", ({ x, y, original }) => {
          original.preventDefault?.();
          setMenu({ side, at: { x, y } });
        }),
      ];
      return () => off.forEach((fn) => fn());
    });

    return () => {
      unsubscribe.forEach((fn) => fn());
      built.destroy();
      handle.current = null;
    };
  }, [bothLoaded]);

  // --- replace contents on navigation -----------------------------------
  useEffect(() => {
    if (left.tree) handle.current?.panels[0]?.viewer.setTree(left.tree.root);
  }, [left.tree]);

  useEffect(() => {
    if (right.tree) handle.current?.panels[1]?.viewer.setTree(right.tree.root);
  }, [right.tree]);

  // Report where we are, so the URL names it and a refresh comes back here.
  useEffect(() => {
    onNavigate?.(left.path, right.path);
  }, [left.path, right.path, onNavigate]);

  const dismiss = useCallback(() => setMenu(null), []);

  // A menu opened on empty canvas still acts on the selected node, if there is
  // one — selecting and then right-clicking is the flow the menus were asked
  // for, and it is also the only way to reach a node too small to hit.
  const resolved: PendingMenu | null = menu
    ? { ...menu, storedId: menu.storedId ?? selected[menu.side] ?? undefined }
    : null;

  const items = resolved
    ? buildMenu(resolved, [left, right], [leftActions, rightActions])
    : [];

  return (
    <div className="comparison">
      <header className="comparison-bar">
        <Side label="Left" state={left} actions={leftActions} selected={selected[0]} />
        <Side label="Right" state={right} actions={rightActions} selected={selected[1]} />
      </header>

      <div className="panels">
        <Panel host={leftHost} state={left} />
        <Panel host={rightHost} state={right} />
      </div>

      {resolved ? (
        <ContextMenu
          at={resolved.at}
          title={menuTitle(resolved, [left, right])}
          items={items}
          onDismiss={dismiss}
        />
      ) : null}
    </div>
  );
}

function Panel({
  host,
  state,
}: {
  host: React.RefObject<HTMLDivElement | null>;
  state: SideState;
}) {
  return (
    <section className="panel">
      <div className="sigma-host" ref={host} />
      {state.loading ? <p className="panel-note">Loading slice…</p> : null}
      {state.error ? <p className="panel-note error">{state.error}</p> : null}
    </section>
  );
}

function Side({
  label,
  state,
  actions,
  selected,
}: {
  label: string;
  state: SideState;
  actions: SideActions;
  selected: number | null;
}) {
  const slice = state.slice;
  return (
    <div className="side-summary">
      <p className="side-name">
        {label}: <strong>{state.treeId}</strong>
        {selected !== null ? (
          <span className="selected-node"> · node {selected} selected</span>
        ) : null}
      </p>
      {slice ? (
        <p className="side-counts">
          {/* The claim, on screen: what is drawn against what it stands for. */}
          showing <strong>{slice.displayed_leaves.toLocaleString()}</strong> of{" "}
          {slice.total_leaves.toLocaleString()} leaves
          {slice.hidden_leaves > 0
            ? ` · ${slice.hidden_leaves.toLocaleString()} behind wedges`
            : null}
          {state.canGoBack ? ` · ${state.path.length} level(s) in` : null}
        </p>
      ) : null}
      {state.canGoBack ? (
        <button type="button" className="link-button" onClick={actions.reset}>
          Back to whole tree
        </button>
      ) : null}
    </div>
  );
}
