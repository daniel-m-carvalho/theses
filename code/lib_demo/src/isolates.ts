/**
 * Isolate metadata: parsing, indexing, filtering, composition.
 *
 * App-side, not library: the library never fetches or interprets data. This
 * module owns the shape of the EnteroBase TSV exports and turns them into the
 * two things the viewer needs — a per-leaf composition (the stacked bar) and a
 * per-leaf predicate (which leaves still have matching isolates).
 *
 * **The model.** Exactly one key *segments* (its values become the bar's
 * coloured slices); any number of keys *filter* (they restrict which isolates
 * count, but add no colours). Within a key the selected values are OR-ed; across
 * keys they are AND-ed. So "Country ∈ {Bangladesh, India} AND Source Niche =
 * Human", segmented by Collection Year, is expressible — and a leaf with one
 * distinct year left ends up with a single-colour bar, which is what makes
 * "one colour vs several" fall out of the data rather than a setting.
 *
 * **Why rows are kept, not per-key counts.** Marginal counts cannot answer an
 * AND query: knowing an ST has 254 Bangladesh isolates and 30 Human-source ones
 * says nothing about how many are both. So each isolate is kept as a *joint
 * tuple* over the configured keys. Values are interned per key, so the tuples
 * hold shared string references rather than 65k × N fresh strings.
 */

/** A value that was not recorded. Never forms a segment, never matches a filter. */
export const UNRECORDED = "";

/** One isolate, as its values for the configured keys (index-aligned to `keys`). */
export type IsolateRow = readonly string[];

export interface IsolateIndex {
  /** The configured columns, in tuple order. */
  keys: string[];
  /** Join value (e.g. ST) → that leaf's isolates. */
  byLeaf: Map<string, IsolateRow[]>;
  /** Per key: recorded value → how many isolates carry it (drives the filter UI). */
  valuesByKey: Map<string, Map<string, number>>;
  /** Isolates indexed (rows with a join value). */
  rows: number;
}

/** Selected values per key. A key that is absent or empty constrains nothing. */
export type FilterSelection = ReadonlyMap<string, ReadonlySet<string>>;

export interface ParseOptions {
  /** Column joining an isolate to a tree leaf (e.g. "ST"). */
  joinColumn: string;
  /** Columns to keep — the segment key and every filterable key. */
  keys: string[];
  /** Raw values meaning "not recorded". */
  missing: ReadonlySet<string>;
}

/**
 * Parse a tab-separated export and index it by the join column.
 *
 * Tab-split with no quote handling is correct here *because* the source is TSV:
 * fields carry unquoted commas (`SRA,GCF_900162645`) but never tabs. It is also
 * what keeps a ~9-12 MB file cheap to load — only the configured columns are
 * read, and values are interned.
 */
export function parseIsolateTsv(text: string, opts: ParseOptions): IsolateIndex {
  const lines = text.split("\n");
  const header = (lines[0] ?? "").replace(/\r$/, "").split("\t");

  const joinAt = header.indexOf(opts.joinColumn);
  if (joinAt < 0) throw new Error(`Isolate file has no "${opts.joinColumn}" column`);
  const keyAt = opts.keys.map((k) => {
    const i = header.indexOf(k);
    if (i < 0) throw new Error(`Isolate file has no "${k}" column`);
    return i;
  });

  const byLeaf = new Map<string, IsolateRow[]>();
  const valuesByKey = new Map(opts.keys.map((k) => [k, new Map<string, number>()]));
  // One intern table per key: repeated values (a country, a year) become one
  // shared string instead of one per row.
  const interned = opts.keys.map(() => new Map<string, string>());
  let rows = 0;

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line) continue; // trailing newline / blank row
    const fields = line.split("\t");
    const leafKey = (fields[joinAt] ?? "").trim();
    if (!leafKey) continue; // no join key ⇒ cannot attach to any leaf
    rows++;

    const row: string[] = new Array(keyAt.length);
    for (let k = 0; k < keyAt.length; k++) {
      const raw = (fields[keyAt[k]] ?? "").trim();
      if (opts.missing.has(raw)) {
        row[k] = UNRECORDED;
        continue;
      }
      const pool = interned[k];
      const value = pool.get(raw) ?? (pool.set(raw, raw), raw);
      row[k] = value;

      const counts = valuesByKey.get(opts.keys[k])!;
      counts.set(value, (counts.get(value) ?? 0) + 1);
    }

    const list = byLeaf.get(leafKey);
    if (list) list.push(row);
    else byLeaf.set(leafKey, [row]);
  }

  return { keys: opts.keys, byLeaf, valuesByKey, rows };
}

/**
 * Does this isolate satisfy the selection? OR within a key, AND across keys.
 * An unrecorded value matches nothing: filtering to "Country = Spain" excludes
 * isolates whose country was never recorded, rather than quietly keeping them.
 */
export function matchesFilter(
  row: IsolateRow,
  keys: readonly string[],
  filter: FilterSelection
): boolean {
  for (let k = 0; k < keys.length; k++) {
    const wanted = filter.get(keys[k]);
    if (!wanted || wanted.size === 0) continue; // this key constrains nothing
    if (!wanted.has(row[k])) return false;
  }
  return true;
}

/** True when no key constrains anything — the "show everything" case. */
export function isFilterEmpty(filter: FilterSelection): boolean {
  for (const values of filter.values()) if (values.size > 0) return false;
  return true;
}

export interface LeafComposition {
  /** Segment value → isolate count, for recorded values only. */
  counts: Map<string, number>;
  /** Matching isolates whose *segment* value was not recorded. */
  unrecorded: number;
  /** Matching isolates in total (`counts` sum + `unrecorded`). */
  matched: number;
}

/**
 * The composition of one leaf under the active filter.
 *
 * `unrecorded` is counted but deliberately kept out of `counts`: a stacked
 * segment's width is its share of the bar, so folding unrecorded isolates into
 * a category would inflate the categories that *are* known. Callers surface it
 * alongside (a tooltip) instead.
 */
export function composeLeaf(
  index: IsolateIndex,
  leafKey: string,
  segmentBy: string,
  filter: FilterSelection
): LeafComposition {
  const empty: LeafComposition = { counts: new Map(), unrecorded: 0, matched: 0 };
  const rows = index.byLeaf.get(leafKey);
  if (!rows) return empty;

  const segAt = index.keys.indexOf(segmentBy);
  if (segAt < 0) return empty;

  const counts = new Map<string, number>();
  let unrecorded = 0;
  let matched = 0;

  for (const row of rows) {
    if (!matchesFilter(row, index.keys, filter)) continue;
    matched++;
    const value = row[segAt];
    if (value === UNRECORDED) unrecorded++;
    else counts.set(value, (counts.get(value) ?? 0) + 1);
  }

  return { counts, unrecorded, matched };
}

/**
 * The same composition as {@link composeLeaf}, but over every isolate in the
 * index — what the legend reports. Counts are filter-dependent on purpose: a
 * legend entry claiming 254 isolates while the filter has excluded all but 13
 * would be describing data the user cannot see.
 */
export function totals(
  index: IsolateIndex,
  segmentBy: string,
  filter: FilterSelection
): LeafComposition {
  const counts = new Map<string, number>();
  let unrecorded = 0;
  let matched = 0;

  const segAt = index.keys.indexOf(segmentBy);
  if (segAt < 0) return { counts, unrecorded, matched };

  for (const rows of index.byLeaf.values()) {
    for (const row of rows) {
      if (!matchesFilter(row, index.keys, filter)) continue;
      matched++;
      const value = row[segAt];
      if (value === UNRECORDED) unrecorded++;
      else counts.set(value, (counts.get(value) ?? 0) + 1);
    }
  }

  return { counts, unrecorded, matched };
}

/**
 * Distinct recorded values of a key, most frequent first — the filter UI's
 * listing order. Counts here are dataset-wide and *not* filter-dependent, so the
 * checkbox list doesn't reshuffle under the user's own selection while they use it.
 */
export function valuesOf(index: IsolateIndex, key: string): Array<[string, number]> {
  const counts = index.valuesByKey.get(key);
  if (!counts) return [];
  return [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
}
