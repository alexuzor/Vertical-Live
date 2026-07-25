/** Bottom status strip: system/CPU/FPS/bitrate + View Logs / Diagnostics. */

import { useDashboard } from '../hooks/useDashboard';

import { IconDiagnostics, IconLogs } from './icons';

export function AppFooter() {
  const d = useDashboard();

  return (
    <footer className="footer">
      <span className="footer__item">
        <span
          className="footer__dot"
          data-ok={d.systemStatus.ok ? 'true' : 'false'}
          aria-hidden="true"
        />
        {d.systemStatus.label}
      </span>
      <span className="footer__item">
        <span className="k">CPU:</span>
        <span className="v">{d.cpu}%</span>
      </span>
      <span className="footer__item">
        <span className="k">FPS:</span>
        <span className="v">{d.liveFps || '—'}</span>
      </span>
      <span className="footer__item">
        <span className="k">Bitrate:</span>
        <span className="v">
          {d.bitrateMbps > 0 ? `${d.bitrateMbps.toFixed(1)} Mbps` : '—'}
        </span>
      </span>

      <span className="footer__spacer" />

      <button type="button" className="footer__btn" onClick={() => void d.viewLogs()}>
        <span className="footer__btn-icon">
          <IconLogs size={15} />
        </span>
        View Logs
      </button>
      <button type="button" className="footer__btn" onClick={() => void d.diagnostics()}>
        <span className="footer__btn-icon">
          <IconDiagnostics size={15} />
        </span>
        Diagnostics
      </button>
    </footer>
  );
}
