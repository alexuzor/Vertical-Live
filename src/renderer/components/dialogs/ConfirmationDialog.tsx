/**
 * The stop-confirmation modal, reproduced from warning-modal.png.
 *
 * A single reusable component configured by a typed variant. Accessible:
 * role="alertdialog", focus trap, Escape-to-close (only when not busy), initial
 * focus on Cancel (so an accidental Enter never stops a broadcast), and focus
 * restored to the trigger on close. The background is inert while open.
 */

import { useCallback, useEffect, useId, useRef } from 'react';

import { IconAlertTriangle, IconX } from '../icons';

import type { ConfirmationDialogVariant } from './confirmationDialogContent';
import { confirmationContent } from './confirmationDialogContent';

export interface ConfirmationDialogProps {
  open: boolean;
  variant: ConfirmationDialogVariant;
  busy: boolean;
  onCancel: () => void;
  onConfirm: () => Promise<void> | void;
}

const FOCUSABLE =
  'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

export function ConfirmationDialog({
  open,
  variant,
  busy,
  onCancel,
  onConfirm,
}: ConfirmationDialogProps) {
  const content = confirmationContent[variant];
  const titleId = useId();
  const messageId = useId();
  const dialogRef = useRef<HTMLDivElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const restoreRef = useRef<HTMLElement | null>(null);

  // Remember the trigger and set initial focus on Cancel.
  useEffect(() => {
    if (!open) return;
    restoreRef.current = document.activeElement as HTMLElement | null;
    const focusTimer = window.setTimeout(() => cancelRef.current?.focus(), 0);

    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';

    return () => {
      window.clearTimeout(focusTimer);
      document.body.style.overflow = previousOverflow;
      restoreRef.current?.focus?.();
    };
  }, [open]);

  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      if (event.key === 'Escape') {
        if (!busy) {
          event.preventDefault();
          onCancel();
        }
        return;
      }

      if (event.key !== 'Tab') return;

      // Trap focus inside the dialog.
      const nodes = dialogRef.current?.querySelectorAll<HTMLElement>(FOCUSABLE);
      if (!nodes || nodes.length === 0) return;
      const list = Array.from(nodes).filter((node) => !node.hasAttribute('disabled'));
      const first = list[0];
      const last = list[list.length - 1];
      const activeEl = document.activeElement as HTMLElement | null;

      if (event.shiftKey && activeEl === first) {
        event.preventDefault();
        last?.focus();
      } else if (!event.shiftKey && activeEl === last) {
        event.preventDefault();
        first?.focus();
      }
    },
    [busy, onCancel],
  );

  if (!open) return null;

  const confirmClass =
    content.tone === 'green' ? 'modal__btn modal__btn--green' : 'modal__btn modal__btn--red';

  return (
    <div
      className="overlay"
      onMouseDown={(event) => {
        // Click on the dim area cancels (never confirms), unless busy.
        if (event.target === event.currentTarget && !busy) onCancel();
      }}
    >
      <div
        ref={dialogRef}
        className={`modal modal--${content.tone}`}
        role="alertdialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={messageId}
        onKeyDown={handleKeyDown}
      >
        <button
          type="button"
          className="modal__close"
          aria-label="Close confirmation"
          onClick={onCancel}
          disabled={busy}
        >
          <IconX size={17} />
        </button>

        <span className={`modal__icon modal__icon--${content.tone}`} aria-hidden="true">
          <IconAlertTriangle size={54} strokeWidth={2} />
        </span>

        <h2 className="modal__title" id={titleId}>
          {content.title}
        </h2>
        <p className="modal__message" id={messageId}>
          {content.message.map((line, index) => (
            <span key={index}>
              {line}
              {index < content.message.length - 1 ? <br /> : null}
            </span>
          ))}
        </p>

        <div className="modal__actions">
          <button
            ref={cancelRef}
            type="button"
            className="modal__btn modal__btn--cancel"
            onClick={onCancel}
            disabled={busy}
          >
            {content.cancelLabel}
          </button>
          <button
            type="button"
            className={confirmClass}
            onClick={() => void onConfirm()}
            disabled={busy}
          >
            {busy ? content.busyLabel : content.confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
