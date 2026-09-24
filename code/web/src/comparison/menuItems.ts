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
 * How much of the other tree a jump should land in.
 *
 * Not a display preference — it is what stops the jump resolving to a tip.
 * Correspondence picks the node with the highest Jaccard overlap and puts no
 * floor on its size, so a 2-leaf clade `{a, b}` matches the bare leaf `{a}` at
 * 0.5, and nothing in a dissimilar tree beats that. Asking from a clade of
 * this many leaves caps a single-leaf match at 1/20, which no real counterpart
 * loses to.
 */
export const JUMP_CONTEXT_LEAVES = 20;

/**
 * Where to send the other panel when a leaf is located in it.
 *
 * Its **enclosing clade**, not the leaf itself. Rooting a panel at a single
 * leaf is technically what was asked for and useless in practice: the panel
 * became one dot, with every bit of the context you were comparing against
 * gone.
 *
 * Asking from the leaf's immediate parent was not enough. The target is chosen
 * by overlap, and overlap with a two-leaf clade is maximised by a *tip* as
 * often as by a clade — measured on clostridium vs vibrio, leaf `15462`'s
 * parent `{11633, 15462}` corresponded to the lone leaf `15462`, and the panel
 * became one dot again. So climb the source side first: Jaccard divides by the
 * union, so the larger the clade asking, the worse a tip scores, and by
 * {@link JUMP_CONTEXT_LEAVES} it cannot win.
 *
 * The climb happens **here**, not in the other tree, because the other tree is
 * only present as its current slice — an arbitrary node's ancestors are not
 * known on this side. The ancestors of a displayed leaf are.
 *
 * Returns the match of the largest clade that has one, so a jump gives as much
 * context as the data allows and still answers when only the tip corresponds.
 */
export function jumpTargetFor(side: SideState, leafStoredId: number): number | undefined {
  const tree = side.tree;
  if (!tree) return undefined;

  // The leaf and its ancestors, innermost first, up to the first one large
  // enough — or to the slice root, whichever comes first.
  const chain: number[] = [leafStoredId];
  let at: number | undefined = leafStoredId;
  while (at !== undefined) {
    const node = tree.byStoredId.get(at);
    if (node && (tree.trueLeafCountOf(node) ?? 1) >= JUMP_CONTEXT_LEAVES) break;
    at = tree.parentOfStoredId.get(at);
    if (at !== undefined) chain.push(at);
  }

  // Outermost first: the widest view the correspondence can actually support.
  for (let i = chain.length - 1; i >= 0; i -= 1) {
    const partner = side.gradient.correspondingTo(chain[i]);
    if (partner !== undefined) return partner;
  }
  return undefined;
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
      onSelect: partner === undefined ? undefined : () => actThere.focus(partner),
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
