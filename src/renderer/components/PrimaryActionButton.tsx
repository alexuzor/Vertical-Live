/**
 * The two large toggle actions. The camera drives a single pipeline, so the two
 * are mutually exclusive: while one is active the other is disabled. Clicking an
 * active button opens its confirmation modal (handled by the controller) rather
 * than stopping immediately.
 */

import type { ReactNode } from 'react';

export function PrimaryActionButton({
  tone,
  icon,
  title,
  subtitle,
  active,
  busy,
  disabled = false,
  degraded = false,
  onClick,
}: {
  tone: 'green' | 'red';
  icon: ReactNode;
  title: string;
  subtitle: string;
  active: boolean;
  busy: boolean;
  disabled?: boolean;
  degraded?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      className={`action action--${tone}${active ? ' is-active' : ''}${degraded ? ' is-degraded' : ''}`}
      aria-pressed={active}
      disabled={busy || disabled}
      onClick={onClick}
    >
      <span className="action__icon">{icon}</span>
      <span className="action__labels">
        <span className="action__title">{busy ? 'Working…' : title}</span>
        <span className="action__sub">{degraded ? 'Weak network — buffering' : subtitle}</span>
      </span>
    </button>
  );
}
