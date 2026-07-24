/**
 * Thin, testable wrapper around a single FFmpeg child process.
 *
 * Responsibilities:
 *  - spawn with an argument array and `shell: false` (never a shell string)
 *  - expose stdout as a raw byte stream (used for the MJPEG preview branch)
 *  - expose stderr as redacted text lines (diagnostics + `-progress` output)
 *  - graceful `q` shutdown with a hard-kill escalation
 *  - PID bookkeeping so orphans can be reaped after an abnormal restart
 */

import { spawn } from 'node:child_process';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';

import { GRACEFUL_STOP_TIMEOUT_MS } from '../../shared/constants';
import { redact } from '../logging/redact';
import { TypedEmitter } from '../util/TypedEmitter';

/** Injectable spawner so tests never touch a real process. */
export type Spawner = (
  executable: string,
  args: readonly string[],
) => ChildProcessWithoutNullStreams;

export const defaultSpawner: Spawner = (executable, args) =>
  spawn(executable, args as string[], {
    shell: false,
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe'],
  }) as ChildProcessWithoutNullStreams;

export interface FfmpegProcessOptions {
  executable: string;
  args: readonly string[];
  spawner?: Spawner;
  /** Called for each already-redacted stderr line. */
  onStderrLine?: (line: string) => void;
  /** Called with raw stdout chunks (binary-safe). */
  onStdoutChunk?: (chunk: Buffer) => void;
  /** Notified when the process is spawned successfully. */
  onSpawn?: (pid: number | undefined) => void;
  /** Notified once, when the process exits for any reason. */
  onExit?: (result: FfmpegExitResult) => void;
  gracefulTimeoutMs?: number;
}

export interface FfmpegExitResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  /** True when we escalated past the graceful `q`. */
  forced: boolean;
  /** True when `stop()` initiated the exit. */
  requested: boolean;
  /** Last redacted stderr lines, for error classification. */
  stderrTail: string[];
}

export interface FfmpegProcessEvents {
  stderr: [line: string];
  stdout: [chunk: Buffer];
  exit: [result: FfmpegExitResult];
  'spawn-error': [error: Error];
  [key: string]: readonly unknown[];
}

const STDERR_TAIL_LIMIT = 200;

export class FfmpegProcess extends TypedEmitter<FfmpegProcessEvents> {
  private child: ChildProcessWithoutNullStreams | null = null;
  private stderrBuffer = '';
  private readonly stderrTail: string[] = [];
  private exited = false;
  private stopRequested = false;
  private forced = false;
  private killTimer: NodeJS.Timeout | null = null;
  private exitPromise: Promise<FfmpegExitResult> | null = null;
  private resolveExit: ((result: FfmpegExitResult) => void) | null = null;

  readonly executable: string;
  readonly args: readonly string[];

  private readonly gracefulTimeoutMs: number;
  private readonly spawner: Spawner;
  private readonly options: FfmpegProcessOptions;

  constructor(options: FfmpegProcessOptions) {
    super();
    this.options = options;
    this.executable = options.executable;
    this.args = options.args;
    this.spawner = options.spawner ?? defaultSpawner;
    this.gracefulTimeoutMs = options.gracefulTimeoutMs ?? GRACEFUL_STOP_TIMEOUT_MS;
  }

  get pid(): number | undefined {
    return this.child?.pid;
  }

  get isRunning(): boolean {
    return this.child !== null && !this.exited;
  }

  /** Redacted stderr lines captured so far, newest last. */
  get diagnostics(): readonly string[] {
    return this.stderrTail;
  }

  /**
   * Spawns the process. Resolves as soon as the child is created; use
   * `waitForExit()` to observe the outcome.
   */
  start(): void {
    if (this.child) throw new Error('FfmpegProcess has already been started.');

    this.exitPromise = new Promise<FfmpegExitResult>((resolvePromise) => {
      this.resolveExit = resolvePromise;
    });

    let child: ChildProcessWithoutNullStreams;
    try {
      child = this.spawner(this.executable, this.args);
    } catch (error) {
      // `finish` is what flips `exited` and settles the exit promise; setting
      // the flag here first would make it return early and leave every
      // `waitForExit()` caller hanging.
      const err = error instanceof Error ? error : new Error(String(error));
      this.emit('spawn-error', err);
      this.finish({
        code: null,
        signal: null,
        forced: false,
        requested: false,
        stderrTail: [],
      });
      return;
    }

    this.child = child;

    child.stdout?.on('data', (chunk: Buffer) => {
      this.options.onStdoutChunk?.(chunk);
      this.emit('stdout', chunk);
    });

    child.stderr?.on('data', (chunk: Buffer) => {
      this.consumeStderr(chunk);
    });

    // FFmpeg exits on its own if stdin closes unexpectedly, so swallow EPIPE.
    child.stdin?.on('error', () => undefined);

    child.on('error', (error) => {
      this.emit('spawn-error', error);
      if (!this.exited) {
        this.finish({
          code: null,
          signal: null,
          forced: this.forced,
          requested: this.stopRequested,
          stderrTail: [...this.stderrTail],
        });
      }
    });

    child.on('close', (code, signal) => {
      this.flushStderr();
      this.finish({
        code,
        signal: signal ?? null,
        forced: this.forced,
        requested: this.stopRequested,
        stderrTail: [...this.stderrTail],
      });
    });

    if (child.pid !== undefined) {
      this.options.onSpawn?.(child.pid);
    }
  }

  /** Resolves when the process has fully exited. */
  waitForExit(): Promise<FfmpegExitResult> {
    if (!this.exitPromise) {
      return Promise.resolve({
        code: null,
        signal: null,
        forced: false,
        requested: false,
        stderrTail: [],
      });
    }
    return this.exitPromise;
  }

  /**
   * Asks FFmpeg to quit gracefully by writing `q` to stdin, so it can flush
   * muxers and write container trailers. Escalates to a hard kill if FFmpeg has
   * not exited within the graceful timeout.
   */
  async stop(): Promise<FfmpegExitResult> {
    if (!this.child || this.exited) {
      return this.waitForExit();
    }

    // A second Stop must join the first, never issue a second quit command or
    // start a second kill timer.
    if (this.stopRequested) {
      return this.waitForExit();
    }

    this.stopRequested = true;

    try {
      // FFmpeg on Windows reads piped stdin through PeekNamedPipe, so a plain
      // write of "q" is honoured exactly as it would be from a console.
      this.child.stdin?.write('q');
    } catch {
      // stdin already closed; the kill escalation below will handle it.
    }

    this.killTimer = setTimeout(() => {
      this.forced = true;
      this.hardKill();
    }, this.gracefulTimeoutMs);

    return this.waitForExit();
  }

  /** Immediately terminates the process tree. Corrupts in-flight containers. */
  forceStop(): Promise<FfmpegExitResult> {
    if (!this.child || this.exited) return this.waitForExit();
    this.stopRequested = true;
    this.forced = true;
    this.hardKill();
    return this.waitForExit();
  }

  private hardKill(): void {
    const child = this.child;
    if (!child?.pid) return;

    if (process.platform === 'win32') {
      // `taskkill /T` also reaps any helper processes FFmpeg may have created.
      try {
        spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], {
          shell: false,
          windowsHide: true,
          stdio: 'ignore',
        }).on('error', () => undefined);
      } catch {
        /* fall through to kill() */
      }
    }

    try {
      child.kill('SIGKILL');
    } catch {
      /* already gone */
    }
  }

  private consumeStderr(chunk: Buffer): void {
    this.stderrBuffer += chunk.toString('utf8');

    // FFmpeg uses \r for in-place status updates; treat both as line breaks.
    const parts = this.stderrBuffer.split(/\r\n|\n|\r/);
    this.stderrBuffer = parts.pop() ?? '';

    for (const part of parts) {
      this.emitStderrLine(part);
    }

    // Guard against a pathological producer that never emits a line break.
    if (this.stderrBuffer.length > 64 * 1024) {
      this.emitStderrLine(this.stderrBuffer);
      this.stderrBuffer = '';
    }
  }

  private flushStderr(): void {
    if (this.stderrBuffer.length > 0) {
      this.emitStderrLine(this.stderrBuffer);
      this.stderrBuffer = '';
    }
  }

  private emitStderrLine(raw: string): void {
    const line = redact(raw).trimEnd();
    if (line.length === 0) return;

    this.stderrTail.push(line);
    if (this.stderrTail.length > STDERR_TAIL_LIMIT) this.stderrTail.shift();

    this.options.onStderrLine?.(line);
    this.emit('stderr', line);
  }

  private finish(result: FfmpegExitResult): void {
    if (this.exited) return;
    this.exited = true;
    if (this.killTimer) {
      clearTimeout(this.killTimer);
      this.killTimer = null;
    }
    this.options.onExit?.(result);
    this.emit('exit', result);
    this.resolveExit?.(result);
    this.resolveExit = null;
    this.child = null;
  }
}
