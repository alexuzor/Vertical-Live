/**
 * Device parsing is tested against captured output from several FFmpeg
 * versions, including device names with the awkward characters real hardware
 * actually uses.
 */

import { describe, expect, it, vi } from 'vitest';

import {
  DeviceDiscovery,
  parseDeviceList,
  resolveDshowName,
} from '../../src/main/streaming/DeviceDiscovery';
import { VerticalLiveError } from '../../src/shared/errors';
import type { ProbeResult } from '../../src/main/streaming/runProbe';

/** ffmpeg 5/6/7 format: the kind is a suffix on the same line. */
const MODERN_OUTPUT = `
[dshow @ 000001f2a1b2c3d4] "Integrated Camera" (video)
[dshow @ 000001f2a1b2c3d4]   Alternative name "@device_pnp_\\\\?\\usb#vid_04f2&pid_b6d9&mi_00#7&2b1a3d4d&0&0000#{65e8773d-8f56-11d0-a3b9-00a0c9223196}\\global"
[dshow @ 000001f2a1b2c3d4] "HD Pro Webcam C920" (video)
[dshow @ 000001f2a1b2c3d4]   Alternative name "@device_pnp_\\\\?\\usb#vid_046d&pid_082d"
[dshow @ 000001f2a1b2c3d4] "Microphone (Realtek(R) Audio)" (audio)
[dshow @ 000001f2a1b2c3d4]   Alternative name "@device_cm_{33D9A762-90C8-11D0-BD43-00A0C911CE86}\\wave_01"
[dshow @ 000001f2a1b2c3d4] "Line In (Realtek(R) Audio)" (audio)
dummy: Immediate exit requested
`;

/** ffmpeg 4.x format: section headers, no per-line suffix. */
const LEGACY_OUTPUT = `
[dshow @ 0000023f] DirectShow video devices (some may be both video and audio devices)
[dshow @ 0000023f]  "Integrated Camera"
[dshow @ 0000023f]     Alternative name "@device_pnp_\\\\?\\usb#vid_04f2"
[dshow @ 0000023f] DirectShow audio devices
[dshow @ 0000023f]  "Microphone (Realtek Audio)"
[dshow @ 0000023f]     Alternative name "@device_cm_{33D9A762}"
dummy: Immediate exit requested
`;

/**
 * ffmpeg 7.x format: `[in#0 @ ...]` prefix, NO section headers, and some real
 * cameras (external UVC webcams, virtual cameras) tagged `(none)` instead of
 * `(video)`. Captured from a live machine.
 */
const FFMPEG7_OUTPUT = `
[in#0 @ 000001fd3bc41ec0] "HP HD Camera" (video)
[in#0 @ 000001fd3bc41ec0]   Alternative name "@device_pnp_\\\\?\\usb#vid_04f2&pid_b6c8&mi_00#6&27d067fe&0&0000#{65e8773d-8f56-11d0-a3b9-00a0c9223196}\\global"
[in#0 @ 000001fd3bc41ec0] "USB2.0 HD UVC WebCam" (none)
[in#0 @ 000001fd3bc41ec0]   Alternative name "@device_pnp_\\\\?\\usb#vid_1bcf&pid_2c99"
[in#0 @ 000001fd3bc41ec0] "OBS Virtual Camera" (none)
[in#0 @ 000001fd3bc41ec0]   Alternative name "@device_sw_{860BB310-5D01-11D0-BD3B-00A0C911CE86}\\{A3FCE0F5-3493-419F-958A-ABA1250EC20B}"
[in#0 @ 000001fd3bc41ec0] "Scarlet Interface (Focusrite USB Audio)" (audio)
[in#0 @ 000001fd3bc41ec0]   Alternative name "@device_cm_{33D9A762-90C8-11D0-BD43-00A0C911CE86}\\wave_x"
[in#0 @ 000001fd3bc41ec0] "CABLE Output (VB-Audio Virtual Cable)" (audio)
Error opening input file dummy.
`;

const AWKWARD_OUTPUT = `
[dshow @ 0001] "Alex's Webcam (USB 2.0)" (video)
[dshow @ 0001] "カメラ — 前面" (video)
[dshow @ 0001] "Cam: Front" (video)
[dshow @ 0001]   Alternative name "@device_pnp_front_cam"
[dshow @ 0001] "Say \\"Cheese\\" Mic" (audio)
`;

function probe(output: string): ProbeResult {
  return { code: 1, output, stdout: '', timedOut: false, spawnError: null };
}

describe('parseDeviceList', () => {
  it('parses the modern per-line format', () => {
    const result = parseDeviceList(MODERN_OUTPUT);

    expect(result.cameras.map((d) => d.name)).toEqual([
      'Integrated Camera',
      'HD Pro Webcam C920',
    ]);
    expect(result.microphones.map((d) => d.name)).toEqual([
      'Microphone (Realtek(R) Audio)',
      'Line In (Realtek(R) Audio)',
    ]);
  });

  it('parses ffmpeg 7.x output with no section headers and (none)-tagged cameras', () => {
    const result = parseDeviceList(FFMPEG7_OUTPUT);

    // Both the external UVC webcam and the virtual camera are tagged (none) by
    // ffmpeg 7.x; they must still be offered as cameras, not dropped.
    expect(result.cameras.map((d) => d.name)).toEqual([
      'HP HD Camera',
      'USB2.0 HD UVC WebCam',
      'OBS Virtual Camera',
    ]);
    // Audio devices, which follow the video block, stay classified as audio.
    expect(result.microphones.map((d) => d.name)).toEqual([
      'Scarlet Interface (Focusrite USB Audio)',
      'CABLE Output (VB-Audio Virtual Cable)',
    ]);
    expect(result.cameras[1]?.alternativeName).toContain('vid_1bcf');
  });

  it('captures alternative names', () => {
    const result = parseDeviceList(MODERN_OUTPUT);
    expect(result.cameras[0]?.alternativeName).toContain('@device_pnp_');
    expect(result.microphones[0]?.alternativeName).toContain('@device_cm_');
  });

  it('leaves alternativeName null when FFmpeg reported none', () => {
    const result = parseDeviceList(MODERN_OUTPUT);
    expect(result.microphones[1]?.alternativeName).toBeNull();
  });

  it('parses the legacy section-header format', () => {
    const result = parseDeviceList(LEGACY_OUTPUT);
    expect(result.cameras).toHaveLength(1);
    expect(result.microphones).toHaveLength(1);
    expect(result.cameras[0]?.name).toBe('Integrated Camera');
    expect(result.microphones[0]?.name).toBe('Microphone (Realtek Audio)');
  });

  it('handles apostrophes, parentheses, Unicode, colons and escaped quotes', () => {
    const result = parseDeviceList(AWKWARD_OUTPUT);
    const names = result.cameras.map((d) => d.name);

    expect(names).toContain("Alex's Webcam (USB 2.0)");
    expect(names).toContain('カメラ — 前面');
    expect(names).toContain('Cam: Front');
    expect(result.microphones[0]?.name).toContain('Cheese');
  });

  it('assigns a stable index per kind', () => {
    const result = parseDeviceList(MODERN_OUTPUT);
    expect(result.cameras.map((d) => d.index)).toEqual([0, 1]);
    expect(result.microphones.map((d) => d.index)).toEqual([0, 1]);
  });

  it('uses the friendly name as the id', () => {
    const result = parseDeviceList(MODERN_OUTPUT);
    expect(result.cameras[0]?.id).toBe('Integrated Camera');
  });

  it('returns empty lists rather than throwing on unrecognised output', () => {
    const result = parseDeviceList('something entirely unexpected\n');
    expect(result.cameras).toEqual([]);
    expect(result.microphones).toEqual([]);
  });

  it('handles empty input', () => {
    expect(parseDeviceList('')).toEqual({ cameras: [], microphones: [], warnings: [] });
  });

  it('handles CRLF line endings', () => {
    const result = parseDeviceList(MODERN_OUTPUT.replace(/\n/g, '\r\n'));
    expect(result.cameras).toHaveLength(2);
  });
});

describe('resolveDshowName', () => {
  it('prefers the friendly name', () => {
    expect(
      resolveDshowName({
        name: 'Integrated Camera',
        alternativeName: '@device_pnp_x',
        id: 'Integrated Camera',
        index: 0,
      }),
    ).toBe('Integrated Camera');
  });

  it('falls back to the alternative name when the friendly name has a colon', () => {
    // FFmpeg's dshow parser splits on ':' with no escape support.
    expect(
      resolveDshowName({
        name: 'Cam: Front',
        alternativeName: '@device_pnp_front_cam',
        id: 'Cam: Front',
        index: 0,
      }),
    ).toBe('@device_pnp_front_cam');
  });

  it('throws a clear error when neither name is addressable', () => {
    expect(() =>
      resolveDshowName({
        name: 'Cam: Front',
        alternativeName: null,
        id: 'Cam: Front',
        index: 0,
      }),
    ).toThrow(VerticalLiveError);
  });
});

describe('DeviceDiscovery', () => {
  const getExecutable = () => 'C:\\ffmpeg\\ffmpeg.exe';

  it('lists devices via the injected runner', async () => {
    const runner = vi.fn(async () => probe(MODERN_OUTPUT));
    const discovery = new DeviceDiscovery({ getExecutable, runner, env: {} });

    const list = await discovery.list();

    expect(list.cameras).toHaveLength(2);
    expect(runner).toHaveBeenCalledTimes(1);
  });

  it('caches until asked to refresh', async () => {
    const runner = vi.fn(async () => probe(MODERN_OUTPUT));
    const discovery = new DeviceDiscovery({ getExecutable, runner, env: {} });

    await discovery.list();
    await discovery.list();
    expect(runner).toHaveBeenCalledTimes(1);

    await discovery.list(true);
    expect(runner).toHaveBeenCalledTimes(2);
  });

  it('treats a non-zero exit as normal, because -i dummy always fails', async () => {
    const runner = vi.fn(async () => ({ ...probe(MODERN_OUTPUT), code: 1 }));
    const discovery = new DeviceDiscovery({ getExecutable, runner, env: {} });

    await expect(discovery.list()).resolves.toMatchObject({ cameras: expect.any(Array) });
  });

  it('surfaces a spawn failure as a missing-FFmpeg error', async () => {
    const runner = vi.fn(async () => ({
      code: null,
      output: '',
      stdout: '',
      timedOut: false,
      spawnError: 'ENOENT',
    }));
    const discovery = new DeviceDiscovery({ getExecutable, runner, env: {} });

    await expect(discovery.list()).rejects.toThrow(VerticalLiveError);
  });

  it('surfaces a timeout', async () => {
    const runner = vi.fn(async () => ({
      code: null,
      output: '',
      stdout: '',
      timedOut: true,
      spawnError: null,
    }));
    const discovery = new DeviceDiscovery({ getExecutable, runner, env: {} });

    await expect(discovery.list()).rejects.toThrow(VerticalLiveError);
  });

  it('returns synthetic devices without running FFmpeg in synthetic mode', async () => {
    const runner = vi.fn(async () => probe(MODERN_OUTPUT));
    const discovery = new DeviceDiscovery({
      getExecutable,
      runner,
      env: { VERTICAL_LIVE_SYNTHETIC_INPUT: 'true' },
    });

    const list = await discovery.list();

    expect(runner).not.toHaveBeenCalled();
    expect(list.cameras[0]?.id).toBe('synthetic:video');
    expect(list.microphones[0]?.id).toBe('synthetic:audio');
  });

  it('finds devices by id', async () => {
    const runner = vi.fn(async () => probe(MODERN_OUTPUT));
    const discovery = new DeviceDiscovery({ getExecutable, runner, env: {} });

    expect(await discovery.findCamera('HD Pro Webcam C920')).not.toBeNull();
    expect(await discovery.findCamera('Nope')).toBeNull();
    expect(await discovery.findMicrophone('Line In (Realtek(R) Audio)')).not.toBeNull();
  });

  it('re-probes after invalidate', async () => {
    const runner = vi.fn(async () => probe(MODERN_OUTPUT));
    const discovery = new DeviceDiscovery({ getExecutable, runner, env: {} });

    await discovery.list();
    discovery.invalidate();
    await discovery.list();

    expect(runner).toHaveBeenCalledTimes(2);
  });
});
