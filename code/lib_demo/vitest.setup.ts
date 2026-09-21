/**
 * Test setup for the demo application.
 *
 * jsdom parses <dialog> but implements none of its modal behaviour, so the
 * legend's "see more" popup would throw on showModal(). Model just enough of the
 * spec for tests to drive it: `open` reflects state, and close() fires the event
 * the caller cleans up on.
 *
 * The WebGL/ResizeObserver shims live in the library package, which is where the
 * code that needs them (TreeViewer) now lives.
 */
if (typeof HTMLDialogElement !== "undefined" && !HTMLDialogElement.prototype.showModal) {
  HTMLDialogElement.prototype.showModal = function showModal(this: HTMLDialogElement) {
    this.open = true;
  };
  HTMLDialogElement.prototype.close = function close(this: HTMLDialogElement) {
    this.open = false;
    this.dispatchEvent(new Event("close"));
  };
}
