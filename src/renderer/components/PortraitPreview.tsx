/**
 * The 9:16 portrait preview. Fills the left column. Shows the empty state when
 * idle and the live camera frames when a session is active. Framing (Fill/Fit)
 * is chosen directly on the preview via icon toggles, top-left.
 */

import { useRef } from 'react';

import cameraUrl from '../assets/camera.png';
import { useDashboard } from '../hooks/useDashboard';
import { usePreviewCanvas } from '../hooks/usePreviewCanvas';
import { queryFlag } from '../lib/api';

import { IconFill, IconFit } from './icons';

// Browser-only demo affordance: `?preview` forces the canvas on so the render
// path can be exercised without Electron. Never affects the packaged app.
const PREVIEW_DEMO = import.meta.env.DEV && queryFlag('preview') !== null;

export function PortraitPreview() {
  const d = useDashboard();
  const active = d.previewState === 'active' || PREVIEW_DEMO;
  const live = d.streamState === 'streaming' || d.streamState === 'connecting';
  const rec = d.recordingState === 'recording' || d.recordingState === 'finalising';
  const canvasRef = useRef<HTMLCanvasElement>(null);
  usePreviewCanvas(canvasRef, active);

  return (
    <section className="panel panel__pad preview" aria-label="Vertical preview">
      <div className="preview__head">Preview · Portrait (1080 × 1920)</div>

      <div className="preview__stage">
        <div className="preview__viewport">
          {/* Frames are painted imperatively onto this canvas (never React state);
              hidden until the first frame so the empty state shows through. */}
          <canvas
            ref={canvasRef}
            className="preview__media"
            aria-label="Live camera preview"
            style={{ display: active ? 'block' : 'none' }}
          />

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
