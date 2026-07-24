/**
 * Parser for FFmpeg's machine-readable `-progress` output.
 *
 * We point `-progress` at `pipe:2` and pass `-nostats`, so stderr carries clean
 * `key=value` blocks terminated by `progress=continue` (or `progress=end`)
 * interleaved with ordinary log lines. FFmpeg emits each progress block with a
 * single write, so blocks never tear; unrecognised lines are simply ignored,
 * which lets the same stream double as the diagnostics channel.
 *
 * Never parse the human-readable status line: it is lossy, locale-sensitive and
 * absent whenever `-nostats` is in effect.
 */

import type { StreamStats } from '../../shared/types';

/** Keys FFmpeg emits inside a progress block. */
const PROGRESS_KEYS = new Set([
  'frame',
  'fps',
  'bitrate',
  'total_size',
  'out_time_us',
  'out_time_ms',
  'out_time',
  'dup_frames',
  'drop_frames',
  'speed',
  'progress',
]);

const KEY_VALUE = /^([a-z0-9_]+)=(.*)$/;

function toNumber(value: string | undefined, fallback = 0): number {
  if (value === undefined) return fallback;
  const trimmed = value.trim();
  if (trimmed === '' || trimmed === 'N/A') return fallback;
  const parsed = Number.parseFloat(trimmed);
  return Number.isFinite(parsed) ? parsed : fallback;
}

/** `3500.1kbits/s` -> 3500.1. `N/A` -> 0. */
export function parseBitrate(value: string | undefined): number {
  if (value === undefined) return 0;
  const match = /^\s*([0-9]*\.?[0-9]+)\s*kbits\/s/i.exec(value);
  if (match) return Number.parseFloat(match[1] as string);
  // Some builds report bits/s or Mbits/s.
  const mbits = /^\s*([0-9]*\.?[0-9]+)\s*mbits\/s/i.exec(value);
  if (mbits) return Number.parseFloat(mbits[1] as string) * 1000;
  return 0;
}

/** `1.02x` -> 1.02. `N/A` -> 0. */
export function parseSpeed(value: string | undefined): number {
  if (value === undefined) return 0;
  const match = /^\s*([0-9]*\.?[0-9]+)\s*x/i.exec(value);
  return match ? Number.parseFloat(match[1] as string) : 0;
}

/**
 * FFmpeg writes the same microsecond value into both `out_time_us` and
 * `out_time_ms` (a long-standing quirk of `print_report`), so both are treated
 * as microseconds and `out_time` (HH:MM:SS.ffffff) is used as a fallback.
 */
export function parseOutTimeMs(fields: Readonly<Record<string, string>>): number {
  const micros = fields.out_time_us ?? fields.out_time_ms;
  if (micros !== undefined && micros.trim() !== '' && micros.trim() !== 'N/A') {
    const parsed = Number.parseInt(micros, 10);
    if (Number.isFinite(parsed)) return Math.max(0, Math.round(parsed / 1000));
  }

  const clock = fields.out_time;
  if (clock) {
    const match = /^(-?)(\d+):(\d{2}):(\d{2}(?:\.\d+)?)$/.exec(clock.trim());
    if (match) {
      const sign = match[1] === '-' ? -1 : 1;
      const hours = Number.parseInt(match[2] as string, 10);
      const minutes = Number.parseInt(match[3] as string, 10);
      const seconds = Number.parseFloat(match[4] as string);
      const total = (hours * 3600 + minutes * 60 + seconds) * 1000 * sign;
      return Math.max(0, Math.round(total));
    }
  }

  return 0;
}

/** Converts one complete progress block into a `StreamStats` sample. */
export function statsFromFields(
  fields: Readonly<Record<string, string>>,
  timestamp: number = Date.now(),
): StreamStats {
  return {
    frames: Math.max(0, Math.round(toNumber(fields.frame))),
    fps: Math.max(0, toNumber(fields.fps)),
    outTimeMs: parseOutTimeMs(fields),
    bitrateKbps: parseBitrate(fields.bitrate),
    speed: parseSpeed(fields.speed),
    droppedFrames: Math.max(0, Math.round(toNumber(fields.drop_frames))),
    duplicatedFrames: Math.max(0, Math.round(toNumber(fields.dup_frames))),
    totalBytes: Math.max(0, Math.round(toNumber(fields.total_size))),
    timestamp,
  };
}

export interface ProgressParserCallbacks {
  /** Fired once per completed progress block. */
  onStats?: (stats: StreamStats) => void;
  /** Fired when FFmpeg reports `progress=end`. */
  onEnd?: (stats: StreamStats) => void;
  /** Fired for every line that is not part of a progress block. */
  onLogLine?: (line: string) => void;
}

/**
 * Incremental, line-oriented progress parser.
 *
 * Feed it every stderr line; it accumulates progress fields and emits a stats
 * sample each time FFmpeg closes a block.
 */
export class ProgressParser {
  private fields: Record<string, string> = {};
  private sawAnyField = false;

  constructor(private readonly callbacks: ProgressParserCallbacks = {}) {}

  /** Feeds one already-split line. */
  push(line: string): void {
    const trimmed = line.trim();
    if (trimmed.length === 0) return;

    const match = KEY_VALUE.exec(trimmed);
    if (!match) {
      this.callbacks.onLogLine?.(line);
      return;
    }

    const key = match[1] as string;
    const value = match[2] as string;

    // `stream_0_0_q=28.0` and friends are valid progress fields we do not use.
    const isProgressField = PROGRESS_KEYS.has(key) || /^stream_\d+_\d+_/.test(key);
    if (!isProgressField) {
      this.callbacks.onLogLine?.(line);
      return;
    }

    if (key === 'progress') {
      // A `progress=` line with no preceding fields is meaningless.
      if (this.sawAnyField) {
        const stats = statsFromFields(this.fields);
        this.callbacks.onStats?.(stats);
        if (value.trim() === 'end') this.callbacks.onEnd?.(stats);
      }
      this.fields = {};
      this.sawAnyField = false;
      return;
    }

    this.fields[key] = value;
    this.sawAnyField = true;
  }

  /** Discards any partially accumulated block. */
  reset(): void {
    this.fields = {};
    this.sawAnyField = false;
  }
}
