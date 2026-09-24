/**
 * Choosing what goes in the report, before it is written.
 *
 * A button that silently downloads a file gives you nothing to correct — you
 * find out what it decided by opening it. This names the parts first, which is
 * the pattern the upload panel already sets.
 */

import { useState } from "react";

export interface ExportChoices {
  title: string;
  images: boolean;
}

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

  return (
    <div className="export-backdrop" role="dialog" aria-modal="true" aria-label="Export report">
      <div className="export-panel">
        <h2>Export report</h2>
        <p className="export-lead">
          A single HTML file, with the pictures embedded — open it in a browser, or
          print it to PDF.
        </p>

        <label className="export-field">
          Title
          <input
            type="text"
            value={title}
            onChange={(event) => setTitle(event.target.value)}
          />
        </label>

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
            onClick={() => onExport({ title: title.trim(), images })}
          >
            {busy ? "Building…" : `Export ${pairLabel}`}
          </button>
        </div>
      </div>
    </div>
  );
}
