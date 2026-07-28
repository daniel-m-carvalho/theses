/**
 * Footer legend: what each bar colour means.
 *
 * App-side presentation, kept out of `main.ts` so the "top N inline, the rest
 * behind a popup" logic is unit-testable — it is exactly the kind of boundary
 * that breaks silently (off-by-one on the cutoff, a stale count, a dialog that
 * never opens).
 *
 * One legend serves both panels: the colour scale is shared, so the same value
 * is the same colour in every tree and a per-panel legend would only repeat
 * itself. Colours are read back from the library's scale rather than recomputed
 * — the library assigns them, so that mapping exists in exactly one place.
 */

/** How many legend entries fit inline before the rest move behind "see more". */
export const LEGEND_INLINE = 5;

/**
 * Footer legend: what each colour in the bars actually means.
 *
 * Lives once, below both panels, because the colour scale is shared — the same
 * value is the same colour in every tree, so a per-panel legend would repeat
 * itself. Colours are read back from the library's scale rather than recomputed:
 * the library assigns them, so it is the only place that mapping exists.
 *
 * Counts follow the active filter, since a legend claiming isolates the filter
 * has excluded would describe data the user cannot see. Only the top few fit
 * inline (144 countries would swamp the page); the rest open in a dialog.
 */
export function renderLegend(
  host: HTMLElement,
  opts: {
    segmentBy: string;
    entries: Array<[string, number]>;
    unrecorded: number;
    colorOf: (value: string) => string;
  }
): void {
  host.innerHTML = "";

  const title = document.createElement("span");
  title.className = "legend-title";
  title.textContent = `${opts.segmentBy}:`;
  host.appendChild(title);

  if (opts.entries.length === 0) {
    const none = document.createElement("span");
    none.className = "legend-empty";
    none.textContent = "no isolates match the current filter";
    host.appendChild(none);
    return;
  }

  for (const [value, count] of opts.entries.slice(0, LEGEND_INLINE)) {
    host.appendChild(legendItem(value, count, opts.colorOf(value)));
  }

  const hidden = opts.entries.length - LEGEND_INLINE;
  if (hidden > 0) {
    const more = button(`See all ${opts.entries.length} …`, () =>
      openLegendDialog(opts.segmentBy, opts.entries, opts.unrecorded, opts.colorOf)
    );
    more.className = "legend-more";
    host.appendChild(more);
  }

  if (opts.unrecorded > 0) {
    // Not a colour: these isolates are counted but deliberately undrawn, and
    // saying so is what stops the bars looking mysteriously short.
    const note = document.createElement("span");
    note.className = "legend-empty";
    note.textContent = `+${opts.unrecorded.toLocaleString()} not recorded (no segment)`;
    host.appendChild(note);
  }
}

function legendItem(value: string, count: number, color: string): HTMLElement {
  const item = document.createElement("span");
  item.className = "legend-item";
  const swatch = document.createElement("span");
  swatch.className = "swatch";
  swatch.style.background = color;
  const label = document.createElement("span");
  label.textContent = `${value} (${count.toLocaleString()})`;
  item.append(swatch, label);
  return item;
}

/** The "see more" popup: every value, searchable, in one scrollable list. */
export function openLegendDialog(
  segmentBy: string,
  entries: Array<[string, number]>,
  unrecorded: number,
  colorOf: (value: string) => string
): void {
  const dialog = document.createElement("dialog");
  dialog.className = "legend-dialog";

  const head = document.createElement("div");
  head.className = "legend-dialog-head";
  const heading = document.createElement("strong");
  heading.textContent = `${segmentBy} — ${entries.length} values`;
  const search = document.createElement("input");
  search.type = "search";
  search.placeholder = "Filter this list…";
  const close = button("Close", () => dialog.close());
  head.append(heading, search, close);

  const list = document.createElement("div");
  list.className = "legend-dialog-list";
  const rows = entries.map(([value, count]) => {
    const row = legendItem(value, count, colorOf(value));
    row.classList.add("legend-row");
    list.appendChild(row);
    return { value: value.toLowerCase(), row };
  });

  // Search narrows the *display* only — it never changes the filter, so opening
  // the legend cannot accidentally alter what the trees show.
  search.addEventListener("input", () => {
    const q = search.value.trim().toLowerCase();
    for (const { value, row } of rows) {
      row.style.display = !q || value.includes(q) ? "" : "none";
    }
  });

  dialog.append(head, list);
  if (unrecorded > 0) {
    const note = document.createElement("div");
    note.className = "legend-empty";
    note.textContent = `+${unrecorded.toLocaleString()} isolates with no recorded ${segmentBy} — counted, but given no colour.`;
    dialog.appendChild(note);
  }

  dialog.addEventListener("close", () => dialog.remove());
  document.body.appendChild(dialog);
  dialog.showModal();
}

/** What the comparison colouring currently means (see the library's §9.5). */
export interface ComparisonLegendOptions {
  /** Hidden entirely when the comparison is off — no legend for absent colour. */
  enabled: boolean;
  mode: "gradient" | "membership";
  /** Gradient stops, low → high. The same list the library's scale uses. */
  stops: string[];
  /** Gradient end labels, e.g. ["different", "similar"]. */
  labels: [string, string];
  /** Membership mode paints agreement only; this is that colour. */
  equalColor: string;
  membershipLabel: string;
}

/**
 * The comparison legend, drawn once in the footer beside the value legend.
 *
 * It used to be drawn by the operator *inside each panel* — which meant two
 * identical ramps for a single comparison, absolutely positioned over the canvas
 * where they overlapped leaf labels. Both problems are positional, so the fix is
 * positional: one legend, in the page's own footer, next to the other one.
 *
 * The stops come from the same config block the library builds its scale from,
 * so the ramp matches the branches by construction rather than by coincidence.
 */
export function renderComparisonLegend(
  host: HTMLElement,
  opts: ComparisonLegendOptions
): void {
  host.innerHTML = "";
  if (!opts.enabled) return; // nothing is coloured, so explain nothing

  const title = document.createElement("span");
  title.className = "legend-title";
  title.textContent = "Differences:";
  host.appendChild(title);

  if (opts.mode === "membership") {
    // One swatch: the mode paints agreement only, so a "different" swatch would
    // advertise a colour that never appears on screen.
    host.appendChild(legendItemLabelled(opts.membershipLabel, opts.equalColor));
    return;
  }

  const low = document.createElement("span");
  low.textContent = opts.labels[0];
  const ramp = document.createElement("span");
  ramp.className = "gradient-ramp";
  ramp.style.background = `linear-gradient(to right, ${opts.stops.join(",")})`;
  const high = document.createElement("span");
  high.textContent = opts.labels[1];

  host.append(low, ramp, high);
}

/** A swatch plus a bare label (no count) — the membership case. */
function legendItemLabelled(label: string, color: string): HTMLElement {
  const item = document.createElement("span");
  item.className = "legend-item";
  const swatch = document.createElement("span");
  swatch.className = "swatch";
  swatch.style.background = color;
  const text = document.createElement("span");
  text.textContent = label;
  item.append(swatch, text);
  return item;
}

/** A plain button; local so the legend module stands alone. */
function button(label: string, onClick: () => void): HTMLButtonElement {
  const b = document.createElement("button");
  b.textContent = label;
  b.addEventListener("click", onClick);
  return b;
}
