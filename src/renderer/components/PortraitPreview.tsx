/**
 * The 9:16 portrait preview. Fills the left column. Shows the empty state when
 * idle and the live camera frames when a session is active. Framing (Fill/Fit)
 * is chosen directly on the preview via icon toggles, top-left.
 */

import cameraUrl from '../assets/camera.png';
import { useDashboard } from '../hooks/useDashboard';
import { useLivePreviewFrame } from '../hooks/useLivePreviewFrame';

import { IconFill, IconFit } from './icons';

export function PortraitPreview() {
  const d = useDashboard();
  const active = d.previewState === 'active';
  const live = d.streamState === 'streaming' || d.streamState === 'connecting';
  const rec = d.recordingState === 'recording' || d.recordingState === 'finalising';
  const frameUrl = useLivePreviewFrame(active);

  return (
    <section className="panel panel__pad preview" aria-label="Vertical preview">
      <div className="preview__head">Preview · Portrait (1080 × 1920)</div>

      <div className="preview__stage">
        <div className="preview__viewport">
          {active && frameUrl ? (
            <img
              className="preview__media"
              src={frameUrl}
              alt="Live camera preview"
              draggable={false}
            />
          ) : active ? (
            <div className="preview__media" aria-hidden="true" style={activeFill} />
          ) : null}

          <div className="preview__framing" role="group" aria-label="Framing mode">
            <button
              type="button"
              className="preview__frame-btn"
              aria-pressed={d.framing === 'fill'}
              aria-label="Fill (crop)"
              title="Fill (Crop)"
              onClick={() => d.setFraming('fill')}
            >
              <IconFill size={16} />
            </button>
            <button
              type="button"
              className="preview__frame-btn"
              aria-pressed={d.framing === 'fit'}
              aria-label="Fit (pad)"
              title="Fit (Pad)"
              onClick={() => d.setFraming('fit')}
            >
              <IconFit size={16} />
            </button>
          </div>

          <div className="preview__badges">
            <span className={`pvbadge pvbadge--live${live ? ' is-active' : ''}`}>LIVE</span>
            <span className={`pvbadge pvbadge--rec${rec ? ' is-active' : ''}`}>
              <span className="dot" aria-hidden="true" />
              REC
            </span>
          </div>

          {active ? null : (
            <div className="preview__empty">
              <img className="preview__empty-img" src={cameraUrl} alt="" aria-hidden="true" />
              <div className="preview__empty-title">Preview not started</div>
              <div className="preview__empty-sub">Camera preview will appear here</div>
            </div>
          )}
        </div>
      </div>
    </section>
  );
}

const activeFill: React.CSSProperties = {
  background: 'radial-gradient(120% 80% at 30% 20%, #1a2733 0%, #0c151d 55%, #060b10 100%)',
};
