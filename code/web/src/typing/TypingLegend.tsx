/**
 * What the bar colours mean, which typing columns they come from, and how bar
 * length is scaled.
 *
 * One legend for both panels, not one each: the colour scale is shared, so two
 * would be the same list twice — the library's own demo learned that, with
 * duplicate ramps floating over the leaf labels.
 *
 * Categories are read from the scale itself rather than from the data, because
 * the scale is what assigns the colours; deriving them separately is how a
 * legend comes to disagree with the picture it explains.
 */

import { useEffect, useRef, useState } from "react";
import type { BarScale } from "phylo-tree-viewer";

export function TypingLegend({
  assignments,
  segmentKeys,
  keys,
  onSegmentKeys,
  scale,
  onScale,
  loading,
  error,
}: {
  assignments: ReadonlyMap<string, string>;
  segmentKeys: string[];
  keys: string[];
  onSegmentKeys: (keys: string[]) => void;
  scale: BarScale;
  onScale: (scale: BarScale) => void;
  loading: boolean;
  error: string | null;
}) {
  const entries = [...assignments.entries()].sort(([a], [b]) =>
    String(a ?? "").localeCompare(String(b ?? "")),
  );

  const toggle = (key: string) =>
    onSegmentKeys(
      segmentKeys.includes(key)
        ? segmentKeys.filter((candidate) => candidate !== key)
        : [...segmentKeys, key],
    );

  return (
    <footer className="typing-legend">
      <div className="legend-head">
        <ColumnPicker keys={keys} chosen={segmentKeys} onToggle={toggle} />

        <label className="legend-scale">
          Bar length
          <select value={scale} onChange={(event) => onScale(event.target.value as BarScale)}>
            <option value="linear">Linear</option>
            {/* Counts span orders of magnitude — most leaves have a handful of
                isolates and a few have hundreds — so on a linear scale almost
                every bar is a stub. */}
            <option value="log">Logarithmic</option>
          </select>
        </label>

        {loading ? <span className="legend-note">loading…</span> : null}
        {error ? <span className="legend-note error">{error}</span> : null}
      </div>

      {!loading && !error && entries.length === 0 ? (
        <p className="legend-note">
          {segmentKeys.length === 0
            ? "Choose a column to colour by."
            : "No typing data for the leaves on screen."}
        </p>
      ) : null}

      <ul className="legend-swatches">
        {entries.map(([value, color]) => (
          <li key={value}>
            <span className="swatch" style={{ background: color }} aria-hidden="true" />
            {value}
          </li>
        ))}
      </ul>
    </footer>
  );
}

/**
 * A dropdown that stays open while you tick several columns.
 *
 * `<select multiple>` is the native fit and is unusable in practice —
 * ctrl-click to add, and it renders as a permanently expanded list box. This
 * keeps the compact closed state of a normal select and opens onto checkboxes.
 */
function ColumnPicker({
  keys,
  chosen,
  onToggle,
}: {
  keys: string[];
  chosen: string[];
  onToggle: (key: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const away = (event: MouseEvent) => {
      if (!ref.current?.contains(event.target as Node)) setOpen(false);
    };
    const key = (event: KeyboardEvent) => event.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", away);
    document.addEventListener("keydown", key);
    return () => {
      document.removeEventListener("mousedown", away);
      document.removeEventListener("keydown", key);
    };
  }, [open]);

  const summary =
    chosen.length === 0
      ? "none"
      : chosen.length <= 2
        ? chosen.join(", ")
        : `${chosen.length} columns`;

  return (
    <div className="column-picker" ref={ref}>
      <span className="legend-label">Colour by</span>
      <button
        type="button"
        className="picker-button"
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
      >
        {summary}
        <span aria-hidden="true">▾</span>
      </button>

      {open ? (
        <div className="picker-menu" role="group" aria-label="Typing columns">
          {keys.map((key) => (
            <label key={key}>
              <input
                type="checkbox"
                checked={chosen.includes(key)}
                onChange={() => onToggle(key)}
              />
              {key}
            </label>
          ))}
        </div>
      ) : null}
    </div>
  );
}
