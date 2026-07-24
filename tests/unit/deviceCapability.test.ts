/**
 * Capture-mode selection must never silently fail. If a camera cannot do the
 * requested frame rate at its best resolution, the app picks something workable
 * and *says so*.
 */

import { describe, expect, it, vi } from 'vitest';

import {
  DeviceCapabilityService,
  parseCameraModes,
  selectCaptureMode,
} from '../../src/main/streaming/DeviceCapabilityService';
import type { CameraMode } from '../../src/shared/types';
import type { ProbeResult } from '../../src/main/streaming/runProbe';

const LIST_OPTIONS_OUTPUT = `
[dshow @ 0001] DirectShow video device options (from video devices)
[dshow @ 0001]  Pin "Capture" (alternative pin name "Capture")
[dshow @ 0001]   vcodec=mjpeg  min s=1920x1080 fps=5 max s=1920x1080 fps=30
[dshow @ 0001]   vcodec=mjpeg  min s=1280x720 fps=5 max s=1280x720 fps=60
[dshow @ 0001]   pixel_format=yuyv422  min s=1920x1080 fps=5 max s=1920x1080 fps=5
[dshow @ 0001]   pixel_format=yuyv422  min s=640x480 fps=5 max s=640x480 fps=30
[dshow @ 0001]   unknown compression type 0x34363248  min s=1920x1080 fps=5 max s=1920x1080 fps=30
`;

function mode(overrides: Partial<CameraMode>): CameraMode {
  return {
    vcodec: null,
    pixelFormat: null,
    minWidth: 640,
    minHeight: 480,
    maxWidth: 640,
    maxHeight: 480,
    minFps: 5,
    maxFps: 30,
    ...overrides,
  };
}

describe('parseCameraModes', () => {
  it('parses vcodec and pixel_format rows', () => {
    const modes = parseCameraModes(LIST_OPTIONS_OUTPUT);

    expect(modes.length).toBeGreaterThanOrEqual(4);
    expect(modes.some((m) => m.vcodec === 'mjpeg' && m.maxWidth === 1920)).toBe(true);
    expect(modes.some((m) => m.pixelFormat === 'yuyv422' && m.maxWidth === 640)).toBe(true);
  });

  it('reads the resolution and frame-rate range', () => {
    const modes = parseCameraModes(LIST_OPTIONS_OUTPUT);
    const hd = modes.find((m) => m.vcodec === 'mjpeg' && m.maxWidth === 1280);

    expect(hd).toMatchObject({ maxWidth: 1280, maxHeight: 720, minFps: 5, maxFps: 60 });
  });

  it('de-duplicates identical rows', () => {
    const duplicated = `${LIST_OPTIONS_OUTPUT}${LIST_OPTIONS_OUTPUT}`;
    expect(parseCameraModes(duplicated).length).toBe(
      parseCameraModes(LIST_OPTIONS_OUTPUT).length,
    );
  });

  it('returns an empty list for unparsable output', () => {
    expect(parseCameraModes('no options here')).toEqual([]);
  });
});

describe('selectCaptureMode', () => {
  it('prefers exactly 1920x1080 at the requested rate', () => {
    const modes = [
      mode({ vcodec: 'mjpeg', maxWidth: 1280, maxHeight: 720, maxFps: 60 }),
      mode({ vcodec: 'mjpeg', maxWidth: 1920, maxHeight: 1080, maxFps: 30 }),
    ];

    const selection = selectCaptureMode(modes, 30);

    expect(selection.width).toBe(1920);
    expect(selection.height).toBe(1080);
    expect(selection.fps).toBe(30);
    expect(selection.substituted).toBe(false);
  });

  it('prefers a compressed mode over a raw one at the same resolution', () => {
    // Raw 1080p exceeds USB 2.0 bandwidth long before 30 fps.
    const modes = [
      mode({ pixelFormat: 'yuyv422', maxWidth: 1920, maxHeight: 1080, maxFps: 30 }),
      mode({ vcodec: 'mjpeg', maxWidth: 1920, maxHeight: 1080, maxFps: 30 }),
    ];

    const selection = selectCaptureMode(modes, 30);

    expect(selection.vcodec).toBe('mjpeg');
    expect(selection.pixelFormat).toBeNull();
  });

  it('falls back to the largest mode that fits when 1080p is unavailable', () => {
    const modes = [
      mode({ vcodec: 'mjpeg', maxWidth: 1280, maxHeight: 720, maxFps: 30 }),
      mode({ vcodec: 'mjpeg', maxWidth: 640, maxHeight: 480, maxFps: 30 }),
    ];

    expect(selectCaptureMode(modes, 30).width).toBe(1280);
  });

  it('reports a substitution when no mode reaches the requested rate', () => {
    const modes = [
      mode({ pixelFormat: 'yuyv422', maxWidth: 1920, maxHeight: 1080, maxFps: 5 }),
    ];

    const selection = selectCaptureMode(modes, 30);

    expect(selection.substituted).toBe(true);
    expect(selection.fps).toBe(5);
    expect(selection.note).toContain('cannot capture 30 fps');
    expect(selection.note).toContain('1920x1080');
  });

  it('accepts 29.97 as satisfying a 30 fps request', () => {
    const modes = [mode({ vcodec: 'mjpeg', maxWidth: 1920, maxHeight: 1080, maxFps: 29.97 })];
    expect(selectCaptureMode(modes, 30).substituted).toBe(false);
  });

  it('honours the lower bound of the advertised range', () => {
    const modes = [
      mode({ vcodec: 'mjpeg', minFps: 30, maxFps: 60, maxWidth: 1920, maxHeight: 1080 }),
    ];
    // 24 fps is below the camera's minimum, so this must be reported.
    expect(selectCaptureMode(modes, 24).substituted).toBe(true);
  });

  it('lets FFmpeg choose when no modes are known', () => {
    const selection = selectCaptureMode([], 30);

    expect(selection.width).toBeNull();
    expect(selection.height).toBeNull();
    expect(selection.fps).toBeNull();
    expect(selection.substituted).toBe(false);
  });

  it('deprioritises oversized modes over ones that fit the target', () => {
    const modes = [
      mode({ vcodec: 'mjpeg', maxWidth: 3840, maxHeight: 2160, maxFps: 30 }),
      mode({ vcodec: 'mjpeg', maxWidth: 1920, maxHeight: 1080, maxFps: 30 }),
    ];

    expect(selectCaptureMode(modes, 30).width).toBe(1920);
  });

  it('still uses an oversized mode when nothing else exists', () => {
    const modes = [mode({ vcodec: 'mjpeg', maxWidth: 3840, maxHeight: 2160, maxFps: 30 })];
    expect(selectCaptureMode(modes, 30).width).toBe(3840);
  });

  it('honours a small (preview) target instead of opening the camera at 1080p', () => {
    const modes = [
      mode({ vcodec: 'mjpeg', maxWidth: 1920, maxHeight: 1080, maxFps: 30 }),
      mode({ vcodec: 'mjpeg', maxWidth: 1280, maxHeight: 720, maxFps: 30 }),
      mode({ vcodec: 'mjpeg', maxWidth: 640, maxHeight: 480, maxFps: 30 }),
    ];

    const selection = selectCaptureMode(modes, 30, { width: 640, height: 480 });

    expect(selection.width).toBe(640);
    expect(selection.height).toBe(480);
  });

  it('picks the smallest oversized mode when nothing meets the small target', () => {
    const modes = [
      mode({ vcodec: 'mjpeg', maxWidth: 1920, maxHeight: 1080, maxFps: 30 }),
      mode({ vcodec: 'mjpeg', maxWidth: 1280, maxHeight: 720, maxFps: 30 }),
    ];

    // No mode <= 640x480, so the closest (smallest) larger one wins — still far
    // cheaper to decode than 1080p.
    expect(selectCaptureMode(modes, 30, { width: 640, height: 480 }).width).toBe(1280);
  });
});

describe('DeviceCapabilityService', () => {
  const getExecutable = () => 'ffmpeg.exe';

  function probe(output: string): ProbeResult {
    return { code: 1, output, stdout: '', timedOut: false, spawnError: null };
  }

  it('parses and caches capabilities per device', async () => {
    const runner = vi.fn(async () => probe(LIST_OPTIONS_OUTPUT));
    const service = new DeviceCapabilityService({ getExecutable, runner, env: {} });

    const first = await service.get('Cam', 'Cam');
    const second = await service.get('Cam', 'Cam');

    expect(first.modes.length).toBeGreaterThan(0);
    expect(first.unknown).toBe(false);
    expect(second).toBe(first);
    expect(runner).toHaveBeenCalledTimes(1);
  });

  it('marks capabilities unknown when nothing parses, without failing', async () => {
    const runner = vi.fn(async () => probe('no modes at all'));
    const service = new DeviceCapabilityService({ getExecutable, runner, env: {} });

    const result = await service.get('Cam', 'Cam');

    expect(result.unknown).toBe(true);
    expect(result.modes).toEqual([]);
    expect(result.error).toContain('driver choose');
  });

  it('returns a fixed synthetic capability set in synthetic mode', async () => {
    const runner = vi.fn(async () => probe(LIST_OPTIONS_OUTPUT));
    const service = new DeviceCapabilityService({
      getExecutable,
      runner,
      env: { VERTICAL_LIVE_SYNTHETIC_INPUT: 'true' },
    });

    const result = await service.get('synthetic:video', 'synthetic:video');

    expect(runner).not.toHaveBeenCalled();
    expect(result.modes).toHaveLength(1);
  });

  it('re-probes after invalidate', async () => {
    const runner = vi.fn(async () => probe(LIST_OPTIONS_OUTPUT));
    const service = new DeviceCapabilityService({ getExecutable, runner, env: {} });

    await service.get('Cam', 'Cam');
    service.invalidate('Cam');
    await service.get('Cam', 'Cam');

    expect(runner).toHaveBeenCalledTimes(2);
  });
});
