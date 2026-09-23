/**
 * What the bar colours mean.
 *
 * One legend for both panels, not one each: the colour scale is shared, so two
 * would be the same list twice — and the library's own demo learned that the
 * hard way, with duplicate ramps floating over the leaf labels.
 *
 * Categories are read from the scale itself rather than from the data, because
 * the scale is what assigns the colours; deriving them separately is how a
 * legend comes to disagree with the picture it explains.
 */

export function TypingLegend({
  assignments,
  segmentBy,
  keys,
  onSegmentBy,
  loading,
  error,
}: {
  assignments: ReadonlyMap<string, string>;
  segmentBy: string;
  keys: string[];
  onSegmentBy: (key: string) => void;
  loading: boolean;
  error: string | null;
}) {
  // Null-safe: a category key can be null or blank where the export recorded
  // nothing, and those isolates are kept rather than dropped — so the key
  // reaches the colour scale and, from there, this list.
  const entries = [...assignments.entries()].sort(([a], [b]) =>
    String(a ?? "").localeCompare(String(b ?? "")),
  );

  return (
    <footer className="typing-legend">
      <div className="legend-head">
        <label>
          Colour by
          <select value={segmentBy} onChange={(event) => onSegmentBy(event.target.value)}>
            {keys.map((key) => (
              <option key={key} value={key}>
                {key}
              </option>
            ))}
          </select>
        </label>
        {loading ? <span className="legend-note">loading…</span> : null}
        {error ? <span className="legend-note error">{error}</span> : null}
        {!loading && !error && entries.length === 0 ? (
          <span className="legend-note">
            No typing data for the leaves on screen.
          </span>
        ) : null}
      </div>

      <ul className="legend-swatches">
        {entries.map(([value, color]) => (
          <li key={value}>
            <span className="swatch" style={{ background: color }} aria-hidden="true" />
            {/* Blank values are kept as isolates but form no segment, so a
                blank swatch here would be a category that never appears. */}
            {value || "(not recorded)"}
          </li>
        ))}
      </ul>
    </footer>
  );
}
