/**
 * Scales the whole dashboard to fit the current window.
 *
 * The dashboard is a dense, pixel-faithful design authored at one exact size
 * (the Electron window defaults in `src/main/window.ts`). Rather than reflow
 * every control at every width — which would fray the reference look — we keep
 * the design at its natural size and proportionally scale `.shell` to whatever
 * size the window is resized to. The result fills the desktop when maximised,
 * shrinks to stay fully visible when smaller, and never clips or scrolls.
 *
 * The computed factor is published as the `--app-scale` CSS variable, which
 * `.shell` consumes in its `transform`.
 */

import { useEffect } from 'react';

// Must match `.shell`'s `--design-w` / `--design-h` in app.css and the window
// defaults (DEFAULT_WINDOW_WIDTH / DEFAULT_WINDOW_HEIGHT) so the factor is 1 at
// the default window size.
const DESIGN_WIDTH = 1648;
const DESIGN_HEIGHT = 928;

export function useFitToWindow(): void {
  useEffect(() => {
    const root = document.documentElement;
    let frame = 0;

    const apply = (): void => {
      frame = 0;
      const scale = Math.min(
        window.innerWidth / DESIGN_WIDTH,
        window.innerHeight / DESIGN_HEIGHT,
      );
      root.style.setProperty('--app-scale', String(scale));
    };

    // Coalesce bursts of resize events into one write per frame.
    const schedule = (): void => {
      if (frame) return;
      frame = requestAnimationFrame(apply);
    };

    apply();
    window.addEventListener('resize', schedule);
    return () => {
      window.removeEventListener('resize', schedule);
      if (frame) cancelAnimationFrame(frame);
    };
  }, []);
}
