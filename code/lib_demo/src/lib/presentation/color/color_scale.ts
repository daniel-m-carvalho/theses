/**
 * A categorical color scale: maps string keys (e.g. category identifiers) to
 * colors, assigning the next palette color the first time a key is seen and
 * memoizing it thereafter.
 *
 * Share ONE instance across several views (e.g. two side-by-side trees) to
 * guarantee that the same key gets the same color everywhere — the first view
 * to render a key fixes its color, and every other view reuses it. This is
 * stronger than hashing each key independently: there are no hash collisions
 * for the first `palette.length` keys, and consistency does not rely on every
 * view computing the same function.
 */
export class CategoricalColorScale {
  private assigned = new Map<string, string>();
  private palette: string[];
  private next = 0;

  constructor(palette: string[] = DEFAULT_PALETTE) {
    this.palette = palette.length > 0 ? palette : DEFAULT_PALETTE;
  }

  /** Color for `key`, assigning (and remembering) one on first request. */
  color(key: string): string {
    let c = this.assigned.get(key);
    if (!c) {
      c = this.palette[this.next % this.palette.length];
      this.next += 1;
      this.assigned.set(key, c);
    }
    return c;
  }

  /** Pre-assign colors for a set of keys in a stable order (optional). */
  prime(keys: Iterable<string>): void {
    for (const k of keys) this.color(k);
  }

  /**
   * Read-only snapshot of the current key → color assignments, in the order the
   * keys were assigned (i.e. palette order). This is what a legend renders from.
   *
   * Prefer this over {@link color} for *reading*: `color()` assigns on miss, so
   * asking it about a key that hasn't been drawn yet consumes the next palette
   * slot and permanently changes the mapping — a legend could thereby recolor the
   * very chart it describes. This method never mutates.
   *
   * Note assignment is lazy, so this lists only keys seen so far; call
   * {@link prime} with the full key set up front for a stable, complete legend.
   */
  assignments(): ReadonlyMap<string, string> {
    return new Map(this.assigned);
  }
}

/** A reasonably distinct default palette (extends the original 8-color set). */
export const DEFAULT_PALETTE = [
  "#5c7cfa", "#12b886", "#f08c00", "#e64980",
  "#22b8cf", "#845ef7", "#82c91e", "#fa5252",
  "#4263eb", "#0ca678", "#e8590c", "#c2255c",
  "#1098ad", "#7048e8", "#66a80f", "#e03131",
];

// --- Sequential (numeric) color scale -------------------------------------

/**
 * Default ramp for comparison values, low → high: a vivid blue → cyan → yellow
 * spectrum, following the blue→yellow hue path used by phylo.io (see the
 * comparison operator's attribution), but more saturated so differences stand
 * out. Blue reads as "low", yellow as "high"; map it to your metric's meaning
 * via the scale's `domain`, or pass custom `stops` for any other spectrum.
 */
export const DIFF_PALETTE = [
  "#1d4ed8", "#0ea5e9", "#22c8b8", "#a3e635", "#ffd400",
];

export interface SequentialColorScaleOptions {
  /** Color stops, low → high. Default {@link DIFF_PALETTE}. */
  stops?: string[];
  /** Value range mapped onto the stops. Default [0, 1]. */
  domain?: [number, number];
}

/**
 * Maps a numeric value to a color by linear interpolation across a list of
 * color stops. Used to color tree branches/nodes by a backend-provided
 * comparison value (similarity / distance / metric). Share ONE instance across
 * several trees so equal values read as the same color everywhere.
 */
export class SequentialColorScale {
  private stops: Array<[number, number, number]>;
  private min: number;
  private max: number;

  constructor(options: SequentialColorScaleOptions = {}) {
    const hex = options.stops && options.stops.length >= 2 ? options.stops : DIFF_PALETTE;
    this.stops = hex.map(hexToRgb);
    [this.min, this.max] = options.domain ?? [0, 1];
  }

  /** Color for a value (clamped to the domain). */
  color(value: number): string {
    const span = this.max - this.min;
    const t = span === 0 ? 0 : clamp01((value - this.min) / span);
    const seg = t * (this.stops.length - 1);
    const i = Math.min(Math.floor(seg), this.stops.length - 2);
    const f = seg - i;
    const a = this.stops[i];
    const b = this.stops[i + 1];
    return rgbToHex([
      Math.round(a[0] + (b[0] - a[0]) * f),
      Math.round(a[1] + (b[1] - a[1]) * f),
      Math.round(a[2] + (b[2] - a[2]) * f),
    ]);
  }

  /** The configured domain [min, max]. */
  getDomain(): [number, number] {
    return [this.min, this.max];
  }

  /** The stop colors as hex (for building a legend gradient). */
  stopsHex(): string[] {
    return this.stops.map(rgbToHex);
  }
}

function clamp01(v: number): number {
  return Math.max(0, Math.min(1, v));
}

function hexToRgb(hex: string): [number, number, number] {
  const h = hex.replace("#", "");
  const n = parseInt(
    h.length === 3 ? h.split("").map((c) => c + c).join("") : h,
    16
  );
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function rgbToHex([r, g, b]: [number, number, number]): string {
  return "#" + [r, g, b].map((v) => v.toString(16).padStart(2, "0")).join("");
}
