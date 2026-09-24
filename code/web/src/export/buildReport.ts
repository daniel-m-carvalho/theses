/**
 * Turning a comparison on screen into a report.
 *
 * The library builds the document and knows nothing about phylogenetics; this
 * decides what goes in one. The split matters more than it looks: the report
 * builder takes headings, fields and images, so a second kind of report — a
 * single tree, a batch of comparisons — needs no library change.
 *
 * **What is included is chosen, not dumped.** The two pictures are the
 * argument; the numbers are what make them checkable. Reconciliation counts
 * and the species caution are in because without them the distance is not
 * interpretable: a Robinson-Foulds figure computed over 17,645 shared leaves
 * after dropping one, between trees whose species was never declared, is a
 * different claim from the same number over a verified same-species pair.
 */

import { renderReport, type Report } from "phylo-tree-viewer";
import type { ComparisonSummary, PairSummary } from "../api/types";

export interface ReportInput {
  pair: PairSummary;
  summary: ComparisonSummary | null;
  title: string;
  images: { left?: string; right?: string };
  /** What each panel is currently showing, for the captions. */
  showing: { left: string; right: string };
  typing?: { columns: string[]; scale: string } | null;
  gradient: boolean;
}

const count = (value: number) => value.toLocaleString();

export function buildReport(input: ReportInput): Report {
  const { pair, summary } = input;
  const sections: Report["sections"] = [];

  const images = [
    input.images.left ? { src: input.images.left, caption: `${pair.left} — ${input.showing.left}` } : null,
    input.images.right ? { src: input.images.right, caption: `${pair.right} — ${input.showing.right}` } : null,
  ].filter((image): image is { src: string; caption: string } => image !== null);

  if (images.length) {
    sections.push({
      heading: "The trees, as shown",
      body: [
        // Said plainly, because a reader cannot tell from the picture: these
        // are summaries, and a triangle is a clade that was never opened.
        "Each panel shows a summary of its tree, not the whole of it. A triangle is a clade that was not expanded, sized by how many leaves it stands for.",
      ],
      images,
    });
  }

  if (summary) {
    const fields = Object.entries(summary.summary).map(([name, value]) => ({
      label: name.replace(/_/g, " "),
      value: typeof value === "number" ? count(value) : String(value),
    }));
    sections.push({
      heading: `Distance (${summary.metric})`,
      fields,
    });

    const dropped = summary.dropped_from_left.length + summary.dropped_from_right.length;
    sections.push({
      heading: "What the distance was computed over",
      body: [
        "A metric can only see leaves both trees have, so the pair is first restricted to the leaves they share.",
      ],
      fields: [
        { label: "Shared leaves", value: count(summary.shared_leaves) },
        {
          label: "Dropped to reconcile",
          value: count(dropped),
          note: dropped
            ? `${count(summary.dropped_from_left.length)} from ${pair.left}, ${count(summary.dropped_from_right.length)} from ${pair.right}`
            : "the two trees have the same leaves",
        },
        { label: "Leaf matching", value: pair.label_match },
        {
          label: "Same species",
          value:
            summary.same_species === null
              ? "not declared"
              : summary.same_species
                ? "yes"
                : "no",
          note:
            summary.same_species === null
              ? "neither tree declared one, so this could not be checked"
              : undefined,
        },
      ],
      caution: summary.caution ?? undefined,
    });
  }

  const settings: string[] = [
    `Divergence colouring ${input.gradient ? "on" : "off"}`,
  ];
  if (input.typing?.columns.length) {
    settings.push(
      `Typing data coloured by ${input.typing.columns.join(", ")}, bars on a ${input.typing.scale} scale`,
    );
    if (input.typing.columns.length > 1) {
      // The one thing a reader of the picture could not work out, and would
      // otherwise misread as "this leaf has twice as many isolates".
      settings.push(
        `Each isolate is counted once per column, so bar lengths are ${input.typing.columns.length}× the isolate count. They remain comparable between leaves.`,
      );
    }
  } else {
    settings.push("Typing data not shown");
  }

  return {
    title: input.title,
    subtitle: `${pair.left} vs ${pair.right}`,
    sections: [...sections, { heading: "How this view was set up", body: settings }],
    footnotes: [
      "Produced by PhyloDelta. Distances are computed on the server over the whole tree, not over the summary shown here.",
    ],
  };
}

/** Build the document and hand it to the browser as a download. */
export function downloadReport(report: Report, filename: string): void {
  const blob = new Blob([renderReport(report)], { type: "text/html;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  // Revoked on the next tick: revoking synchronously can cancel the download
  // in some browsers before it has read the blob.
  setTimeout(() => URL.revokeObjectURL(url), 1_000);
}
