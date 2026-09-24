/**
 * What the bar colours mean, and which typing columns they come from.
 *
 * One legend for both panels, not one each: the colour scale is shared, so two
 * would be the same list twice — the library's own demo learned that, with
 * duplicate ramps floating over the leaf labels.
 *
 * Categories are read from the scale itself rather than from the data, because
 * the scale is what assigns the colours; deriving them separately is how a
 * legend comes to disagree with the picture it explains.
 */

export function TypingLegend({
  assignments,
  segmentKeys,
  keys,
  onSegmentKeys,
  inflation,
  loading,
  error,
}: {
  assignments: ReadonlyMap<string, string>;
  segmentKeys: string[];
  keys: string[];
  onSegmentKeys: (keys: string[]) => void;
  inflation: number;
  loading: boolean;
  error: string | null;
}) {
  const entries = [...assignments.entries()].sort(([a], [b]) =>
    String(a ?? "").localeCompare(String(b ?? "")),
  );

  const toggle = (key: string) => {
    const next = segmentKeys.includes(key)
      ? segmentKeys.filter((candidate) => candidate !== key)
      : [...segmentKeys, key];
    onSegmentKeys(next);
  };

  return (
    <footer className="typing-legend">
      <div className="legend-head">
        <span className="legend-label">Colour by</span>
        <div className="legend-keys">
          {keys.map((key) => (
            <label key={key} className={segmentKeys.includes(key) ? "key on" : "key"}>
              <input
                type="checkbox"
                checked={segmentKeys.includes(key)}
                onChange={() => toggle(key)}
              />
              {key}
            </label>
          ))}
        </div>
        {loading ? <span className="legend-note">loading…</span> : null}
        {error ? <span className="legend-note error">{error}</span> : null}
      </div>

      {/*
        Stated rather than left to be discovered. Every isolate appears in
        every column, so showing two columns counts each one twice and a bar
        is twice as long as the leaf's isolate count. Lengths stay comparable
        between leaves; they just stop meaning "isolates".
      */}
      {inflation > 1 ? (
        <p className="legend-warning">
          {inflation} columns shown, so each isolate is counted {inflation} times:
          bar lengths are {inflation}× the isolate count. They remain comparable
          between leaves.
        </p>
      ) : null}

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
