/**
 * Imperative preview renderer.
 *
 * Live JPEG frames arrive over the dedicated preview MessagePort (see the
 * preload bridge). They are decoded off the main thread with
 * `createImageBitmap`, painted to a `<canvas>` on `requestAnimationFrame`, and
 * closed — never stored in React/Zustand state, so a fast camera can never flood
 * the render loop.
 *
 * Latest-frame semantics (no historical queue):
 *   - at most one frame is decoding at a time;
 *   - a newer arrival replaces the pending one and the older is dropped;
 *   - at most one decoded bitmap waits for the next animation frame.
 * So the preview always shows the freshest frame and can never drift seconds
 * behind, even if the renderer briefly falls behind the producer.
 *
 * Diagnostics: deliberately dropped frames are counted and logged at most once a
 * second, never per frame.
 */

import { useEffect } from 'react';
import type { RefObject } from 'react';

import { getApi } from '../lib/api';

export function usePreviewCanvas(
  canvasRef: RefObject<HTMLCanvasElement | null>,
  active: boolean,
): void {
  useEffect(() => {
    if (!active) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d', { alpha: false });
    if (!ctx) return;

    let latest: Uint8Array | null = null; // newest undecoded frame, or null
    let pending: ImageBitmap | null = null; // newest decoded frame awaiting paint
    let decoding = false;
    let rafId = 0;
    let disposed = false;

    // Diagnostics, flushed at most once per second — never per frame.
    let dropped = 0;
    let painted = 0;
    let received = 0;
    const statsTimer = window.setInterval(() => {
      if (received > 0) {
        // eslint-disable-next-line no-console
        console.debug(
          `[preview] received=${received}/s painted=${painted}/s dropped=${dropped}/s`,
        );
      }
      received = 0;
      painted = 0;
      dropped = 0;
    }, 1000);

    const paint = (): void => {
      rafId = 0;
      const bmp = pending;
      pending = null;
      if (!bmp) return;
      if (canvas.width !== bmp.width || canvas.height !== bmp.height) {
        canvas.width = bmp.width;
        canvas.height = bmp.height;
      }
      ctx.drawImage(bmp, 0, 0);
      bmp.close();
      painted += 1;
    };

    const pump = (): void => {
      if (decoding || latest === null) return;
      const data = latest;
      latest = null;
      decoding = true;
      createImageBitmap(new Blob([data as BlobPart], { type: 'image/jpeg' }))
        .then((bmp) => {
          decoding = false;
          if (disposed) {
            bmp.close();
            return;
          }
          // Only the newest decoded frame survives to be painted.
          if (pending) {
            pending.close();
            dropped += 1;
          }
          pending = bmp;
          if (rafId === 0) rafId = requestAnimationFrame(paint);
          // A newer frame may have arrived while this one decoded.
          pump();
        })
        .catch(() => {
          decoding = false;
        });
    };

    const off = getApi().onPreviewFrame((frame) => {
      received += 1;
      if (latest !== null) dropped += 1; // replaced an undecoded frame
      latest = frame;
      pump();
    });

    return () => {
      disposed = true;
      off();
      window.clearInterval(statsTimer);
      if (rafId) cancelAnimationFrame(rafId);
      if (pending) pending.close();
      latest = null;
    };
  }, [canvasRef, active]);
}
