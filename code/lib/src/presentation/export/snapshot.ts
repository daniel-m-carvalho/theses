/**
 * A picture of what a viewer is currently showing.
 *
 * Harder than "grab the canvas", and worth saying why. A panel is drawn in two
 * layers: Sigma renders branches, node markers and labels onto stacked
 * `<canvas>` elements, while the clade wedges and the bar charts are **DOM
 * overlays** positioned on top. Compositing only the canvases would produce an
 * image missing exactly the things this project added — every collapsed clade
 * and every isolate bar.
 *
 * So the canvases are drawn first, in order, and the overlays are rasterised
 * on top by serialising them into an SVG `foreignObject`. That works here
 * because the overlays are built with **inline styles** (see
 * `CladeShapePresenter` and `BarChartPresenter`), so the serialised markup
 * carries its own appearance and needs no stylesheet to travel with it.
 *
 * If the overlay pass fails the canvas composite is still returned: an image
 * of the branches alone is worth more than an exception in the middle of
 * someone's report.
 */

import type { TreeViewer } from "../viewer/tree_viewer";

export interface SnapshotOptions {
  /** Pixel ratio; 2 gives a print-quality image. Default 2. */
  scale?: number;
  /** Painted behind everything. Default white — reports are printed. */
  background?: string;
}

export async function snapshotViewer(
  viewer: TreeViewer,
  options: SnapshotOptions = {},
): Promise<string> {
  const container = viewer.getContainer();
  const width = container.clientWidth;
  const height = container.clientHeight;
  if (!width || !height) {
    throw new Error("snapshotViewer: the viewer's container has no size");
  }

  const scale = options.scale ?? 2;
  const out = document.createElement("canvas");
  out.width = Math.round(width * scale);
  out.height = Math.round(height * scale);
  const context = out.getContext("2d");
  if (!context) throw new Error("snapshotViewer: no 2d context available");

  context.scale(scale, scale);
  context.fillStyle = options.background ?? "#ffffff";
  context.fillRect(0, 0, width, height);

  const renderer = viewer.getRenderer();
  if (renderer) {
    /**
     * Render and read in the **same synchronous block**, with nothing awaited
     * between them.
     *
     * Sigma draws branches and markers through WebGL, and a WebGL drawing
     * buffer is only guaranteed to hold its contents until the browser next
     * composites — after that it may be cleared, and `drawImage` yields a
     * blank. That is not hypothetical: reading the canvases without this gave
     * a report whose pictures had the wedges and the legend, drawn as DOM
     * overlays, and no tree at all.
     *
     * `preserveDrawingBuffer` would be the other fix, but Sigma only exposes
     * it per layer at creation, not through the settings a consumer passes.
     */
    renderer.refresh();
    for (const canvas of Object.values(renderer.getCanvases())) {
      context.drawImage(canvas, 0, 0, width, height);
    }
  }

  // Only now may control leave this function: the canvases have been read.
  for (const layer of overlayLayers(container)) {
    try {
      const image = await rasterise(layer, width, height);
      context.drawImage(image, 0, 0, width, height);
    } catch {
      // Degrade rather than fail: see the module docstring.
    }
  }

  return out.toDataURL("image/png");
}

/** The operators' absolutely-positioned layers, in stacking order. */
function overlayLayers(container: HTMLElement): HTMLElement[] {
  return [...container.children].filter(
    (child): child is HTMLElement =>
      child instanceof HTMLElement &&
      child.tagName !== "CANVAS" &&
      getComputedStyle(child).position === "absolute",
  );
}

/** Draw a DOM subtree into an image via an SVG foreignObject. */
function rasterise(element: HTMLElement, width: number, height: number): Promise<HTMLImageElement> {
  const markup = new XMLSerializer().serializeToString(element);
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">` +
    `<foreignObject width="100%" height="100%">` +
    `<div xmlns="http://www.w3.org/1999/xhtml" style="width:${width}px;height:${height}px">` +
    markup +
    `</div></foreignObject></svg>`;

  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("overlay could not be rasterised"));
    image.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
  });
}
