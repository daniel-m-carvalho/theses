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
import { CheckboxMenu } from "../ui/CheckboxMenu";

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
        <CheckboxMenu
          title="Colour by"
          summary={
            segmentKeys.length === 0
              ? "none"
              : segmentKeys.length <= 2
                ? segmentKeys.join(", ")
                : `${segmentKeys.length} columns`
          }
          items={keys.map((key) => ({
            key,
            label: key,
            checked: segmentKeys.includes(key),
          }))}
          onToggle={toggle}
          openUpward
        />


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
