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
import { EXPAND_ALL_LIMIT, type SideActions, type SideState } from "./useSide";

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

/**
 * Which node in the other tree a leaf points at.
 *
 * The leaf's **own** counterpart, which is exact: leaves correspond by label,
 * so this is the same sequence type and not a guess. An earlier version asked
 * from the leaf's parent instead, on the theory that a clade gives more to
 * look at — but a clade corresponds by best overlap, which is an
 * approximation, and a two-leaf cherry `{a, b}` overlaps the bare leaf `{a}`
 * at 0.5, which nothing beats where the trees disagree. It resolved to a tip
 * anyway, and traded exactness for nothing.
 *
 * Note this returns a **tip**, and a panel rooted at a tip is one dot. Making
 * it worth looking at is {@link SideActions.focusWithContext}'s job, on the
 * receiving side: how much context fits is a property of that panel, and the
 * ancestors of a node it has not sliced are known only to the server.
 */
export function jumpTargetFor(side: SideState, leafStoredId: number): number | undefined {
  return side.gradient.correspondingTo(leafStoredId);
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

    // Only for a leaf. A leaf is matched by its label, which is exact — the
    // same sequence type in both trees. A clade is matched by best overlap,
    // which is an approximation: the corresponding "clade" may share most of
    // its leaves or almost none, and offering to jump to it presents a guess
    // as a location. Where the two trees disagree — which is the whole reason
    // to look — the guess is worst.
    const isLeaf = here.tree.leaves.has(storedId);
    const partner = isLeaf ? jumpTargetFor(here, storedId) : undefined;
    items.push({
      label: "Find this leaf in the other tree",
      detail:
        partner !== undefined ? `shows its clade in ${there.treeId}` : undefined,
      disabledBecause: !isLeaf
        ? "only leaves can be located exactly; a clade is matched by overlap"
        : partner === undefined
          ? "this leaf is not in the other tree"
          : undefined,
      onSelect:
        partner === undefined ? undefined : () => actThere.focusWithContext(partner),
    });
  }

  // Everything below acts on the view rather than on a node, so a menu opened
  // on a clade or a leaf offers none of it: that menu is about the thing under
  // the cursor, and nothing else.
  if (menu.storedId !== undefined) return items;

  const total = here.slice?.total_leaves ?? 0;
  const tooLarge = total > EXPAND_ALL_LIMIT;
  items.push({
    label: "Expand all",
    detail: total && !tooLarge ? `${total.toLocaleString()} leaves` : undefined,
    // Not a limit of the server — it answers fine — but of the browser, which
    // is the thing being measured. Asking for every leaf of a 500k-leaf tree
    // reproduces the failure this design exists to avoid.
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

  const atOriginal = !here.canGoBack && here.budget === here.autoBudget;
  items.push({
    label: "Reset to the whole tree",
    disabledBecause: atOriginal ? "already showing it" : undefined,
    onSelect: atOriginal ? undefined : act.reset,
  });

  return items;
}
