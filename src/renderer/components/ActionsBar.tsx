/** The Start Live / Start Recording pair plus the helper line. */

import { useDashboard } from '../hooks/useDashboard';

import { IconBroadcast, IconRecord } from './icons';
import { PrimaryActionButton } from './PrimaryActionButton';

export function ActionsBar() {
  const d = useDashboard();

  const live = d.streamState === 'streaming';
  const liveBusy = d.streamState === 'connecting' || d.streamState === 'stopping';
  const rec = d.recordingState === 'recording';
  const recBusy =
    d.recordingState === 'starting' ||
    d.recordingState === 'stopping' ||
    d.recordingState === 'finalising';
  const streamActive = d.streamState !== 'idle' && d.streamState !== 'error';
  const recordActive = d.recordingState !== 'idle' && d.recordingState !== 'error';

  return (
    <div className="actions">
      <PrimaryActionButton
        tone="green"
        icon={<IconBroadcast size={26} />}
        title={live ? 'Stop Live' : 'Start Live'}
        subtitle={live ? 'Streaming to Facebook' : 'Stream to Facebook'}
        active={live}
        busy={liveBusy}
        disabled={recordActive}
        degraded={d.networkDegraded}
        onClick={() => void d.toggleLive()}
      />
      <PrimaryActionButton
        tone="red"
        icon={<IconRecord size={26} />}
        title={rec ? 'Stop Recording' : 'Start Recording'}
        subtitle={rec ? 'Recording to this computer' : 'Record to this computer'}
        active={rec}
        busy={recBusy}
        disabled={streamActive}
        onClick={() => void d.toggleRecording()}
      />
      <p className="actions__hint">
        Stream or record — the camera runs one pipeline at a time.
      </p>
    </div>
  );
}
