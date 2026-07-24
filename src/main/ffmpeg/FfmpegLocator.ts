/**
 * Resolves and validates the FFmpeg executable.
 *
 * Resolution order:
 *   1. `VERTICAL_LIVE_FFMPEG_PATH` (explicit override, used by CI and tests)
 *   2. Packaged app:   <resources>/ffmpeg/ffmpeg.exe
 *   3. Development:    <repo>/resources/ffmpeg/ffmpeg.exe
 *   4. Last resort:    ffmpeg(.exe) on PATH  -- logged as a warning, because the
 *      shipped application must never rely on a system install.
 */

import { spawn } from 'node:child_process';
import { accessSync, constants, existsSync, statSync } from 'node:fs';
import { delimiter, join, resolve } from 'node:path';

import { ENV_FFMPEG_PATH, PROBE_TIMEOUT_MS } from '../../shared/constants';
import type { FfmpegInfo } from '../../shared/types';
import { redact } from '../logging/redact';

export interface LocatorContext {
  /** True when running from an asar-packaged build. */
  isPackaged: boolean;
  /** `process.resourcesPath` in a packaged app. */
  resourcesPath: string | null;
  /** Repository root (or app path) in development. */
  appPath: string;
  /** Injected for testing. */
  env?: NodeJS.ProcessEnv;
}

const EXECUTABLE_NAME = process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg';

interface Candidate {
  path: string;
  source: FfmpegInfo['source'];
}

/** Builds the ordered candidate list without touching the filesystem. */
export function buildCandidates(context: LocatorContext): Candidate[] {
  const env = context.env ?? process.env;
  const candidates: Candidate[] = [];

  const override = env[ENV_FFMPEG_PATH]?.trim();
  if (override) {
    candidates.push({ path: resolve(override), source: 'env-override' });
  }

  if (context.isPackaged && context.resourcesPath) {
    candidates.push({
      path: join(context.resourcesPath, 'ffmpeg', EXECUTABLE_NAME),
      source: 'packaged-resource',
    });
  }

  candidates.push({
    path: join(context.appPath, 'resources', 'ffmpeg', EXECUTABLE_NAME),
    source: 'dev-resource',
  });

  // `app.getAppPath()` points inside app.asar when packaged, so also probe the
  // directory two levels up, which is where a `--dir` build keeps resources.
  if (context.isPackaged) {
    candidates.push({
      path: join(context.appPath, '..', 'ffmpeg', EXECUTABLE_NAME),
      source: 'packaged-resource',
    });
  }

  for (const dir of (env.PATH ?? '').split(delimiter)) {
    const trimmed = dir.trim();
    if (!trimmed) continue;
    candidates.push({ path: join(trimmed, EXECUTABLE_NAME), source: 'system-path' });
  }

  return candidates;
}

function isExecutableFile(path: string): boolean {
  try {
    if (!existsSync(path)) return false;
    if (!statSync(path).isFile()) return false;
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** Runs FFmpeg with the given args and returns combined output. */
function runFfmpeg(
  executable: string,
  args: string[],
  timeoutMs = PROBE_TIMEOUT_MS,
): Promise<{ code: number | null; output: string }> {
  return new Promise((resolvePromise) => {
    let settled = false;
    let output = '';

    const child = spawn(executable, args, {
      shell: false,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const finish = (code: number | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolvePromise({ code, output });
    };

    const timer = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {
        /* already gone */
      }
      finish(null);
    }, timeoutMs);

    child.stdout?.on('data', (chunk: Buffer) => {
      output += chunk.toString('utf8');
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      output += chunk.toString('utf8');
    });
    child.on('error', () => finish(null));
    child.on('close', (code) => finish(code));
  });
}

export interface FfmpegRuntime {
  info: FfmpegInfo;
}

const UNAVAILABLE: FfmpegInfo = {
  available: false,
  path: null,
  version: null,
  source: 'not-found',
  hasDshow: false,
  hasRtmp: false,
  hasRtmps: false,
  hasLibx264: false,
  error: null,
};

/** Extracts the version token from `ffmpeg -version` output. */
export function parseVersion(output: string): string | null {
  const match = /^ffmpeg version (\S+)/m.exec(output);
  return match?.[1] ?? null;
}

/**
 * Locates FFmpeg and verifies it can actually do what Vertical Live needs:
 * report a version, demux DirectShow, speak RTMP/RTMPS and encode H.264.
 */
export class FfmpegLocator {
  private cached: FfmpegInfo | null = null;

  constructor(private readonly context: LocatorContext) {}

  /** Cached result of the last successful validation. */
  get info(): FfmpegInfo {
    return this.cached ?? UNAVAILABLE;
  }

  /** Path to the executable, or throws when FFmpeg is unavailable. */
  requirePath(): string {
    const path = this.cached?.path;
    if (!this.cached?.available || !path) {
      throw new Error('FFmpeg is not available.');
    }
    return path;
  }

  async validate(force = false): Promise<FfmpegInfo> {
    if (this.cached && !force) return this.cached;

    const candidates = buildCandidates(this.context);
    const seen = new Set<string>();

    for (const candidate of candidates) {
      const key = candidate.path.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      if (!isExecutableFile(candidate.path)) continue;

      const info = await this.inspect(candidate.path, candidate.source);
      if (info.available || info.error) {
        this.cached = info;
        return info;
      }
    }

    this.cached = {
      ...UNAVAILABLE,
      error:
        'FFmpeg was not found. Run "npm run setup:ffmpeg" to download it into resources/ffmpeg, ' +
        'or set VERTICAL_LIVE_FFMPEG_PATH to an existing ffmpeg executable.',
    };
    return this.cached;
  }

  private async inspect(path: string, source: FfmpegInfo['source']): Promise<FfmpegInfo> {
    const version = await runFfmpeg(path, ['-hide_banner', '-version']);
    if (version.code !== 0) {
      return {
        ...UNAVAILABLE,
        path,
        source,
        error: `The FFmpeg executable at ${path} could not be run: ${redact(
          version.output.slice(0, 400),
        )}`,
      };
    }

    const [protocols, encoders, demuxers] = await Promise.all([
      runFfmpeg(path, ['-hide_banner', '-protocols']),
      runFfmpeg(path, ['-hide_banner', '-encoders']),
      runFfmpeg(path, ['-hide_banner', '-demuxers']),
    ]);

    const protocolText = protocols.output;
    const hasRtmp = /^\s*rtmp\s*$/m.test(protocolText) || /\brtmp\b/.test(protocolText);
    const hasRtmps = /\brtmps\b/.test(protocolText);
    const hasLibx264 = /\blibx264\b/.test(encoders.output);
    const hasDshow = /\bdshow\b/.test(demuxers.output);

    const problems: string[] = [];
    if (!hasRtmp) problems.push('the rtmp protocol');
    if (!hasLibx264) problems.push('the libx264 encoder');
    if (process.platform === 'win32' && !hasDshow) problems.push('the dshow input device');

    return {
      available: problems.length === 0,
      path,
      version: parseVersion(version.output),
      source,
      hasDshow,
      hasRtmp,
      hasRtmps,
      hasLibx264,
      // Missing rtmps is reported separately as a warning: rtmp:// still works,
      // so it must not block startup.
      error:
        problems.length === 0
          ? null
          : `This FFmpeg build is missing ${problems.join(', ')}. ` +
            'Replace resources/ffmpeg with a full Windows build (see README).',
    };
  }
}
