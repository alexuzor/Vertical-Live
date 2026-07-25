/**
 * The FFmpeg command builder is pure, so every argument the app will ever run
 * can be asserted here without touching hardware.
 */

import { describe, expect, it } from 'vitest';

import {
  PREVIEW_FPS,
  PREVIEW_HEIGHT,
  PREVIEW_RTBUFSIZE,
  PREVIEW_WIDTH,
  RECORDING_HEIGHT,
  RECORDING_WIDTH,
  STREAM_HEIGHT,
  STREAM_WIDTH,
} from '../../src/shared/constants';
import {
  InvalidDestinationError,
  buildAudioEncoderArgs,
  buildAudioInputArgs,
  buildBranchScale,
  buildDeviceListCommand,
  buildDeviceOptionsCommand,
  buildEncoderArgs,
  buildEncoderTestCommand,
  NOISE_REDUCTION_CHAIN,
  buildFacebookUrl,
  buildFilterGraph,
  buildMeterCommand,
  buildPortraitCropFilter,
  buildPreviewCommand,
  buildRecordingCommand,
  buildRemuxCommand,
  buildStreamCommand,
  buildVideoInputArgs,
  calculateBufsizeKbps,
  calculateGop,
  escapeDshowName,
  formatDshowInput,
  isDshowNameUsable,
} from '../../src/main/streaming/FfmpegCommandBuilder';
import { DEFAULT_SETTINGS } from '../../src/shared/schemas';
import type { EncoderId } from '../../src/shared/types';

/** Reads the value that follows a flag in an argv array. */
function valueAfter(args: readonly string[], flag: string, occurrence = 0): string | undefined {
  let seen = 0;
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === flag) {
      if (seen === occurrence) return args[index + 1];
      seen += 1;
    }
  }
  return undefined;
}

function countOf(args: readonly string[], flag: string): number {
  return args.filter((arg) => arg === flag).length;
}

/* ------------------------------------------------------------------ */

describe('buildFacebookUrl', () => {
  it('joins a server URL and key with exactly one slash', () => {
    expect(buildFacebookUrl('rtmps://live-api-s.facebook.com:443/rtmp/', 'KEY123')).toBe(
      'rtmps://live-api-s.facebook.com:443/rtmp/KEY123',
    );
  });

  it('does not create a double slash when the server has no trailing slash', () => {
    expect(buildFacebookUrl('rtmps://x.facebook.com/rtmp', 'KEY')).toBe(
      'rtmps://x.facebook.com/rtmp/KEY',
    );
  });

  it('collapses slashes from both halves', () => {
    expect(buildFacebookUrl('rtmps://x.facebook.com/rtmp///', '///KEY')).toBe(
      'rtmps://x.facebook.com/rtmp/KEY',
    );
  });

  it('trims surrounding whitespace safely', () => {
    expect(buildFacebookUrl('  rtmps://x.facebook.com/rtmp/  ', '  KEY  ')).toBe(
      'rtmps://x.facebook.com/rtmp/KEY',
    );
  });

  it('never percent-encodes the key: Facebook keys contain ? & and =', () => {
    const key = 'FB-123?s_bl=1&s_sw=0&s_vt=api-s&a=AbCdEf';
    expect(buildFacebookUrl('rtmps://x.facebook.com/rtmp/', key)).toBe(
      `rtmps://x.facebook.com/rtmp/${key}`,
    );
  });

  it('accepts rtmp:// as well as rtmps://', () => {
    expect(buildFacebookUrl('rtmp://x.facebook.com/rtmp', 'K')).toBe(
      'rtmp://x.facebook.com/rtmp/K',
    );
  });

  it('rejects a non-RTMP scheme', () => {
    expect(() => buildFacebookUrl('https://x.facebook.com/rtmp', 'K')).toThrow(
      InvalidDestinationError,
    );
    expect(() => buildFacebookUrl('file:///etc/passwd', 'K')).toThrow(InvalidDestinationError);
  });

  it('rejects an empty key', () => {
    expect(() => buildFacebookUrl('rtmps://x.facebook.com/rtmp', '   ')).toThrow(
      InvalidDestinationError,
    );
  });

  it('rejects a URL with no host', () => {
    expect(() => buildFacebookUrl('rtmps://', 'K')).toThrow(InvalidDestinationError);
  });

  it('is not hard-coded to one Facebook server', () => {
    expect(buildFacebookUrl('rtmps://live-api-a.facebook.com:443/rtmp/', 'K')).toContain(
      'live-api-a.facebook.com',
    );
  });
});

/* ------------------------------------------------------------------ */

describe('calculateGop', () => {
  it('produces a two-second keyframe interval for every supported rate', () => {
    expect(calculateGop(24)).toBe(48);
    expect(calculateGop(25)).toBe(50);
    expect(calculateGop(30)).toBe(60);
  });

  it('rounds fractional rates', () => {
    expect(calculateGop(29.97)).toBe(60);
  });
});

describe('calculateBufsizeKbps', () => {
  it('gives two seconds of rate-control buffer', () => {
    expect(calculateBufsizeKbps(3500)).toBe(7000);
  });
});

/* ------------------------------------------------------------------ */

describe('portrait framing', () => {
  it('fill crops once to an exact 9:16 rectangle and never scales the source up', () => {
    const crop = buildPortraitCropFilter();
    expect(crop).toContain('crop=');
    // The largest 9:16 rectangle that fits — the minimum crop, centred.
    expect(crop).toContain('min(iw');
    expect(crop).toContain('9/16');
    expect(crop).toContain('16/9');
    // Even dimensions for yuv420p.
    expect(crop).toContain('/2)*2');
    // Crop-first: it must not enlarge the source to cover the canvas.
    expect(crop).not.toContain('scale=');
    expect(crop).not.toContain('increase');
  });

  it('fill branch is a plain scale to the exact output size (master already 9:16)', () => {
    const scale = buildBranchScale('fill', PREVIEW_WIDTH, PREVIEW_HEIGHT);
    expect(scale).toBe(`scale=${PREVIEW_WIDTH}:${PREVIEW_HEIGHT}`);
    expect(scale).not.toContain('crop');
    expect(scale).not.toContain('pad');
  });

  it('fit preserves the whole frame: scale down and pad black, no crop', () => {
    const fit = buildBranchScale('fit', RECORDING_WIDTH, RECORDING_HEIGHT);
    expect(fit).toContain('force_original_aspect_ratio=decrease');
    expect(fit).toContain(
      `pad=${RECORDING_WIDTH}:${RECORDING_HEIGHT}:(ow-iw)/2:(oh-ih)/2:color=black`,
    );
    expect(fit).not.toContain('crop=');
  });

  it('crops exactly once, on the master, only in fill mode', () => {
    const fill = buildFilterGraph('fill', 30, { stream: true, recording: true, preview: true });
    const fit = buildFilterGraph('fit', 30, { stream: true, recording: true, preview: true });
    expect(fill.filterComplex.match(/crop=/g)?.length).toBe(1);
    expect(fill.filterComplex).toContain('[0:v]fps=30,crop=');
    expect(fit.filterComplex).not.toContain('crop=');
  });
});

describe('buildFilterGraph', () => {
  it('normalises the master once: square pixels and yuv420p', () => {
    const { filterComplex } = buildFilterGraph('fill', 30, {
      stream: true,
      recording: false,
      preview: true,
    });
    expect(filterComplex).toContain('setsar=1');
    expect(filterComplex).toContain('format=yuv420p');
    expect(filterComplex).toContain('[0:v]fps=30');
  });

  it('opens the camera once and splits into three branches', () => {
    const { filterComplex, labels } = buildFilterGraph('fill', 30, {
      stream: true,
      recording: true,
      preview: true,
    });
    expect(filterComplex).toContain('[master]split=3');
    expect(countOf(filterComplex.split(';'), '')).toBe(0);
    expect(labels.stream).toBe('v_stream');
    expect(labels.recording).toBe('v_record');
    expect(labels.preview).toBe('v_preview');
  });

  it('scales the Facebook branch to 720x1280', () => {
    const { filterComplex } = buildFilterGraph('fill', 30, {
      stream: true,
      recording: false,
      preview: false,
    });
    expect(filterComplex).toContain(`scale=${STREAM_WIDTH}:${STREAM_HEIGHT}[v_stream]`);
  });

  it('scales the recording branch to the full 1080x1920 output', () => {
    const { filterComplex } = buildFilterGraph('fill', 30, {
      stream: false,
      recording: true,
      preview: false,
    });
    expect(filterComplex).toContain(`scale=${RECORDING_WIDTH}:${RECORDING_HEIGHT}[v_record]`);
    expect(filterComplex).not.toContain(`scale=${STREAM_WIDTH}:${STREAM_HEIGHT}`);
  });

  it('emits a small, slow preview branch', () => {
    const { filterComplex } = buildFilterGraph('fill', 30, {
      stream: false,
      recording: false,
      preview: true,
    });
    expect(filterComplex).toContain(`fps=${PREVIEW_FPS}`);
    expect(filterComplex).toContain(`scale=${PREVIEW_WIDTH}:${PREVIEW_HEIGHT}[v_preview]`);
  });

  it('omits split entirely when only one branch is active', () => {
    const { filterComplex } = buildFilterGraph('fit', 24, {
      stream: false,
      recording: false,
      preview: true,
    });
    expect(filterComplex).not.toContain('split=');
  });

  it('splits audio only when two outputs consume it', () => {
    const both = buildFilterGraph('fill', 30, { stream: true, recording: true, preview: true });
    expect(both.filterComplex).toContain('asplit=2[a_stream][a_record]');

    const one = buildFilterGraph('fill', 30, { stream: true, recording: false, preview: true });
    expect(one.filterComplex).not.toContain('asplit');
    expect(one.labels.streamAudio).toBe('a_stream');
    expect(one.labels.recordingAudio).toBeNull();
  });

  it('wires no audio at all for a preview-only graph', () => {
    const { filterComplex, labels } = buildFilterGraph(
      'fill',
      30,
      { stream: false, recording: false, preview: true },
      { audio: false },
    );
    expect(filterComplex).not.toContain('[1:a]');
    expect(labels.streamAudio).toBeNull();
  });

  it('normalises audio to 48 kHz stereo', () => {
    const { filterComplex } = buildFilterGraph('fill', 30, {
      stream: true,
      recording: false,
      preview: false,
    });
    expect(filterComplex).toContain('sample_rates=48000');
    expect(filterComplex).toContain('channel_layouts=stereo');
    expect(filterComplex).toContain('aresample=async=1000');
  });

  it('refuses to build a graph with no outputs', () => {
    expect(() =>
      buildFilterGraph('fill', 30, { stream: false, recording: false, preview: false }),
    ).toThrow();
  });
});

/* ------------------------------------------------------------------ */

describe('buildEncoderArgs', () => {
  const target = {
    bitrateKbps: 3500,
    maxrateKbps: 3500,
    bufsizeKbps: 7000,
    gop: 60,
    profile: 'stream' as const,
  };

  const encoders: EncoderId[] = ['libx264', 'h264_nvenc', 'h264_qsv', 'h264_amf'];

  it.each(encoders)('%s sets the codec, rate control and GOP', (encoder) => {
    const args = buildEncoderArgs(encoder, target);
    expect(valueAfter(args, '-c:v')).toBe(encoder);
    expect(valueAfter(args, '-b:v')).toBe('3500k');
    expect(valueAfter(args, '-maxrate')).toBe('3500k');
    expect(valueAfter(args, '-bufsize')).toBe('7000k');
    expect(valueAfter(args, '-g')).toBe('60');
    expect(valueAfter(args, '-profile:v')).toBe('high');
  });

  it.each(encoders)('%s disables B-frames for ingest compatibility', (encoder) => {
    expect(valueAfter(buildEncoderArgs(encoder, target), '-bf')).toBe('0');
  });

  it('libx264 uses a fast preset and zerolatency for the stream branch', () => {
    const args = buildEncoderArgs('libx264', target);
    expect(valueAfter(args, '-preset')).toBe('veryfast');
    expect(valueAfter(args, '-tune')).toBe('zerolatency');
    expect(valueAfter(args, '-pix_fmt')).toBe('yuv420p');
    expect(valueAfter(args, '-level:v')).toBe('4.1');
  });

  it('libx264 drops zerolatency for recording, where quality matters more', () => {
    const args = buildEncoderArgs('libx264', { ...target, profile: 'recording' });
    expect(args).not.toContain('zerolatency');
    expect(valueAfter(args, '-preset')).toBe('veryfast');
  });

  it('nvenc uses CBR and low latency while streaming', () => {
    const args = buildEncoderArgs('h264_nvenc', target);
    expect(valueAfter(args, '-rc')).toBe('cbr');
    expect(valueAfter(args, '-tune')).toBe('ll');
    expect(valueAfter(args, '-rc-lookahead')).toBe('0');
  });

  it('qsv requests nv12, which it encodes natively', () => {
    expect(valueAfter(buildEncoderArgs('h264_qsv', target), '-pix_fmt')).toBe('nv12');
  });

  it('amf uses the low-latency usage while streaming', () => {
    const args = buildEncoderArgs('h264_amf', target);
    expect(valueAfter(args, '-usage')).toBe('lowlatency');
    expect(valueAfter(args, '-rc')).toBe('cbr');
  });

  it('throws on an unknown encoder', () => {
    expect(() => buildEncoderArgs('h264_fake' as EncoderId, target)).toThrow();
  });
});

describe('buildAudioEncoderArgs', () => {
  it('produces 128 kbps stereo AAC at 48 kHz', () => {
    const args = buildAudioEncoderArgs(128);
    expect(valueAfter(args, '-c:a')).toBe('aac');
    expect(valueAfter(args, '-b:a')).toBe('128k');
    expect(valueAfter(args, '-ar')).toBe('48000');
    expect(valueAfter(args, '-ac')).toBe('2');
  });
});

/* ------------------------------------------------------------------ */

describe('DirectShow naming', () => {
  it('passes names through verbatim (ffmpeg dshow supports no escapes)', () => {
    const name = "Alex's Webcam (USB 2.0) — 日本語";
    expect(escapeDshowName(name)).toBe(name);
    expect(formatDshowInput('video', name)).toBe(`video=${name}`);
  });

  it('accepts spaces, apostrophes, quotes, parentheses and Unicode', () => {
    expect(isDshowNameUsable('HD Pro Webcam C920')).toBe(true);
    expect(isDshowNameUsable('Bob\'s "Cam" (2)')).toBe(true);
    expect(isDshowNameUsable('カメラ')).toBe(true);
  });

  it('rejects a name containing a colon, which strtok would split', () => {
    expect(isDshowNameUsable('Cam: Front')).toBe(false);
  });

  it('rejects an empty name', () => {
    expect(isDshowNameUsable('')).toBe(false);
  });
});

/* ------------------------------------------------------------------ */

describe('buildVideoInputArgs', () => {
  it('uses dshow with a real-time buffer and thread queue', () => {
    const args = buildVideoInputArgs({
      deviceName: 'Integrated Camera',
      captureMode: null,
      fps: 30,
      synthetic: false,
    });
    expect(valueAfter(args, '-f')).toBe('dshow');
    expect(valueAfter(args, '-rtbufsize')).toBe('512M');
    expect(valueAfter(args, '-thread_queue_size')).toBe('1024');
    expect(valueAfter(args, '-i')).toBe('video=Integrated Camera');
  });

  it('applies a selected capture mode', () => {
    const args = buildVideoInputArgs({
      deviceName: 'Cam',
      captureMode: {
        width: 1920,
        height: 1080,
        fps: 30,
        vcodec: 'mjpeg',
        pixelFormat: null,
        substituted: false,
        note: null,
      },
      fps: 30,
      synthetic: false,
    });
    expect(valueAfter(args, '-video_size')).toBe('1920x1080');
    expect(valueAfter(args, '-framerate')).toBe('30');
    expect(valueAfter(args, '-vcodec')).toBe('mjpeg');
    expect(args).not.toContain('-pixel_format');
  });

  it('uses pixel_format only when there is no vcodec', () => {
    const args = buildVideoInputArgs({
      deviceName: 'Cam',
      captureMode: {
        width: 640,
        height: 480,
        fps: 30,
        vcodec: null,
        pixelFormat: 'yuyv422',
        substituted: false,
        note: null,
      },
      fps: 30,
      synthetic: false,
    });
    expect(valueAfter(args, '-pixel_format')).toBe('yuyv422');
    expect(args).not.toContain('-vcodec');
  });

  it('substitutes testsrc2 in synthetic mode', () => {
    const args = buildVideoInputArgs({
      deviceName: 'Cam',
      captureMode: null,
      fps: 25,
      synthetic: true,
    });
    expect(valueAfter(args, '-f')).toBe('lavfi');
    expect(valueAfter(args, '-i')).toContain('testsrc2');
    expect(valueAfter(args, '-i')).toContain('rate=25');
    expect(args).not.toContain('dshow');
  });
});

describe('buildAudioInputArgs', () => {
  it('opens the chosen dshow microphone', () => {
    const args = buildAudioInputArgs({ deviceName: 'Microphone (Realtek)', synthetic: false });
    expect(valueAfter(args, '-f')).toBe('dshow');
    expect(valueAfter(args, '-i')).toBe('audio=Microphone (Realtek)');
  });

  it('feeds silence rather than -an when audio is disabled', () => {
    // Facebook expects an audio track even from a camera-only broadcast.
    const args = buildAudioInputArgs({ deviceName: null, synthetic: false });
    expect(valueAfter(args, '-i')).toContain('anullsrc');
    expect(valueAfter(args, '-i')).toContain('stereo');
  });

  it('uses a sine tone in synthetic mode', () => {
    const args = buildAudioInputArgs({ deviceName: null, synthetic: true });
    expect(valueAfter(args, '-i')).toContain('sine');
  });
});

/* ------------------------------------------------------------------ */

describe('buildStreamCommand', () => {
  const base = {
    cameraDevice: 'Integrated Camera',
    microphoneDevice: 'Microphone (Realtek)',
    framingMode: 'fill' as const,
    fps: 30 as const,
    bitrateKbps: 3500,
    encoder: 'libx264' as EncoderId,
    destination: { kind: 'rtmp' as const, url: 'rtmps://x.facebook.com/rtmp/KEY' },
    recordingPath: null,
    preview: true,
    captureMode: null,
    synthetic: false,
    audioSyncOffsetMs: 0,
    noiseSuppression: false,
  };

  it('applies a manual audio sync offset via -itsoffset before the mic input', () => {
    const withOffset = buildStreamCommand({ ...base, audioSyncOffsetMs: 120 });
    const idx = withOffset.indexOf('-itsoffset');
    expect(idx).toBeGreaterThan(-1);
    expect(withOffset[idx + 1]).toBe('0.12');
    // Must precede the microphone input so it shifts that input's timestamps.
    const micArg = withOffset.findIndex((arg) => arg.startsWith('audio='));
    expect(idx).toBeLessThan(micArg);

    // A zero offset adds nothing; a negative offset advances the audio.
    expect(buildStreamCommand({ ...base, audioSyncOffsetMs: 0 })).not.toContain('-itsoffset');
    const negative = buildStreamCommand({ ...base, audioSyncOffsetMs: -250 });
    expect(negative[negative.indexOf('-itsoffset') + 1]).toBe('-0.25');
  });

  it('requests machine-readable progress and suppresses the human status line', () => {
    const args = buildStreamCommand(base);
    expect(valueAfter(args, '-progress')).toBe('pipe:2');
    expect(args).toContain('-nostats');
  });

  it('does not pass -nostdin, because graceful stop writes "q" to stdin', () => {
    expect(buildStreamCommand(base)).not.toContain('-nostdin');
  });

  it('puts the Facebook output first so progress describes the stream', () => {
    const args = buildStreamCommand({ ...base, recordingPath: 'C:\\rec\\out.mkv' });
    const flvIndex = args.indexOf('flv');
    const mkvIndex = args.indexOf('matroska');
    const mjpegIndex = args.lastIndexOf('mjpeg');
    expect(flvIndex).toBeGreaterThan(-1);
    expect(flvIndex).toBeLessThan(mkvIndex);
    expect(mkvIndex).toBeLessThan(mjpegIndex);
  });

  it('sends FLV to the RTMPS destination', () => {
    const args = buildStreamCommand(base);
    const urlIndex = args.indexOf('rtmps://x.facebook.com/rtmp/KEY');

    expect(urlIndex).toBeGreaterThan(-1);
    // The destination is the terminator of output 0.
    expect(args.slice(urlIndex - 4, urlIndex)).toEqual([
      '-f',
      'flv',
      '-flvflags',
      'no_duration_filesize',
    ]);
  });

  it('maps the 720x1280 branch plus audio to the Facebook output', () => {
    const args = buildStreamCommand(base);
    expect(args).toContain('[v_stream]');
    expect(args).toContain('[a_stream]');
  });

  it('adds the recording output only when a path is supplied', () => {
    expect(buildStreamCommand(base)).not.toContain('matroska');
    const withRecording = buildStreamCommand({ ...base, recordingPath: 'C:\\rec\\out.mkv' });
    expect(withRecording).toContain('matroska');
    expect(withRecording).toContain('C:\\rec\\out.mkv');
    expect(withRecording).toContain('[v_record]');
    expect(withRecording).toContain('[a_record]');
  });

  it('writes MJPEG preview frames to stdout with no audio', () => {
    const args = buildStreamCommand(base);
    expect(args).toContain('pipe:1');
    expect(args).toContain('mjpeg');
    expect(args).toContain('-an');
  });

  it('omits the preview branch when preview is off', () => {
    const args = buildStreamCommand({ ...base, preview: false });
    expect(args).not.toContain('pipe:1');
    expect(args).not.toContain('[v_preview]');
  });

  it('derives the GOP from the chosen frame rate', () => {
    expect(valueAfter(buildStreamCommand({ ...base, fps: 24 }), '-g')).toBe('48');
    expect(valueAfter(buildStreamCommand({ ...base, fps: 25 }), '-g')).toBe('50');
    expect(valueAfter(buildStreamCommand({ ...base, fps: 30 }), '-g')).toBe('60');
  });

  it('applies the requested bitrate to the stream branch only', () => {
    const args = buildStreamCommand({
      ...base,
      bitrateKbps: 5000,
      recordingPath: 'C:\\rec\\out.mkv',
    });
    expect(valueAfter(args, '-b:v', 0)).toBe('5000k');
    // The recording branch keeps its own high bitrate.
    expect(valueAfter(args, '-b:v', 1)).toBe('10000k');
  });

  it('supports a local file destination for dry runs', () => {
    const args = buildStreamCommand({
      ...base,
      destination: { kind: 'file', path: 'C:\\tmp\\dry.flv' },
    });
    expect(args).toContain('pipe:1'); // preview branch is emitted on stdout
    expect(args).toContain('C:\\tmp\\dry.flv');
    expect(args.join(' ')).not.toContain('rtmp');
  });

  it('time-limits the inputs, not just output 0, so every branch ends together', () => {
    const args = buildStreamCommand({ ...base, durationSeconds: 3, recordingPath: 'r.mkv' });
    const inputIndices = args.reduce<number[]>((acc, arg, index) => {
      if (arg === '-i') acc.push(index);
      return acc;
    }, []);

    expect(inputIndices).toHaveLength(2);
    for (const index of inputIndices) {
      expect(args.slice(index - 2, index)).toEqual(['-t', '3']);
    }
  });

  it('supports a null destination', () => {
    const args = buildStreamCommand({
      ...base,
      preview: false,
      destination: { kind: 'null' },
    });
    expect(args).toContain('null');
  });

  it('adds a duration limit only when asked', () => {
    expect(buildStreamCommand(base)).not.toContain('-t');
    expect(buildStreamCommand({ ...base, durationSeconds: 3 })).toContain('-t');
  });

  it('produces a fit-mode graph when requested', () => {
    const args = buildStreamCommand({ ...base, framingMode: 'fit' });
    const graph = valueAfter(args, '-filter_complex') ?? '';
    expect(graph).toContain('pad=');
    expect(graph).not.toContain('crop=');
  });
});

describe('buildPreviewCommand', () => {
  const previewBase = {
    cameraDevice: 'Cam',
    framingMode: 'fill' as const,
    fps: 30 as const,
    captureMode: null,
    synthetic: false,
  };

  it('is camera-only: one input, no audio, no meter (the mic is a separate process)', () => {
    const args = buildPreviewCommand(previewBase);
    expect(args.filter((arg) => arg === '-i')).toHaveLength(1);
    expect(args.join(' ')).not.toContain('audio=');
    expect(args).toContain('-an');
    expect(args.join(' ')).not.toContain('ebur128');
  });

  it('applies fit framing straight to the preview size, with no 1080x1920 intermediate', () => {
    const graph =
      valueAfter(
        buildPreviewCommand({ ...previewBase, framingMode: 'fit' }),
        '-filter_complex',
      ) ?? '';
    // The whole frame is preserved (fit), padded straight to the preview size.
    expect(graph).toContain(
      `scale=${PREVIEW_WIDTH}:${PREVIEW_HEIGHT}:force_original_aspect_ratio=decrease`,
    );
    expect(graph).toContain('pad=');
    expect(graph).not.toContain(`scale=${RECORDING_WIDTH}:${RECORDING_HEIGHT}`);
  });

  it('writes MJPEG to stdout', () => {
    expect(buildPreviewCommand(previewBase).at(-1)).toBe('pipe:1');
  });

  it('composes the preview at the preview frame rate, not the stream rate', () => {
    const graph = valueAfter(buildPreviewCommand(previewBase), '-filter_complex') ?? '';
    // The composition runs at PREVIEW_FPS, never the 30 fps the user configured.
    expect(graph).toContain(`[0:v]fps=${PREVIEW_FPS}`);
    expect(graph).not.toContain('fps=30');
  });

  it('caps capture buffering so the preview cannot bank up latency', () => {
    const args = buildPreviewCommand(previewBase);
    expect(valueAfter(args, '-rtbufsize')).toBe(PREVIEW_RTBUFSIZE);
    expect(valueAfter(args, '-fflags')).toBe('nobuffer');
  });

  it('flushes each JPEG to the pipe immediately', () => {
    expect(valueAfter(buildPreviewCommand(previewBase), '-flush_packets')).toBe('1');
  });
});

describe('buildMeterCommand', () => {
  it('opens the microphone and runs it through ebur128 into a null sink', () => {
    const args = buildMeterCommand({
      microphoneDevice: 'Microphone (Realtek)',
      synthetic: false,
    });
    expect(args.join(' ')).toContain('audio=Microphone (Realtek)');
    const graph = valueAfter(args, '-filter_complex') ?? '';
    expect(graph).toContain('ebur128=peak=true');
    // Audio is discarded; there is no video and no encoded/piped output.
    const joined = args.join(' ');
    expect(joined).toContain('-f null');
    expect(joined).not.toContain('pipe:1');
    expect(joined).not.toContain('-c:v');
  });

  it('has exactly one input — the microphone only, never the camera', () => {
    const args = buildMeterCommand({ microphoneDevice: 'Mic', synthetic: false });
    expect(args.filter((arg) => arg === '-i')).toHaveLength(1);
    expect(args.join(' ')).not.toContain('video=');
  });

  it('uses a synthetic sine source in synthetic mode', () => {
    expect(buildMeterCommand({ microphoneDevice: null, synthetic: true }).join(' ')).toContain(
      'sine=',
    );
  });
});

/* ------------------------------------------------------------------ */

describe('buildRecordingCommand', () => {
  const base = {
    cameraDevice: 'Cam',
    microphoneDevice: 'Mic',
    framingMode: 'fill' as const,
    fps: 30 as const,
    encoder: 'libx264' as EncoderId,
    recordingPath: 'C:\\out\\clip.mkv',
    preview: true,
    captureMode: null,
    synthetic: false,
    audioSyncOffsetMs: 0,
    noiseSuppression: false,
  };

  it('writes a matroska file and never opens a network output', () => {
    const args = buildRecordingCommand(base);
    const mkvIndex = args.indexOf('C:\\out\\clip.mkv');
    expect(mkvIndex).toBeGreaterThan(0);
    expect(args[mkvIndex - 1]).toBe('matroska');
    expect(args[mkvIndex - 2]).toBe('-f');
    expect(args.join(' ')).not.toContain('rtmp');
    expect(args.join(' ')).not.toContain('flv');
  });

  it('records at the full 1080×1920 output and 10 Mbps', () => {
    const args = buildRecordingCommand(base);
    const graph = valueAfter(args, '-filter_complex') ?? '';
    expect(graph).toContain(`scale=${RECORDING_WIDTH}:${RECORDING_HEIGHT}[v_record]`);
    // No 720×1280 Facebook branch is present.
    expect(graph).not.toContain(`scale=${STREAM_WIDTH}:${STREAM_HEIGHT}`);
    expect(valueAfter(args, '-b:v')).toBe('10000k');
  });

  it('opens the microphone and includes an audio track', () => {
    const args = buildRecordingCommand(base);
    expect(args).toContain('audio=Mic');
    expect(valueAfter(args, '-c:a')).toBe('aac');
  });

  it('emits the MJPEG preview branch to stdout when requested', () => {
    const withPreview = buildRecordingCommand(base);
    expect(withPreview).toContain('pipe:1');
    expect(valueAfter(withPreview, '-filter_complex') ?? '').toContain(
      `scale=${PREVIEW_WIDTH}:${PREVIEW_HEIGHT}`,
    );

    const withoutPreview = buildRecordingCommand({ ...base, preview: false });
    expect(withoutPreview).not.toContain('pipe:1');
  });
});

/* ------------------------------------------------------------------ */

describe('noise cancellation', () => {
  const streamBase = {
    cameraDevice: 'Cam',
    microphoneDevice: 'Mic',
    framingMode: 'fill' as const,
    fps: 30 as const,
    bitrateKbps: 3500,
    encoder: 'libx264' as EncoderId,
    destination: { kind: 'rtmp' as const, url: 'rtmps://x.facebook.com/rtmp/KEY' },
    recordingPath: 'C:\\out\\clip.mkv',
    preview: true,
    captureMode: null,
    synthetic: false,
    audioSyncOffsetMs: 0,
  };
  const recordBase = {
    cameraDevice: 'Cam',
    microphoneDevice: 'Mic',
    framingMode: 'fill' as const,
    fps: 30 as const,
    encoder: 'libx264' as EncoderId,
    recordingPath: 'C:\\out\\clip.mkv',
    preview: true,
    captureMode: null,
    synthetic: false,
    audioSyncOffsetMs: 0,
  };

  it('off: the audio chain contains no noise-reduction filters', () => {
    const graph =
      valueAfter(
        buildStreamCommand({ ...streamBase, noiseSuppression: false }),
        '-filter_complex',
      ) ?? '';
    expect(graph).not.toContain('afftdn');
    expect(graph).not.toContain('highpass');
    expect(graph).not.toContain(NOISE_REDUCTION_CHAIN);
  });

  it('on: inserts the noise-reduction chain exactly once, upstream of the audio split', () => {
    const graph =
      valueAfter(
        buildStreamCommand({ ...streamBase, noiseSuppression: true }),
        '-filter_complex',
      ) ?? '';
    expect(graph).toContain(NOISE_REDUCTION_CHAIN);
    expect(graph.match(/afftdn/g)?.length).toBe(1);
    // It sits on the normalised master audio, before asplit fans it out to the
    // stream and recording encoders — so both branches get the cleaned audio.
    const denoiseAt = graph.indexOf('afftdn');
    const splitAt = graph.indexOf('asplit');
    expect(denoiseAt).toBeGreaterThan(-1);
    expect(splitAt).toBeGreaterThan(denoiseAt);
  });

  it('on: the local recording branch also receives cleaned audio', () => {
    const graph =
      valueAfter(
        buildRecordingCommand({ ...recordBase, noiseSuppression: true }),
        '-filter_complex',
      ) ?? '';
    expect(graph).toContain(NOISE_REDUCTION_CHAIN);
  });

  it('off by default in persisted settings', () => {
    expect(DEFAULT_SETTINGS.noiseSuppression).toBe(false);
  });
});

describe('probe commands', () => {
  it('lists devices through the dshow demuxer', () => {
    expect(buildDeviceListCommand()).toEqual([
      '-hide_banner',
      '-list_devices',
      'true',
      '-f',
      'dshow',
      '-i',
      'dummy',
    ]);
  });

  it('lists options for a specific camera', () => {
    const args = buildDeviceOptionsCommand('HD Webcam');
    expect(args).toContain('-list_options');
    expect(args.at(-1)).toBe('video=HD Webcam');
  });

  it('tests an encoder with the production argument set', () => {
    const args = buildEncoderTestCommand('h264_nvenc');
    // The point of the test is that it exercises the real flags.
    expect(args).toContain('h264_nvenc');
    expect(valueAfter(args, '-rc')).toBe('cbr');
    expect(valueAfter(args, '-tune')).toBe('ll');
    expect(valueAfter(args, '-i')).toContain('testsrc2');
    expect(valueAfter(args, '-frames:v')).toBe('20');
    // Discards the encoded output: the point is whether the encoder starts.
    expect(args.slice(-3)).toEqual(['-f', 'null', '-']);
  });

  it('remuxes without re-encoding', () => {
    const args = buildRemuxCommand('in.mkv', 'out.mp4');
    expect(valueAfter(args, '-c')).toBe('copy');
    expect(args).toContain('+faststart');
    expect(args).not.toContain('libx264');
    expect(args.at(-1)).toBe('out.mp4');
  });
});
