/**
 * The preview parser must never emit a partial JPEG, must never grow without
 * bound, and must never apply back-pressure to FFmpeg.
 */

import { describe, expect, it, vi } from 'vitest';

import {
  LatestFrameThrottle,
  PreviewFrameParser,
} from '../../src/main/streaming/PreviewFrameParser';

/** A minimal but structurally valid JPEG: SOI ... EOI. */
function makeJpeg(payloadSize = 32, fill = 0x7f): Buffer {
  return Buffer.concat([
    Buffer.from([0xff, 0xd8]),
    Buffer.alloc(payloadSize, fill),
    Buffer.from([0xff, 0xd9]),
  ]);
}

describe('PreviewFrameParser', () => {
  it('emits a single complete frame', () => {
    const onFrame = vi.fn();
    const parser = new PreviewFrameParser({ onFrame });
    const jpeg = makeJpeg();

    parser.push(jpeg);

    expect(onFrame).toHaveBeenCalledTimes(1);
    expect(onFrame.mock.calls[0]?.[0]).toEqual(jpeg);
  });

  it('emits several frames from one chunk', () => {
    const onFrame = vi.fn();
    const parser = new PreviewFrameParser({ onFrame });
    parser.push(Buffer.concat([makeJpeg(8, 1), makeJpeg(8, 2), makeJpeg(8, 3)]));
    expect(onFrame).toHaveBeenCalledTimes(3);
  });

  it('reassembles a frame split across chunk boundaries', () => {
    const onFrame = vi.fn();
    const parser = new PreviewFrameParser({ onFrame });
    const jpeg = makeJpeg(64);

    for (let offset = 0; offset < jpeg.length; offset += 7) {
      parser.push(jpeg.subarray(offset, offset + 7));
    }

    expect(onFrame).toHaveBeenCalledTimes(1);
    expect(onFrame.mock.calls[0]?.[0]).toEqual(jpeg);
  });

  it('handles a split exactly between the two EOI bytes', () => {
    const onFrame = vi.fn();
    const parser = new PreviewFrameParser({ onFrame });
    const jpeg = makeJpeg(16);

    parser.push(jpeg.subarray(0, jpeg.length - 1));
    expect(onFrame).not.toHaveBeenCalled();
    parser.push(jpeg.subarray(jpeg.length - 1));
    expect(onFrame).toHaveBeenCalledTimes(1);
  });

  it('never emits a partial frame', () => {
    const onFrame = vi.fn();
    const parser = new PreviewFrameParser({ onFrame });
    parser.push(Buffer.concat([Buffer.from([0xff, 0xd8]), Buffer.alloc(500, 0x11)]));
    expect(onFrame).not.toHaveBeenCalled();
  });

  it('resynchronises past leading junk', () => {
    const onFrame = vi.fn();
    const onDrop = vi.fn();
    const parser = new PreviewFrameParser({ onFrame, onDrop });

    parser.push(Buffer.concat([Buffer.from([0x00, 0x11, 0x22]), makeJpeg()]));

    expect(onFrame).toHaveBeenCalledTimes(1);
    expect(onDrop).toHaveBeenCalled();
  });

  it('drops a frame that exceeds the size limit', () => {
    const onFrame = vi.fn();
    const onDrop = vi.fn();
    const parser = new PreviewFrameParser({ onFrame, onDrop, maxFrameBytes: 64 });

    parser.push(makeJpeg(4096));

    expect(onFrame).not.toHaveBeenCalled();
    expect(onDrop).toHaveBeenCalled();
  });

  it('bounds the buffer when no EOI ever arrives', () => {
    const onFrame = vi.fn();
    const onDrop = vi.fn();
    const parser = new PreviewFrameParser({
      onFrame,
      onDrop,
      maxFrameBytes: 512,
      maxBufferBytes: 1024,
    });

    for (let index = 0; index < 40; index += 1) {
      parser.push(Buffer.concat([Buffer.from([0xff, 0xd8]), Buffer.alloc(256, 0x33)]));
    }

    expect(parser.stats.buffered).toBeLessThanOrEqual(1024);
    expect(onFrame).not.toHaveBeenCalled();
  });

  it('copies the frame so later writes to the source cannot corrupt it', () => {
    // Node pools small Buffer allocations, so comparing `.buffer` identity
    // proves nothing. Mutating the source is the real test of non-aliasing.
    const onFrame = vi.fn();
    const parser = new PreviewFrameParser({ onFrame });
    const source = Buffer.concat([makeJpeg(8, 0xaa), makeJpeg(8, 0xbb)]);

    parser.push(source);
    const emitted = onFrame.mock.calls[0]?.[0] as Buffer;
    const before = Buffer.from(emitted);

    source.fill(0x00);

    expect(emitted).toEqual(before);
    expect(emitted[2]).toBe(0xaa);
  });

  it('counts what it emitted and dropped', () => {
    const parser = new PreviewFrameParser({ onFrame: () => undefined });
    parser.push(makeJpeg());
    parser.push(makeJpeg());
    expect(parser.stats.emitted).toBe(2);
  });

  it('discards a partial frame on reset', () => {
    const onFrame = vi.fn();
    const parser = new PreviewFrameParser({ onFrame });
    const jpeg = makeJpeg(32);

    parser.push(jpeg.subarray(0, 10));
    parser.reset();
    parser.push(jpeg.subarray(10));

    expect(onFrame).not.toHaveBeenCalled();
  });
});

describe('LatestFrameThrottle', () => {
  it('delivers the first frame immediately', () => {
    const deliver = vi.fn();
    const throttle = new LatestFrameThrottle(80, deliver);

    throttle.submit(Buffer.from([1]), 1000);

    expect(deliver).toHaveBeenCalledTimes(1);
    throttle.dispose();
  });

  it('delivers again once the interval has elapsed', () => {
    const deliver = vi.fn();
    const throttle = new LatestFrameThrottle(80, deliver);

    throttle.submit(Buffer.from([1]), 1000);
    throttle.submit(Buffer.from([2]), 1100);

    expect(deliver).toHaveBeenCalledTimes(2);
    throttle.dispose();
  });

  it('keeps only the newest frame when the consumer is behind', async () => {
    vi.useFakeTimers();
    const deliver = vi.fn();
    const throttle = new LatestFrameThrottle(80, deliver);

    throttle.submit(Buffer.from([1]), 1000);
    throttle.submit(Buffer.from([2]), 1010);
    throttle.submit(Buffer.from([3]), 1020);
    throttle.submit(Buffer.from([4]), 1030);

    await vi.advanceTimersByTimeAsync(200);

    // One immediate + one coalesced delivery of the *latest* frame.
    expect(deliver).toHaveBeenCalledTimes(2);
    expect(deliver.mock.calls[1]?.[0]).toEqual(Buffer.from([4]));
    expect(throttle.droppedCount).toBe(2);

    throttle.dispose();
    vi.useRealTimers();
  });

  it('stops delivering after dispose', async () => {
    vi.useFakeTimers();
    const deliver = vi.fn();
    const throttle = new LatestFrameThrottle(80, deliver);

    throttle.submit(Buffer.from([1]), 1000);
    throttle.submit(Buffer.from([2]), 1005);
    throttle.dispose();

    await vi.advanceTimersByTimeAsync(500);

    expect(deliver).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });
});
