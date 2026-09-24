/**
 * One side of a comparison, and how it navigates.
 *
 * **The server summarises; the client navigates by re-rooting.** A slice is a
 * subtree reduced to a leaf budget, so going deeper is not "reveal what is
 * already loaded" — it is another request, rooted at the node the user chose.
 * That is the whole point: a 500k-leaf tree is never in the browser, only ever
 * a few hundred nodes standing in for it.
 *
 * Navigation is therefore a **stack of root ids**. Focusing pushes, going back
 * pops, resetting clears. `budget` is the second dimension: raising it shows
 * more of the current subtree without moving, which is what "expand all" means
 * on a tree small enough to afford it.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { api, ApiError } from "../api/client";
import type { TreeSlice } from "../api/types";
import { gradientFrom, type Gradient } from "../tree/comparisonValues";
import { treeFromSlice, type SliceTree } from "../tree/fromSlice";

/**
 * Roughly how many vertical pixels one displayed tip needs to be legible.
 *
 * A slice's tips are mostly **wedges**, not leaves — at this budget the vibrio
 * pair shows 19 real leaves and 31 collapsed clades — so this is really the
 * row spacing of the view, and the wedge height is derived from it
 * (`ComparisonView`). Fourteen leaves room for a triangle that can be told
 * apart from its neighbours and still aimed at with a mouse.
 *
 * Six is where the staircase of a ladder-shaped tree stays visible as
 * separate steps. Below about three, adjacent leaves merge: the terminals —
 * which the cladogram pins to a single column — fuse into a solid bar, and
 * the structure between them turns into a block of colour. That is what a
 * fixed budget of 400 produced in a 700px panel (1.7px per leaf), and it is
 * why the trees looked like a smear rather than a tree.
 */
export const PIXELS_PER_LEAF = 14;

/** Used before a panel has been measured, and as the floor for a tiny window. */
export const DEFAULT_BUDGET = 120;

/** Budgets are rounded to this, so small resizes do not each cost a request. */
const BUDGET_STEP = 25;

/**
 * How many leaves this panel can actually draw.
 *
 * Asking the server for more detail than the client can render is the failure
 * this project is about, in miniature: the request succeeds, the bytes
 * arrive, and the picture is worse. The budget is a property of the viewport,
 * not a constant.
 */
export function readableBudget(panelHeightPx: number): number {
  // Zero means "not measured yet", and the caller waits rather than guessing:
  // fetching at a placeholder budget and again at the real one is two slices
  // per panel on every load, for a picture nobody sees.
  if (!panelHeightPx) return 0;
  const fits = Math.max(40, Math.min(600, Math.floor(panelHeightPx / PIXELS_PER_LEAF)));
  // Quantised, so the few pixels a layout shifts by while settling — or a
  // window nudged by a scrollbar — do not each cost a slice. Observed: the
  // panel measured 600px then 577px on load, and the difference between 100
  // leaves and 96 is invisible, but it was a second request for both trees.
  return Math.round(fits / BUDGET_STEP) * BUDGET_STEP;
}

/**
 * Above this, "expand all" is not offered.
 *
 * Not a guess about the server — it answers fine — but about the browser,
 * which is the thing this project is measuring. Asking for every leaf of a
 * 500k-leaf tree would reproduce exactly the failure this design exists to
 * avoid.
 */
export const EXPAND_ALL_LIMIT = 5_000;

export interface SideState {
  treeId: string;
  slice: TreeSlice | null;
  tree: SliceTree | null;
  gradient: Gradient;
  budget: number;
  /** What the viewport allows; `budget` differs once the user overrides it. */
  autoBudget: number;
  loading: boolean;
  error: string | null;
  /** Root ids visited, oldest first. The last entry is where we are. */
  path: number[];
  canGoBack: boolean;
}

export interface SideActions {
  focus: (storedId: number) => void;
  back: () => void;
  reset: () => void;
  setBudget: (budget: number) => void;
  expandAll: () => void;
  collapseAll: () => void;
  reload: () => void;
}

const NO_GRADIENT: Gradient = {
  similarityOf: () => undefined,
  correspondingTo: () => undefined,
};

export function useSide(
  treeId: string,
  compare: string | undefined,
  metric = "rf",
  initialPath: number[] = [],
  autoBudget: number = DEFAULT_BUDGET,
  labelClades: boolean = false,
): [SideState, SideActions] {
  const [path, setPath] = useState<number[]>(initialPath);

  // Follow the URL when it changes underneath us — a Back press, or a link
  // pasted into the bar. Guarded by a content comparison, because the URL is
  // also written *from* this state: without that, every navigation would
  // round-trip through the address bar and set the state it came from.
  const wanted = initialPath.join(",");
  useEffect(() => {
    setPath((current) => (current.join(",") === wanted ? current : wanted ? wanted.split(",").map(Number) : []));
  }, [wanted]);
  const [budget, setBudget] = useState(autoBudget);
  // Follows the viewport until the user overrides it with expand/collapse all.
  const [overridden, setOverridden] = useState(false);

  useEffect(() => {
    if (!overridden) setBudget(autoBudget);
  }, [autoBudget, overridden]);
  const [slice, setSlice] = useState<TreeSlice | null>(null);
  const [tree, setTree] = useState<SliceTree | null>(null);
  const [gradient, setGradient] = useState<Gradient>(NO_GRADIENT);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);

  // The root currently displayed; undefined means "the tree's own root",
  // which is what the API assumes when `root` is omitted.
  const root = path.length ? path[path.length - 1] : undefined;
  const latest = useRef(0);

  useEffect(() => {
    // Nothing to ask for until the panel has been measured.
    if (budget <= 0) return;
    // Navigation is faster than the network, so a slow earlier request must
    // not overwrite a newer one. Both guards matter: abort stops the work,
    // the sequence number stops a response that already escaped.
    const controller = new AbortController();
    const ticket = ++latest.current;
    setLoading(true);
    setError(null);

    api
      .slice(treeId, { root, budget, compare, metric, signal: controller.signal })
      .then((fetched) => {
        if (ticket !== latest.current) return;
        const built = treeFromSlice(fetched, { labelClades });
        setSlice(fetched);
        setTree(built);
        setGradient(gradientFrom(built, fetched.comparison));
        setLoading(false);
      })
      .catch((failed: unknown) => {
        if (ticket !== latest.current || controller.signal.aborted) return;
        setError(
          failed instanceof ApiError
            ? `${failed.message}${failed.hint ? ` — ${failed.hint}` : ""}`
            : String(failed),
        );
        setLoading(false);
      });

    return () => controller.abort();
    // `labelClades` only changes a node's display name, so the slice itself is
    // unchanged — but the tree handed to the viewer must be rebuilt for the
    // new names to reach it.
  }, [treeId, root, budget, compare, metric, nonce, labelClades]);

  const actions: SideActions = {
    focus: useCallback((storedId: number) => {
      setPath((current) =>
        current[current.length - 1] === storedId ? current : [...current, storedId],
      );
      setOverridden(false);
      setBudget(autoBudget);
    }, [autoBudget]),

    back: useCallback(() => setPath((current) => current.slice(0, -1)), []),

    reset: useCallback(() => {
      setPath([]);
      setOverridden(false);
      setBudget(autoBudget);
    }, [autoBudget]),

    setBudget,

    // "Expand all" is a budget large enough to hold every leaf under the
    // current root — the server then has nothing left to summarise.
    expandAll: useCallback(() => {
      setOverridden(true);
      setBudget(Math.max(autoBudget, (slice?.total_leaves ?? 0) + 1));
    }, [slice, autoBudget]),

    collapseAll: useCallback(() => {
      setOverridden(true);
      setBudget(2);
    }, []),

    reload: useCallback(() => setNonce((n) => n + 1), []),
  };

  return [
    {
      treeId,
      slice,
      tree,
      gradient,
      budget,
      autoBudget,
      loading,
      error,
      path,
      canGoBack: path.length > 0,
    },
    actions,
  ];
}
