/** Transient bottom-centre message for demo / non-wired actions. */

import { useDashboard } from '../hooks/useDashboard';

import { IconCheckCircle } from './icons';

export function Toast() {
  const { toast } = useDashboard();
  if (!toast) return null;
  return (
    <div className={`toast toast--${toast.tone}`} role="status" aria-live="polite" key={toast.id}>
      <span className="toast__icon">
        <IconCheckCircle size={16} />
      </span>
      {toast.text}
    </div>
  );
}
