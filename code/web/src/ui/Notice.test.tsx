// @vitest-environment jsdom
/**
 * The only thing that speaks when a jump cannot be made.
 *
 * Worth a test because it is the *failure* path: the panel it would have
 * changed still looks fine, so if this does not appear, nothing else says the
 * click did anything.
 */

import { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";
import { Notice } from "./Notice";

function render(node: React.ReactElement) {
  const host = document.createElement("div");
  document.body.appendChild(host);
  act(() => {
    createRoot(host).render(node);
  });
  return host;
}

describe("Notice", () => {
  it("shows what went wrong and why", () => {
    const host = render(
      <Notice title="That leaf could not be located" detail="No such route" onDismiss={() => {}} />,
    );
    expect(host.textContent).toContain("That leaf could not be located");
    expect(host.textContent).toContain("No such route");
  });

  it("dismisses on the button, the backdrop and Escape", () => {
    for (const close of [
      (host: HTMLElement) => host.querySelector("button")!.click(),
      (host: HTMLElement) => host.querySelector<HTMLElement>(".notice-backdrop")!.click(),
      () => document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" })),
    ]) {
      const onDismiss = vi.fn();
      const host = render(<Notice title="nope" onDismiss={onDismiss} />);
      act(() => close(host));
      expect(onDismiss).toHaveBeenCalled();
    }
  });

  it("asks rather than tells when given a confirm action", () => {
    const onConfirm = vi.fn();
    const host = render(
      <Notice
        title="Remove a vs b?"
        confirm={{ label: "Remove", onConfirm }}
        onDismiss={() => {}}
      />,
    );
    const labels = [...host.querySelectorAll("button")].map((b) => b.textContent);
    // Cancel first and focused: the destructive one must not be what a stray
    // Return key reaches.
    expect(labels).toEqual(["Cancel", "Remove"]);
    expect(document.activeElement?.textContent).toBe("Cancel");

    host.querySelectorAll("button")[1].click();
    expect(onConfirm).toHaveBeenCalled();
  });

  it("keeps Escape and the backdrop on the safe path when confirming", () => {
    // Both dismiss, neither confirms — otherwise the fastest way out of the
    // dialog would be the irreversible one.
    const onConfirm = vi.fn();
    const onDismiss = vi.fn();
    const host = render(
      <Notice title="Remove?" confirm={{ label: "Remove", onConfirm }} onDismiss={onDismiss} />,
    );
    act(() => host.querySelector<HTMLElement>(".notice-backdrop")!.click());
    act(() => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    });
    expect(onDismiss).toHaveBeenCalledTimes(2);
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it("disables both actions while the work is running", () => {
    // A second click on Remove would be a second DELETE, and the first has
    // already made the row a 404.
    const host = render(
      <Notice
        title="Remove?"
        confirm={{ label: "Remove", onConfirm: () => {} }}
        busy
        onDismiss={() => {}}
      />,
    );
    expect([...host.querySelectorAll("button")].every((b) => b.disabled)).toBe(true);
  });

  it("does not dismiss when the message itself is clicked", () => {
    // Otherwise selecting the text to copy it closes the thing being read.
    const onDismiss = vi.fn();
    const host = render(<Notice title="nope" onDismiss={onDismiss} />);
    act(() => host.querySelector<HTMLElement>(".notice")!.click());
    expect(onDismiss).not.toHaveBeenCalled();
  });
});
