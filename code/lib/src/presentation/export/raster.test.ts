// @vitest-environment jsdom
/**
 * The picture and the PDF are built from the same HTML as the report, so what
 * is worth testing here is the plumbing that makes that possible: the PDF is
 * a real file, and the pagination follows the page, not the caller's luck.
 *
 * jsdom cannot rasterise, so `renderHtmlToCanvas` itself is exercised in the
 * browser rather than here; these cover the parts that are pure enough to pin.
 */

import { describe, expect, it, vi } from "vitest";
import { canvasToPdf } from "./raster";

/** A canvas stub: jsdom has no 2d context and no JPEG encoder. */
function fakeCanvas(width: number, height: number) {
  const slices: Array<{ width: number; height: number }> = [];
  const original = document.createElement.bind(document);
  vi.spyOn(document, "createElement").mockImplementation((tag: string) => {
    const el = original(tag) as HTMLCanvasElement;
    if (tag === "canvas") {
      Object.defineProperty(el, "getContext", {
        value: () => ({ fillRect() {}, drawImage() {}, fillStyle: "" }),
      });
      Object.defineProperty(el, "toDataURL", {
        value: () => {
          slices.push({ width: el.width, height: el.height });
          // A one-byte "JPEG"; the writer only ever copies it verbatim.
          return "data:image/jpeg;base64,/w==";
        },
      });
    }
    return el;
  });
  return { canvas: { width, height } as HTMLCanvasElement, slices };
}

async function bytes(blob: Blob): Promise<string> {
  return new TextDecoder("latin1").decode(await blob.arrayBuffer());
}

describe("canvasToPdf", () => {
  it("writes a PDF whose cross-reference offsets point at real objects", async () => {
    const { canvas } = fakeCanvas(1000, 400);
    const text = await bytes(canvasToPdf(canvas));
    vi.restoreAllMocks();

    expect(text.startsWith("%PDF-1.4")).toBe(true);
    expect(text.trimEnd().endsWith("%%EOF")).toBe(true);

    // Every offset in the table must land on that object's own header, which
    // is the one thing a hand-written PDF gets wrong and a reader refuses on.
    // `lastIndexOf("xref")` would find "startxref"; the table starts its line.
    const table = text.slice(text.indexOf("\nxref\n"));
    const offsets = [...table.matchAll(/^(\d{10}) 00000 n $/gm)].map((m) => Number(m[1]));
    expect(offsets.length).toBeGreaterThan(0);
    offsets.forEach((offset, index) => {
      expect(text.slice(offset, offset + 8)).toContain(`${index + 1} 0 obj`);
    });
    // And startxref must point at the table itself.
    const startxref = Number(/startxref\n(\d+)/.exec(text)![1]);
    expect(text.slice(startxref, startxref + 4)).toBe("xref");
  });

  it("paginates a tall report instead of shrinking it onto one page", async () => {
    // A page holds roughly width * (printable height / printable width) source
    // pixels; three times that must not come back as one page.
    const { canvas, slices } = fakeCanvas(1000, 6000);
    const text = await bytes(canvasToPdf(canvas));
    vi.restoreAllMocks();

    expect(slices.length).toBeGreaterThan(1);
    expect(text).toContain(`/Count ${slices.length}`);
    // The last page is short rather than stretched, so nothing is distorted.
    expect(slices[slices.length - 1].height).toBeLessThanOrEqual(slices[0].height);
    expect(slices.reduce((sum, s) => sum + s.height, 0)).toBe(6000);
  });

  it("keeps a short report to a single page", async () => {
    const { canvas, slices } = fakeCanvas(1000, 200);
    const text = await bytes(canvasToPdf(canvas));
    vi.restoreAllMocks();

    expect(slices).toHaveLength(1);
    expect(text).toContain("/Count 1");
  });
});
