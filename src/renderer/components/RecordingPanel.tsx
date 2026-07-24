/** 5. RECORDING — path, browse/open, quality, disk + output helpers. */

import { useDashboard } from '../hooks/useDashboard';

import { IconFolder, IconFolderOpen } from './icons';
import { Field, Panel } from './primitives';

export function RecordingPanel() {
  const d = useDashboard();

  return (
    <Panel num="4." title="RECORDING">
      <div className="rec">
        <Field label="Recording Path" htmlFor="rec-path">
          <input
            id="rec-path"
            className="input input--mono"
            type="text"
            spellCheck={false}
            readOnly
            placeholder="Choose a folder…"
            value={d.recordingPath}
          />
        </Field>

        <button type="button" className="btn" onClick={() => void d.browseFolder()}>
          <span className="btn__icon">
            <IconFolder size={16} />
          </span>
          Browse
        </button>

        <button type="button" className="btn" onClick={() => void d.openFolder()}>
          <span className="btn__icon">
            <IconFolderOpen size={16} />
          </span>
          Open
        </button>
      </div>

      <div className="rec__foot">
        <span>
          Space Available: <b>{d.freeDiskLabel}</b>
        </span>
        <span>
          Files will be saved as <b>1080 × 1920</b> <span className="dot-sep">•</span>{' '}
          <b>H.264 (MP4)</b> <span className="dot-sep">•</span> <b>≈10 Mbps</b>
        </span>
      </div>
    </Panel>
  );
}
