/**
 * The FFmpeg process wrapper, exercised against a fake child process so no real
 * binary is needed. Covers the graceful-quit contract that keeps recordings
 * from being corrupted.
 */

import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { FfmpegProcess } from '../../src/main/streaming/FfmpegProcess';
import type { FfmpegProcessOptions } from '../../src/main/streaming/FfmpegProcess';
import { clearSecrets, registerSecret } from '../../src/main/logging/redact';

/** A child_process stand-in with controllable streams. */
class FakeChild extends EventEmitter {
  stdout = new PassThrough();
  stderr = new PassThrough();
  stdinWrites: string[] = [];
  killed: NodeJS.Signals | null = null;
  pid = 4242;

  stdin = new Writable({
    write: (chunk: Buffer, _encoding, callback) => {
      this.stdinWrites.push(chunk.toString('utf8'));
      callback();
    },
  });

  kill(signal?: NodeJS.Signals): boolean {
    this.killed = signal ?? 'SIGTERM';
    return true;
  }

  /** Simulates the process exiting. */
  finish(code: number | null, signal: NodeJS.Signals | null = null): void {
    this.stdout.end();
    this.stderr.end();
    this.emit('close', code, signal);
  }
}

function make(options: Omit<FfmpegProcessOptions, 'executable' | 'args' | 'spawner'> = {}): {
  child: FakeChild;
  process: FfmpegProcess;
} {
  const child = new FakeChild();
  const process = new FfmpegProcess({
    executable: 'ffmpeg.exe',
    args: ['-version'],
    spawner: () => child as never,
    ...options,
  });
  return { child, process };
}

afterEach(() => {
  clearSecrets();
  vi.useRealTimers();
});

describe('FfmpegProcess', () => {
  it('spawns and reports the pid', () => {
    const onSpawn = vi.fn();
    const { process } = make({ onSpawn });

    process.start();

    expect(onSpawn).toHaveBeenCalledWith(4242);
    expect(process.pid).toBe(4242);
    expect(process.isRunning).toBe(true);
  });

  it('refuses to start twice', () => {
    const { process } = make();
    process.start();
    expect(() => process.start()).toThrow();
  });

  it('forwards stdout chunks verbatim for binary safety', async () => {
    const chunks: Buffer[] = [];
    const { child, process } = make({ onStdoutChunk: (chunk) => chunks.push(chunk) });

    process.start();
    child.stdout.write(Buffer.from([0xff, 0xd8, 0x00, 0xff, 0xd9]));
    await new Promise((resolve) => setImmediate(resolve));

    expect(Buffer.concat(chunks)).toEqual(Buffer.from([0xff, 0xd8, 0x00, 0xff, 0xd9]));
  });

  it('splits stderr into lines', async () => {
    const lines: string[] = [];
    const { child, process } = make({ onStderrLine: (line) => lines.push(line) });

    process.start();
    child.stderr.write('first line\nsecond line\n');
    await new Promise((resolve) => setImmediate(resolve));

    expect(lines).toEqual(['first line', 'second line']);
  });

  it('treats a lone carriage return as a line break', async () => {
    const lines: string[] = [];
    const { child, process } = make({ onStderrLine: (line) => lines.push(line) });

    process.start();
    child.stderr.write('progress a\rprogress b\r');
    await new Promise((resolve) => setImmediate(resolve));

    expect(lines).toEqual(['progress a', 'progress b']);
  });

  it('redacts registered secrets out of stderr before anyone sees them', async () => {
    registerSecret('SUPER-SECRET-KEY');
    const lines: string[] = [];
    const { child, process } = make({ onStderrLine: (line) => lines.push(line) });

    process.start();
    child.stderr.write('Opening rtmps://x.facebook.com/rtmp/SUPER-SECRET-KEY\n');
    await new Promise((resolve) => setImmediate(resolve));

    expect(lines.join('')).not.toContain('SUPER-SECRET-KEY');
  });

  it('flushes a trailing partial stderr line on exit', async () => {
    const lines: string[] = [];
    const { child, process } = make({ onStderrLine: (line) => lines.push(line) });

    process.start();
    child.stderr.write('no trailing newline');
    await new Promise((resolve) => setImmediate(resolve));
    child.finish(0);
    await process.waitForExit();

    expect(lines).toContain('no trailing newline');
  });

  it('keeps a bounded stderr tail for diagnostics', async () => {
    const { child, process } = make();
    process.start();

    for (let index = 0; index < 500; index += 1) {
      child.stderr.write(`line ${index}\n`);
    }
    await new Promise((resolve) => setImmediate(resolve));

    expect(process.diagnostics.length).toBeLessThanOrEqual(200);
    expect(process.diagnostics.at(-1)).toBe('line 499');
  });

  it('asks FFmpeg to quit gracefully by writing "q" to stdin', async () => {
    const { child, process } = make();
    process.start();

    const stopped = process.stop();
    await new Promise((resolve) => setImmediate(resolve));

    expect(child.stdinWrites.join('')).toBe('q');
    expect(child.killed).toBeNull();

    child.finish(0);
    const result = await stopped;

    expect(result.forced).toBe(false);
    expect(result.requested).toBe(true);
    expect(result.code).toBe(0);
  });

  it('escalates to a kill only after the graceful timeout', async () => {
    vi.useFakeTimers();
    const { child, process } = make({ gracefulTimeoutMs: 1000 });
    process.start();

    const stopped = process.stop();
    await vi.advanceTimersByTimeAsync(500);
    expect(child.killed).toBeNull();

    await vi.advanceTimersByTimeAsync(600);
    expect(child.killed).toBe('SIGKILL');

    child.finish(null, 'SIGKILL');
    expect((await stopped).forced).toBe(true);
  });

  it('forceStop kills immediately', async () => {
    const { child, process } = make();
    process.start();

    const stopped = process.forceStop();
    expect(child.killed).toBe('SIGKILL');

    child.finish(null, 'SIGKILL');
    expect((await stopped).forced).toBe(true);
  });

  it('reports an unrequested exit as such', async () => {
    const onExit = vi.fn();
    const { child, process } = make({ onExit });

    process.start();
    child.finish(1);
    const result = await process.waitForExit();

    expect(result.requested).toBe(false);
    expect(result.code).toBe(1);
    expect(onExit).toHaveBeenCalledTimes(1);
  });

  it('includes the stderr tail in the exit result for classification', async () => {
    const { child, process } = make();
    process.start();

    child.stderr.write('[dshow] Could not open video device\n');
    await new Promise((resolve) => setImmediate(resolve));
    child.finish(1);

    const result = await process.waitForExit();
    expect(result.stderrTail.join(' ')).toContain('Could not open video device');
  });

  it('emits exit exactly once even if close fires after an error', async () => {
    const onExit = vi.fn();
    const { child, process } = make({ onExit });

    process.start();
    child.emit('error', new Error('boom'));
    child.finish(null);
    await process.waitForExit();

    expect(onExit).toHaveBeenCalledTimes(1);
  });

  it('surfaces a spawn failure without throwing', async () => {
    const process = new FfmpegProcess({
      executable: 'missing.exe',
      args: [],
      spawner: () => {
        throw new Error('ENOENT');
      },
    });

    const spawnError = vi.fn();
    process.on('spawn-error', spawnError);
    process.start();

    expect(spawnError).toHaveBeenCalled();
    expect((await process.waitForExit()).code).toBeNull();
  });

  it('stop() on an already-exited process resolves rather than hanging', async () => {
    const { child, process } = make();
    process.start();
    child.finish(0);
    await process.waitForExit();

    await expect(process.stop()).resolves.toMatchObject({ code: 0 });
  });

  it('is safe to call stop() twice', async () => {
    const { child, process } = make();
    process.start();

    const first = process.stop();
    const second = process.stop();
    await new Promise((resolve) => setImmediate(resolve));
    child.finish(0);

    await expect(Promise.all([first, second])).resolves.toHaveLength(2);
    // Only the first stop writes the quit command.
    expect(child.stdinWrites.join('')).toBe('q');
  });
});
