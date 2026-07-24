/**
 * Turns raw FFmpeg stderr into an actionable error code.
 *
 * Every pattern here was chosen from FFmpeg's own message strings for the
 * DirectShow input, the RTMP protocol and the file muxers. Input is already
 * redacted by `FfmpegProcess`, so nothing sensitive can reach a rule.
 */

import type { ErrorCode } from '../../shared/errors';

interface Rule {
  code: ErrorCode;
  patterns: RegExp[];
}

/**
 * Ordered most-specific first: the first rule that matches wins, so
 * "Could not run filter" never shadows "device in use".
 */
const RULES: readonly Rule[] = [
  {
    code: 'camera-in-use',
    patterns: [
      /device or resource busy/i,
      /could not open video device/i,
      /the device is in use/i,
      /0x80070005/i, // E_ACCESSDENIED from DirectShow
      /VIDIOC_/i,
    ],
  },
  {
    code: 'camera-not-found',
    patterns: [
      /could not find video device with name/i,
      /could not find video-only device/i,
      /no such video device/i,
    ],
  },
  {
    code: 'microphone-unavailable',
    patterns: [
      /could not find audio device with name/i,
      /could not find audio-only device/i,
      /no such audio device/i,
    ],
  },
  {
    code: 'camera-disconnected',
    patterns: [
      /error while decoding stream .*dshow/i,
      /real-time buffer .* full.*frame dropped/i,
      /input\/output error/i,
      /device has been removed/i,
      /0x8007001f/i, // ERROR_GEN_FAILURE, typical of an unplugged USB camera
    ],
  },
  {
    code: 'unsupported-camera-mode',
    patterns: [
      /could not set video options/i,
      /could not set video format/i,
      /could not find matching (?:pin|format)/i,
      /unsupported .*(?:size|frame rate|framerate)/i,
      /could not run filter/i,
    ],
  },
  {
    code: 'hardware-encoder-init-failed',
    patterns: [
      /openencodesessionex failed/i,
      /cannot load (?:nvcuda|nvEncodeAPI)/i,
      /no capable devices found/i,
      /initializeencoder failed/i,
      /failed to initialise?e? (?:the )?(?:amf|qsv|nvenc)/i,
      /error initializing the encoder/i,
      /device creation failed/i,
      /amf failed/i,
      /error creating (?:a )?(?:qsv|amf) /i,
      /no device available for encoder/i,
      /driver does not support the required nvenc api/i,
    ],
  },
  {
    code: 'encoder-unavailable',
    patterns: [/unknown encoder/i, /encoder .* not found/i],
  },
  {
    code: 'dns-failure',
    patterns: [
      /failed to resolve hostname/i,
      /name or service not known/i,
      /getaddrinfo/i,
      /no such host is known/i,
    ],
  },
  {
    code: 'rtmp-connection-refused',
    patterns: [
      /connection refused/i,
      /cannot open connection tcp:/i,
      /rtmp.*handshake.*fail/i,
      /tls.*handshake.*fail/i,
      /error in the pull function/i,
    ],
  },
  {
    code: 'publish-rejected',
    patterns: [
      /netstream\.publish\.badname/i,
      /netconnection\.connect\.rejected/i,
      /netconnection\.connect\.invalidapp/i,
      /server error/i,
      /unauthorized/i,
      /403 forbidden/i,
      /rtmp server sent error/i,
    ],
  },
  {
    code: 'network-interrupted',
    patterns: [
      /broken pipe/i,
      /connection reset by peer/i,
      /error writing trailer/i,
      /end of file/i,
      /error muxing a packet/i,
      /software caused connection abort/i,
    ],
  },
  {
    code: 'network-disconnected',
    patterns: [
      /network is unreachable/i,
      /connection timed out/i,
      /a socket operation was attempted to an unreachable network/i,
    ],
  },
  {
    code: 'disk-full',
    patterns: [/no space left on device/i, /disk full/i, /there is not enough space/i],
  },
  {
    code: 'permission-denied',
    patterns: [/permission denied/i, /access is denied/i, /operation not permitted/i],
  },
  {
    code: 'recording-path-unwritable',
    patterns: [
      /no such file or directory/i,
      /unable to open .*for writing/i,
      /error opening output file/i,
      /could not write header/i,
    ],
  },
];

export interface ClassifiedError {
  code: ErrorCode;
  /** The (already redacted) line that triggered the classification. */
  evidence: string | null;
}

/**
 * Classifies FFmpeg output. Scans newest-to-oldest so the failure that actually
 * killed the process wins over earlier warnings.
 */
export function classifyFfmpegOutput(
  lines: readonly string[],
  fallback: ErrorCode = 'unexpected-exit',
): ClassifiedError {
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index] as string;
    for (const rule of RULES) {
      for (const pattern of rule.patterns) {
        if (pattern.test(line)) {
          return { code: rule.code, evidence: line };
        }
      }
    }
  }
  return { code: fallback, evidence: lines.at(-1) ?? null };
}

/** True when the failure is worth retrying with the software encoder. */
export function isHardwareEncoderFailure(code: ErrorCode): boolean {
  return code === 'hardware-encoder-init-failed' || code === 'encoder-unavailable';
}

/** Builds the redacted technical detail shown in the diagnostics disclosure. */
export function buildErrorDetail(lines: readonly string[], limit = 12): string | null {
  const meaningful = lines
    .filter((line) => !/^[a-z0-9_]+=/.test(line))
    .filter((line) => line.trim().length > 0);
  if (meaningful.length === 0) return null;
  return meaningful.slice(-limit).join('\n');
}
