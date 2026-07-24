/** 3. STREAM QUALITY — bitrate preset, custom bitrate, encode meta line. */

import { useDashboard } from '../hooks/useDashboard';

import { IconChevronUpDown } from './icons';
import { Field, Panel, SelectField } from './primitives';

const BITRATE_OPTIONS = [
  { value: 'data-saver', label: 'Data Saver (2500 Kbps)' },
  { value: 'standard', label: 'Standard (3500 Kbps)' },
  { value: 'high', label: 'High (5000 Kbps)' },
  { value: 'maximum', label: 'Maximum (6000 Kbps)' },
  { value: 'custom', label: 'Custom' },
];

export function StreamQualityPanel() {
  const d = useDashboard();
  const gop = (Number.parseInt(d.fps, 10) || 30) * 2;

  return (
    <Panel num="2." title="STREAM QUALITY">
      <div className="quality">
        <Field label="Bitrate" htmlFor="bitrate-select">
          <SelectField
            id="bitrate-select"
            value={d.bitratePreset}
            onChange={d.setBitratePreset}
            options={BITRATE_OPTIONS}
          />
        </Field>

        <Field label="Custom Bitrate (Kbps)" htmlFor="custom-bitrate">
          <div className="numberfield">
            <input
              id="custom-bitrate"
              className="input input--number input--mono"
              type="number"
              inputMode="numeric"
              min={2000}
              max={6000}
              step={100}
              value={d.customBitrate}
              onChange={(event) => d.setCustomBitrate(event.target.value)}
            />
            <span className="numberfield__spin" aria-hidden="true">
              <IconChevronUpDown size={15} />
            </span>
          </div>
        </Field>
      </div>

      <div className="metaline">
        <span>
          <b>GOP:</b> {gop} (2 sec)
        </span>
        <span className="dot-sep">•</span>
        <span>
          <b>Keyframe:</b> 2s
        </span>
        <span className="dot-sep">•</span>
        <span>
          <b>Profile:</b> High
        </span>
        <span className="dot-sep">•</span>
        <span>
          <b>Level:</b> 4.1
        </span>
      </div>
    </Panel>
  );
}
