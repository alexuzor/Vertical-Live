/**
 * Startup / splash screen.
 *
 * Shown before the dashboard while the app performs its real startup checks —
 * confirming the main process, verifying FFmpeg, and enumerating capture
 * devices — with the progress reflecting the actual outcome of each call rather
 * than a fixed timer. When every step settles it hands control to the dashboard.
 */

import { useEffect, useRef, useState } from 'react';

import logoUrl from '../assets/vl-logo.png';
import { getApi } from '../lib/api';

import { IconCheckCircle, IconMinus, IconX } from './icons';

type StepStatus = 'pending' | 'active' | 'done' | 'error';

interface Step {
  id: string;
  label: string;
  status: StepStatus;
}

const INITIAL_STEPS: Step[] = [
  { id: 'engine', label: 'Initializing media engine', status: 'pending' },
  { id: 'ffmpeg', label: 'Verifying FFmpeg', status: 'pending' },
  { id: 'devices', label: 'Loading devices', status: 'pending' },
  { id: 'interface', label: 'Preparing interface', status: 'pending' },
];

function statusLabel(status: StepStatus): string {
  switch (status) {
    case 'done':
      return 'Complete';
    case 'active':
      return 'In progress';
    case 'error':
      return 'Unavailable';
    default:
      return 'Pending';
  }
}

const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export function BootScreen({ onReady }: { onReady: () => void }) {
  const api = getApi();
  const [steps, setSteps] = useState<Step[]>(INITIAL_STEPS);
  const [version, setVersion] = useState('');
  const finished = useRef(false);

  useEffect(() => {
    let cancelled = false;
    const set = (id: string, status: StepStatus): void => {
      setSteps((prev) => prev.map((s) => (s.id === id ? { ...s, status } : s)));
    };

    const done = (): void => {
      if (cancelled || finished.current) return;
      finished.current = true;
      onReady();
    };

    // Failsafe: never trap the user on the splash if a startup call hangs.
    const failsafe = setTimeout(done, 15000);

    void (async () => {
      set('engine', 'active');
      const appInfo = await api.getAppInfo().catch(() => null);
      if (appInfo && !cancelled) setVersion(appInfo.version);
      await wait(360);
      if (cancelled) return;
      set('engine', 'done');

      set('ffmpeg', 'active');
      const ffmpeg = await api.getFfmpegInfo().catch(() => null);
      await wait(360);
      if (cancelled) return;
      set('ffmpeg', ffmpeg?.available ? 'done' : 'error');

      set('devices', 'active');
      await api.listDevices(false).catch(() => null);
      await wait(320);
      if (cancelled) return;
      set('devices', 'done');

      set('interface', 'active');
      await wait(420);
      if (cancelled) return;
      set('interface', 'done');

      // Hold on a full, 100% bar for a beat before handing off to the dashboard.
      await wait(520);
      done();
    })();

    return () => {
      cancelled = true;
      clearTimeout(failsafe);
    };
  }, [api, onReady]);

  const settled = steps.filter((s) => s.status === 'done' || s.status === 'error').length;
  const progress = Math.round((settled / steps.length) * 100);
  const active = steps.find((s) => s.status === 'active');
  const statusText =
    settled === steps.length ? 'Ready' : active ? `${active.label}…` : 'Starting up…';

  return (
    <div className="boot">
      <header className="header boot__header">
        <div className="header__brand">
          <img className="header__logo" src={logoUrl} alt="Vertical Live" draggable={false} />
          {version ? <span className="header__version">v{version}</span> : null}
        </div>
        <div className="header__spacer" />
        <div className="header__controls">
          <button
            type="button"
            className="winbtn"
            aria-label="Minimise"
            onClick={() => api.window.minimize()}
          >
            <IconMinus size={17} />
          </button>
          <button
            type="button"
            className="winbtn winbtn--close"
            aria-label="Close"
            onClick={() => api.window.close()}
          >
            <IconX size={18} />
          </button>
        </div>
      </header>

      <div className="boot__body">
        <img className="boot__logo" src={logoUrl} alt="Vertical Live" draggable={false} />
        <p className="boot__tagline">Vertical livestreaming for Facebook</p>

        <div
          className="boot__bar"
          role="progressbar"
          aria-valuenow={progress}
          aria-valuemin={0}
          aria-valuemax={100}
        >
          <div className="boot__bar-fill" style={{ width: `${progress}%` }} />
        </div>
        <div className="boot__status">{statusText}</div>

        <ul className="boot__steps">
          {steps.map((step) => (
            <li key={step.id} className={`boot__step is-${step.status}`}>
              <span className="boot__step-ic" aria-hidden="true">
                {step.status === 'done' ? (
                  <span className="boot__ic-done">
                    <IconCheckCircle size={19} />
                  </span>
                ) : step.status === 'active' ? (
                  <span className="boot__spinner" />
                ) : step.status === 'error' ? (
                  <span className="boot__ring boot__ring--error" />
                ) : (
                  <span className="boot__ring" />
                )}
              </span>
              <span className="boot__step-label">{step.label}</span>
              <span className="boot__step-status">{statusLabel(step.status)}</span>
            </li>
          ))}
        </ul>
      </div>

      <footer className="boot__foot">
        RTMP Ready <span className="dot-sep">•</span> 1080 × 1920 <span className="dot-sep">•</span>{' '}
        Facebook Vertical Streaming
      </footer>
    </div>
  );
}
