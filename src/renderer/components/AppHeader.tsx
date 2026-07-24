/** Top title bar: brand, version, activity pills, settings + window controls. */

import logoUrl from '../assets/vl-logo.png';
import { useDashboard } from '../hooks/useDashboard';
import { formatClock } from '../utils/time';

import { ActivityIndicator } from './ActivityIndicator';
import { IconMinus, IconRestore, IconSquare, IconX } from './icons';

export function AppHeader() {
  const d = useDashboard();
  const streaming = d.streamState === 'streaming' || d.streamState === 'connecting';
  const recording =
    d.recordingState === 'recording' ||
    d.recordingState === 'starting' ||
    d.recordingState === 'finalising';

  return (
    <header className="header">
      <div className="header__brand">
        <img className="header__logo" src={logoUrl} alt="Vertical Live" draggable={false} />
        {d.appVersion ? <span className="header__version">v{d.appVersion}</span> : null}
      </div>

      <div className="header__spacer" />

      <div className="header__activity">
        <ActivityIndicator
          tone="green"
          label={streaming ? 'Streaming' : 'Stream'}
          timer={formatClock(d.streamElapsed)}
          active={streaming}
          busy={d.streamState === 'connecting' || d.streamState === 'stopping'}
          degraded={d.networkDegraded}
          onClick={() => void d.toggleLive()}
        />
        <span className="header__sep" aria-hidden="true" />
        <ActivityIndicator
          tone="red"
          label={recording ? 'Recording' : 'Record'}
          timer={formatClock(d.recordElapsed)}
          active={recording}
          busy={d.recordingState === 'starting' || d.recordingState === 'stopping'}
          onClick={() => void d.toggleRecording()}
        />
      </div>

      <div className="header__controls">
        <button
          type="button"
          className="winbtn"
          aria-label="Minimise"
          onClick={d.windowMinimize}
        >
          <IconMinus size={17} />
        </button>
        <button
          type="button"
          className="winbtn"
          aria-label={d.windowMaximized ? 'Restore' : 'Maximise'}
          title={d.windowMaximized ? 'Restore' : 'Maximise'}
          onClick={d.windowToggleMaximize}
        >
          {d.windowMaximized ? <IconRestore size={15} /> : <IconSquare size={14} />}
        </button>
        <button
          type="button"
          className="winbtn winbtn--close"
          aria-label="Close"
          onClick={d.windowClose}
        >
          <IconX size={18} />
        </button>
      </div>
    </header>
  );
}
