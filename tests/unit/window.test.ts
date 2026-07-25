/**
 * The window sizing/positioning maths is pure, so first-launch centring,
 * small-display clamping and the "always the 1230x830 default" rule are all
 * asserted here without opening a real Electron window.
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
  it('opens at the 1230x830 default, centred, on a roomy display', () => {
    const b = computeInitialBounds(WORK);
    expect(b.width).toBe(DEFAULT_WINDOW_WIDTH);
    expect(b.height).toBe(DEFAULT_WINDOW_HEIGHT);
    expect(b.width).toBe(1230);
    expect(b.height).toBe(830);
    // Centred: equal margins on each axis.
    expect(b.x).toBe(Math.round((WORK.width - b.width) / 2));
    expect(b.y).toBe(Math.round((WORK.height - b.height) / 2));
  });

  it('always uses the 1230x830 default — never a restored/persisted size', () => {
    // The default is honoured over any saved bounds (they are not consulted), so
    // the size is identical on every launch, on any roomy display.
    const a = computeInitialBounds(WORK);
    const b = computeInitialBounds({ x: 0, y: 0, width: 2560, height: 1440 });
    expect([a.width, a.height]).toEqual([1230, 830]);
    expect([b.width, b.height]).toEqual([1230, 830]);
  });

  it('clamps the size down to fit a small display, never below the minimum floor', () => {
    const small = { x: 0, y: 0, width: 1100, height: 760 };
    const b = computeInitialBounds(small);
    expect(b.width).toBeLessThanOrEqual(small.width);
    expect(b.height).toBeLessThanOrEqual(small.height);
    expect(b.width).toBeGreaterThanOrEqual(MIN_WINDOW_WIDTH);
    expect(b.height).toBeGreaterThanOrEqual(MIN_WINDOW_HEIGHT);
    // Still centred within the small display.
    expect(b.x).toBe(Math.round((small.width - b.width) / 2));
  });

  it('centres on a non-zero-origin display (second monitor)', () => {
    const second = { x: 1920, y: 0, width: 1920, height: 1040 };
    const b = computeInitialBounds(second);
    expect(b.width).toBe(1230);
    expect(b.height).toBe(830);
    expect(b.x).toBe(Math.round(second.x + (second.width - b.width) / 2));
    expect(b.y).toBe(Math.round(second.y + (second.height - b.height) / 2));
    // Fully within the second monitor.
    expect(b.x).toBeGreaterThanOrEqual(second.x);
    expect(b.x + b.width).toBeLessThanOrEqual(second.x + second.width);
  });
});
