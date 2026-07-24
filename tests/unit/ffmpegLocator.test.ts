/**
 * FFmpeg path resolution across development, packaged and installed layouts.
 */

import { delimiter, join, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { buildCandidates, parseVersion } from '../../src/main/ffmpeg/FfmpegLocator';

const EXE = process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg';

describe('buildCandidates', () => {
  it('puts the explicit environment override first', () => {
    const candidates = buildCandidates({
      isPackaged: true,
      resourcesPath: 'C:\\Program Files\\Vertical Live\\resources',
      appPath: 'C:\\Program Files\\Vertical Live\\resources\\app.asar',
      env: { VERTICAL_LIVE_FFMPEG_PATH: 'D:\\tools\\ffmpeg.exe', PATH: '' },
    });

    expect(candidates[0]).toEqual({
      path: resolve('D:\\tools\\ffmpeg.exe'),
      source: 'env-override',
    });
  });

  it('prefers the packaged resource over PATH', () => {
    const candidates = buildCandidates({
      isPackaged: true,
      resourcesPath: 'C:\\App\\resources',
      appPath: 'C:\\App\\resources\\app.asar',
      env: { PATH: 'C:\\Windows\\System32' },
    });

    const packaged = candidates.findIndex((c) => c.source === 'packaged-resource');
    const systemPath = candidates.findIndex((c) => c.source === 'system-path');

    expect(packaged).toBeGreaterThanOrEqual(0);
    expect(packaged).toBeLessThan(systemPath);
    expect(candidates[packaged]?.path).toBe(join('C:\\App\\resources', 'ffmpeg', EXE));
  });

  it('looks in the repo resources directory during development', () => {
    const candidates = buildCandidates({
      isPackaged: false,
      resourcesPath: null,
      appPath: 'C:\\repo\\vertical-live',
      env: { PATH: '' },
    });

    expect(candidates[0]).toEqual({
      path: join('C:\\repo\\vertical-live', 'resources', 'ffmpeg', EXE),
      source: 'dev-resource',
    });
  });

  it('offers PATH only as a last resort', () => {
    const candidates = buildCandidates({
      isPackaged: false,
      resourcesPath: null,
      appPath: 'C:\\repo',
      env: { PATH: ['C:\\a', 'C:\\b'].join(delimiter) },
    });

    const pathCandidates = candidates.filter((c) => c.source === 'system-path');
    expect(pathCandidates.map((c) => c.path)).toEqual([join('C:\\a', EXE), join('C:\\b', EXE)]);
    expect(candidates.at(-1)?.source).toBe('system-path');
  });

  it('ignores empty PATH segments', () => {
    const candidates = buildCandidates({
      isPackaged: false,
      resourcesPath: null,
      appPath: 'C:\\repo',
      env: { PATH: `C:\\a${delimiter}${delimiter}  ${delimiter}C:\\b` },
    });

    expect(candidates.filter((c) => c.source === 'system-path')).toHaveLength(2);
  });

  it('copes with no PATH at all', () => {
    const candidates = buildCandidates({
      isPackaged: false,
      resourcesPath: null,
      appPath: 'C:\\repo',
      env: {},
    });

    expect(candidates.some((c) => c.source === 'dev-resource')).toBe(true);
  });

  it('also probes next to the asar for a --dir build', () => {
    const candidates = buildCandidates({
      isPackaged: true,
      resourcesPath: 'C:\\App\\resources',
      appPath: 'C:\\App\\resources\\app.asar',
      env: { PATH: '' },
    });

    expect(
      candidates.some(
        (c) => c.path === join('C:\\App\\resources\\app.asar', '..', 'ffmpeg', EXE),
      ),
    ).toBe(true);
  });
});

describe('parseVersion', () => {
  it('extracts the version token', () => {
    expect(
      parseVersion('ffmpeg version 7.1.1-essentials_build-www.gyan.dev Copyright (c)'),
    ).toBe('7.1.1-essentials_build-www.gyan.dev');
  });

  it('handles a git build string', () => {
    expect(parseVersion('ffmpeg version n7.1-11-g123abc Copyright')).toBe('n7.1-11-g123abc');
  });

  it('returns null when the banner is absent', () => {
    expect(parseVersion('not ffmpeg output')).toBeNull();
    expect(parseVersion('')).toBeNull();
  });
});
