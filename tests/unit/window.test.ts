/**
 * The window sizing/positioning maths is pure, so first-launch centring,
 * restore, small-display clamping and invalid-bounds recovery are all asserted
 * here without opening a real Electron window.
 */

import { describe, expect, it } from 'vitest';

import {
  DEFAULT_WINDOW_HEIGHT,
  DEFAULT_WINDOW_WIDTH,
  MIN_WINDOW_HEIGHT,
  MIN_WINDOW_WIDTH,
  computeInitialBounds,
} from '../../src/main/window';

/** A roomy 1080p primary display work area (taskbar removed). */
const WORK = { x: 0, y: 0, width: 1920, height: 1040 };

describe('computeInitialBounds', () => {
  it('opens at the ~1230x830 default, centred, on first launch', () => {
    const b = computeInitialBounds(null, WORK);
    expect(b.width).toBe(DEFAULT_WINDOW_WIDTH);
    expect(b.height).toBe(DEFAULT_WINDOW_HEIGHT);
    expect(b.width).toBe(1230);
    expect(b.height).toBe(830);
    // Centred: equal margins on each axis.
    expect(b.x).toBe(Math.round((WORK.width - b.width) / 2));
    expect(b.y).toBe(Math.round((WORK.height - b.height) / 2));
  });

  it('honours a valid saved size and position (restore)', () => {
    const saved = { x: 200, y: 120, width: 1400, height: 900 };
    const b = computeInitialBounds(saved, WORK);
    expect(b).toEqual(saved);
  });

  it('recovers a rectangle saved on a now-disconnected monitor by re-centring', () => {
    // Saved far off to the right (a second monitor that is gone).
    const saved = { x: 3200, y: 200, width: 1300, height: 850 };
    const b = computeInitialBounds(saved, WORK);
    expect(b.x).toBe(Math.round((WORK.width - b.width) / 2));
    expect(b.y).toBe(Math.round((WORK.height - b.height) / 2));
    // Fully on-screen.
    expect(b.x).toBeGreaterThanOrEqual(WORK.x);
    expect(b.x + b.width).toBeLessThanOrEqual(WORK.x + WORK.width);
    expect(b.y + b.height).toBeLessThanOrEqual(WORK.y + WORK.height);
  });

  it('clamps the size down to fit a small display, never below the minimum floor', () => {
    const small = { x: 0, y: 0, width: 1100, height: 760 };
    const b = computeInitialBounds(null, small);
    expect(b.width).toBeLessThanOrEqual(small.width);
    expect(b.height).toBeLessThanOrEqual(small.height);
    expect(b.width).toBeGreaterThanOrEqual(MIN_WINDOW_WIDTH);
    expect(b.height).toBeGreaterThanOrEqual(MIN_WINDOW_HEIGHT);
    // Still centred within the small display.
    expect(b.x).toBe(Math.round((small.width - b.width) / 2));
  });

  it('honours a saved position on a non-zero-origin display (second monitor)', () => {
    const secondMonitor = { x: 1920, y: 0, width: 1920, height: 1040 };
    const saved = { x: 2100, y: 100, width: 1230, height: 830 };
    const b = computeInitialBounds(saved, secondMonitor);
    expect(b).toEqual(saved);
  });

  it('rejects a mostly-off-top saved position (title bar above the work area)', () => {
    const saved = { x: 300, y: -400, width: 1230, height: 830 };
    const b = computeInitialBounds(saved, WORK);
    // Re-centred rather than opening with an unreachable title bar.
    expect(b.y).toBe(Math.round((WORK.height - b.height) / 2));
  });
});
