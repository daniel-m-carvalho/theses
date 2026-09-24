/**
 * The same report, as a picture and as a PDF.
 *
 * One layout, three files. The HTML report is the source for all of them:
 * re-implementing it per format is how two of the three quietly stop matching
 * the third, and the whole point of the export is that what a reader receives
 * is what was on screen.
 *
 * The technique is the one `snapshot.ts` already uses for the panel overlays —
 * serialise the markup into an SVG `foreignObject` and let the browser draw it
 * — applied to the whole document rather than one layer. It needs no
 * dependency and no headless browser, which matters for a library that is
 * meant to be dropped into someone else's app.
 *
 * Two constraints come with it, and both are handled here rather than left for
 * the caller to discover:
 *
 *  - **Everything must be inline.** A `foreignObject` is rendered without the
 *    page's stylesheets and without network access, so the report's CSS
 *    travels inside it and its images are already data URLs (the panel
 *    snapshots are). Anything fetched by URL would be missing.
 *  - **The markup must parse as XML.** The SVG is parsed strictly, so an
 *    unclosed `<img>` or a bare `&` is fatal. `renderReport` escapes its text
 *    and closes its tags; `toXhtml` handles the void elements.
 */

/** A4 at 72dpi, in points — what a PDF page is measured in. */
const PAGE_WIDTH = 595.28;
const PAGE_HEIGHT = 841.89;
const PAGE_MARGIN = 24;

export interface RasterOptions {
  /** Layout width in CSS px before scaling. Default 1000, the report's max. */
  width?: number;
  /** Pixel ratio. Default 2, so text survives printing. */
  scale?: number;
  /** Painted behind the document. Default white. */
  background?: string;
}

/**
 * Draw a full HTML document onto a canvas.
 *
 * The document is first laid out **for real**, in a hidden element attached to
 * the page, because nothing else can tell us how tall it is: a `foreignObject`
 * clips to the height it is given, and a guess either cuts the report off or
 * pads it with white.
 */
export async function renderHtmlToCanvas(
  html: string,
  options: RasterOptions = {},
): Promise<HTMLCanvasElement> {
  const scale = options.scale ?? 2;
  const { body, width, height } = await measure(html, options.width ?? 1000);

  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">` +
    `<foreignObject width="100%" height="100%">${body}</foreignObject></svg>`;

  const image = await loadImage(
    `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`,
  );

  const canvas = document.createElement("canvas");
  canvas.width = Math.round(width * scale);
  canvas.height = Math.round(height * scale);
  const context = canvas.getContext("2d");
  if (!context) throw new Error("renderHtmlToCanvas: no 2d context available");
  context.scale(scale, scale);
  context.fillStyle = options.background ?? "#ffffff";
  context.fillRect(0, 0, width, height);
  context.drawImage(image, 0, 0, width, height);
  return canvas;
}

/**
 * Lay the document out off-screen and return its serialised body and height.
 *
 * Off-screen by position, not by `display: none`: a hidden element has no
 * layout at all, so it would measure zero.
 */
async function measure(
  html: string,
  width: number,
): Promise<{ body: string; width: number; height: number }> {
  const host = document.createElement("div");
  Object.assign(host.style, {
    position: "fixed",
    left: "-10000px",
    top: "0",
    width: `${width}px`,
  } as CSSStyleDeclaration);
  // The report is a whole document; only its style and body belong in a
  // foreignObject. `class="report"` is what carries the page's own rules —
  // they are scoped to that class precisely so they survive this trip.
  const style = html.match(/<style>([\s\S]*?)<\/style>/)?.[1] ?? "";
  const body = html.match(/<body[^>]*>([\s\S]*?)<\/body>/)?.[1] ?? html;
  host.innerHTML = `<style>${style}</style><div class="report">${body}</div>`;
  document.body.appendChild(host);
  try {
    const inner = host.querySelector<HTMLElement>(".report")!;
    // The panel snapshots are data URLs, but a data URL is still decoded
    // asynchronously. Measuring first gives figures of height zero, and the
    // report is then rasterised taller than the canvas and cut off at the
    // bottom — which is exactly what the first version shipped.
    await Promise.all(
      [...inner.querySelectorAll("img")].map((image) =>
        image.complete ? Promise.resolve() : image.decode().catch(() => undefined),
      ),
    );
    const box = inner.getBoundingClientRect();
    return {
      body:
        `<div xmlns="http://www.w3.org/1999/xhtml">` +
        `<style>${escapeForXml(style)}</style>` +
        `<div class="report">${toXhtml(inner.innerHTML)}</div></div>`,
      width: Math.max(1, Math.ceil(box.width)),
      height: Math.max(1, Math.ceil(box.height)),
    };
  } finally {
    host.remove();
  }
}

/**
 * Make serialised HTML parse as XML.
 *
 * `innerHTML` gives back `<img ...>` and `<br>` unclosed, which is valid HTML
 * and fatal inside an SVG. Ampersands that the browser left bare are escaped
 * too — it normalises most of them, but not inside attribute values it did not
 * rewrite.
 */
function toXhtml(markup: string): string {
  return markup
    .replace(/<(img|br|hr|input|meta|link)((?:[^<>"']|"[^"]*"|'[^']*')*?)\/?>/g, "<$1$2/>")
    .replace(/&(?!(?:[a-zA-Z][a-zA-Z0-9]*|#\d+|#x[0-9a-fA-F]+);)/g, "&amp;");
}

function escapeForXml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () =>
      reject(new Error("renderHtmlToCanvas: the browser could not draw the report"));
    image.src = src;
  });
}

/** The canvas as a PNG blob. */
export function canvasToPng(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error("canvasToPng: encoding failed"))),
      "image/png",
    );
  });
}

/**
 * The canvas as a paginated PDF.
 *
 * Written by hand rather than with a PDF library, which would be a large
 * dependency for one page type. Each page carries a **JPEG**, because a PDF
 * embeds JPEG data verbatim (`DCTDecode`) — a PNG would have to be decoded and
 * re-deflated here, which is where a hand-rolled writer would stop being
 * worth it.
 *
 * The image is sliced across pages at the printable width's aspect ratio, so
 * the report reads at the same size on every page instead of one tall page
 * shrunk to illegibility.
 */
export function canvasToPdf(canvas: HTMLCanvasElement, quality = 0.92): Blob {
  const printableWidth = PAGE_WIDTH - PAGE_MARGIN * 2;
  const printableHeight = PAGE_HEIGHT - PAGE_MARGIN * 2;
  // How many source pixels fill one page, at the scale that fits the width.
  const sliceHeight = Math.max(
    1,
    Math.round((canvas.width * printableHeight) / printableWidth),
  );
  const pages: Uint8Array[] = [];
  const heights: number[] = [];

  for (let top = 0; top < canvas.height; top += sliceHeight) {
    const height = Math.min(sliceHeight, canvas.height - top);
    const slice = document.createElement("canvas");
    slice.width = canvas.width;
    slice.height = height;
    const context = slice.getContext("2d");
    if (!context) throw new Error("canvasToPdf: no 2d context available");
    // JPEG has no transparency; without this, anything unpainted turns black.
    context.fillStyle = "#ffffff";
    context.fillRect(0, 0, slice.width, slice.height);
    context.drawImage(canvas, 0, -top);
    pages.push(dataUrlToBytes(slice.toDataURL("image/jpeg", quality)));
    heights.push(height);
  }

  return buildPdf(pages, heights, canvas.width);
}

function dataUrlToBytes(url: string): Uint8Array {
  const base64 = url.slice(url.indexOf(",") + 1);
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/**
 * A minimal PDF: catalogue, page tree, and one page per image.
 *
 * Offsets in the cross-reference table are **byte** offsets, so the file is
 * assembled as byte chunks and measured as it goes. Counting characters would
 * be correct only until the first non-ASCII byte in a JPEG.
 */
function buildPdf(images: Uint8Array[], heights: number[], imageWidth: number): Blob {
  const encoder = new TextEncoder();
  const chunks: Uint8Array[] = [];
  const offsets: number[] = [];
  let length = 0;

  const push = (data: string | Uint8Array) => {
    const bytes = typeof data === "string" ? encoder.encode(data) : data;
    chunks.push(bytes);
    length += bytes.length;
  };
  const startObject = (id: number) => {
    offsets[id] = length;
    push(`${id} 0 obj\n`);
  };

  const pageCount = images.length;
  // 1 catalogue, 2 page tree, then three objects per page.
  const pageId = (i: number) => 3 + i * 3;
  const contentId = (i: number) => 4 + i * 3;
  const imageId = (i: number) => 5 + i * 3;

  push("%PDF-1.4\n%âãÏÓ\n");

  startObject(1);
  push("<< /Type /Catalog /Pages 2 0 R >>\nendobj\n");

  startObject(2);
  const kids = images.map((_, i) => `${pageId(i)} 0 R`).join(" ");
  push(`<< /Type /Pages /Kids [${kids}] /Count ${pageCount} >>\nendobj\n`);

  const printableWidth = PAGE_WIDTH - PAGE_MARGIN * 2;

  images.forEach((jpeg, i) => {
    // Drawn at the width that fits the margins; the height follows the slice's
    // own aspect, so a short last page is short rather than stretched.
    const drawWidth = printableWidth;
    const drawHeight = (heights[i] / imageWidth) * printableWidth;
    const top = PAGE_HEIGHT - PAGE_MARGIN - drawHeight;

    startObject(pageId(i));
    push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PAGE_WIDTH.toFixed(2)} ` +
        `${PAGE_HEIGHT.toFixed(2)}] /Resources << /XObject << /Im0 ${imageId(i)} 0 R >> >> ` +
        `/Contents ${contentId(i)} 0 R >>\nendobj\n`,
    );

    const content =
      `q\n${drawWidth.toFixed(2)} 0 0 ${drawHeight.toFixed(2)} ` +
      `${PAGE_MARGIN.toFixed(2)} ${top.toFixed(2)} cm\n/Im0 Do\nQ\n`;
    startObject(contentId(i));
    push(`<< /Length ${encoder.encode(content).length} >>\nstream\n${content}endstream\nendobj\n`);

    startObject(imageId(i));
    push(
      `<< /Type /XObject /Subtype /Image /Width ${imageWidth} /Height ${heights[i]} ` +
        `/ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode ` +
        `/Length ${jpeg.length} >>\nstream\n`,
    );
    push(jpeg);
    push("\nendstream\nendobj\n");
  });

  const total = 2 + pageCount * 3;
  const xref = length;
  push(`xref\n0 ${total + 1}\n0000000000 65535 f \n`);
  for (let id = 1; id <= total; id += 1) {
    push(`${String(offsets[id]).padStart(10, "0")} 00000 n \n`);
  }
  push(`trailer\n<< /Size ${total + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`);

  return new Blob(chunks as BlobPart[], { type: "application/pdf" });
}
