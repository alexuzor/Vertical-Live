/**
 * Extracts whole JPEG frames from FFmpeg's MJPEG stdout stream.
 *
 * Design constraints:
 *  - must never block FFmpeg: parsing is O(bytes) with no allocation per byte
 *  - must be bounded: a stalled consumer can never grow the buffer without
 *    limit, and a corrupt stream resynchronises instead of accumulating
 *  - must never emit a partial frame, which would render as a broken image
 *
 * FFmpeg's MJPEG encoder emits baseline JPEGs with no EXIF thumbnail, so a
 * simple SOI/EOI scan is unambiguous.
 */

import { PREVIEW_MAX_BUFFER_BYTES, PREVIEW_MAX_FRAME_BYTES } from '../../shared/constants';

const SOI_0 = 0xff;
const SOI_1 = 0xd8;
const EOI_1 = 0xd9;

export interface PreviewFrameParserOptions {
  onFrame: (frame: Buffer) => void;
  /** Called when the parser had to discard data to recover. */
  onDrop?: (reason: string, bytes: number) => void;
  maxFrameBytes?: number;
  maxBufferBytes?: number;
}

export class PreviewFrameParser {
  private buffer: Buffer = Buffer.alloc(0);
  private readonly maxFrameBytes: number;
  private readonly maxBufferBytes: number;

  private framesEmitted = 0;
  private framesDropped = 0;

  constructor(private readonly options: PreviewFrameParserOptions) {
    this.maxFrameBytes = options.maxFrameBytes ?? PREVIEW_MAX_FRAME_BYTES;
    this.maxBufferBytes = options.maxBufferBytes ?? PREVIEW_MAX_BUFFER_BYTES;
  }

  get stats(): { emitted: number; dropped: number; buffered: number } {
    return {
      emitted: this.framesEmitted,
      dropped: this.framesDropped,
      buffered: this.buffer.length,
    };
  }

  /** Feeds a raw stdout chunk. Emits zero or more complete frames. */
  push(chunk: Buffer): void {
    this.buffer = this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk]);

    for (;;) {
      const start = this.indexOfMarker(this.buffer, SOI_1, 0);
      if (start === -1) {
        // No start of image anywhere; keep only a trailing byte in case an
        // 0xFF straddles the chunk boundary.
        this.discard(this.buffer.length - 1, 'no SOI marker');
        return;
      }

      if (start > 0) {
        // Junk before the first frame (or a resync); throw it away.
        this.discard(start, 'leading junk');
      }

      const end = this.indexOfMarker(this.buffer, EOI_1, 2);
      if (end === -1) {
        // Frame is still arriving. Guard against a runaway buffer.
        if (this.buffer.length > this.maxFrameBytes) {
          this.discard(2, 'oversized frame');
          continue;
        }
        if (this.buffer.length > this.maxBufferBytes) {
          this.framesDropped += 1;
          this.options.onDrop?.('buffer limit exceeded', this.buffer.length);
          this.buffer = Buffer.alloc(0);
        }
        return;
      }

      const frameEnd = end + 2;
      const frame = this.buffer.subarray(0, frameEnd);

      if (frame.length <= this.maxFrameBytes) {
        this.framesEmitted += 1;
        // Copy so the emitted frame does not pin the (much larger) read buffer.
        this.options.onFrame(Buffer.from(frame));
      } else {
        this.framesDropped += 1;
        this.options.onDrop?.('frame exceeded size limit', frame.length);
      }

      this.buffer = this.buffer.subarray(frameEnd);
      if (this.buffer.length === 0) {
        this.buffer = Buffer.alloc(0);
        return;
      }
    }
  }

  /** Drops any partially received frame. */
  reset(): void {
    this.buffer = Buffer.alloc(0);
  }

  private discard(count: number, reason: string): void {
    if (count <= 0) return;
    this.framesDropped += 1;
    this.options.onDrop?.(reason, count);
    this.buffer = this.buffer.subarray(count);
  }

  /**
   * Finds the offset of an `0xFF <marker>` pair at or after `from`.
   * Returns the index of the `0xFF` byte, or -1.
   */
  private indexOfMarker(buffer: Buffer, marker: number, from: number): number {
    for (let index = from; index < buffer.length - 1; index += 1) {
      if (buffer[index] === SOI_0 && buffer[index + 1] === marker) return index;
    }
    return -1;
  }
}

/**
 * Rate limiter that keeps only the newest frame when the renderer falls behind.
 *
 * Preview must never apply back-pressure to FFmpeg, so old frames are dropped
 * rather than queued.
 */
export class LatestFrameThrottle {
  private pending: Buffer | null = null;
  private lastSentAt = 0;
  private timer: NodeJS.Timeout | null = null;
  private dropped = 0;

  constructor(
    private readonly minIntervalMs: number,
    private readonly deliver: (frame: Buffer) => void,
  ) {}

  get droppedCount(): number {
    return this.dropped;
  }

  submit(frame: Buffer, now: number = Date.now()): void {
    const elapsed = now - this.lastSentAt;

    if (elapsed >= this.minIntervalMs && this.pending === null) {
      this.lastSentAt = now;
      this.deliver(frame);
      return;
    }

    if (this.pending !== null) this.dropped += 1;
    this.pending = frame;

    if (this.timer === null) {
      const wait = Math.max(0, this.minIntervalMs - elapsed);
      this.timer = setTimeout(() => {
        this.timer = null;
        const next = this.pending;
        this.pending = null;
        if (next) {
          this.lastSentAt = Date.now();
          this.deliver(next);
        }
      }, wait);
      // Never keep the process alive for a preview frame.
      this.timer.unref?.();
    }
  }

  dispose(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.pending = null;
  }
}
