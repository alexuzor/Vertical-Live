/**
 * Shared, framework-free constants used by main, preload and renderer.
 *
 * Everything here must stay importable from a sandboxed preload script, so this
 * module must not import Node built-ins or Electron.
 */

/** Master portrait composition canvas. Everything is composed at this size. */
export const MASTER_WIDTH = 1080;
export const MASTER_HEIGHT = 1920;

/** Facebook RTMPS output size (vertical 720p). */
export const STREAM_WIDTH = 720;
export const STREAM_HEIGHT = 1280;

/** Local recording size (matches the master canvas). */
export const RECORDING_WIDTH = MASTER_WIDTH;
export const RECORDING_HEIGHT = MASTER_HEIGHT;

/** Lightweight preview branch. Deliberately tiny to keep IPC cheap. */
export const PREVIEW_WIDTH = 360;
export const PREVIEW_HEIGHT = 640;
export const PREVIEW_FPS = 10;
/** MJPEG quality scale for the preview branch (2 = best, 31 = worst). */
export const PREVIEW_MJPEG_QUALITY = 8;
/** Hard ceiling on a single decoded preview frame; anything larger is discarded. */
export const PREVIEW_MAX_FRAME_BYTES = 2 * 1024 * 1024;
/** Hard ceiling on the un-parsed preview byte buffer before we resynchronise. */
export const PREVIEW_MAX_BUFFER_BYTES = 8 * 1024 * 1024;
/** Minimum wall-clock gap between preview frames forwarded to the renderer. */
export const PREVIEW_MIN_FRAME_INTERVAL_MS = 80;
/**
 * DirectShow real-time buffer for a preview-only run. Much smaller than the
 * streaming/recording 512M: a live preview must stay current, so a momentary
 * stall should drop stale frames rather than bank up seconds (for an MJPEG
 * webcam, tens of seconds) of latency the viewer then has to watch through.
 */
export const PREVIEW_RTBUFSIZE = '64M';

/** Supported streaming frame rates. */
export const SUPPORTED_FPS = [24, 25, 30] as const;

/**
 * Manual audio→video sync offset, in milliseconds, applied via `-itsoffset` on
 * the microphone input. Positive delays the audio (use when audio runs ahead);
 * negative advances it (use when a USB interface's latency makes audio lag).
 * Automatic drift correction still runs; this only shifts a fixed offset.
 */
export const MIN_AUDIO_SYNC_OFFSET_MS = -1000;
export const MAX_AUDIO_SYNC_OFFSET_MS = 1000;
export const DEFAULT_AUDIO_SYNC_OFFSET_MS = 0;

/** GOP is always two seconds' worth of frames. */
export const KEYFRAME_INTERVAL_SECONDS = 2;

/** Facebook-friendly video bitrate bounds for the custom preset, in Kbps. */
export const MIN_CUSTOM_BITRATE_KBPS = 2000;
export const MAX_CUSTOM_BITRATE_KBPS = 6000;

/** Named bitrate presets, in Kbps. */
export const BITRATE_PRESETS = {
  'data-saver': 2500,
  standard: 3500,
  high: 5000,
  maximum: 6000,
} as const;

export const DEFAULT_FPS = 30;
export const DEFAULT_BITRATE_KBPS = BITRATE_PRESETS.standard;
export const DEFAULT_BITRATE_PRESET = 'standard';
export const DEFAULT_FRAMING_MODE = 'fill';

/** Audio settings for both the Facebook branch and the recording branch. */
export const AUDIO_SAMPLE_RATE = 48_000;
export const AUDIO_CHANNELS = 2;
export const STREAM_AUDIO_BITRATE_KBPS = 128;
export const RECORDING_AUDIO_BITRATE_KBPS = 160;

/** Local recording video bitrate (spec asks for roughly 8-12 Mbps). */
export const RECORDING_VIDEO_BITRATE_KBPS = 10_000;
export const RECORDING_VIDEO_MAXRATE_KBPS = 12_000;

/** Prefix used for every generated recording file name. */
export const RECORDING_FILENAME_PREFIX = 'Vertical-Live';

/**
 * Camera capture target. Cameras are landscape devices; we capture the largest
 * practical landscape mode and rotate/crop the framing in the filter graph.
 */
export const CAPTURE_TARGET_WIDTH = 1920;
export const CAPTURE_TARGET_HEIGHT = 1080;

/**
 * Capture target for a preview-only run. The preview is only a 360x640
 * thumbnail, so opening the camera at the full 1920x1080 target forces FFmpeg to
 * decode a full-resolution frame for every captured frame — the dominant cost,
 * and the one that makes a weak machine fall behind real time (growing lag +
 * stutter). A small capture mode keeps decode cheap so the pipeline stays ahead;
 * framing is aspect-based, so the composed preview looks identical.
 */
export const PREVIEW_CAPTURE_TARGET_WIDTH = 640;
export const PREVIEW_CAPTURE_TARGET_HEIGHT = 480;

/** How long we wait for FFmpeg to quit gracefully before escalating (ms). */
export const GRACEFUL_STOP_TIMEOUT_MS = 8_000;
/**
 * Pause between closing one DirectShow capture and opening the next. FFmpeg has
 * already exited, but Windows does not always hand the device back instantly.
 */
export const DEVICE_RELEASE_SETTLE_MS = 300;
/** How long we wait for the remux step before treating it as failed (ms). */
export const REMUX_TIMEOUT_MS = 120_000;
/** How long a probe/discovery FFmpeg invocation may run (ms). */
export const PROBE_TIMEOUT_MS = 20_000;
/** How long a single encoder capability test may run (ms). */
export const ENCODER_TEST_TIMEOUT_MS = 25_000;

/**
 * If the stream process dies within this window and no frames have reached the
 * destination, a hardware encoder failure is eligible for a libx264 retry.
 */
export const HARDWARE_FALLBACK_WINDOW_MS = 15_000;

/* ------------------------------------------------------------------ */
/* Network quality heuristics (live streaming)                         */
/* ------------------------------------------------------------------ */

/**
 * While sending to Facebook, FFmpeg's encode `speed` sits at ~1.0x. When the
 * uplink can't keep up, the socket back-pressures the whole pipeline and speed
 * falls below real time; frames also start dropping. These thresholds turn
 * those signals into a "degraded" flag the UI shows in amber. Hysteresis (a run
 * of consecutive samples in each direction) keeps it from flickering on a
 * single noisy sample.
 */
export const NETWORK_DEGRADED_SPEED = 0.85;
export const NETWORK_RECOVERED_SPEED = 0.95;
/** New dropped frames within one sample that count as a bad sample. */
export const NETWORK_DEGRADED_DROP_DELTA = 3;
/** Consecutive bad samples before the stream is flagged degraded. */
export const NETWORK_DEGRADED_SAMPLES = 3;
/** Consecutive healthy samples before the stream is flagged recovered. */
export const NETWORK_RECOVERED_SAMPLES = 3;

/** Placeholder written wherever a secret would otherwise appear. */
export const REDACTION_PLACEHOLDER = '[REDACTED]';

/** Rotating log file limits. */
export const LOG_MAX_BYTES = 1024 * 1024;
export const LOG_MAX_FILES = 3;

/** Environment switches for hardware-free development. */
export const ENV_SYNTHETIC_INPUT = 'VERTICAL_LIVE_SYNTHETIC_INPUT';
export const ENV_DRY_RUN = 'VERTICAL_LIVE_DRY_RUN';
export const ENV_FFMPEG_PATH = 'VERTICAL_LIVE_FFMPEG_PATH';

/**
 * Characters Windows forbids in file names: the reserved punctuation set plus
 * every ASCII control character. Hyphens and spaces are legal and preserved.
 */
// eslint-disable-next-line no-control-regex
export const INVALID_FILENAME_CHARS = /[<>:"/\\|?*\u0000-\u001F]/g;

/**
 * Resolves the effective bitrate for a preset + custom value pair.
 *
 * Lives here rather than in `schemas.ts` so the renderer can compute the
 * displayed bitrate without pulling Zod into its bundle. Validation stays in
 * the main process, where it belongs.
 */
export function resolveBitrateKbps(
  preset: keyof typeof BITRATE_PRESETS | 'custom',
  customKbps: number,
): number {
  if (preset === 'custom') {
    return Math.min(
      MAX_CUSTOM_BITRATE_KBPS,
      Math.max(MIN_CUSTOM_BITRATE_KBPS, Math.round(customKbps)),
    );
  }
  return BITRATE_PRESETS[preset];
}

/** Narrows an arbitrary number to a supported streaming frame rate. */
export function coerceFps(value: number): (typeof SUPPORTED_FPS)[number] {
  const match = SUPPORTED_FPS.find((fps) => fps === value);
  return match ?? DEFAULT_FPS;
}

/** Windows reserved device names that can never be used as a file stem. */
export const WINDOWS_RESERVED_NAMES = new Set([
  'CON',
  'PRN',
  'AUX',
  'NUL',
  'COM1',
  'COM2',
  'COM3',
  'COM4',
  'COM5',
  'COM6',
  'COM7',
  'COM8',
  'COM9',
  'LPT1',
  'LPT2',
  'LPT3',
  'LPT4',
  'LPT5',
  'LPT6',
  'LPT7',
  'LPT8',
  'LPT9',
]);
