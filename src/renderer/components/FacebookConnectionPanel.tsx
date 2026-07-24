/** FACEBOOK CONNECTION — RTMP(S) URL, masked stream key, test + status. */

import { useDashboard } from '../hooks/useDashboard';

import { IconCheckCircle, IconEye, IconEyeOff, IconSignal } from './icons';
import { Field, Panel } from './primitives';

export function FacebookConnectionPanel() {
  const d = useDashboard();
  const placeholder = d.hasStoredKey ? '•••••••••• (saved) ••••••••••' : '••••••••••••••••••••••••••';
  const testing = d.connectionState === 'testing';

  return (
    <Panel num="3." title="FACEBOOK CONNECTION">
      <div className="fb__grid">
        <Field label="RTMP(S) URL" htmlFor="rtmp-url">
          <input
            id="rtmp-url"
            className="input input--mono"
            type="text"
            spellCheck={false}
            autoComplete="off"
            value={d.serverUrl}
            onChange={(event) => d.setServerUrl(event.target.value)}
          />
        </Field>

        <Field label="Stream Key" htmlFor="stream-key">
          <div className="fb__keyrow">
            <input
              id="stream-key"
              className="input input--mono"
              type={d.keyRevealed ? 'text' : 'password'}
              spellCheck={false}
              autoComplete="off"
              placeholder={placeholder}
              value={d.streamKey}
              onChange={(event) => d.setStreamKey(event.target.value)}
            />
            <button
              type="button"
              className="iconbtn"
              aria-label={d.keyRevealed ? 'Hide stream key' : 'Reveal stream key'}
              aria-pressed={d.keyRevealed}
              onClick={d.toggleKeyRevealed}
            >
              {d.keyRevealed ? <IconEyeOff size={17} /> : <IconEye size={17} />}
            </button>
          </div>
        </Field>

        <div className={`fb__status fb__status--${d.connectionState}`}>
          <IconCheckCircle size={16} />
          {d.connectionMessage}
        </div>

        <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
          <button
            type="button"
            className="btn"
            onClick={() => void d.testConnection()}
            disabled={testing}
          >
            <span className="btn__icon">
              <IconSignal size={16} />
            </span>
            {testing ? 'Testing…' : 'Test Connection'}
          </button>
        </div>
      </div>
    </Panel>
  );
}
