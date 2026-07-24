/**
 * Encoder selection: an encoder is only offered after a real short encode with
 * the production argument set has succeeded on this machine.
 */

import { describe, expect, it, vi } from 'vitest';

import {
  ENCODER_PREFERENCE,
  EncoderDetector,
  parseListedEncoders,
  selectPreferredEncoder,
  summariseEncoderFailure,
} from '../../src/main/streaming/EncoderDetector';
import type { EncoderProbe } from '../../src/shared/types';
import type { ProbeResult } from '../../src/main/streaming/runProbe';

const ENCODERS_OUTPUT = `
Encoders:
 V..... = Video
 ------
 V....D h264_amf             AMD AMF H.264 Encoder (codec h264)
 V....D h264_nvenc           NVIDIA NVENC H.264 encoder (codec h264)
 V....D h264_qsv             H.264 / AVC (Intel Quick Sync Video acceleration) (codec h264)
 V....D libx264              libx264 H.264 / AVC / MPEG-4 AVC (codec h264)
`;

const SOFTWARE_ONLY_OUTPUT = `
Encoders:
 V....D libx264              libx264 H.264 / AVC / MPEG-4 AVC (codec h264)
`;

function probe(code: number | null, output = ''): ProbeResult {
  return { code, output, stdout: '', timedOut: false, spawnError: null };
}

function makeProbe(id: EncoderProbe['id'], usable: boolean): EncoderProbe {
  return { id, label: id, listed: true, usable, detail: null, hardware: id !== 'libx264' };
}

describe('parseListedEncoders', () => {
  it('finds all four supported encoders', () => {
    const listed = parseListedEncoders(ENCODERS_OUTPUT);
    expect(listed.has('h264_nvenc')).toBe(true);
    expect(listed.has('h264_qsv')).toBe(true);
    expect(listed.has('h264_amf')).toBe(true);
    expect(listed.has('libx264')).toBe(true);
  });

  it('reports only what is present', () => {
    const listed = parseListedEncoders(SOFTWARE_ONLY_OUTPUT);
    expect(listed.has('libx264')).toBe(true);
    expect(listed.has('h264_nvenc')).toBe(false);
  });

  it('returns an empty set for empty output', () => {
    expect(parseListedEncoders('').size).toBe(0);
  });
});

describe('selectPreferredEncoder', () => {
  it('prefers NVENC, then QSV, then AMF, then software', () => {
    expect(ENCODER_PREFERENCE.map((definition) => definition.id)).toEqual([
      'h264_nvenc',
      'h264_qsv',
      'h264_amf',
      'libx264',
    ]);
  });

  it('picks the first usable encoder in preference order', () => {
    expect(
      selectPreferredEncoder([
        makeProbe('h264_nvenc', true),
        makeProbe('h264_qsv', true),
        makeProbe('libx264', true),
      ]),
    ).toBe('h264_nvenc');
  });

  it('skips encoders that failed their capability test', () => {
    expect(
      selectPreferredEncoder([
        makeProbe('h264_nvenc', false),
        makeProbe('h264_qsv', false),
        makeProbe('h264_amf', true),
        makeProbe('libx264', true),
      ]),
    ).toBe('h264_amf');
  });

  it('falls back to software when no hardware works', () => {
    expect(
      selectPreferredEncoder([
        makeProbe('h264_nvenc', false),
        makeProbe('h264_qsv', false),
        makeProbe('h264_amf', false),
        makeProbe('libx264', true),
      ]),
    ).toBe('libx264');
  });

  it('returns null when even software encoding fails', () => {
    expect(selectPreferredEncoder([makeProbe('libx264', false)])).toBeNull();
    expect(selectPreferredEncoder([])).toBeNull();
  });
});

describe('summariseEncoderFailure', () => {
  it('extracts the meaningful error lines', () => {
    const summary = summariseEncoderFailure(
      [
        'ffmpeg version 7.1',
        '  configuration: --enable-gpl',
        '  libavutil 59.  8.100',
        '[h264_nvenc @ 0001] Cannot load nvEncodeAPI64.dll',
        'Error initializing output stream 0:0',
      ].join('\n'),
    );

    expect(summary).toContain('nvEncodeAPI64.dll');
    expect(summary).not.toContain('configuration:');
    expect(summary).not.toContain('libavutil');
  });

  it('never returns an empty string', () => {
    expect(summariseEncoderFailure('')).toBeTruthy();
  });

  it('caps the length so a banner cannot be flooded', () => {
    expect(summariseEncoderFailure('error '.repeat(500)).length).toBeLessThanOrEqual(400);
  });
});

describe('EncoderDetector', () => {
  const getExecutable = () => 'ffmpeg.exe';

  it('runs a real encode test per listed encoder', async () => {
    const runner = vi.fn(async (_exe: string, args: readonly string[]) => {
      if (args.includes('-encoders')) return probe(0, ENCODERS_OUTPUT);
      return probe(0);
    });

    const detector = new EncoderDetector({ getExecutable, runner });
    const result = await detector.detect();

    // 1 listing + 4 capability tests.
    expect(runner).toHaveBeenCalledTimes(5);
    expect(result.selected).toBe('h264_nvenc');
    expect(result.probes.every((p) => p.usable)).toBe(true);
  });

  it('tests with the production flags, not a generic encode', async () => {
    const seen: string[][] = [];
    const runner = vi.fn(async (_exe: string, args: readonly string[]) => {
      seen.push([...args]);
      if (args.includes('-encoders')) return probe(0, ENCODERS_OUTPUT);
      return probe(0);
    });

    await new EncoderDetector({ getExecutable, runner }).detect();

    const nvencTest = seen.find((args) => args.includes('h264_nvenc'));
    expect(nvencTest).toBeDefined();
    expect(nvencTest).toContain('-rc');
    expect(nvencTest).toContain('cbr');
    expect(nvencTest).toContain('testsrc2=size=640x360:rate=30');
  });

  it('excludes an encoder whose capability test fails', async () => {
    const runner = vi.fn(async (_exe: string, args: readonly string[]) => {
      if (args.includes('-encoders')) return probe(0, ENCODERS_OUTPUT);
      if (args.includes('h264_nvenc')) {
        return probe(
          1,
          '[h264_nvenc @ 1] OpenEncodeSessionEx failed: no capable devices found',
        );
      }
      return probe(0);
    });

    const result = await new EncoderDetector({ getExecutable, runner }).detect();

    expect(result.probes.find((p) => p.id === 'h264_nvenc')?.usable).toBe(false);
    expect(result.probes.find((p) => p.id === 'h264_nvenc')?.detail).toContain(
      'OpenEncodeSessionEx',
    );
    expect(result.selected).toBe('h264_qsv');
  });

  it('marks an unlisted encoder unusable without running a test for it', async () => {
    const runner = vi.fn(async (_exe: string, args: readonly string[]) => {
      if (args.includes('-encoders')) return probe(0, SOFTWARE_ONLY_OUTPUT);
      return probe(0);
    });

    const result = await new EncoderDetector({ getExecutable, runner }).detect();

    expect(result.probes.find((p) => p.id === 'h264_nvenc')).toMatchObject({
      listed: false,
      usable: false,
    });
    expect(result.selected).toBe('libx264');
    // 1 listing + 1 test for libx264 only.
    expect(runner).toHaveBeenCalledTimes(2);
  });

  it('treats a timeout as unusable', async () => {
    const runner = vi.fn(async (_exe: string, args: readonly string[]) => {
      if (args.includes('-encoders')) return probe(0, ENCODERS_OUTPUT);
      if (args.includes('h264_amf')) {
        return { code: null, output: '', stdout: '', timedOut: true, spawnError: null };
      }
      return probe(0);
    });

    const result = await new EncoderDetector({ getExecutable, runner }).detect();
    const amf = result.probes.find((p) => p.id === 'h264_amf');

    expect(amf?.usable).toBe(false);
    expect(amf?.detail).toContain('timed out');
  });

  it('returns null when nothing at all works', async () => {
    const runner = vi.fn(async (_exe: string, args: readonly string[]) => {
      if (args.includes('-encoders')) return probe(0, ENCODERS_OUTPUT);
      return probe(1, 'Unknown encoder');
    });

    const result = await new EncoderDetector({ getExecutable, runner }).detect();
    expect(result.selected).toBeNull();
  });

  it('caches results and re-probes only when forced', async () => {
    const runner = vi.fn(async (_exe: string, args: readonly string[]) =>
      args.includes('-encoders') ? probe(0, SOFTWARE_ONLY_OUTPUT) : probe(0),
    );

    const detector = new EncoderDetector({ getExecutable, runner });
    await detector.detect();
    await detector.detect();
    expect(runner).toHaveBeenCalledTimes(2);

    await detector.detect(true);
    expect(runner).toHaveBeenCalledTimes(4);
  });

  it('can skip the runtime test for fast unit tests', async () => {
    const runner = vi.fn(async () => probe(0, ENCODERS_OUTPUT));
    const detector = new EncoderDetector({ getExecutable, runner, skipRuntimeTest: true });

    const result = await detector.detect();

    expect(runner).toHaveBeenCalledTimes(1);
    expect(result.selected).toBe('h264_nvenc');
  });
});
