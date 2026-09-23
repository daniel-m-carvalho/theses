/**
 * What the right-click menu offers, given where it was opened.
 *
 * Separated from the view so the rules can be tested without a renderer — the
 * interesting part of a context menu is not how it is drawn but *what it
 * offers and why*, and that is decided here.
 *
 * Two conventions:
 *
 * - An item is **omitted** when it could never apply where the menu was
 *   opened (node actions on empty canvas), and **shown with a reason** when it
 *   applies but cannot run right now. "This is not a thing here" and "not yet"
 *   are different answers and a menu that conflates them teaches nothing.
 * - An item names its subject where it can — "8,441 leaves", "no corresponding
 *   clade" — because a menu attached to a node knows which node, and a sidebar
 *   of buttons never does.
 */

import type { MenuItem, MenuPosition } from "../menu/ContextMenu";
import { DEFAULT_BUDGET, EXPAND_ALL_LIMIT, type SideActions, type SideState } from "./useSide";

export interface PendingMenu {
  side: 0 | 1;
  at: MenuPosition;
  /**
   * The backend's id for the node, or undefined when the menu was opened away
   * from one.
   *
   * Resolved before it gets here, through the library's own node map. An
   * earlier version passed the Sigma key and looked it up by name, which was
   * wrong twice: the library prefixes keys (`named_10049`) and generates its
   * own (`n47`) for anything unnamed, so the lookup missed and every node
   * menu said "this node has no server id".
   */
  storedId?: number;
}

export function menuTitle(menu: PendingMenu, states: [SideState, SideState]): string {
  const state = states[menu.side];
  if (menu.storedId === undefined) return `${state.treeId} — view`;
  const node = state.tree?.byStoredId.get(menu.storedId);
  const leaves = node ? state.tree?.trueLeafCountOf(node) : undefined;
  const label = (node?.metadata?.label as string) || "";
  const named = label && label !== "_" ? label : "unnamed clade";
  return leaves && leaves > 1 ? `${named} — ${leaves.toLocaleString()} leaves` : named;
}

export function buildMenu(
  menu: PendingMenu,
  states: [SideState, SideState],
  actions: [SideActions, SideActions],
): MenuItem[] {
  const here = states[menu.side];
  const act = actions[menu.side];
  const otherSide = (menu.side === 0 ? 1 : 0) as 0 | 1;
  const there = states[otherSide];
  const actThere = actions[otherSide];
  const items: MenuItem[] = [];

  if (menu.storedId !== undefined && here.tree) {
    const storedId = menu.storedId;
    const node = here.tree.byStoredId.get(storedId);
    const leaves = node ? (here.tree.trueLeafCountOf(node) ?? 0) : 0;
    const isWedge = here.tree.truncated.has(storedId);
    const alreadyHere = here.path[here.path.length - 1] === storedId;

    items.push({
      label: isWedge ? "Expand this clade" : "Focus this subtree",
      detail: leaves > 1 ? `${leaves.toLocaleString()} leaves — fetches a new slice` : undefined,
      disabledBecause:
        !node
          ? "this node is not in the current slice"
          : leaves <= 1
            ? "a single leaf has nothing to expand"
            : alreadyHere
              ? "already showing this subtree"
              : undefined,
      onSelect:
        !node || leaves <= 1 || alreadyHere ? undefined : () => act.focus(storedId),
    });

    // The correspondence is what a comparison is for: the same clade, located
    // in the other tree. Computed once per pair on the server, so this is a
    // lookup rather than a search.
    const partner = here.gradient.correspondingTo(storedId);
    items.push({
      label: "Show the matching clade on the other side",
      detail: partner !== undefined ? `node ${partner} in ${there.treeId}` : undefined,
      disabledBecause:
        partner === undefined ? "no corresponding clade in the other tree" : undefined,
      onSelect: partner === undefined ? undefined : () => actThere.focus(partner),
    });
  }

  const total = here.slice?.total_leaves ?? 0;
  const tooLarge = total > EXPAND_ALL_LIMIT;
  items.push({
    label: "Expand all",
    separated: items.length > 0,
    detail: total && !tooLarge ? `${total.toLocaleString()} leaves` : undefined,
    // Not a limit of the server — it answers fine — but of the browser, which
    // is the thing being measured. Asking for every leaf of a 500k-leaf tree
    // reproduces exactly the failure this design exists to avoid.
    disabledBecause: tooLarge
      ? `too large — ${total.toLocaleString()} leaves would overwhelm the browser`
      : undefined,
    onSelect: tooLarge ? undefined : act.expandAll,
  });

  items.push({
    label: "Collapse all",
    detail: "summarise this subtree to its shape",
    onSelect: act.collapseAll,
  });

  items.push({
    label: "Go back",
    separated: true,
    detail: here.canGoBack ? `one level out of ${here.path.length}` : undefined,
    disabledBecause: here.canGoBack ? undefined : "already at the whole tree",
    onSelect: here.canGoBack ? act.back : undefined,
  });

  const atOriginal = !here.canGoBack && here.budget === DEFAULT_BUDGET;
  items.push({
    label: "Reset to the whole tree",
    disabledBecause: atOriginal ? "already showing it" : undefined,
    onSelect: atOriginal ? undefined : act.reset,
  });

  return items;
}
