/**
 * The meter parser is tested against real `ebur128` lines captured from the
 * bundled FFmpeg (both the stereo two-value and mono single-value forms).
 */

import { describe, expect, it, vi } from 'vitest';

import {
  AudioLevelParser,
  METER_FLOOR_DBFS,
  dbfsToLevel,
  parseFtpkDbfs,
} from '../../src/main/streaming/AudioLevelParser';

// Captured verbatim from the bundled ffmpeg (stereo, `level+info` prefix).
const STEREO_LINE =
  '[Parsed_ebur128_0 @ 000001fee08e9dc0] [info] t: 0.499979   TARGET:-23 LUFS    ' +
  'M: -21.8 S:-120.7     I: -21.8 LUFS       LRA:   0.0 LU  ' +
  'FTPK: -21.1 -21.1 dBFS  TPK: -21.1 -21.1 dBFS';

const MONO_LINE =
  '[Parsed_ebur128_0 @ 0x1] [info] t: 0.1  M: -30.0 S:-30.0  I: -30.0 LUFS  ' +
  'LRA: 0.0 LU  FTPK: -18.1 dBFS  TPK: -18.1 dBFS';

const SILENCE_LINE =
  '[Parsed_ebur128_0 @ 0x1] [info] t: 0.1  M:-120.7 S:-120.7  I: -70.0 LUFS  ' +
  'LRA: 0.0 LU  FTPK: -inf -inf dBFS  TPK: -inf -inf dBFS';

describe('parseFtpkDbfs', () => {
  it('reads the peak dBFS from a stereo line', () => {
    expect(parseFtpkDbfs(STEREO_LINE)).toBeCloseTo(-21.1, 5);
  });

  it('reads the peak dBFS from a mono line', () => {
    expect(parseFtpkDbfs(MONO_LINE)).toBeCloseTo(-18.1, 5);
  });

  it('takes the louder of two channels', () => {
    const line = 'FTPK: -30.0 -12.0 dBFS';
    expect(parseFtpkDbfs(line)).toBeCloseTo(-12.0, 5);
  });

  it('treats -inf (digital silence) as the meter floor', () => {
    expect(parseFtpkDbfs(SILENCE_LINE)).toBe(METER_FLOOR_DBFS);
  });

  it('returns null for lines without an FTPK measurement', () => {
    expect(parseFtpkDbfs('[info] Summary:')).toBeNull();
    expect(parseFtpkDbfs('frame=10 fps=30')).toBeNull();
    expect(parseFtpkDbfs('')).toBeNull();
  });
});

describe('dbfsToLevel', () => {
  it('maps the floor to 0 and 0 dBFS to 1', () => {
    expect(dbfsToLevel(METER_FLOOR_DBFS)).toBe(0);
    expect(dbfsToLevel(0)).toBe(1);
  });

  it('maps the midpoint to ~0.5', () => {
    expect(dbfsToLevel(-30)).toBeCloseTo(0.5, 5);
  });

  it('clamps out-of-range values', () => {
    expect(dbfsToLevel(6)).toBe(1);
    expect(dbfsToLevel(-200)).toBe(0);
    expect(dbfsToLevel(Number.NEGATIVE_INFINITY)).toBe(0);
  });
});

describe('AudioLevelParser', () => {
  it('emits a 0..1 level for an ebur128 line and reports it as consumed', () => {
    const onLevel = vi.fn();
    const parser = new AudioLevelParser({ onLevel });

    const consumed = parser.push(STEREO_LINE);

    expect(consumed).toBe(true);
    expect(onLevel).toHaveBeenCalledTimes(1);
    const level = onLevel.mock.calls[0]?.[0] as number;
    expect(level).toBeGreaterThan(0);
    expect(level).toBeLessThan(1);
  });

  it('ignores non-measurement lines and reports them as not consumed', () => {
    const onLevel = vi.fn();
    const parser = new AudioLevelParser({ onLevel });

    expect(parser.push('frame=1 fps=30 bitrate=1000kbits/s')).toBe(false);
    expect(onLevel).not.toHaveBeenCalled();
  });
});
