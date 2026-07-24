/**
 * Camera capability detection and capture-mode selection.
 *
 * `ffmpeg -list_options true -f dshow -i video=NAME` dumps every mode the
 * driver exposes, e.g.
 *
 *   [dshow @ ...]   vcodec=mjpeg  min s=1280x720 fps=5 max s=1280x720 fps=30
 *   [dshow @ ...]   pixel_format=yuyv422  min s=640x480 fps=5 max s=640x480 fps=30
 *
 * Selection never silently fails: if the requested frame rate is impossible at
 * the best resolution, a compatible mode is chosen and the substitution is
 * reported to the user rather than swallowed.
 */

import {
  CAPTURE_TARGET_HEIGHT,
  CAPTURE_TARGET_WIDTH,
  ENV_SYNTHETIC_INPUT,
} from '../../shared/constants';
import type { CameraMode, DeviceCapabilities, SelectedCaptureMode } from '../../shared/types';
import { buildDeviceOptionsCommand } from './FfmpegCommandBuilder';
import type { ProbeRunner } from './runProbe';
import { runProbe } from './runProbe';

const MODE_RE =
  /(?:vcodec=(\S+)|pixel_format=(\S+))\s+min\s+s=(\d+)x(\d+)\s+fps=([\d.]+)\s+max\s+s=(\d+)x(\d+)\s+fps=([\d.]+)/;

/** Compressed camera modes; preferred at high resolution because raw formats
 *  exceed USB 2.0 bandwidth well before 1080p30. */
const COMPRESSED_CODECS = new Set(['mjpeg', 'h264', 'hevc']);

/** Parses `-list_options` output into a mode list. */
export function parseCameraModes(output: string): CameraMode[] {
  const modes: CameraMode[] = [];

  for (const rawLine of output.split(/\r\n|\n|\r/)) {
    const match = MODE_RE.exec(rawLine);
    if (!match) continue;

    const [, vcodec, pixelFormat, minW, minH, minFps, maxW, maxH, maxFps] = match;

    modes.push({
      vcodec: vcodec ?? null,
      pixelFormat: pixelFormat ?? null,
      minWidth: Number.parseInt(minW as string, 10),
      minHeight: Number.parseInt(minH as string, 10),
      maxWidth: Number.parseInt(maxW as string, 10),
      maxHeight: Number.parseInt(maxH as string, 10),
      minFps: Number.parseFloat(minFps as string),
      maxFps: Number.parseFloat(maxFps as string),
    });
  }

  return dedupeModes(modes);
}

function modeKey(mode: CameraMode): string {
  return [
    mode.vcodec ?? '',
    mode.pixelFormat ?? '',
    mode.minWidth,
    mode.minHeight,
    mode.maxWidth,
    mode.maxHeight,
    mode.minFps,
    mode.maxFps,
  ].join('|');
}

function dedupeModes(modes: CameraMode[]): CameraMode[] {
  const seen = new Set<string>();
  const result: CameraMode[] = [];
  for (const mode of modes) {
    const key = modeKey(mode);
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(mode);
  }
  return result;
}

function isCompressed(mode: CameraMode): boolean {
  return mode.vcodec !== null && COMPRESSED_CODECS.has(mode.vcodec.toLowerCase());
}

/** A mode can run at `fps` when the rate falls inside its advertised range. */
function supportsFps(mode: CameraMode, fps: number): boolean {
  // A small epsilon absorbs NTSC rates reported as 29.97 for "30".
  return mode.minFps <= fps + 0.05 && mode.maxFps >= fps - 0.05;
}

/** A landscape resolution the capture mode selection aims for. */
export interface CaptureTarget {
  width: number;
  height: number;
}

const DEFAULT_CAPTURE_TARGET: CaptureTarget = {
  width: CAPTURE_TARGET_WIDTH,
  height: CAPTURE_TARGET_HEIGHT,
};

/** Score a mode's resolution: exact target first, then largest that fits. */
function resolutionScore(mode: CameraMode, target: CaptureTarget): number {
  const width = mode.maxWidth;
  const height = mode.maxHeight;
  const area = width * height;

  if (width === target.width && height === target.height) {
    return Number.MAX_SAFE_INTEGER;
  }
  if (width <= target.width && height <= target.height) {
    return area;
  }
  // Oversized modes are usable but least preferred: they cost bandwidth and CPU
  // for detail the target canvas throws away. Among oversized modes the smaller
  // one wins, so a camera with no mode at/under the target still gets its
  // closest (smallest) larger mode rather than its biggest.
  return -area;
}

export interface CaptureModeSelection extends SelectedCaptureMode {
  /** The mode object that was chosen, for logging. */
  mode: CameraMode | null;
}

/**
 * Chooses the capture mode closest to `target` (default 1920x1080) that can
 * sustain `fps`. Preview passes a small target so decode stays cheap.
 *
 * Falls back, in order:
 *   1. exact target resolution at the requested fps
 *   2. largest mode <= target at the requested fps (compressed preferred)
 *   3. any mode at the requested fps
 *   4. best resolution at its own maximum fps  -> reported as a substitution
 *   5. nothing (let FFmpeg pick)               -> reported as a substitution
 */
export function selectCaptureMode(
  modes: readonly CameraMode[],
  requestedFps: number,
  target: CaptureTarget = DEFAULT_CAPTURE_TARGET,
): CaptureModeSelection {
  if (modes.length === 0) {
    return {
      width: null,
      height: null,
      fps: null,
      vcodec: null,
      pixelFormat: null,
      substituted: false,
      note: null,
      mode: null,
    };
  }

  const compare = (a: CameraMode, b: CameraMode): number => {
    const scoreDelta = resolutionScore(b, target) - resolutionScore(a, target);
    if (scoreDelta !== 0) return scoreDelta;
    // At equal resolution prefer compressed modes (USB bandwidth), then the
    // one with the higher ceiling frame rate.
    const compressedDelta = Number(isCompressed(b)) - Number(isCompressed(a));
    if (compressedDelta !== 0) return compressedDelta;
    return b.maxFps - a.maxFps;
  };

  const atRequestedFps = modes.filter((mode) => supportsFps(mode, requestedFps)).sort(compare);

  if (atRequestedFps.length > 0) {
    const best = atRequestedFps[0] as CameraMode;
    return {
      width: best.maxWidth,
      height: best.maxHeight,
      fps: requestedFps,
      vcodec: best.vcodec,
      pixelFormat: best.vcodec ? null : best.pixelFormat,
      substituted: false,
      note: null,
      mode: best,
    };
  }

  // Nothing can do the requested rate. Take the best resolution available and
  // run it at its own maximum, then say so.
  const fallback = [...modes].sort(compare)[0] as CameraMode;
  const usableFps = Math.min(fallback.maxFps, requestedFps);
  const chosenFps = usableFps > 0 ? usableFps : fallback.maxFps;

  return {
    width: fallback.maxWidth,
    height: fallback.maxHeight,
    fps: chosenFps,
    vcodec: fallback.vcodec,
    pixelFormat: fallback.vcodec ? null : fallback.pixelFormat,
    substituted: true,
    note:
      `The camera cannot capture ${requestedFps} fps at ${fallback.maxWidth}x${fallback.maxHeight}. ` +
      `Capturing at ${chosenFps} fps instead; the stream is still sent at ${requestedFps} fps.`,
    mode: fallback,
  };
}

export interface DeviceCapabilityServiceOptions {
  getExecutable: () => string;
  runner?: ProbeRunner;
  env?: NodeJS.ProcessEnv;
}

export class DeviceCapabilityService {
  private readonly cache = new Map<string, DeviceCapabilities>();
  private readonly runner: ProbeRunner;

  constructor(private readonly options: DeviceCapabilityServiceOptions) {
    this.runner = options.runner ?? runProbe;
  }

  private get synthetic(): boolean {
    return (this.options.env ?? process.env)[ENV_SYNTHETIC_INPUT] === 'true';
  }

  async get(deviceId: string, dshowName: string, refresh = false): Promise<DeviceCapabilities> {
    if (!refresh) {
      const cached = this.cache.get(deviceId);
      if (cached) return cached;
    }

    if (this.synthetic) {
      const synthetic: DeviceCapabilities = {
        deviceId,
        modes: [
          {
            vcodec: null,
            pixelFormat: 'yuv420p',
            minWidth: 1280,
            minHeight: 720,
            maxWidth: 1280,
            maxHeight: 720,
            minFps: 1,
            maxFps: 60,
          },
        ],
        unknown: false,
        error: null,
      };
      this.cache.set(deviceId, synthetic);
      return synthetic;
    }

    const result = await this.runner(
      this.options.getExecutable(),
      buildDeviceOptionsCommand(dshowName),
    );

    // As with device listing, FFmpeg exits non-zero after dumping the options.
    const modes = parseCameraModes(result.output);

    const capabilities: DeviceCapabilities = {
      deviceId,
      modes,
      unknown: modes.length === 0,
      error:
        modes.length === 0
          ? (result.spawnError ??
            'FFmpeg did not report any capture modes for this camera; ' +
              'Vertical Live will let the driver choose one.')
          : null,
    };

    this.cache.set(deviceId, capabilities);
    return capabilities;
  }

  invalidate(deviceId?: string): void {
    if (deviceId) this.cache.delete(deviceId);
    else this.cache.clear();
  }
}
