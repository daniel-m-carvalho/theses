/**
 * Test setup: shim the WebGL globals jsdom does not implement.
 *
 * Sigma probes `WebGL2RenderingContext` at *module load*, so merely importing
 * anything that reaches `sigma` (e.g. TreeViewer) throws a ReferenceError under
 * jsdom before a single test runs. These stubs exist only to let the module
 * import; no test renders through WebGL — viewer tests cover state and event
 * behaviour, which is the part worth unit-testing anyway. Rendering itself needs
 * a real GPU context and belongs in a browser-level test.
 */
class WebGLRenderingContextStub {}
class WebGL2RenderingContextStub {}

const g = globalThis as Record<string, unknown>;
g.WebGLRenderingContext ??= WebGLRenderingContextStub;
g.WebGL2RenderingContext ??= WebGL2RenderingContextStub;

// jsdom *defines* getContext but throws "Not implemented" and logs on every
// call, which floods the output when an operator measures text. Replace it
// outright with a null-returning stub so callers take their documented
// "no context available" fallback path (BarChartPresenter estimates label
// widths from character count) quietly.
if (typeof HTMLCanvasElement !== "undefined") {
  HTMLCanvasElement.prototype.getContext = (() => null) as never;
}

// jsdom has no ResizeObserver, which the viewer installs to keep the tree
// centered when its container changes size. This stub records observers so a
// test can fire them; nothing here measures anything (jsdom has no layout).
if (typeof globalThis.ResizeObserver === "undefined") {
  class ResizeObserverStub {
    static instances: ResizeObserverStub[] = [];
    observed = new Set<Element>();
    constructor(private callback: () => void) {
      ResizeObserverStub.instances.push(this);
    }
    observe(el: Element): void {
      this.observed.add(el);
    }
    unobserve(el: Element): void {
      this.observed.delete(el);
    }
    disconnect(): void {
      this.observed.clear();
    }
    /** Test-only: pretend the observed element resized. */
    trigger(): void {
      this.callback();
    }
  }
  (globalThis as Record<string, unknown>).ResizeObserver = ResizeObserverStub;
}

// jsdom parses <dialog> but implements none of its modal behaviour, so the
// legend's "see more" popup would throw on showModal(). Model just enough of the
// spec for tests to drive it: `open` reflects state, and close() fires the event
// the caller cleans up on.
if (typeof HTMLDialogElement !== "undefined" && !HTMLDialogElement.prototype.showModal) {
  HTMLDialogElement.prototype.showModal = function showModal(this: HTMLDialogElement) {
    this.open = true;
  };
  HTMLDialogElement.prototype.close = function close(this: HTMLDialogElement) {
    this.open = false;
    this.dispatchEvent(new Event("close"));
  };
}
