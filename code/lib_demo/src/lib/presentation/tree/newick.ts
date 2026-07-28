import * as NewickParser from "newick";
import type { NewickNode } from "./types";
import { countLeaves } from "./model";

/**
 * Parse a Newick string into a {@link NewickNode} tree.
 *
 * Some inputs (goeBURST output) are a *forest*: many ';'-separated components
 * — real trees plus thousands of bare singleton STs — on a single line. The
 * `newick` parser only returns one tree, so we parse the components ourselves
 * and return the **largest** one (the dominant cluster). Single-tree inputs
 * (NJ / UPGMA) go through the same path unchanged.
 *
 * This function is pure (string in, tree out) — fetching/loading is the
 * application's concern, so the library stays project-agnostic.
 */
export function parseNewick(text: string): NewickNode {
  const components = text
    .split(";")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

  let best: NewickNode | null = null;
  let bestLeaves = -1;

  for (const component of components) {
    if (!component.includes("(")) continue; // skip singleton STs
    let tree: NewickNode;
    try {
      tree = NewickParser.parse(`${component};`) as NewickNode;
    } catch {
      continue; // ignore unparseable fragments
    }
    const leaves = countLeaves(tree);
    if (leaves > bestLeaves) {
      bestLeaves = leaves;
      best = tree;
    }
  }

  if (best) return best;

  // No clade found (degenerate input): parse the whole thing as-is.
  const parsed = NewickParser.parse(text);
  const tree = (Array.isArray(parsed) ? parsed[0] : parsed) as NewickNode | undefined;
  if (!isUsableTree(tree)) {
    throw new Error("No tree found in Newick input");
  }
  return tree;
}

/**
 * Guard against the parser's degenerate success: on empty or unparseable input
 * it returns `{}` — truthy, so a plain null-check passes it through, and the
 * `as NewickNode` cast hides that it lacks even a `name`. Rendering that yields
 * a single blank tip: a failed backend response would look like a legitimate
 * one-node tree instead of an error. A usable tree needs at least a name (a lone
 * leaf, `"a;"`) or children.
 */
function isUsableTree(tree: NewickNode | undefined): tree is NewickNode {
  if (!tree) return false;
  const hasName = typeof tree.name === "string" && tree.name.trim() !== "";
  return hasName || !!tree.branchset?.length;
}
