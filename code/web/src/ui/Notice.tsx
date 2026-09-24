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
  onDismiss,
}: {
  title: string;
  detail?: string | null;
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
        <button type="button" ref={close} className="back-button" onClick={onDismiss}>
          OK
        </button>
      </div>
    </div>
  );
}
