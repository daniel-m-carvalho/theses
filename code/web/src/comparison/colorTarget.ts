/**
 * Where the divergence gradient is drawn.
 *
 * Two readings of the same number, not two numbers. A per-clade metric is
 * defined on the clade; the branch leading into it is where the disagreement
 * shows as a *path*, which is how phylo.io draws it and how it reads when much
 * of the tree is expanded. On a heavily summarised view, though, most of what
 * is on screen is wedges, and a colour on the wedge puts the value on the thing
 * it describes.
 *
 * Kept out of `ComparisonView` so the header can offer the choice without
 * importing the view.
 */
export type ColorTarget = "branches" | "clades";

export const COLOR_TARGETS: ReadonlyArray<{
  key: ColorTarget;
  label: string;
  note: string;
}> = [
  { key: "branches", label: "Branches", note: "colour the branch into each clade" },
  { key: "clades", label: "Clades", note: "colour the wedge itself" },
];
