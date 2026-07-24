/**
 * Local recording lifecycle.
 *
 * Strategy (crash resistant by construction):
 *   1. record to Matroska while live -- MKV survives an abrupt process death
 *      because it needs no seekable trailer
 *   2. on a normal stop, remux MKV -> MP4 with `-c copy` (never re-encode)
 *   3. verify the MP4 exists and is non-empty
 *   4. only then delete the temporary MKV
 *   5. if any of that fails, keep the MKV and tell the user where it is
 */

import { constants } from 'node:fs';
import { access, mkdir, stat, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import {
  INVALID_FILENAME_CHARS,
  RECORDING_FILENAME_PREFIX,
  REMUX_TIMEOUT_MS,
  WINDOWS_RESERVED_NAMES,
} from '../../shared/constants';
import { VerticalLiveError } from '../../shared/errors';
import type { RecordingStatus } from '../../shared/types';
import { buildRemuxCommand } from './FfmpegCommandBuilder';
import type { ProbeRunner } from './runProbe';
import { runProbe } from './runProbe';

/** Removes characters Windows forbids and refuses reserved device names. */
export function sanitiseFileStem(stem: string): string {
  const cleaned = stem.replace(INVALID_FILENAME_CHARS, '_').replace(/[.\s]+$/, '');
  const safe = cleaned.length > 0 ? cleaned : 'recording';
  return WINDOWS_RESERVED_NAMES.has(safe.toUpperCase()) ? `_${safe}` : safe;
}

/**
 * `Vertical-Live_2026-07-24_01-35-20` in local time.
 *
 * Local time is deliberate: the file name should match the wall clock the
 * person was broadcasting against, not UTC.
 */
export function buildRecordingStem(date: Date = new Date()): string {
  const pad = (value: number): string => String(value).padStart(2, '0');
  const stamp =
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `_${pad(date.getHours())}-${pad(date.getMinutes())}-${pad(date.getSeconds())}`;
  return sanitiseFileStem(`${RECORDING_FILENAME_PREFIX}_${stamp}`);
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Produces a collision-free base path inside `directory`.
 *
 * A suffix is appended when either the `.mkv` or the `.mp4` already exists, so
 * an existing recording can never be overwritten by either stage.
 */
export async function reserveRecordingPaths(
  directory: string,
  date: Date = new Date(),
  fileExists: (path: string) => Promise<boolean> = exists,
): Promise<{ mkvPath: string; mp4Path: string; stem: string }> {
  const base = buildRecordingStem(date);

  for (let attempt = 0; attempt < 1000; attempt += 1) {
    const stem = attempt === 0 ? base : `${base}_${attempt + 1}`;
    const mkvPath = join(directory, `${stem}.mkv`);
    const mp4Path = join(directory, `${stem}.mp4`);
    if (!(await fileExists(mkvPath)) && !(await fileExists(mp4Path))) {
      return { mkvPath, mp4Path, stem };
    }
  }

  throw new VerticalLiveError(
    'recording-path-unwritable',
    'Could not find an unused recording file name in that folder.',
  );
}

/** Verifies the folder exists and is actually writable, creating it if needed. */
export async function ensureWritableDirectory(directory: string): Promise<void> {
  try {
    await mkdir(directory, { recursive: true });
  } catch (error) {
    throw new VerticalLiveError(
      'recording-path-unwritable',
      `The recording folder could not be created: ${String((error as Error).message)}`,
    );
  }

  // An access() check can lie on Windows network shares, so write a real file.
  const probePath = join(directory, `.vertical-live-write-test-${process.pid}`);
  try {
    await writeFile(probePath, 'ok');
    await unlink(probePath);
  } catch (error) {
    throw new VerticalLiveError(
      'recording-path-unwritable',
      `The recording folder is not writable: ${String((error as Error).message)}`,
    );
  }
}

export interface FinaliseOptions {
  mkvPath: string;
  mp4Path: string;
  getExecutable: () => string;
  runner?: ProbeRunner;
  /** Delete the MKV after a verified MP4. Disabled by the integration test. */
  removeSource?: boolean;
  onLog?: (message: string) => void;
}

/**
 * Remuxes the working MKV into an MP4 without re-encoding, verifies the result
 * and reports what happened. Never throws: a recording problem must not mask a
 * successful broadcast.
 */
export async function finaliseRecording(options: FinaliseOptions): Promise<RecordingStatus> {
  const { mkvPath, mp4Path } = options;
  const runner = options.runner ?? runProbe;

  if (!(await exists(mkvPath))) {
    return {
      phase: 'failed',
      workingPath: mkvPath,
      finalPath: null,
      bytesWritten: 0,
      message:
        'No recording file was produced. FFmpeg may have stopped before writing any data.',
    };
  }

  const sourceStat = await stat(mkvPath);
  if (sourceStat.size === 0) {
    await unlink(mkvPath).catch(() => undefined);
    return {
      phase: 'failed',
      workingPath: null,
      finalPath: null,
      bytesWritten: 0,
      message: 'The recording file was empty and has been removed.',
    };
  }

  options.onLog?.(`Remuxing recording to MP4 (${sourceStat.size} bytes).`);

  const result = await runner(
    options.getExecutable(),
    buildRemuxCommand(mkvPath, mp4Path),
    REMUX_TIMEOUT_MS,
  );

  const remuxOk = result.code === 0 && !result.timedOut && !result.spawnError;

  if (remuxOk && (await exists(mp4Path))) {
    const finalStat = await stat(mp4Path);
    if (finalStat.size > 0) {
      let workingPath: string | null = mkvPath;
      if (options.removeSource !== false) {
        try {
          await unlink(mkvPath);
          workingPath = null;
        } catch {
          // Keeping an extra MKV is harmless; report it rather than fail.
        }
      }
      return {
        phase: 'completed',
        workingPath,
        finalPath: mp4Path,
        bytesWritten: finalStat.size,
        message: null,
      };
    }
  }

  // Remux failed: the MKV is still a complete, playable recording.
  await unlink(mp4Path).catch(() => undefined);
  const reason = result.timedOut
    ? 'the conversion timed out'
    : (result.spawnError ?? `FFmpeg exited with code ${String(result.code)}`);

  options.onLog?.(`Recording remux failed: ${reason}`);

  return {
    phase: 'kept-as-mkv',
    workingPath: mkvPath,
    finalPath: null,
    bytesWritten: sourceStat.size,
    message:
      `The recording could not be converted to MP4 (${reason}). ` +
      'The original MKV file was kept and is fully playable in VLC.',
  };
}
