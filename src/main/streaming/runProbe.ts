/**
 * One-shot FFmpeg invocation helper used by discovery, capability listing,
 * encoder testing and remuxing.
 *
 * Always spawns with an argument array and `shell: false`, so device names
 * containing spaces, quotes, apostrophes, parentheses or Unicode are passed
 * through byte-for-byte with no quoting rules to get wrong.
 */

import { spawn } from 'node:child_process';

import { PROBE_TIMEOUT_MS } from '../../shared/constants';
import { redact } from '../logging/redact';

export interface ProbeResult {
  code: number | null;
  /** Combined stdout + stderr, already redacted. */
  output: string;
  stdout: string;
  timedOut: boolean;
  spawnError: string | null;
}

export type ProbeRunner = (
  executable: string,
  args: readonly string[],
  timeoutMs?: number,
) => Promise<ProbeResult>;

export const runProbe: ProbeRunner = (executable, args, timeoutMs = PROBE_TIMEOUT_MS) =>
  new Promise<ProbeResult>((resolve) => {
    let settled = false;
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let spawnError: string | null = null;

    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(executable, args as string[], {
        shell: false,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (error) {
      resolve({
        code: null,
        output: redact(error),
        stdout: '',
        timedOut: false,
        spawnError: redact(error),
      });
      return;
    }

    const finish = (code: number | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        code,
        output: redact(`${stdout}${stderr}`),
        stdout,
        timedOut,
        spawnError,
      });
    };

    const timer = setTimeout(() => {
      timedOut = true;
      try {
        child.kill('SIGKILL');
      } catch {
        /* already gone */
      }
      finish(null);
    }, timeoutMs);

    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });
    child.on('error', (error) => {
      spawnError = redact(error);
      finish(null);
    });
    child.on('close', (code) => finish(code));
  });
