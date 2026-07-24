/**
 * Recording naming and finalisation. The key guarantees:
 *  - never overwrite an existing recording
 *  - never produce an invalid Windows file name
 *  - never lose the MKV when the MP4 remux fails
 */

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  buildRecordingStem,
  ensureWritableDirectory,
  finaliseRecording,
  reserveRecordingPaths,
  sanitiseFileStem,
} from '../../src/main/streaming/RecordingFinalizer';
import { VerticalLiveError } from '../../src/shared/errors';
import type { ProbeResult } from '../../src/main/streaming/runProbe';

let workDir: string;

beforeEach(async () => {
  workDir = await mkdtemp(join(tmpdir(), 'vertical-live-test-'));
});

afterEach(async () => {
  await rm(workDir, { recursive: true, force: true });
});

describe('sanitiseFileStem', () => {
  it('keeps hyphens, underscores and spaces, which are legal on Windows', () => {
    expect(sanitiseFileStem('Vertical-Live_2026-07-24_01-35-20')).toBe(
      'Vertical-Live_2026-07-24_01-35-20',
    );
    expect(sanitiseFileStem('My Recording')).toBe('My Recording');
  });

  it('replaces every character Windows forbids', () => {
    expect(sanitiseFileStem('a<b>c:d"e/f\\g|h?i*j')).toBe('a_b_c_d_e_f_g_h_i_j');
  });

  it('strips control characters', () => {
    expect(sanitiseFileStem('name\u0000with\u001Fcontrol')).toBe('name_with_control');
  });

  it('strips trailing dots and spaces, which Windows silently drops', () => {
    expect(sanitiseFileStem('recording. . ')).toBe('recording');
  });

  it('escapes reserved device names', () => {
    expect(sanitiseFileStem('CON')).toBe('_CON');
    expect(sanitiseFileStem('nul')).toBe('_nul');
    expect(sanitiseFileStem('COM1')).toBe('_COM1');
  });

  it('never returns an empty stem', () => {
    expect(sanitiseFileStem('')).toBe('recording');
    expect(sanitiseFileStem('///')).toBe('___');
  });
});

describe('buildRecordingStem', () => {
  it('uses the documented date-and-time pattern in local time', () => {
    const date = new Date(2026, 6, 24, 1, 35, 20);
    expect(buildRecordingStem(date)).toBe('Vertical-Live_2026-07-24_01-35-20');
  });

  it('zero-pads every component', () => {
    const date = new Date(2026, 0, 5, 9, 8, 7);
    expect(buildRecordingStem(date)).toBe('Vertical-Live_2026-01-05_09-08-07');
  });

  it('produces a name that survives sanitisation unchanged', () => {
    const stem = buildRecordingStem(new Date(2026, 11, 31, 23, 59, 59));
    expect(sanitiseFileStem(stem)).toBe(stem);
  });
});

describe('reserveRecordingPaths', () => {
  it('returns matching mkv and mp4 paths', async () => {
    const date = new Date(2026, 6, 24, 1, 35, 20);
    const result = await reserveRecordingPaths(workDir, date);

    expect(result.mkvPath).toBe(join(workDir, 'Vertical-Live_2026-07-24_01-35-20.mkv'));
    expect(result.mp4Path).toBe(join(workDir, 'Vertical-Live_2026-07-24_01-35-20.mp4'));
  });

  it('never overwrites an existing mkv', async () => {
    const date = new Date(2026, 6, 24, 1, 35, 20);
    await writeFile(join(workDir, 'Vertical-Live_2026-07-24_01-35-20.mkv'), 'x');

    const result = await reserveRecordingPaths(workDir, date);
    expect(result.stem).toBe('Vertical-Live_2026-07-24_01-35-20_2');
  });

  it('never overwrites an existing mp4 either', async () => {
    const date = new Date(2026, 6, 24, 1, 35, 20);
    await writeFile(join(workDir, 'Vertical-Live_2026-07-24_01-35-20.mp4'), 'x');

    const result = await reserveRecordingPaths(workDir, date);
    expect(result.mkvPath).toContain('_2.mkv');
  });

  it('keeps counting past a second collision', async () => {
    const date = new Date(2026, 6, 24, 1, 35, 20);
    await writeFile(join(workDir, 'Vertical-Live_2026-07-24_01-35-20.mkv'), 'x');
    await writeFile(join(workDir, 'Vertical-Live_2026-07-24_01-35-20_2.mkv'), 'x');

    expect((await reserveRecordingPaths(workDir, date)).stem).toBe(
      'Vertical-Live_2026-07-24_01-35-20_3',
    );
  });

  it('throws rather than looping forever if every name is taken', async () => {
    await expect(reserveRecordingPaths(workDir, new Date(), async () => true)).rejects.toThrow(
      VerticalLiveError,
    );
  });
});

describe('ensureWritableDirectory', () => {
  it('creates a missing directory', async () => {
    const nested = join(workDir, 'a', 'b', 'c');
    await expect(ensureWritableDirectory(nested)).resolves.toBeUndefined();
  });

  it('accepts an existing writable directory', async () => {
    await expect(ensureWritableDirectory(workDir)).resolves.toBeUndefined();
  });

  it('leaves no probe file behind', async () => {
    await ensureWritableDirectory(workDir);
    const { readdir } = await import('node:fs/promises');
    const entries = await readdir(workDir);
    expect(entries.filter((name) => name.includes('write-test'))).toHaveLength(0);
  });

  it('reports an unusable path as a recording error', async () => {
    // A path whose parent is a file, not a directory.
    const filePath = join(workDir, 'not-a-dir');
    await writeFile(filePath, 'x');

    await expect(ensureWritableDirectory(join(filePath, 'child'))).rejects.toThrow(
      VerticalLiveError,
    );
  });
});

describe('finaliseRecording', () => {
  const getExecutable = () => 'ffmpeg.exe';

  function probe(code: number | null, overrides: Partial<ProbeResult> = {}): ProbeResult {
    return { code, output: '', stdout: '', timedOut: false, spawnError: null, ...overrides };
  }

  it('produces an MP4 and removes the MKV when the remux succeeds', async () => {
    const mkvPath = join(workDir, 'take.mkv');
    const mp4Path = join(workDir, 'take.mp4');
    await writeFile(mkvPath, 'matroska-bytes');

    const runner = vi.fn(async () => {
      await writeFile(mp4Path, 'mp4-bytes');
      return probe(0);
    });

    const status = await finaliseRecording({ mkvPath, mp4Path, getExecutable, runner });

    expect(status.phase).toBe('completed');
    expect(status.finalPath).toBe(mp4Path);
    expect(status.workingPath).toBeNull();
    expect(status.bytesWritten).toBeGreaterThan(0);
    await expect(readFile(mkvPath)).rejects.toThrow();
  });

  it('never re-encodes during finalisation', async () => {
    const mkvPath = join(workDir, 'take.mkv');
    const mp4Path = join(workDir, 'take.mp4');
    await writeFile(mkvPath, 'x');

    const runner = vi.fn(async (_exe: string, args: readonly string[]) => {
      expect(args).toContain('-c');
      expect(args).toContain('copy');
      expect(args).not.toContain('libx264');
      await writeFile(mp4Path, 'y');
      return probe(0);
    });

    await finaliseRecording({ mkvPath, mp4Path, getExecutable, runner });
    expect(runner).toHaveBeenCalledTimes(1);
  });

  it('keeps the MKV when the remux fails', async () => {
    const mkvPath = join(workDir, 'take.mkv');
    const mp4Path = join(workDir, 'take.mp4');
    await writeFile(mkvPath, 'matroska-bytes');

    const status = await finaliseRecording({
      mkvPath,
      mp4Path,
      getExecutable,
      runner: async () => probe(1),
    });

    expect(status.phase).toBe('kept-as-mkv');
    expect(status.workingPath).toBe(mkvPath);
    expect(status.finalPath).toBeNull();
    expect(status.message).toContain('MKV');
    await expect(readFile(mkvPath, 'utf8')).resolves.toBe('matroska-bytes');
  });

  it('keeps the MKV when the remux produces a zero-byte MP4', async () => {
    const mkvPath = join(workDir, 'take.mkv');
    const mp4Path = join(workDir, 'take.mp4');
    await writeFile(mkvPath, 'data');

    const status = await finaliseRecording({
      mkvPath,
      mp4Path,
      getExecutable,
      runner: async () => {
        await writeFile(mp4Path, '');
        return probe(0);
      },
    });

    expect(status.phase).toBe('kept-as-mkv');
    await expect(readFile(mkvPath, 'utf8')).resolves.toBe('data');
  });

  it('reports a timeout without losing the recording', async () => {
    const mkvPath = join(workDir, 'take.mkv');
    await writeFile(mkvPath, 'data');

    const status = await finaliseRecording({
      mkvPath,
      mp4Path: join(workDir, 'take.mp4'),
      getExecutable,
      runner: async () => probe(null, { timedOut: true }),
    });

    expect(status.phase).toBe('kept-as-mkv');
    expect(status.message).toContain('timed out');
  });

  it('reports a missing source file rather than throwing', async () => {
    const status = await finaliseRecording({
      mkvPath: join(workDir, 'never-created.mkv'),
      mp4Path: join(workDir, 'never-created.mp4'),
      getExecutable,
      runner: async () => probe(0),
    });

    expect(status.phase).toBe('failed');
    expect(status.message).toContain('No recording file');
  });

  it('removes an empty MKV and says so', async () => {
    const mkvPath = join(workDir, 'empty.mkv');
    await writeFile(mkvPath, '');

    const status = await finaliseRecording({
      mkvPath,
      mp4Path: join(workDir, 'empty.mp4'),
      getExecutable,
      runner: async () => probe(0),
    });

    expect(status.phase).toBe('failed');
    expect(status.message).toContain('empty');
    await expect(readFile(mkvPath)).rejects.toThrow();
  });

  it('can keep the MKV on request', async () => {
    const mkvPath = join(workDir, 'take.mkv');
    const mp4Path = join(workDir, 'take.mp4');
    await writeFile(mkvPath, 'x');

    const status = await finaliseRecording({
      mkvPath,
      mp4Path,
      getExecutable,
      removeSource: false,
      runner: async () => {
        await writeFile(mp4Path, 'y');
        return probe(0);
      },
    });

    expect(status.phase).toBe('completed');
    await expect(readFile(mkvPath, 'utf8')).resolves.toBe('x');
  });
});
