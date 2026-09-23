/**
 * A minimal hook runner.
 *
 * React Testing Library would do this, but it is a dependency and a peer
 * dependency for one file. `react-dom/server` cannot run effects, so this uses
 * the real client renderer against a detached container.
 */

import { act as reactAct } from "react";
import { createRoot, type Root } from "react-dom/client";
import { createElement } from "react";

export function act(fn: () => void): void {
  reactAct(() => {
    fn();
  });
}

export function renderHook<T>(hook: () => T): { result: { current: T } } {
  const result = { current: undefined as unknown as T };
  const container = document.createElement("div");
  document.body.appendChild(container);
  let root: Root;

  function Probe() {
    result.current = hook();
    return null;
  }

  reactAct(() => {
    root = createRoot(container);
    root.render(createElement(Probe));
  });

  return { result };
}
