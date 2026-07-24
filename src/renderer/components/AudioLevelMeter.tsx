/**
 * Audio level meter.
 *
 * `active` reflects whether audio monitoring is armed (the mic toggle). When it
 * is off the whole meter is greyed out — no lit bars at all.
 *
 * `level` is the live input level in the range 0..1, measured by the FFmpeg
 * pipeline (the renderer is sandboxed and cannot read the mic itself). While a
 * measurement is flowing the lit bars track it; before any measurement arrives
 * `level` is 0, so an armed-but-silent mic reads as a quiet floor rather than a
 * fabricated fill.
 */

const BAR_COUNT = 26;
/** Bars from this index up are yellow, then red for the final few. */
const YELLOW_FROM = 19;
const RED_FROM = 23;

function zoneClass(index: number): string {
  if (index >= RED_FROM) return 'zone-red';
  if (index >= YELLOW_FROM) return 'zone-yellow';
  return 'zone-green';
}

export function AudioLevelMeter({ active, level }: { active: boolean; level?: number }) {
  const hasSignal = typeof level === 'number';
  // Off → nothing lit (grey). On with a live measurement → light bars in
  // proportion to it. On without any measurement yet (live metering not wired
  // in this build) → a steady "armed" floor so the control never looks dead.
  const lit = !active
    ? 0
    : typeof level === 'number'
      ? Math.round(Math.max(0, Math.min(1, level)) * BAR_COUNT)
      : 11;

  return (
    <div
      className={`meter${active ? '' : ' meter--off'}`}
      role="img"
      aria-label={
        active ? (hasSignal ? 'Audio input level' : 'Audio monitoring armed') : 'Audio monitoring off'
      }
      title={
        active
          ? 'Microphone monitoring — audio is captured by the encoder during a session'
          : 'Audio monitoring is off'
      }
    >
      {Array.from({ length: BAR_COUNT }, (_, index) => (
        <span
          key={index}
          className={`meter__bar ${zoneClass(index)}${index < lit ? ' is-on' : ''}`}
        />
      ))}
    </div>
  );
}
