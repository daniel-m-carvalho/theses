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

  return (
    <footer className="typing-legend">
      <div className="legend-head">
        <label className="legend-columns">
          Colour by
          {/*
            A native multi-select, as asked for. Worth knowing how it is
            driven: a plain click *replaces* the selection, so adding a second
            column needs Ctrl (Cmd on a Mac) and a range needs Shift. Nothing
            on screen says so, which is why the hint sits beside it.
          */}
          <select
            multiple
            size={Math.min(6, Math.max(3, keys.length))}
            value={segmentKeys}
            onChange={(event) =>
              onSegmentKeys([...event.target.selectedOptions].map((option) => option.value))
            }
          >
            {keys.map((key) => (
              <option key={key} value={key}>
                {key}
              </option>
            ))}
          </select>
        </label>
        <span className="legend-hint">Ctrl/Cmd-click to add, Shift-click for a range</span>

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
