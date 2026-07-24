/**
 * Error classification turns raw FFmpeg stderr into an actionable code, which
 * drives both the friendly banner and the automatic hardware->software retry.
 */

import { describe, expect, it } from 'vitest';

import {
  buildErrorDetail,
  classifyFfmpegOutput,
  isHardwareEncoderFailure,
} from '../../src/main/streaming/ErrorClassifier';

describe('classifyFfmpegOutput', () => {
  const cases: [string, string][] = [
    ['[dshow @ 001] Could not open video device.', 'camera-in-use'],
    ['[dshow @ 001] Could not find video device with name "Old Cam"', 'camera-not-found'],
    ['[dshow @ 001] Could not find audio device with name "Old Mic"', 'microphone-unavailable'],
    ['[dshow @ 001] Could not set video options', 'unsupported-camera-mode'],
    [
      '[h264_nvenc @ 001] OpenEncodeSessionEx failed: no capable devices found',
      'hardware-encoder-init-failed',
    ],
    ['[h264_qsv @ 001] Error initializing the encoder.', 'hardware-encoder-init-failed'],
    ['Unknown encoder h264_amf', 'encoder-unavailable'],
    ['[tcp @ 001] Failed to resolve hostname live-api-s.facebook.com', 'dns-failure'],
    ['[tcp @ 001] Connection refused', 'rtmp-connection-refused'],
    ['[rtmp @ 001] NetStream.Publish.BadName', 'publish-rejected'],
    ['av_interleaved_write_frame(): Broken pipe', 'network-interrupted'],
    ['[tcp @ 001] Network is unreachable', 'network-disconnected'],
    ['av_interleaved_write_frame(): No space left on device', 'disk-full'],
    ['C:\\locked\\out.mkv: Permission denied', 'permission-denied'],
    ['C:\\gone\\out.mkv: No such file or directory', 'recording-path-unwritable'],
  ];

  it.each(cases)('classifies %s', (line, expected) => {
    expect(classifyFfmpegOutput([line]).code).toBe(expected);
  });

  it('prefers the newest matching line', () => {
    const result = classifyFfmpegOutput([
      '[dshow @ 001] Could not set video options',
      '[tcp @ 001] Connection refused',
    ]);
    expect(result.code).toBe('rtmp-connection-refused');
  });

  it('returns the evidence line that triggered the match', () => {
    const result = classifyFfmpegOutput(['noise', '[tcp @ 001] Connection refused']);
    expect(result.evidence).toContain('Connection refused');
  });

  it('falls back when nothing matches', () => {
    const result = classifyFfmpegOutput(['some completely unremarkable line']);
    expect(result.code).toBe('unexpected-exit');
    expect(result.evidence).toBe('some completely unremarkable line');
  });

  it('accepts a custom fallback', () => {
    expect(classifyFfmpegOutput(['nothing'], 'internal-error').code).toBe('internal-error');
  });

  it('handles empty output', () => {
    const result = classifyFfmpegOutput([]);
    expect(result.code).toBe('unexpected-exit');
    expect(result.evidence).toBeNull();
  });

  it('detects a camera unplugged mid-stream', () => {
    expect(
      classifyFfmpegOutput(['[dshow @ 001] real-time buffer [Cam] too full, frame dropped!'])
        .code,
    ).toBe('camera-disconnected');
  });
});

describe('isHardwareEncoderFailure', () => {
  it('flags the cases worth retrying with libx264', () => {
    expect(isHardwareEncoderFailure('hardware-encoder-init-failed')).toBe(true);
    expect(isHardwareEncoderFailure('encoder-unavailable')).toBe(true);
  });

  it('does not flag unrelated failures', () => {
    expect(isHardwareEncoderFailure('camera-in-use')).toBe(false);
    expect(isHardwareEncoderFailure('dns-failure')).toBe(false);
    expect(isHardwareEncoderFailure('disk-full')).toBe(false);
  });
});

describe('buildErrorDetail', () => {
  it('keeps the last few meaningful lines', () => {
    const detail = buildErrorDetail(['line one', 'line two', 'line three'], 2);
    expect(detail).toBe('line two\nline three');
  });

  it('strips progress key/value noise', () => {
    const detail = buildErrorDetail(['frame=100', 'fps=30.0', '[error] real failure']);
    expect(detail).toBe('[error] real failure');
  });

  it('returns null when there is nothing useful', () => {
    expect(buildErrorDetail([])).toBeNull();
    expect(buildErrorDetail(['frame=1', 'progress=continue'])).toBeNull();
  });
});
