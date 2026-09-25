/**
 * A dropdown that stays open while you tick several things.
 *
 * Shaped like a normal select when closed, so it sits beside one as a pair,
 * and opening onto checkboxes so adding a second choice is a plain click. A
 * native `<select multiple>` cannot be this: browsers render it as a
 * permanently expanded list box, and adding an option needs Ctrl/Cmd-click,
 * which nothing on screen can tell you.
 *
 * **It must not be placed inside a scrolling ancestor.** The menu is
 * absolutely positioned and opens out of its parent's box; an
 * overflow-scrolling ancestor clips it away entirely, and clicks then land on
 * whatever is behind. That cost an afternoon once.
 */

import { Fragment, useEffect, useRef, useState } from "react";

export interface CheckboxItem {
  key: string;
  label: string;
  checked: boolean;
  /** Shown smaller under the label. */
  note?: string;
  /**
   * Radio items with the same `group` are mutually exclusive, and clicking one
   * that is already on does nothing — the menu still holds independent toggles
   * alongside them, which is why this is per item rather than per menu.
   */
  group?: string;
  /** A labelled rule above this item, separating it from what precedes it. */
  heading?: string;
}

export function CheckboxMenu({
  title,
  summary,
  items,
  onToggle,
  align = "left",
  openUpward = false,
}: {
  /** Static text before the button, e.g. "Colour by". Omit for a bare button. */
  title?: string;
  /** What the closed button reads. */
  summary: string;
  items: CheckboxItem[];
  onToggle: (key: string) => void;
  align?: "left" | "right";
  openUpward?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const away = (event: MouseEvent) => {
      if (!ref.current?.contains(event.target as Node)) setOpen(false);
    };
    const key = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      // Claimed, so an Escape that closed the menu does not also act underneath.
      event.preventDefault();
      setOpen(false);
    };
    document.addEventListener("mousedown", away);
    document.addEventListener("keydown", key);
    return () => {
      document.removeEventListener("mousedown", away);
      document.removeEventListener("keydown", key);
    };
  }, [open]);

  return (
    <div className="checkbox-menu" ref={ref}>
      {title ? <span className="menu-title">{title}</span> : null}
      <button
        type="button"
        className="picker-button"
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
      >
        <span className="picker-summary">{summary}</span>
        <span aria-hidden="true">▾</span>
      </button>

      {open ? (
        <div
          className={`picker-menu${align === "right" ? " right" : ""}${openUpward ? " up" : ""}`}
          role="group"
          aria-label={title ?? summary}
        >
          {items.map((item) => (
            <Fragment key={item.key}>
              {item.heading ? <span className="menu-heading">{item.heading}</span> : null}
              <label>
                <input
                  type={item.group ? "radio" : "checkbox"}
                  name={item.group}
                  checked={item.checked}
                  onChange={() => onToggle(item.key)}
                />
                <span>
                  {item.label}
                  {item.note ? <span className="menu-note">{item.note}</span> : null}
                </span>
              </label>
            </Fragment>
          ))}
        </div>
      ) : null}
    </div>
  );
}
