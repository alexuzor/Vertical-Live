/**
 * Statistics come from FFmpeg's `-progress` key/value stream, never from the
 * human-readable status line. These tests pin that contract, including the
 * `out_time_ms`-is-actually-microseconds quirk.
 */

import { describe, expect, it, vi } from 'vitest';

import {
  ProgressParser,
  parseBitrate,
  parseOutTimeMs,
  parseSpeed,
  statsFromFields,
} from '../../src/main/streaming/ProgressParser';

const BLOCK = [
  'frame=150',
  'fps=30.00',
  'stream_0_0_q=28.0',
  'bitrate=3500.1kbits/s',
  'total_size=2187500',
  'out_time_us=5000000',
  'out_time_ms=5000000',
  'out_time=00:00:05.000000',
  'dup_frames=2',
  'drop_frames=1',
  'speed=1.02x',
  'progress=continue',
];

describe('parseBitrate', () => {
  it('parses kbits/s', () => {
    expect(parseBitrate('3500.1kbits/s')).toBeCloseTo(3500.1);
    expect(parseBitrate(' 2500kbits/s')).toBe(2500);
  });

  it('converts mbits/s', () => {
    expect(parseBitrate('10.5mbits/s')).toBeCloseTo(10500);
  });

  it('treats N/A and missing values as zero', () => {
    expect(parseBitrate('N/A')).toBe(0);
    expect(parseBitrate(undefined)).toBe(0);
  });
});

describe('parseSpeed', () => {
  it('strips the x suffix', () => {
    expect(parseSpeed('1.02x')).toBeCloseTo(1.02);
    expect(parseSpeed('0.5x')).toBe(0.5);
  });

  it('handles N/A', () => {
    expect(parseSpeed('N/A')).toBe(0);
    expect(parseSpeed(undefined)).toBe(0);
  });
});

describe('parseOutTimeMs', () => {
  it('treats out_time_us as microseconds', () => {
    expect(parseOutTimeMs({ out_time_us: '5000000' })).toBe(5000);
  });

  it('treats out_time_ms as microseconds too, matching FFmpeg', () => {
    // FFmpeg writes the same microsecond value into both fields.
    expect(parseOutTimeMs({ out_time_ms: '5000000' })).toBe(5000);
  });

  it('falls back to the HH:MM:SS.ffffff clock', () => {
    expect(parseOutTimeMs({ out_time: '00:01:30.500000' })).toBe(90_500);
    expect(parseOutTimeMs({ out_time: '01:00:00.000000' })).toBe(3_600_000);
  });

  it('never returns a negative duration', () => {
    expect(parseOutTimeMs({ out_time: '-00:00:01.000000' })).toBe(0);
    expect(parseOutTimeMs({})).toBe(0);
  });

  it('ignores N/A', () => {
    expect(parseOutTimeMs({ out_time_us: 'N/A', out_time: '00:00:02.000000' })).toBe(2000);
  });
});

describe('statsFromFields', () => {
  it('maps a complete block', () => {
    const fields = Object.fromEntries(BLOCK.map((line) => line.split('=') as [string, string]));
    const stats = statsFromFields(fields, 1000);

    expect(stats).toEqual({
      frames: 150,
      fps: 30,
      outTimeMs: 5000,
      bitrateKbps: 3500.1,
      speed: 1.02,
      droppedFrames: 1,
      duplicatedFrames: 2,
      totalBytes: 2187500,
      timestamp: 1000,
    });
  });

  it('produces zeroes rather than NaN for a startup block', () => {
    const stats = statsFromFields({ frame: '0', fps: '0.00', bitrate: 'N/A', speed: 'N/A' });
    expect(stats.frames).toBe(0);
    expect(stats.bitrateKbps).toBe(0);
    expect(stats.speed).toBe(0);
    expect(Number.isNaN(stats.fps)).toBe(false);
  });
});

describe('ProgressParser', () => {
  it('emits one sample per completed block', () => {
    const onStats = vi.fn();
    const parser = new ProgressParser({ onStats });
    for (const line of BLOCK) parser.push(line);

    expect(onStats).toHaveBeenCalledTimes(1);
    expect(onStats.mock.calls[0]?.[0]).toMatchObject({ frames: 150, fps: 30 });
  });

  it('emits nothing until the block is closed', () => {
    const onStats = vi.fn();
    const parser = new ProgressParser({ onStats });
    parser.push('frame=10');
    parser.push('fps=30.0');
    expect(onStats).not.toHaveBeenCalled();
  });

  it('fires onEnd for progress=end', () => {
    const onEnd = vi.fn();
    const parser = new ProgressParser({ onEnd });
    parser.push('frame=900');
    parser.push('progress=end');
    expect(onEnd).toHaveBeenCalledTimes(1);
  });

  it('routes non-progress lines to the log callback', () => {
    const onLogLine = vi.fn();
    const onStats = vi.fn();
    const parser = new ProgressParser({ onLogLine, onStats });

    parser.push('[dshow @ 000001] Could not open video device');
    parser.push('  Stream #0:0: Video: mjpeg');

    expect(onLogLine).toHaveBeenCalledTimes(2);
    expect(onStats).not.toHaveBeenCalled();
  });

  it('survives log lines interleaved into a progress block', () => {
    // Log output and progress output share stderr, so this happens in practice.
    const onStats = vi.fn();
    const onLogLine = vi.fn();
    const parser = new ProgressParser({ onStats, onLogLine });

    parser.push('frame=42');
    parser.push('[rtmp @ 00f] Sending stream');
    parser.push('fps=29.5');
    parser.push('progress=continue');

    expect(onLogLine).toHaveBeenCalledTimes(1);
    expect(onStats).toHaveBeenCalledTimes(1);
    expect(onStats.mock.calls[0]?.[0]).toMatchObject({ frames: 42, fps: 29.5 });
  });

  it('ignores a progress line with no preceding fields', () => {
    const onStats = vi.fn();
    const parser = new ProgressParser({ onStats });
    parser.push('progress=continue');
    expect(onStats).not.toHaveBeenCalled();
  });

  it('resets between blocks so values do not leak forward', () => {
    const onStats = vi.fn();
    const parser = new ProgressParser({ onStats });

    parser.push('frame=10');
    parser.push('drop_frames=5');
    parser.push('progress=continue');

    parser.push('frame=20');
    parser.push('progress=continue');

    expect(onStats.mock.calls[1]?.[0]).toMatchObject({ frames: 20, droppedFrames: 0 });
  });

  it('accepts stream_N_M_ fields without treating them as log noise', () => {
    const onLogLine = vi.fn();
    const parser = new ProgressParser({ onLogLine });
    parser.push('stream_0_0_q=23.0');
    expect(onLogLine).not.toHaveBeenCalled();
  });

  it('discards a partial block on reset', () => {
    const onStats = vi.fn();
    const parser = new ProgressParser({ onStats });
    parser.push('frame=99');
    parser.reset();
    parser.push('progress=continue');
    expect(onStats).not.toHaveBeenCalled();
  });

  it('ignores blank lines', () => {
    const onLogLine = vi.fn();
    const parser = new ProgressParser({ onLogLine });
    parser.push('');
    parser.push('   ');
    expect(onLogLine).not.toHaveBeenCalled();
  });
});
