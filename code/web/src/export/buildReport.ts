/**
 * PhyloDelta's API, in the terms the library's report builder speaks.
 *
 * All this does is translate. What a comparison report *says* — its sections,
 * its wording, what the colours mean — lives in `phylo-tree-viewer`, because
 * the panels, the gradient, the wedges and the bars are all drawn there.
 *
 * What stays here is the one thing the library must not know: the shape of
 * this backend's JSON. `ComparisonSummary` and `PairSummary` are a wire
 * contract, and a library that accepted them would be reusable only by the
 * server that produces them.
 */

import {
  downloadComparisonReport,
  type ComparisonReportInput,
  type ReportFormat,
} from "phylo-tree-viewer";
import type { ComparisonSummary, PairSummary } from "../api/types";

export interface ReportInput {
  pair: PairSummary;
  /** What to call each tree in the captions; the ids otherwise. */
  names?: { left: string; right: string };
  summary: ComparisonSummary | null;
  title: string;
  images: { left?: string; right?: string };
  /** What each panel is currently showing, for the captions. */
  showing: { left: string; right: string };
  typing?: { columns: string[]; scale: string } | null;
  gradient: boolean;
  /** Which of the two the gradient was drawn on. */
  gradientOn?: "branches" | "clades";
  /** Category colour assignments, so the report can name each one. */
  swatches?: ReadonlyMap<string, string>;
  /** The two ends of the divergence scale, as drawn. */
  gradientEnds?: { identical: string; diverged: string };
  /** Set when the panels held branches with no value at all. */
  absent?: { label: string; color: string };
}

export function toReportInput(input: ReportInput): ComparisonReportInput {
  const { pair, summary } = input;
  return {
    title: input.title,
    panels: [
      { label: input.names?.left ?? pair.left, image: input.images.left, showing: input.showing.left },
      { label: input.names?.right ?? pair.right, image: input.images.right, showing: input.showing.right },
    ],
    metric: summary ? { name: summary.metric, scalars: summary.summary } : null,
    reconciliation: summary
      ? {
          sharedLeaves: summary.shared_leaves,
          droppedFromLeft: summary.dropped_from_left.length,
          droppedFromRight: summary.dropped_from_right.length,
          labelMatch: pair.label_match,
          sameSpecies: summary.same_species,
        }
      : null,
    caution: summary?.caution ?? null,
    view: {
      gradient: input.gradient,
      gradientOn: input.gradientOn,
      typing: input.typing ?? null,
      legend: [...(input.swatches ?? [])].map(([label, color]) => ({ label, color })),
      gradientEnds: input.gradientEnds,
      absent: input.absent,
    },
    footnotes: [
      // The one caveat the library cannot know: these numbers came from a
      // server that saw the whole tree, not from the summary on screen.
      "Produced by PhyloDelta. Distances are computed on the server over the whole tree, not over the summary shown here.",
    ],
  };
}

export function exportReport(
  input: ReportInput,
  filename: string,
  format: ReportFormat = "html",
): Promise<void> {
  return downloadComparisonReport(toReportInput(input), filename, format);
}
