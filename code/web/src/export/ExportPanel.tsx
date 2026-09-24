/**
 * Choosing what goes in the report, before it is written.
 *
 * A button that silently downloads a file gives you nothing to correct — you
 * find out what it decided by opening it. This names the parts first, which is
 * the pattern the upload panel already sets.
 */

import { useState } from "react";
import type { ReportFormat } from "phylo-tree-viewer";

export interface ExportChoices {
  title: string;
  images: boolean;
  format: ReportFormat;
}

/**
 * The same report, three ways.
 *
 * Named by what each is *for* rather than by extension, because the choice is
 * not really about file types: the layout is identical in all three, and what
 * differs is whether the reader can select the text, drop it into a document,
 * or hand it to someone who will print it.
 */
const FORMATS: ReadonlyArray<{ key: ReportFormat; label: string; note: string }> = [
  { key: "html", label: "HTML", note: "Text stays selectable and the pictures full size" },
  { key: "pdf", label: "PDF", note: "Paginated, for printing or attaching" },
  { key: "png", label: "PNG", note: "One image, to drop into slides or a document" },
];

export function ExportPanel({
  defaultTitle,
  pairLabel,
  busy,
  error,
  onCancel,
  onExport,
}: {
  defaultTitle: string;
  pairLabel: string;
  busy: boolean;
  error: string | null;
  onCancel: () => void;
  onExport: (choices: ExportChoices) => void;
}) {
  const [title, setTitle] = useState(defaultTitle);
  const [images, setImages] = useState(true);
  const [format, setFormat] = useState<ReportFormat>("html");

  return (
    <div className="export-backdrop" role="dialog" aria-modal="true" aria-label="Export report">
      <div className="export-panel">
        <h2>Export report</h2>
        <p className="export-lead">
          One file, with the pictures embedded. The layout is the same whichever
          format you choose.
        </p>

        <label className="export-field">
          Title
          <input
            type="text"
            value={title}
            onChange={(event) => setTitle(event.target.value)}
          />
        </label>

        <fieldset className="export-formats">
          <legend>Format</legend>
          {FORMATS.map((option) => (
            <label key={option.key} className="switch">
              <input
                type="radio"
                name="report-format"
                checked={format === option.key}
                onChange={() => setFormat(option.key)}
              />
              {option.label}
              <span className="switch-note">{option.note}</span>
            </label>
          ))}
        </fieldset>

        <label className="switch">
          <input
            type="checkbox"
            checked={images}
            onChange={(event) => setImages(event.target.checked)}
          />
          Include the two trees as they look now
          <span className="switch-note">
            Captured from the current view — the same clades expanded, the same colouring.
          </span>
        </label>

        <ul className="export-contents">
          <li>Distance, with every scalar the metric reports</li>
          <li>Shared leaves, and any dropped to reconcile the pair</li>
          <li>Whether the two are the same species, and the caution if they are not</li>
          <li>How the view was set up, so the pictures can be read</li>
        </ul>

        {error ? <p className="export-error">{error}</p> : null}

        <div className="export-actions">
          <button type="button" className="back-button" onClick={onCancel} disabled={busy}>
            Cancel
          </button>
          <button
            type="button"
            className="primary"
            disabled={busy || !title.trim()}
            onClick={() => onExport({ title: title.trim(), images, format })}
          >
            {busy ? "Building…" : `Export ${pairLabel}`}
          </button>
        </div>
      </div>
    </div>
  );
}
