/**
 * The right-click menu.
 *
 * Actions live where the thing they act on is, rather than in a sidebar of
 * buttons that apply to whatever happens to be selected. The difference shows
 * up in what the menu can say: an item can be absent when it does not apply,
 * and can name its subject ("Expand 8,441 leaves") because it knows which node
 * was clicked.
 *
 * Items are supplied by the caller; this owns only presentation and dismissal.
 */

import { useEffect, useRef } from "react";

export interface MenuItem {
  label: string;
  /** Shown greyed with this reason instead of being actionable. */
  disabledBecause?: string;
  /** Secondary text: what the action will do, or what it costs. */
  detail?: string;
  onSelect?: () => void;
  /** Draws a divider above this item. */
  separated?: boolean;
}

export interface MenuPosition {
  x: number;
  y: number;
}

export function ContextMenu({
  at,
  title,
  items,
  onDismiss,
}: {
  at: MenuPosition;
  title?: string;
  items: MenuItem[];
  onDismiss: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    // Only a LEFT press dismisses. A right-click elsewhere is opening a new
    // menu, and dismissing on it was a bug: the viewer's handler runs first
    // (it listens on the container, this listens on the document, and events
    // bubble inward-out), so the new menu was set and then immediately torn
    // down by this — every right-click after the first appeared to do nothing.
    const away = (event: MouseEvent) => {
      if (event.button !== 0) return;
      if (!ref.current?.contains(event.target as Node)) onDismiss();
    };
    const key = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      // Claimed, so an Escape that closed the menu does not also act underneath.
      event.preventDefault();
      onDismiss();
    };
    document.addEventListener("mousedown", away);
    document.addEventListener("keydown", key);
    window.addEventListener("resize", onDismiss);
    return () => {
      document.removeEventListener("mousedown", away);
      document.removeEventListener("keydown", key);
      window.removeEventListener("resize", onDismiss);
    };
  }, [onDismiss]);

  useEffect(() => {
    // Keep it on screen when opened near an edge.
    const element = ref.current;
    if (!element) return;
    const box = element.getBoundingClientRect();
    if (box.right > window.innerWidth) {
      element.style.left = `${Math.max(4, window.innerWidth - box.width - 4)}px`;
    }
    if (box.bottom > window.innerHeight) {
      element.style.top = `${Math.max(4, window.innerHeight - box.height - 4)}px`;
    }
  }, [at]);

  return (
    <div
      ref={ref}
      className="context-menu"
      style={{ left: at.x, top: at.y }}
      role="menu"
      aria-label={title ?? "Actions"}
    >
      {title ? <p className="context-menu-title">{title}</p> : null}
      {items.map((item, index) => (
        <button
          key={`${item.label}-${index}`}
          type="button"
          role="menuitem"
          className={item.separated ? "context-menu-item separated" : "context-menu-item"}
          disabled={Boolean(item.disabledBecause) || !item.onSelect}
          title={item.disabledBecause}
          onClick={() => {
            item.onSelect?.();
            onDismiss();
          }}
        >
          <span>{item.label}</span>
          {item.detail || item.disabledBecause ? (
            <span className="context-menu-detail">
              {item.disabledBecause ?? item.detail}
            </span>
          ) : null}
        </button>
      ))}
    </div>
  );
}
