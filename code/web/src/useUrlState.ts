/**
 * What you are looking at, in the URL.
 *
 * Without this, refreshing returns you to the chooser — which is wrong twice
 * over: a comparison of two large trees is expensive to get back to, and a URL
 * that does not name what it shows cannot be sent to anyone.
 *
 * The hash rather than the path, so no server rewrite rule is needed: the app
 * is served as static files behind nginx in the container, and a path-based
 * route would 404 on reload unless nginx were taught about it.
 */

import { useCallback, useEffect, useState } from "react";

export interface ViewState {
  /** The comparison being shown, or null for the chooser. */
  comparison: string | null;
  /** Root ids each side has navigated into, oldest first. */
  left: number[];
  right: number[];
}

const EMPTY: ViewState = { comparison: null, left: [], right: [] };

function parse(hash: string): ViewState {
  // #/c/<id>?l=3,900&r=12
  const match = /^#\/c\/([^?]+)(?:\?(.*))?$/.exec(hash);
  if (!match) return EMPTY;
  const query = new URLSearchParams(match[2] ?? "");
  const ids = (value: string | null): number[] =>
    (value ?? "")
      .split(",")
      .map((part) => Number.parseInt(part, 10))
      .filter((n) => Number.isFinite(n));
  return {
    comparison: decodeURIComponent(match[1]),
    left: ids(query.get("l")),
    right: ids(query.get("r")),
  };
}

function format(state: ViewState): string {
  if (!state.comparison) return "";
  const query = new URLSearchParams();
  if (state.left.length) query.set("l", state.left.join(","));
  if (state.right.length) query.set("r", state.right.join(","));
  const tail = query.toString();
  return `#/c/${encodeURIComponent(state.comparison)}${tail ? `?${tail}` : ""}`;
}

export function useUrlState(): [ViewState, (next: ViewState) => void] {
  const [state, setState] = useState<ViewState>(() => parse(window.location.hash));

  useEffect(() => {
    // Back and forward should move between views, not out of the app.
    const onHash = () => setState(parse(window.location.hash));
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  const write = useCallback((next: ViewState) => {
    const hash = format(next);
    if (hash === window.location.hash) return;
    // replaceState, not a hash assignment: navigating within a comparison
    // should not fill the history with one entry per expansion, or Back would
    // mean "undo one expand" rather than "leave this comparison".
    window.history.replaceState(null, "", hash || window.location.pathname);
    setState(next);
  }, []);

  return [state, write];
}
