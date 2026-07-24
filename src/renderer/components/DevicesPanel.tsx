/** 1. DEVICES — camera, resolution, fps, microphone, audio monitoring. */

import { useDashboard } from '../hooks/useDashboard';

import { AudioLevelMeter } from './AudioLevelMeter';
import { IconCamera, IconMic, IconRefresh } from './icons';
import { Field, Panel, SelectField } from './primitives';
import { ToggleSwitch } from './ToggleSwitch';

export function DevicesPanel() {
  const d = useDashboard();

  return (
    <Panel
      num="1."
      title="DEVICES"
      aside={
        <button
          type="button"
          className="linkbtn"
          onClick={() => void d.refreshDevices()}
          disabled={d.devicesLoading}
        >
          <IconRefresh size={15} />
          {d.devicesLoading ? 'Scanning…' : 'Refresh'}
        </button>
      }
    >
      <div className="devices">
        <Field label="Camera" htmlFor="camera-select">
          <SelectField
            id="camera-select"
            value={d.camera}
            onChange={d.setCamera}
            icon={<IconCamera size={16} />}
            options={d.cameras.map((c) => ({ value: c.id, label: c.label }))}
          />
        </Field>

        <Field label="Stream Resolution" htmlFor="res-value">
          <input
            id="res-value"
            className="input input--mono"
            type="text"
            readOnly
            value="720 × 1280 (9:16)"
            title="The Facebook output is a fixed vertical 720×1280 (recording is 1080×1920)."
          />
        </Field>

        <Field label="FPS" htmlFor="fps-select">
          <SelectField
            id="fps-select"
            value={d.fps}
            onChange={d.setFps}
            options={[
              { value: '24', label: '24' },
              { value: '25', label: '25' },
              { value: '30', label: '30' },
            ]}
          />
        </Field>

        <Field label="Microphone" htmlFor="mic-select">
          <SelectField
            id="mic-select"
            value={d.microphone}
            onChange={d.setMicrophone}
            icon={<IconMic size={16} />}
            options={d.microphones.map((m) => ({ value: m.id, label: m.label }))}
          />
        </Field>

        <div className="field devices__monitoring">
          <span className="field__label">Audio Monitoring</span>
          <div className="monitoring">
            <ToggleSwitch
              checked={d.monitoring}
              onChange={d.setMonitoring}
              ariaLabel="Audio monitoring"
            />
            <span className="monitoring__label">{d.monitoring ? 'Enabled' : 'Disabled'}</span>
            <AudioLevelMeter active={d.monitoring} level={d.audioLevel} />
          </div>
        </div>

        <div className="field devices__sync">
          <span className="field__label">
            A/V Sync Offset
            <span className="field__hint">+ delays audio, − advances it</span>
          </span>
          <div className="sync">
            <button
              type="button"
              className="sync__step"
              aria-label="Decrease audio offset by 10 ms"
              onClick={() => d.setAudioSyncOffset(d.audioSyncOffsetMs - 10)}
            >
              −
            </button>
            <div className="sync__value">
              <input
                className="input input--mono sync__input"
                type="number"
                step={10}
                value={Number.isFinite(d.audioSyncOffsetMs) ? d.audioSyncOffsetMs : 0}
                aria-label="Audio sync offset in milliseconds"
                onChange={(event) => {
                  const next = Number.parseInt(event.target.value, 10);
                  d.setAudioSyncOffset(Number.isFinite(next) ? next : 0);
                }}
              />
              <span className="sync__unit">ms</span>
            </div>
            <button
              type="button"
              className="sync__step"
              aria-label="Increase audio offset by 10 ms"
              onClick={() => d.setAudioSyncOffset(d.audioSyncOffsetMs + 10)}
            >
              +
            </button>
          </div>
        </div>
      </div>
    </Panel>
  );
}
