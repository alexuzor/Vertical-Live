/**
 * Pure FFmpeg argument generation.
 *
 * This module has no side effects and no I/O, which is what makes the whole
 * pipeline unit-testable: every filter graph, encoder flag and output URL that
 * the app will ever run is produced here and asserted in `tests/`.
 *
 * Pipeline shape (single camera open, one FFmpeg process):
 *
 *     dshow video ─┐
 *                  ├─ 1080x1920 master composition (fill | fit)
 *     dshow audio ─┘            │
 *                             split
 *                ┌──────────────┼──────────────┐
 *           720x1280        1080x1920       360x640
 *          Facebook FLV      MKV file      MJPEG -> stdout
 */

import {
  AUDIO_CHANNELS,
  AUDIO_SAMPLE_RATE,
  KEYFRAME_INTERVAL_SECONDS,
  MASTER_HEIGHT,
  MASTER_WIDTH,
  PREVIEW_FPS,
  PREVIEW_HEIGHT,
  PREVIEW_MJPEG_QUALITY,
  PREVIEW_RTBUFSIZE,
  PREVIEW_WIDTH,
  RECORDING_AUDIO_BITRATE_KBPS,
  RECORDING_VIDEO_BITRATE_KBPS,
  RECORDING_VIDEO_MAXRATE_KBPS,
  STREAM_AUDIO_BITRATE_KBPS,
  STREAM_HEIGHT,
  STREAM_WIDTH,
} from '../../shared/constants';
import type {
  EncoderId,
  FramingMode,
  SelectedCaptureMode,
  StreamFps,
} from '../../shared/types';

/* ------------------------------------------------------------------ */
/* DirectShow naming                                                   */
/* ------------------------------------------------------------------ */

/**
 * FFmpeg's DirectShow demuxer parses `video=NAME:audio=NAME` with `strtok` on
 * `=` and `:` and supports **no** escape sequences (see libavdevice/dshow.c,
 * `parse_device_name`). Backslash-escaping a colon would therefore make things
 * worse, not better: the backslash would be passed through literally and the
 * colon would still split the token.
 *
 * The correct handling is: pass the name through verbatim (safe, because we
 * spawn with an argv array and `shell: false`, so spaces, quotes, apostrophes,
 * parentheses and Unicode all survive untouched) and refuse names containing a
 * colon, substituting the DirectShow "Alternative name" instead.
 */
export function escapeDshowName(name: string): string {
  return name;
}

/** True when a friendly device name can be handed to the dshow demuxer as-is. */
export function isDshowNameUsable(name: string): boolean {
  return name.length > 0 && !name.includes(':');
}

/** Builds the `video=...` / `audio=...` URL for a dshow input. */
export function formatDshowInput(kind: 'video' | 'audio', name: string): string {
  return `${kind}=${escapeDshowName(name)}`;
}

/* ------------------------------------------------------------------ */
/* Facebook destination                                                */
/* ------------------------------------------------------------------ */

export class InvalidDestinationError extends Error {}

/**
 * Joins a Facebook server URL and stream key into a single RTMP(S) destination.
 *
 * - trims whitespace from both halves
 * - collapses the slash between them so `.../rtmp/` + `/key` yields one slash
 * - never percent-encodes: Facebook keys legitimately contain `?`, `&` and `=`,
 *   and encoding them would silently break publishing
 */
export function buildFacebookUrl(serverUrl: string, streamKey: string): string {
  const server = serverUrl.trim().replace(/\/+$/, '');
  const key = streamKey.trim().replace(/^\/+/, '');

  if (!/^rtmps?:\/\//i.test(server)) {
    throw new InvalidDestinationError('The server URL must start with rtmps:// or rtmp://.');
  }
  if (server.replace(/^rtmps?:\/\//i, '').length === 0) {
    throw new InvalidDestinationError('The server URL is missing a host name.');
  }
  if (key.length === 0) {
    throw new InvalidDestinationError('The stream key is empty.');
  }

  return `${server}/${key}`;
}

/* ------------------------------------------------------------------ */
/* Encoding maths                                                      */
/* ------------------------------------------------------------------ */

/** Two seconds of frames, as Facebook expects. 24->48, 25->50, 30->60. */
export function calculateGop(fps: number): number {
  return Math.round(fps * KEYFRAME_INTERVAL_SECONDS);
}

/** Rate-control buffer: two seconds of video keeps RTMP delivery stable. */
export function calculateBufsizeKbps(bitrateKbps: number): number {
  return bitrateKbps * 2;
}

/* ------------------------------------------------------------------ */
/* Video filter graph                                                  */
/* ------------------------------------------------------------------ */

/**
 * Scaling half of the master composition.
 *
 * `fill` scales until the 1080x1920 canvas is covered, then centre-crops.
 * `fit` scales the whole frame inside the canvas and pads with black.
 *
 * `force_divisible_by=2` keeps the intermediate frame even in both dimensions,
 * which yuv420p requires.
 */
export function buildFramingFilter(
  mode: FramingMode,
  width = MASTER_WIDTH,
  height = MASTER_HEIGHT,
): string {
  if (mode === 'fill') {
    return (
      `scale=${width}:${height}:force_original_aspect_ratio=increase:force_divisible_by=2` +
      `,crop=${width}:${height}`
    );
  }
  return (
    `scale=${width}:${height}:force_original_aspect_ratio=decrease:force_divisible_by=2` +
    `,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:color=black`
  );
}

export interface FilterGraphBranches {
  stream: boolean;
  recording: boolean;
  preview: boolean;
}

export interface FilterGraphResult {
  filterComplex: string;
  labels: {
    stream: string | null;
    recording: string | null;
    preview: string | null;
    streamAudio: string | null;
    recordingAudio: string | null;
    /** ebur128 measurement output, mapped to a null sink for live metering. */
    meter: string | null;
  };
}

/**
 * Builds the complete `-filter_complex` string.
 *
 * The camera is opened exactly once; every consumer is fed from a `split` of
 * the single master composition, so preview, stream and recording can never
 * contend for the device.
 */
export function buildFilterGraph(
  mode: FramingMode,
  fps: number,
  branches: FilterGraphBranches,
  options: { audio: boolean; meter?: boolean } = { audio: true },
): FilterGraphResult {
  const chains: string[] = [];

  // Master composition: rate-limit first (cheapest), then frame, then normalise
  // pixel aspect ratio and pixel format once for every downstream branch.
  chains.push(`[0:v]fps=${fps},${buildFramingFilter(mode)},setsar=1,format=yuv420p[master]`);

  const active: (keyof FilterGraphBranches)[] = [];
  if (branches.stream) active.push('stream');
  if (branches.recording) active.push('recording');
  if (branches.preview) active.push('preview');

  if (active.length === 0) {
    throw new Error('At least one output branch is required.');
  }

  const splitLabels: Record<string, string> = {};
  if (active.length === 1) {
    splitLabels[active[0] as string] = 'master';
  } else {
    const outputs = active.map((name) => `[sp_${name}]`).join('');
    chains.push(`[master]split=${active.length}${outputs}`);
    for (const name of active) splitLabels[name] = `sp_${name}`;
  }

  const labels: FilterGraphResult['labels'] = {
    stream: null,
    recording: null,
    preview: null,
    streamAudio: null,
    recordingAudio: null,
    meter: null,
  };

  if (branches.stream) {
    chains.push(`[${splitLabels.stream}]scale=${STREAM_WIDTH}:${STREAM_HEIGHT}[v_stream]`);
    labels.stream = 'v_stream';
  }

  if (branches.recording) {
    // Already 1080x1920 yuv420p; `null` is a zero-cost pass-through that gives
    // the branch a stable, mappable label.
    chains.push(`[${splitLabels.recording}]null[v_record]`);
    labels.recording = 'v_record';
  }

  if (branches.preview) {
    chains.push(
      `[${splitLabels.preview}]fps=${PREVIEW_FPS},scale=${PREVIEW_WIDTH}:${PREVIEW_HEIGHT}[v_preview]`,
    );
    labels.preview = 'v_preview';
  }

  // Audio is only wired up when something actually consumes it, or when a live
  // meter is requested. The encoded branches always receive byte-identical
  // samples (asplit only duplicates), so adding the meter never perturbs A/V
  // sync: drift is corrected once, upstream, by `aresample=async`.
  const audioConsumers: ('stream' | 'recording')[] = [];
  if (options.audio && branches.stream) audioConsumers.push('stream');
  if (options.audio && branches.recording) audioConsumers.push('recording');
  const wantMeter = options.meter === true;

  if (audioConsumers.length > 0 || wantMeter) {
    const normalise =
      `[1:a]aresample=async=1000:first_pts=0,` +
      `aformat=sample_fmts=fltp:sample_rates=${AUDIO_SAMPLE_RATE}:channel_layouts=stereo`;

    // Every label the normalised audio must feed: the encoder branch(es) first,
    // then the meter tap.
    const sinks: string[] = [];
    for (const consumer of audioConsumers) {
      sinks.push(consumer === 'stream' ? 'a_stream' : 'a_record');
    }
    if (wantMeter) sinks.push('a_meter_src');

    if (sinks.length === 1) {
      chains.push(`${normalise}[${sinks[0] as string}]`);
    } else {
      chains.push(`${normalise}[a_master]`);
      chains.push(`[a_master]asplit=${sinks.length}${sinks.map((s) => `[${s}]`).join('')}`);
    }

    for (const consumer of audioConsumers) {
      if (consumer === 'stream') labels.streamAudio = 'a_stream';
      else labels.recordingAudio = 'a_record';
    }

    if (wantMeter) {
      // ebur128 passes the audio through and prints a per-100ms measurement to
      // stderr, which AudioLevelParser turns into the UI meter level.
      chains.push('[a_meter_src]ebur128=peak=true[a_meter]');
      labels.meter = 'a_meter';
    }
  }

  return { filterComplex: chains.join(';'), labels };
}

/* ------------------------------------------------------------------ */
/* Encoder arguments                                                   */
/* ------------------------------------------------------------------ */

export interface EncoderTarget {
  bitrateKbps: number;
  maxrateKbps: number;
  bufsizeKbps: number;
  gop: number;
  /** `stream` favours latency and CBR pacing; `recording` favours quality. */
  profile: 'stream' | 'recording';
}

/**
 * Per-encoder arguments.
 *
 * These exact argument sets are what `EncoderDetector` runs during its short
 * synthetic capability test, so an encoder is only ever selected if the app has
 * already proved that *these* flags work on *this* machine and driver.
 *
 * B-frames are disabled everywhere: Facebook's ingest is happiest without them
 * and it keeps the software and hardware paths behaviourally identical.
 */
export function buildEncoderArgs(encoder: EncoderId, target: EncoderTarget): string[] {
  const { bitrateKbps, maxrateKbps, bufsizeKbps, gop, profile } = target;
  const rate = [
    '-b:v',
    `${bitrateKbps}k`,
    '-maxrate',
    `${maxrateKbps}k`,
    '-bufsize',
    `${bufsizeKbps}k`,
  ];
  const gopArgs = ['-g', String(gop), '-keyint_min', String(gop)];

  switch (encoder) {
    case 'libx264':
      return [
        '-c:v',
        'libx264',
        '-preset',
        'veryfast',
        // zerolatency disables lookahead and B-frames, which is right for a
        // live send but needlessly costly for the local recording.
        ...(profile === 'stream' ? ['-tune', 'zerolatency'] : []),
        '-profile:v',
        'high',
        '-level:v',
        '4.1',
        '-pix_fmt',
        'yuv420p',
        ...rate,
        ...gopArgs,
        '-sc_threshold',
        '0',
        '-bf',
        '0',
      ];

    case 'h264_nvenc':
      return [
        '-c:v',
        'h264_nvenc',
        // p4 is the balanced preset available on every NVENC generation that
        // ships with a Windows 10/11 driver new enough for ffmpeg 5+.
        '-preset',
        profile === 'stream' ? 'p4' : 'p5',
        '-tune',
        profile === 'stream' ? 'll' : 'hq',
        '-rc',
        profile === 'stream' ? 'cbr' : 'vbr',
        '-profile:v',
        'high',
        '-level',
        '4.1',
        '-pix_fmt',
        'yuv420p',
        ...rate,
        ...gopArgs,
        '-bf',
        '0',
        '-rc-lookahead',
        profile === 'stream' ? '0' : '8',
      ];

    case 'h264_qsv':
      return [
        '-c:v',
        'h264_qsv',
        '-preset',
        profile === 'stream' ? 'veryfast' : 'fast',
        '-profile:v',
        'high',
        // QSV encodes NV12 natively; asking for yuv420p forces an extra
        // conversion and, on some drivers, an outright failure.
        '-pix_fmt',
        'nv12',
        ...rate,
        ...gopArgs,
        '-bf',
        '0',
      ];

    case 'h264_amf':
      return [
        '-c:v',
        'h264_amf',
        '-usage',
        profile === 'stream' ? 'lowlatency' : 'transcoding',
        '-quality',
        profile === 'stream' ? 'speed' : 'balanced',
        '-rc',
        profile === 'stream' ? 'cbr' : 'vbr_peak',
        '-profile:v',
        'high',
        '-pix_fmt',
        'yuv420p',
        ...rate,
        ...gopArgs,
        '-bf',
        '0',
      ];

    default: {
      const exhaustive: never = encoder;
      throw new Error(`Unsupported encoder: ${String(exhaustive)}`);
    }
  }
}

/** AAC arguments shared by the Facebook and recording branches. */
export function buildAudioEncoderArgs(bitrateKbps: number): string[] {
  return [
    '-c:a',
    'aac',
    '-b:a',
    `${bitrateKbps}k`,
    '-ar',
    String(AUDIO_SAMPLE_RATE),
    '-ac',
    String(AUDIO_CHANNELS),
  ];
}

/* ------------------------------------------------------------------ */
/* Inputs                                                              */
/* ------------------------------------------------------------------ */

export interface VideoInputOptions {
  /** DirectShow device name, or null when using a synthetic source. */
  deviceName: string | null;
  captureMode: SelectedCaptureMode | null;
  fps: number;
  synthetic: boolean;
  /**
   * Limit this input to N seconds. Applied as an *input* option so that every
   * output branch ends together: as an output option it would only bound the
   * first output and leave the others running against an endless source.
   */
  durationSeconds?: number;
  /**
   * Preview-only: minimise capture-side buffering (small real-time buffer,
   * `nobuffer`) so a stall drops stale frames instead of accumulating latency.
   * Never set for stream/record, where the 512M buffer prevents dropped frames
   * in the output the viewer keeps.
   */
  lowLatency?: boolean;
}

function durationArgs(durationSeconds: number | undefined): string[] {
  return durationSeconds === undefined ? [] : ['-t', String(durationSeconds)];
}

export function buildVideoInputArgs(options: VideoInputOptions): string[] {
  if (options.synthetic || !options.deviceName) {
    return [
      '-f',
      'lavfi',
      ...durationArgs(options.durationSeconds),
      '-i',
      `testsrc2=size=1280x720:rate=${options.fps}`,
    ];
  }

  const args = [
    '-f',
    'dshow',
    // Preview keeps latency current by dropping stale frames; stream/record use
    // a generous buffer, the documented fix for DirectShow's "real-time buffer
    // too full, frame dropped" warnings on USB cameras.
    ...(options.lowLatency ? ['-fflags', 'nobuffer'] : []),
    '-rtbufsize',
    options.lowLatency ? PREVIEW_RTBUFSIZE : '512M',
    '-thread_queue_size',
    '1024',
    // DirectShow timestamps drift on many webcams; wall-clock timestamps keep
    // the audio and video branches aligned over a long broadcast.
    '-use_wallclock_as_timestamps',
    '1',
  ];

  const mode = options.captureMode;
  if (mode?.width && mode.height) {
    args.push('-video_size', `${mode.width}x${mode.height}`);
  }
  if (mode?.fps) {
    args.push('-framerate', String(mode.fps));
  }
  // `vcodec` and `pixel_format` are mutually exclusive ways to pick a mode.
  if (mode?.vcodec) {
    args.push('-vcodec', mode.vcodec);
  } else if (mode?.pixelFormat) {
    args.push('-pixel_format', mode.pixelFormat);
  }

  args.push(...durationArgs(options.durationSeconds));
  args.push('-i', formatDshowInput('video', options.deviceName));
  return args;
}

export interface AudioInputOptions {
  deviceName: string | null;
  synthetic: boolean;
  durationSeconds?: number;
  /**
   * Manual audio→video offset in ms, applied via `-itsoffset` on the real
   * microphone input only. Positive delays the audio; negative advances it.
   */
  offsetMs?: number;
}

/** `-itsoffset` args for a non-zero, finite offset (seconds), else empty. */
function itsOffsetArgs(offsetMs: number | undefined): string[] {
  if (offsetMs === undefined || !Number.isFinite(offsetMs) || offsetMs === 0) return [];
  return ['-itsoffset', (offsetMs / 1000).toString()];
}

export function buildAudioInputArgs(options: AudioInputOptions): string[] {
  const duration = durationArgs(options.durationSeconds);

  if (options.synthetic) {
    return [
      '-f',
      'lavfi',
      ...duration,
      '-i',
      `sine=frequency=440:sample_rate=${AUDIO_SAMPLE_RATE}`,
    ];
  }

  if (!options.deviceName) {
    // Facebook's ingest expects an audio track even when the user has turned
    // their microphone off, so feed it digital silence rather than `-an`.
    return [
      '-f',
      'lavfi',
      ...duration,
      '-i',
      `anullsrc=channel_layout=stereo:sample_rate=${AUDIO_SAMPLE_RATE}`,
    ];
  }

  return [
    '-f',
    'dshow',
    '-rtbufsize',
    '128M',
    '-thread_queue_size',
    '1024',
    '-use_wallclock_as_timestamps',
    '1',
    // The manual sync offset must precede `-i` to shift this input's timestamps.
    ...itsOffsetArgs(options.offsetMs),
    ...duration,
    '-i',
    formatDshowInput('audio', options.deviceName),
  ];
}

/* ------------------------------------------------------------------ */
/* Full command assembly                                               */
/* ------------------------------------------------------------------ */

export type StreamDestination =
  { kind: 'rtmp'; url: string } | { kind: 'file'; path: string } | { kind: 'null' };

export interface BuildStreamCommandOptions {
  cameraDevice: string | null;
  microphoneDevice: string | null;
  framingMode: FramingMode;
  fps: StreamFps;
  bitrateKbps: number;
  encoder: EncoderId;
  destination: StreamDestination;
  /** Absolute MKV path, or null when recording is disabled. */
  recordingPath: string | null;
  /** Emit the MJPEG preview branch on stdout. */
  preview: boolean;
  captureMode: SelectedCaptureMode | null;
  synthetic: boolean;
  /** Manual audio→video sync offset in ms. */
  audioSyncOffsetMs: number;
  /** Stop after this many seconds. Used by the integration test only. */
  durationSeconds?: number;
}

/** Global options that apply to the whole FFmpeg invocation. */
export function buildGlobalArgs(): string[] {
  return [
    '-hide_banner',
    // Machine-readable progress on stderr. `-nostats` suppresses the
    // human-readable status line so the two never interleave mid-line.
    '-nostats',
    '-loglevel',
    'level+info',
    '-progress',
    'pipe:2',
  ];
}

function buildDestinationArgs(destination: StreamDestination): string[] {
  switch (destination.kind) {
    case 'rtmp':
      return ['-f', 'flv', '-flvflags', 'no_duration_filesize', destination.url];
    case 'file':
      return ['-f', 'flv', destination.path];
    case 'null':
      return ['-f', 'null', '-'];
    default: {
      const exhaustive: never = destination;
      throw new Error(`Unsupported destination: ${String(exhaustive)}`);
    }
  }
}

/**
 * Builds the complete argument vector for a live send.
 *
 * Output order is deliberate: the Facebook branch is output #0 so FFmpeg's
 * `-progress` `total_size`/`bitrate` fields describe the stream the user cares
 * about rather than the much larger local recording.
 */
export function buildStreamCommand(options: BuildStreamCommandOptions): string[] {
  const gop = calculateGop(options.fps);
  const audioEnabled = true; // silence is substituted upstream when muted
  // Only meter a real (or synthetic) microphone; there is nothing to show for
  // substituted silence, and the UI greys the meter out when monitoring is off.
  const withMeter = options.synthetic || options.microphoneDevice !== null;

  const graph = buildFilterGraph(
    options.framingMode,
    options.fps,
    {
      stream: true,
      recording: options.recordingPath !== null,
      preview: options.preview,
    },
    { audio: audioEnabled, meter: withMeter },
  );

  const args: string[] = [...buildGlobalArgs()];

  args.push(
    ...buildVideoInputArgs({
      deviceName: options.cameraDevice,
      captureMode: options.captureMode,
      fps: options.fps,
      synthetic: options.synthetic,
      durationSeconds: options.durationSeconds,
    }),
  );

  args.push(
    ...buildAudioInputArgs({
      deviceName: options.microphoneDevice,
      synthetic: options.synthetic,
      durationSeconds: options.durationSeconds,
      offsetMs: options.audioSyncOffsetMs,
    }),
  );

  args.push('-filter_complex', graph.filterComplex);

  /* --- Output 0: Facebook ---------------------------------------- */
  args.push('-map', `[${graph.labels.stream}]`);
  if (graph.labels.streamAudio) args.push('-map', `[${graph.labels.streamAudio}]`);
  args.push(
    ...buildEncoderArgs(options.encoder, {
      bitrateKbps: options.bitrateKbps,
      maxrateKbps: options.bitrateKbps,
      bufsizeKbps: calculateBufsizeKbps(options.bitrateKbps),
      gop,
      profile: 'stream',
    }),
  );
  args.push(...buildAudioEncoderArgs(STREAM_AUDIO_BITRATE_KBPS));
  args.push('-max_muxing_queue_size', '1024');
  args.push(...buildDestinationArgs(options.destination));

  /* --- Output 1: local recording (MKV, crash resistant) ----------- */
  if (options.recordingPath && graph.labels.recording) {
    args.push('-map', `[${graph.labels.recording}]`);
    if (graph.labels.recordingAudio) args.push('-map', `[${graph.labels.recordingAudio}]`);
    args.push(
      ...buildEncoderArgs(options.encoder, {
        bitrateKbps: RECORDING_VIDEO_BITRATE_KBPS,
        maxrateKbps: RECORDING_VIDEO_MAXRATE_KBPS,
        bufsizeKbps: calculateBufsizeKbps(RECORDING_VIDEO_BITRATE_KBPS),
        gop,
        profile: 'recording',
      }),
    );
    args.push(...buildAudioEncoderArgs(RECORDING_AUDIO_BITRATE_KBPS));
    args.push('-max_muxing_queue_size', '1024');
    args.push('-f', 'matroska', options.recordingPath);
  }

  /* --- Output 2: MJPEG preview on stdout -------------------------- */
  if (options.preview && graph.labels.preview) {
    args.push('-map', `[${graph.labels.preview}]`, '-an');
    args.push('-c:v', 'mjpeg', '-q:v', String(PREVIEW_MJPEG_QUALITY), '-pix_fmt', 'yuvj420p');
    args.push('-f', 'mjpeg', 'pipe:1');
  }

  /* --- Output 3: metering sink (ebur128 -> discarded) ------------- */
  if (graph.labels.meter) {
    args.push('-map', `[${graph.labels.meter}]`, '-f', 'null', '-');
  }

  return args;
}

export interface BuildPreviewCommandOptions {
  cameraDevice: string | null;
  /** When set (or in synthetic mode), the mic is opened so the meter is live. */
  microphoneDevice: string | null;
  framingMode: FramingMode;
  fps: StreamFps;
  captureMode: SelectedCaptureMode | null;
  synthetic: boolean;
}

/**
 * Preview-only invocation used while the user is still configuring.
 *
 * It composes exactly the same 1080x1920 master as a live send, so the framing
 * the user sees is the framing Facebook will receive. When a microphone is
 * selected the mic is opened purely to drive the live audio meter (ebur128 into
 * a discarded null sink); the audio is never encoded or played back here.
 */
export function buildPreviewCommand(options: BuildPreviewCommandOptions): string[] {
  const withAudio = options.synthetic || options.microphoneDevice !== null;

  // Composite the master at the preview's own frame rate, not the (up to 60 fps)
  // stream rate. The preview only ever shows PREVIEW_FPS, so building the full
  // 1080x1920 canvas at the stream rate just to drop most of it downstream is
  // wasted CPU — and when it can't keep up in real time, latency piles up in the
  // capture buffer and the preview drifts behind. The framing geometry is
  // resolution-based, so this changes only the cost, never what the user sees.
  const graph = buildFilterGraph(
    options.framingMode,
    PREVIEW_FPS,
    { stream: false, recording: false, preview: true },
    { audio: false, meter: withAudio },
  );

  const args: string[] = [
    ...buildGlobalArgs(),
    ...buildVideoInputArgs({
      deviceName: options.cameraDevice,
      captureMode: options.captureMode,
      fps: options.fps,
      synthetic: options.synthetic,
      lowLatency: true,
    }),
  ];

  if (withAudio) {
    args.push(
      ...buildAudioInputArgs({
        deviceName: options.microphoneDevice,
        synthetic: options.synthetic,
      }),
    );
  }

  args.push(
    '-filter_complex',
    graph.filterComplex,
    // Output 0: the MJPEG preview image on stdout.
    '-map',
    `[${graph.labels.preview}]`,
    '-an',
    '-c:v',
    'mjpeg',
    '-q:v',
    String(PREVIEW_MJPEG_QUALITY),
    '-pix_fmt',
    'yuvj420p',
    // Push each JPEG to the pipe the instant it is muxed instead of letting it
    // sit in the output buffer, so the renderer sees frames without added delay.
    '-flush_packets',
    '1',
    '-f',
    'mjpeg',
    'pipe:1',
  );

  // Output 1: metering sink — ebur128 measurement discarded to null.
  if (graph.labels.meter) {
    args.push('-map', `[${graph.labels.meter}]`, '-f', 'null', '-');
  }

  return args;
}

export interface BuildRecordingCommandOptions {
  cameraDevice: string | null;
  microphoneDevice: string | null;
  framingMode: FramingMode;
  fps: StreamFps;
  encoder: EncoderId;
  /** Absolute MKV path to write. */
  recordingPath: string;
  /** Emit the MJPEG preview branch on stdout. */
  preview: boolean;
  captureMode: SelectedCaptureMode | null;
  synthetic: boolean;
  /** Manual audio→video sync offset in ms. */
  audioSyncOffsetMs: number;
  /** Stop after this many seconds. Used by tests only. */
  durationSeconds?: number;
}

/**
 * Record-only invocation: the same 1080x1920 master a live send composes, but
 * with no Facebook branch. Output #0 is the crash-resistant MKV so the
 * `-progress` size/bitrate fields describe the file being written. The preview
 * branch is optional so the UI can show exactly what is being recorded.
 */
export function buildRecordingCommand(options: BuildRecordingCommandOptions): string[] {
  const gop = calculateGop(options.fps);
  const withMeter = options.synthetic || options.microphoneDevice !== null;

  const graph = buildFilterGraph(
    options.framingMode,
    options.fps,
    { stream: false, recording: true, preview: options.preview },
    { audio: true, meter: withMeter },
  );

  const args: string[] = [...buildGlobalArgs()];

  args.push(
    ...buildVideoInputArgs({
      deviceName: options.cameraDevice,
      captureMode: options.captureMode,
      fps: options.fps,
      synthetic: options.synthetic,
      durationSeconds: options.durationSeconds,
    }),
  );

  args.push(
    ...buildAudioInputArgs({
      deviceName: options.microphoneDevice,
      synthetic: options.synthetic,
      durationSeconds: options.durationSeconds,
      offsetMs: options.audioSyncOffsetMs,
    }),
  );

  args.push('-filter_complex', graph.filterComplex);

  /* --- Output 0: local recording (MKV, crash resistant) ----------- */
  args.push('-map', `[${graph.labels.recording}]`);
  if (graph.labels.recordingAudio) args.push('-map', `[${graph.labels.recordingAudio}]`);
  args.push(
    ...buildEncoderArgs(options.encoder, {
      bitrateKbps: RECORDING_VIDEO_BITRATE_KBPS,
      maxrateKbps: RECORDING_VIDEO_MAXRATE_KBPS,
      bufsizeKbps: calculateBufsizeKbps(RECORDING_VIDEO_BITRATE_KBPS),
      gop,
      profile: 'recording',
    }),
  );
  args.push(...buildAudioEncoderArgs(RECORDING_AUDIO_BITRATE_KBPS));
  args.push('-max_muxing_queue_size', '1024');
  args.push('-f', 'matroska', options.recordingPath);

  /* --- Output 1: MJPEG preview on stdout -------------------------- */
  if (options.preview && graph.labels.preview) {
    args.push('-map', `[${graph.labels.preview}]`, '-an');
    args.push('-c:v', 'mjpeg', '-q:v', String(PREVIEW_MJPEG_QUALITY), '-pix_fmt', 'yuvj420p');
    args.push('-f', 'mjpeg', 'pipe:1');
  }

  /* --- Output 2: metering sink (ebur128 -> discarded) ------------- */
  if (graph.labels.meter) {
    args.push('-map', `[${graph.labels.meter}]`, '-f', 'null', '-');
  }

  return args;
}

/* ------------------------------------------------------------------ */
/* Probes                                                              */
/* ------------------------------------------------------------------ */

export function buildDeviceListCommand(): string[] {
  return ['-hide_banner', '-list_devices', 'true', '-f', 'dshow', '-i', 'dummy'];
}

export function buildDeviceOptionsCommand(deviceName: string): string[] {
  return [
    '-hide_banner',
    '-list_options',
    'true',
    '-f',
    'dshow',
    '-i',
    formatDshowInput('video', deviceName),
  ];
}

/**
 * A short synthetic encode using the *production* argument set for `encoder`.
 *
 * This is what makes "Encoder: Automatic" trustworthy: an encoder is only
 * offered if these exact flags have already succeeded on this machine.
 */
export function buildEncoderTestCommand(encoder: EncoderId): string[] {
  return [
    '-hide_banner',
    '-nostats',
    '-loglevel',
    'error',
    '-f',
    'lavfi',
    '-i',
    'testsrc2=size=640x360:rate=30',
    '-frames:v',
    '20',
    ...buildEncoderArgs(encoder, {
      bitrateKbps: 2000,
      maxrateKbps: 2000,
      bufsizeKbps: 4000,
      gop: 60,
      profile: 'stream',
    }),
    '-f',
    'null',
    '-',
  ];
}

/** Stream-copy remux from the crash-resistant MKV to a shareable MP4. */
export function buildRemuxCommand(inputPath: string, outputPath: string): string[] {
  return [
    '-hide_banner',
    '-nostats',
    '-loglevel',
    'error',
    '-y',
    '-i',
    inputPath,
    '-map',
    '0',
    '-c',
    'copy',
    '-movflags',
    '+faststart',
    '-f',
    'mp4',
    outputPath,
  ];
}
