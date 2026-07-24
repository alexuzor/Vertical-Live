/**
 * Size-limited rotating file logger.
 *
 * Writes are queued and flushed asynchronously so the main process is never
 * blocked by disk I/O during a live stream. Every message is redacted before it
 * is written.
 */

import {
  createWriteStream,
  existsSync,
  mkdirSync,
  renameSync,
  statSync,
  unlinkSync,
} from 'node:fs';
import type { WriteStream } from 'node:fs';
import { join } from 'node:path';

import { LOG_MAX_BYTES, LOG_MAX_FILES } from '../../shared/constants';

import { redact } from './redact';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export interface LoggerOptions {
  directory: string;
  fileName?: string;
  minLevel?: LogLevel;
  /** Mirror output to the terminal. Enabled automatically in development. */
  echoToConsole?: boolean;
  /** Number of most-recent lines to keep in memory for diagnostics reports. */
  ringBufferSize?: number;
}

export class Logger {
  private readonly directory: string;
  private readonly filePath: string;
  private readonly minLevel: LogLevel;
  private readonly echoToConsole: boolean;
  private readonly ringBufferSize: number;

  private stream: WriteStream | null = null;
  private bytesWritten = 0;
  private readonly ring: string[] = [];
  private disposed = false;

  constructor(options: LoggerOptions) {
    this.directory = options.directory;
    this.filePath = join(options.directory, options.fileName ?? 'vertical-live.log');
    this.minLevel = options.minLevel ?? 'info';
    this.echoToConsole = options.echoToConsole ?? false;
    this.ringBufferSize = options.ringBufferSize ?? 400;

    try {
      mkdirSync(this.directory, { recursive: true });
      this.bytesWritten = existsSync(this.filePath) ? statSync(this.filePath).size : 0;
      this.openStream();
    } catch (error) {
      // A broken log destination must never prevent the app from starting.

      console.error('[vertical-live] unable to open log file:', redact(error));
      this.stream = null;
    }
  }

  get path(): string {
    return this.filePath;
  }

  debug(message: string, meta?: unknown): void {
    this.write('debug', message, meta);
  }

  info(message: string, meta?: unknown): void {
    this.write('info', message, meta);
  }

  warn(message: string, meta?: unknown): void {
    this.write('warn', message, meta);
  }

  error(message: string, meta?: unknown): void {
    this.write('error', message, meta);
  }

  /** Most recent redacted log lines, oldest first. */
  recentLines(): readonly string[] {
    return this.ring;
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    const stream = this.stream;
    this.stream = null;
    if (!stream) return;
    await new Promise<void>((resolve) => {
      stream.end(() => resolve());
    });
  }

  private openStream(): void {
    this.stream = createWriteStream(this.filePath, { flags: 'a', encoding: 'utf8' });
    this.stream.on('error', (error) => {
      console.error('[vertical-live] log stream error:', redact(error));
      this.stream = null;
    });
  }

  private write(level: LogLevel, message: string, meta?: unknown): void {
    if (this.disposed) return;
    if (LEVEL_ORDER[level] < LEVEL_ORDER[this.minLevel]) return;

    const safeMessage = redact(message);
    const safeMeta = meta === undefined ? '' : ` ${redact(meta)}`;
    const line = `${new Date().toISOString()} [${level.toUpperCase()}] ${safeMessage}${safeMeta}\n`;

    this.ring.push(line.trimEnd());
    if (this.ring.length > this.ringBufferSize) this.ring.shift();

    if (this.echoToConsole) {
      const sink = level === 'error' ? console.error : console.warn;
      sink(line.trimEnd());
    }

    if (!this.stream) return;

    const size = Buffer.byteLength(line, 'utf8');
    if (this.bytesWritten + size > LOG_MAX_BYTES) {
      this.rotate();
    }

    this.stream?.write(line);
    this.bytesWritten += size;
  }

  /**
   * Rotates `vertical-live.log` to `.1`, `.1` to `.2` and so on, discarding the
   * oldest. Rotation is synchronous but happens at most once per megabyte.
   */
  private rotate(): void {
    const stream = this.stream;
    this.stream = null;
    stream?.end();

    try {
      const oldest = `${this.filePath}.${LOG_MAX_FILES}`;
      if (existsSync(oldest)) unlinkSync(oldest);

      for (let index = LOG_MAX_FILES - 1; index >= 1; index -= 1) {
        const from = `${this.filePath}.${index}`;
        if (existsSync(from)) renameSync(from, `${this.filePath}.${index + 1}`);
      }

      if (existsSync(this.filePath)) renameSync(this.filePath, `${this.filePath}.1`);
    } catch {
      // If rotation fails we simply keep appending to the existing file.
    }

    this.bytesWritten = 0;
    try {
      this.openStream();
    } catch {
      this.stream = null;
    }
  }
}

/**
 * Process-wide logger. Assigned once during main-process startup, before any
 * other subsystem runs.
 */
let activeLogger: Logger | null = null;

export function setLogger(logger: Logger): void {
  activeLogger = logger;
}

export function getLogger(): Logger {
  if (!activeLogger) {
    throw new Error('Logger has not been initialised yet.');
  }
  return activeLogger;
}

/** Safe accessor for code that may run before or after logger lifetime. */
export function tryGetLogger(): Logger | null {
  return activeLogger;
}
