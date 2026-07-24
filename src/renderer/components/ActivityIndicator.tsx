/**
 * Header status pill — single line: bulb + label + live timer. It is also a
 * control: clicking starts the activity when idle, or opens the stop
 * confirmation when active (same behaviour as the big action buttons).
 */

export function ActivityIndicator({
  tone,
  label,
  timer,
  active,
  busy,
  degraded = false,
  onClick,
}: {
  tone: 'green' | 'red';
  label: string;
  timer: string;
  active: boolean;
  busy: boolean;
  degraded?: boolean;
  onClick: () => void;
}) {
  const verb = active ? 'Stop' : 'Start';
  const noun = tone === 'green' ? 'live stream' : 'recording';
  const health = degraded ? ' — weak network, buffering' : '';
  return (
    <button
      type="button"
      className={`activity activity--${tone}${active ? ' is-active' : ''}${degraded ? ' is-degraded' : ''}`}
      aria-label={`${verb} ${noun} — currently ${active ? `active, ${timer}${health}` : 'inactive'}`}
      aria-pressed={active}
      disabled={busy}
      onClick={onClick}
    >
      <span className="activity__bulb" aria-hidden="true" />
      <span className="activity__label">{degraded ? 'WEAK NET' : label}</span>
      <span className={`activity__timer${active ? ' is-active' : ''}`}>{timer}</span>
    </button>
  );
}
