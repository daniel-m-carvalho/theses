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

export const DEFAULT_BUDGET = 400;

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
  valueFor: () => undefined,
  correspondingTo: () => undefined,
};

export function useSide(
  treeId: string,
  compare: string | undefined,
  metric = "rf",
): [SideState, SideActions] {
  const [path, setPath] = useState<number[]>([]);
  const [budget, setBudget] = useState(DEFAULT_BUDGET);
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
        const built = treeFromSlice(fetched);
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
  }, [treeId, root, budget, compare, metric, nonce]);

  const actions: SideActions = {
    focus: useCallback((storedId: number) => {
      setPath((current) =>
        current[current.length - 1] === storedId ? current : [...current, storedId],
      );
      setBudget(DEFAULT_BUDGET);
    }, []),

    back: useCallback(() => setPath((current) => current.slice(0, -1)), []),

    reset: useCallback(() => {
      setPath([]);
      setBudget(DEFAULT_BUDGET);
    }, []),

    setBudget,

    // "Expand all" is a budget large enough to hold every leaf under the
    // current root — the server then has nothing left to summarise.
    expandAll: useCallback(() => {
      setBudget(Math.max(DEFAULT_BUDGET, (slice?.total_leaves ?? 0) + 1));
    }, [slice]),

    collapseAll: useCallback(() => setBudget(2), []),

    reload: useCallback(() => setNonce((n) => n + 1), []),
  };

  return [
    {
      treeId,
      slice,
      tree,
      gradient,
      budget,
      loading,
      error,
      path,
      canGoBack: path.length > 0,
    },
    actions,
  ];
}
