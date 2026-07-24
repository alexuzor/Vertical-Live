/**
 * Extracts a live microphone level from FFmpeg's `ebur128` log lines.
 *
 * The renderer is sandboxed and cannot read the microphone, so the metering
 * pipeline runs an `ebur128=peak=true` filter on the captured audio and FFmpeg
 * prints a measurement roughly every 100 ms to stderr at info level:
 *
 *   [Parsed_ebur128_0 @ 0x..] [info] t: 0.4  TARGET:-23 LUFS  M: -21.8 S:-120.7 \
 *      I: -21.8 LUFS  LRA: 0.0 LU  FTPK: -18.1 dBFS  TPK: -18.1 dBFS
 *
 * We read `FTPK` (frame true peak, in dBFS, one value per channel) because it
 * tracks the last 100 ms and so gives a responsive meter. The value is mapped
 * from the meter's dBFS floor..0 range onto 0..1 for the UI.
 */

/** Meter floor: quieter than this reads as an empty meter. */
export const METER_FLOOR_DBFS = -60;

/** Matches `FTPK: -18.1 dBFS` and `FTPK: -18.1 -12.0 dBFS` (stereo). */
const FTPK_RE = /\bFTPK:\s*(-?(?:inf|\d+(?:\.\d+)?))(?:\s+(-?(?:inf|\d+(?:\.\d+)?)))?\s*dBFS/i;

function parseDb(token: string | undefined): number {
  if (token === undefined) return Number.NEGATIVE_INFINITY;
  if (/^-?inf$/i.test(token)) return Number.NEGATIVE_INFINITY;
  const value = Number.parseFloat(token);
  return Number.isFinite(value) ? value : Number.NEGATIVE_INFINITY;
}

/** Maps a dBFS peak (floor..0) onto a 0..1 meter level. */
export function dbfsToLevel(dbfs: number, floor = METER_FLOOR_DBFS): number {
  if (!Number.isFinite(dbfs)) return 0;
  const level = (dbfs - floor) / (0 - floor);
  return Math.max(0, Math.min(1, level));
}

/**
 * Reads the peak dBFS out of one `ebur128` line, or `null` if the line is not a
 * measurement line. `-inf`/silence yields the floor.
 */
export function parseFtpkDbfs(line: string): number | null {
  const match = FTPK_RE.exec(line);
  if (!match) return null;
  const left = parseDb(match[1]);
  const right = parseDb(match[2]);
  const peak = Math.max(left, right);
  return Number.isFinite(peak) ? peak : METER_FLOOR_DBFS;
}

export interface AudioLevelParserCallbacks {
  /** Fired with a 0..1 level for every ebur128 measurement line. */
  onLevel: (level: number) => void;
}

/** Incremental, line-oriented meter parser. Feed it every stderr line. */
export class AudioLevelParser {
  constructor(private readonly callbacks: AudioLevelParserCallbacks) {}

  /** Returns true if the line was an ebur128 measurement (and was consumed). */
  push(line: string): boolean {
    const dbfs = parseFtpkDbfs(line);
    if (dbfs === null) return false;
    this.callbacks.onLevel(dbfsToLevel(dbfs));
    return true;
  }
}
