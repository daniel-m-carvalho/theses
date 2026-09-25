/**
 * What to call a tree or a comparison on screen.
 *
 * The ids are handles — `0603c72037c7` for an upload — and were shown as if
 * they were names: the list read "0603c72037c7 vs 1531dacf584f" while the name
 * typed at upload sat unused on the server. The id is the fallback only when
 * nothing was named, which is the one case where it is the honest answer.
 */

import type { DatasetsResponse, PairSummary } from "./api/types";

export function treeName(treeId: string, datasets: DatasetsResponse | null): string {
  const tree = datasets?.trees.find((candidate) => candidate.id === treeId);
  return tree?.display_name?.trim() || treeId;
}

export function pairName(pair: PairSummary, datasets: DatasetsResponse | null): string {
  return (
    pair.display_name?.trim() ||
    `${treeName(pair.left, datasets)} vs ${treeName(pair.right, datasets)}`
  );
}
