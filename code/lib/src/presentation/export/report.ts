/**
 * Building a report document.
 *
 * Deliberately knows nothing about phylogenetics. It is handed a title, some
 * sections, some images and some labelled values, and returns a self-contained
 * HTML document — what goes in it is the application's business, the same
 * split the rest of this library keeps.
 *
 * HTML rather than PDF: a browser already prints it, it embeds its images as
 * data URIs so the file travels alone, and it can be opened and edited by
 * anyone. A PDF writer would be a dependency and a rasterisation step for a
 * document that is mostly text.
 */

export interface ReportField {
  label: string;
  value: string;
  /** Shown smaller under the value — a unit, a caveat, a derivation. */
  note?: string;
}

export interface ReportSwatch {
  label: string;
  /** Any CSS colour. Shown as a chip beside the label. */
  color: string;
}

export interface ReportImage {
  /** A data URI, so the document stays self-contained. */
  src: string;
  caption?: string;
}

export interface ReportSection {
  heading: string;
  /** Paragraphs, before anything else in the section. */
  body?: string[];
  fields?: ReportField[];
  /**
   * A legend. Without one, a reader of the pictures can see that two clades
   * are different colours and has no way to learn what either colour means.
   */
  swatches?: ReportSwatch[];
  images?: ReportImage[];
  /** Set apart and emphasised — a caveat the reader must not skim past. */
  caution?: string;
}

export interface Report {
  title: string;
  subtitle?: string;
  /** Defaults to now. Passed in so a test can pin it. */
  generated?: Date;
  sections: ReportSection[];
  /** Small print at the end: provenance, versions, how it was made. */
  footnotes?: string[];
}

/** Escape text for HTML. Everything user-supplied goes through this. */
function escape(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function renderFields(fields: ReportField[]): string {
  return (
    `<dl class="fields">` +
    fields
      .map(
        (field) =>
          `<div><dt>${escape(field.label)}</dt>` +
          `<dd>${escape(field.value)}` +
          (field.note ? `<span class="note">${escape(field.note)}</span>` : "") +
          `</dd></div>`,
      )
      .join("") +
    `</dl>`
  );
}

function renderSwatches(swatches: ReportSwatch[]): string {
  return (
    `<ul class="swatches">` +
    swatches
      .map(
        (swatch) =>
          `<li><span class="chip" style="background:${escape(swatch.color)}"></span>` +
          `${escape(swatch.label)}</li>`,
      )
      .join("") +
    `</ul>`
  );
}

function renderImages(images: ReportImage[]): string {
  return (
    `<div class="figures">` +
    images
      .map(
        (image) =>
          `<figure><img src="${image.src}" alt="${escape(image.caption ?? "")}" />` +
          (image.caption ? `<figcaption>${escape(image.caption)}</figcaption>` : "") +
          `</figure>`,
      )
      .join("") +
    `</div>`
  );
}

function renderSection(section: ReportSection): string {
  return (
    `<section><h2>${escape(section.heading)}</h2>` +
    (section.body ?? []).map((line) => `<p>${escape(line)}</p>`).join("") +
    (section.caution ? `<p class="caution">${escape(section.caution)}</p>` : "") +
    (section.fields?.length ? renderFields(section.fields) : "") +
    (section.swatches?.length ? renderSwatches(section.swatches) : "") +
    (section.images?.length ? renderImages(section.images) : "") +
    `</section>`
  );
}

/** The whole document, as an HTML string. */
export function renderReport(report: Report): string {
  const when = (report.generated ?? new Date()).toISOString().slice(0, 16).replace("T", " ");
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<title>${escape(report.title)}</title>
<style>
  :root { color-scheme: light; }
  body {
    margin: 0 auto; padding: 32px; max-width: 1000px;
    font: 15px/1.6 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
    color: #16181d; background: #fff;
  }
  h1 { font-size: 22px; margin: 0 0 4px; }
  h2 { font-size: 15px; margin: 28px 0 10px; padding-bottom: 6px; border-bottom: 1px solid #e2e4ea; }
  .subtitle, .generated { color: #6b7180; margin: 0; font-size: 13px; }
  .generated { margin-bottom: 8px; }
  p { margin: 0 0 10px; }
  .caution { background: #fff6e0; color: #9a6400; padding: 9px 12px; border-radius: 8px; }
  .fields { display: grid; grid-template-columns: repeat(auto-fit, minmax(190px, 1fr)); gap: 12px; margin: 0; }
  .fields dt { font-size: 12px; color: #6b7180; }
  .fields dd { margin: 2px 0 0; font-size: 17px; font-variant-numeric: tabular-nums; }
  .fields .note { display: block; font-size: 12px; color: #6b7180; font-variant-numeric: normal; }
  .swatches { list-style: none; margin: 8px 0 0; padding: 0; display: flex; flex-wrap: wrap; gap: 5px 16px; font-size: 13px; }
  .swatches li { display: flex; align-items: center; gap: 6px; }
  .chip { width: 12px; height: 12px; border-radius: 3px; border: 1px solid rgb(0 0 0 / 12%); }
  .figures { display: grid; grid-template-columns: repeat(auto-fit, minmax(320px, 1fr)); gap: 16px; }
  figure { margin: 0; }
  figure img { width: 100%; border: 1px solid #e2e4ea; border-radius: 8px; }
  figcaption { font-size: 12px; color: #6b7180; margin-top: 6px; }
  footer { margin-top: 32px; padding-top: 12px; border-top: 1px solid #e2e4ea; font-size: 12px; color: #6b7180; }
  footer p { margin: 0 0 4px; }
  /* Figures are the point of the document; do not let a page break split one. */
  @media print { figure { break-inside: avoid; } section { break-inside: avoid-page; } }
</style>
</head>
<body>
<h1>${escape(report.title)}</h1>
${report.subtitle ? `<p class="subtitle">${escape(report.subtitle)}</p>` : ""}
<p class="generated">Generated ${escape(when)}</p>
${report.sections.map(renderSection).join("")}
${
  report.footnotes?.length
    ? `<footer>${report.footnotes.map((line) => `<p>${escape(line)}</p>`).join("")}</footer>`
    : ""
}
</body>
</html>`;
}
