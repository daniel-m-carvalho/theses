/**
 * A report on a side-by-side comparison.
 *
 * This is the library's business, not an application's: the panels, the
 * divergence gradient, the wedges and the bar charts are all drawn here, so
 * describing them in a document is the same job as drawing the legend beside
 * them. An app that shows a comparison with this library should not have to
 * write, or rewrite, what a comparison report says.
 *
 * What it deliberately does **not** take is any server's response shape. The
 * input below is in domain terms — shared leaves, dropped leaves, metric
 * scalars — and it is the consumer's job to translate its own API into them.
 * Accepting one backend's JSON here would make the library reusable only by
 * that backend.
 */

import { renderReport, type Report, type ReportSwatch } from "./report";

export interface ComparisonPanel {
  /** What the tree is called. */
  label: string;
  /** A data URI, typically from {@link snapshotViewer}. */
  image?: string;
  /** What it is currently showing, e.g. "showing 50 of 17,645 leaves". */
  showing?: string;
}

export interface ComparisonMetric {
  /** The metric's name, e.g. "rf". */
  name: string;
  /**
   * Whatever scalars it reports. Free-form because metrics differ: a distance
   * may report one number or six, and a report that fixed the set would
   * silently drop whatever a new metric added.
   */
  scalars: Record<string, number | string>;
}

export interface ComparisonReconciliation {
  sharedLeaves: number;
  droppedFromLeft: number;
  droppedFromRight: number;
  /** How leaves were matched, e.g. "identity". */
  labelMatch?: string;
  /** Null means it could not be checked, which is not the same as "no". */
  sameSpecies?: boolean | null;
}

export interface ComparisonView {
  /** Whether divergence colouring was on at all. */
  gradient: boolean;
  /**
   * Where that colour was drawn — on the branch into each clade, or on the
   * collapsed clade's own wedge. The reader is looking at a picture and cannot
   * tell which carries the value, so the report has to say.
   */
  gradientOn?: "branches" | "clades";
  /** Per-leaf bars, when shown. */
  typing?: {
    columns: string[];
    scale: string;
  } | null;
  /** Category colours, so the reader can name what is on the leaves. */
  legend?: ReportSwatch[];
  /** The two ends of the divergence scale, as drawn. */
  gradientEnds?: { identical: string; diverged: string };
}

export interface ComparisonReportInput {
  title: string;
  subtitle?: string;
  panels: [ComparisonPanel, ComparisonPanel];
  metric?: ComparisonMetric | null;
  reconciliation?: ComparisonReconciliation | null;
  /** Shown set apart, where the matching is suspect. */
  caution?: string | null;
  view?: ComparisonView;
  footnotes?: string[];
  generated?: Date;
}

const count = (value: number) => value.toLocaleString();

export function buildComparisonReport(input: ComparisonReportInput): Report {
  const [left, right] = input.panels;
  const sections: Report["sections"] = [];

  const images = [left, right]
    .filter((panel) => panel.image)
    .map((panel) => ({
      src: panel.image!,
      caption: panel.showing ? `${panel.label} — ${panel.showing}` : panel.label,
    }));

  if (images.length) {
    sections.push({
      heading: "Panels",
      body: [
        // Said plainly, because a reader cannot tell it from the picture:
        // these are summaries, and a triangle is a clade never opened.
        "Each panel shows a summary of its tree, not the whole of it. A triangle is a clade that was not expanded, sized by how many leaves it stands for.",
      ],
      images,
    });
  }

  if (input.metric) {
    sections.push({
      heading: `Distance (${input.metric.name})`,
      fields: Object.entries(input.metric.scalars).map(([name, value]) => ({
        label: name.replace(/_/g, " "),
        value: typeof value === "number" ? count(value) : String(value),
      })),
    });
  }

  if (input.reconciliation) {
    const { sharedLeaves, droppedFromLeft, droppedFromRight } = input.reconciliation;
    const dropped = droppedFromLeft + droppedFromRight;
    const sameSpecies = input.reconciliation.sameSpecies;
    sections.push({
      heading: "Additional metric information",
      fields: [
        { label: "Shared leaves", value: count(sharedLeaves) },
        {
          label: "Dropped to reconcile",
          value: count(dropped),
          note: dropped
            ? `${count(droppedFromLeft)} from ${left.label}, ${count(droppedFromRight)} from ${right.label}`
            : "the two trees have the same leaves",
        },
        ...(input.reconciliation.labelMatch
          ? [{ label: "Leaf matching", value: input.reconciliation.labelMatch }]
          : []),
        ...(sameSpecies !== undefined
          ? [
              {
                label: "Same species",
                value: sameSpecies === null ? "not declared" : sameSpecies ? "yes" : "no",
                note:
                  sameSpecies === null
                    ? "neither tree declared one, so this could not be checked"
                    : undefined,
              },
            ]
          : []),
      ],
      caution: input.caution ?? undefined,
    });
  }

  if (input.view) {
    sections.push(viewSetup(input.view));
  }

  return {
    title: input.title,
    subtitle: input.subtitle ?? `${left.label} vs ${right.label}`,
    generated: input.generated,
    sections,
    footnotes: input.footnotes,
  };
}

/**
 * What every colour on the pictures means.
 *
 * Without this the report carries two trees in a handful of colours and no way
 * to learn what any of them is: the reader can see that two clades differ and
 * not what the difference is.
 */
function viewSetup(view: ComparisonView): Report["sections"][number] {
  const body: string[] = [];
  const swatches: ReportSwatch[] = [];

  if (view.gradient) {
    body.push(
      view.gradientOn === "clades"
        ? "Each collapsed clade's wedge is coloured by how much the two trees disagree at that clade. Branch colour carries no meaning here."
        : "Branches are coloured by how much the two trees disagree at the clade they lead into.",
    );
    swatches.push(
      {
        label: "identical — the same clade in both trees",
        color: view.gradientEnds?.identical ?? "#1d4ed8",
      },
      {
        label: "diverged — no counterpart in the other tree",
        color: view.gradientEnds?.diverged ?? "#ffd400",
      },
    );
  } else {
    body.push("Divergence colouring was off: branch colour carries no meaning here.");
  }

  if (view.typing?.columns.length) {
    body.push(
      `Each leaf carries a bar of its isolates, coloured by ${view.typing.columns.join(", ")}, on a ${view.typing.scale} scale. A leaf with no bar has no typing data.`,
    );
    if (view.typing.columns.length > 1) {
      // The one thing a reader of the picture could not work out, and would
      // otherwise misread as "this leaf has more isolates".
      body.push(
        `Each isolate is counted once per column, so bar lengths are ${view.typing.columns.length}× the isolate count. They remain comparable between leaves.`,
      );
    }
    swatches.push(...(view.legend ?? []));
  } else {
    body.push("Typing data was not shown, so the leaves carry no bars.");
  }

  return { heading: "View setup", body, swatches };
}

/** Build the document and hand it to the browser as a download. */
export function downloadComparisonReport(
  input: ComparisonReportInput,
  filename: string,
): void {
  const blob = new Blob([renderReport(buildComparisonReport(input))], {
    type: "text/html;charset=utf-8",
  });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  // Revoked on the next tick: revoking synchronously can cancel the download
  // in some browsers before they have read the blob.
  setTimeout(() => URL.revokeObjectURL(url), 1_000);
}
