/**
 * A modal that says one thing went wrong, and nothing else.
 *
 * For the case where an action the user asked for cannot happen at all —
 * distinct from a panel note, which describes the state of what is on screen.
 * A jump that does not move the view has nowhere else to report itself: the
 * panel it would have changed still looks perfectly fine, so a quiet line
 * beside it reads as decoration rather than as the answer to what was just
 * clicked.
 */

import { useEffect, useRef } from "react";

export function Notice({
  title,
  detail,
  confirm,
  busy = false,
  onDismiss,
}: {
  title: string;
  detail?: string | null;
  /**
   * Turns this into a question rather than a statement.
   *
   * Same box on purpose: a separate confirm dialog would be the same markup
   * with a second button, and two of them drift. The cancel path stays the
   * default action — Escape and the backdrop both dismiss, so the destructive
   * one is never what a stray keypress reaches.
   */
  confirm?: { label: string; onConfirm: () => void };
  busy?: boolean;
  onDismiss: () => void;
}) {
  const close = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    close.current?.focus();
    const key = (event: KeyboardEvent) => event.key === "Escape" && onDismiss();
    document.addEventListener("keydown", key);
    return () => document.removeEventListener("keydown", key);
  }, [onDismiss]);

  return (
    <div className="notice-backdrop" onClick={onDismiss}>
      <div
        className="notice"
        role="alertdialog"
        aria-modal="true"
        aria-label={title}
        onClick={(event) => event.stopPropagation()}
      >
        <p className="notice-title">{title}</p>
        {detail ? <p className="notice-detail">{detail}</p> : null}
        <div className="notice-actions">
          <button
            type="button"
            ref={close}
            className="back-button"
            onClick={onDismiss}
            disabled={busy}
          >
            {confirm ? "Cancel" : "OK"}
          </button>
          {confirm ? (
            <button
              type="button"
              className="primary danger"
              onClick={confirm.onConfirm}
              disabled={busy}
            >
              {busy ? "Removing…" : confirm.label}
            </button>
          ) : null}
        </div>
      </div>
    </div>
  );
}
