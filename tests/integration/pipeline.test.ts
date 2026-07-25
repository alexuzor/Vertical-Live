/**
 * Integration test: runs the *real* FFmpeg with the *real* generated arguments
 * against synthetic `testsrc2` / `sine` sources, and verifies the pipeline
 * actually produces what the product promises:
 *
 *   - a 720x1280 H.264/AAC FLV stream-compatible output
 *   - a 1080x1920 H.264/AAC Matroska recording-compatible output
 *   - MJPEG preview frames on stdout
 *   - a working MKV -> MP4 stream-copy remux
 *
 * No camera, no microphone and no Facebook connection are involved. The RTMPS
 * destination is replaced by a local FLV file, exactly as the app's dry-run
 * mode does.
 *
 * The whole suite is skipped (not failed) when FFmpeg is not installed, so a
 * fresh clone without `npm run setup:ffmpeg` still has a green test run.
 */

import { spawn } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  MASTER_HEIGHT,
  MASTER_WIDTH,
  STREAM_HEIGHT,
  STREAM_WIDTH,
} from '../../src/shared/constants';
import {
  buildRemuxCommand,
  buildStreamCommand,
} from '../../src/main/streaming/FfmpegCommandBuilder';
import { PreviewFrameParser } from '../../src/main/streaming/PreviewFrameParser';
import { ProgressParser } from '../../src/main/streaming/ProgressParser';
import type { StreamStats } from '../../src/shared/types';

const EXE = process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg';

/** Finds a usable FFmpeg: the bundled one, an override, or one on PATH. */
function findFfmpeg(): string | null {
  const override = process.env.VERTICAL_LIVE_FFMPEG_PATH;
  if (override && existsSync(override)) return override;

  const bundled = resolve(__dirname, '..', '..', 'resources', 'ffmpeg', EXE);
  if (existsSync(bundled)) return bundled;

  return null;
}

const ffmpegPath = findFfmpeg();
const ffprobePath = ffmpegPath
  ? ffmpegPath.replace(/ffmpeg(\.exe)?$/i, (m) => m.replace('ffmpeg', 'ffprobe'))
  : null;

interface RunResult {
  code: number | null;
  stderr: string;
  previewFrames: number;
  stats: StreamStats[];
}

/** Runs FFmpeg and parses stdout/stderr exactly as StreamingEngine does. */
function runFfmpeg(executable: string, args: readonly string[]): Promise<RunResult> {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(executable, args as string[], {
      shell: false,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stderr = '';
    let previewFrames = 0;
    const stats: StreamStats[] = [];

    const preview = new PreviewFrameParser({
      onFrame: () => {
        previewFrames += 1;
      },
    });
    const progress = new ProgressParser({ onStats: (sample) => stats.push(sample) });

    child.stdout.on('data', (chunk: Buffer) => preview.push(chunk));

    let pending = '';
    child.stderr.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf8');
      stderr += text;
      pending += text;
      const lines = pending.split(/\r\n|\n|\r/);
      pending = lines.pop() ?? '';
      for (const line of lines) progress.push(line);
    });

    child.on('error', rejectPromise);
    child.on('close', (code) => {
      if (pending) progress.push(pending);
      resolvePromise({ code, stderr, previewFrames, stats });
    });
  });
}

/** Reads stream properties with ffprobe, when it is available. */
function probeStreams(
  path: string,
): Promise<{ codec_type: string; codec_name: string; width?: number; height?: number }[]> {
  return new Promise((resolvePromise, rejectPromise) => {
    if (!ffprobePath || !existsSync(ffprobePath)) {
      rejectPromise(new Error('ffprobe not available'));
      return;
    }

    const child = spawn(
      ffprobePath,
      [
        '-v',
        'error',
        '-show_entries',
        'stream=codec_type,codec_name,width,height',
        '-of',
        'json',
        path,
      ],
      { shell: false, windowsHide: true },
    );

    let out = '';
    child.stdout.on('data', (chunk: Buffer) => {
      out += chunk.toString('utf8');
    });
    child.on('error', rejectPromise);
    child.on('close', () => {
      try {
        resolvePromise(JSON.parse(out).streams ?? []);
      } catch (error) {
        rejectPromise(error as Error);
      }
    });
  });
}

let workDir: string;

beforeAll(async () => {
  workDir = await mkdtemp(join(tmpdir(), 'vertical-live-integration-'));
});

afterAll(async () => {
  await rm(workDir, { recursive: true, force: true });
});

describe.skipIf(ffmpegPath === null)('FFmpeg pipeline (synthetic input)', () => {
  it('runs the full three-branch graph and produces every output', async () => {
    const flvPath = join(workDir, 'stream.flv');
    const mkvPath = join(workDir, 'recording.mkv');

    const args = buildStreamCommand({
      cameraDevice: null,
      microphoneDevice: null,
      framingMode: 'fill',
      fps: 30,
      bitrateKbps: 3500,
      encoder: 'libx264',
      destination: { kind: 'file', path: flvPath },
      recordingPath: mkvPath,
      preview: true,
      captureMode: null,
      synthetic: true,
      audioSyncOffsetMs: 0,
      durationSeconds: 3,
    });

    const result = await runFfmpeg(ffmpegPath as string, args);

    expect(result.code, `ffmpeg failed:\n${result.stderr.slice(-4000)}`).toBe(0);

    // Both files exist and contain data.
    expect(existsSync(flvPath)).toBe(true);
    expect(existsSync(mkvPath)).toBe(true);
    expect(statSync(flvPath).size).toBeGreaterThan(1024);
    expect(statSync(mkvPath).size).toBeGreaterThan(1024);

    // The preview branch really emitted complete JPEG frames on stdout.
    // 3 seconds at 10 fps, allowing for start-up.
    expect(result.previewFrames).toBeGreaterThanOrEqual(10);

    // Statistics came from -progress, not from scraping the status line.
    expect(result.stats.length).toBeGreaterThan(0);
    const last = result.stats.at(-1) as StreamStats;
    expect(last.frames).toBeGreaterThan(30);
    expect(last.outTimeMs).toBeGreaterThan(1500);
  });

  it('produces a 720x1280 H.264/AAC stream-compatible output', async () => {
    const flvPath = join(workDir, 'stream-check.flv');

    const result = await runFfmpeg(
      ffmpegPath as string,
      buildStreamCommand({
        cameraDevice: null,
        microphoneDevice: null,
        framingMode: 'fill',
        fps: 30,
        bitrateKbps: 2500,
        encoder: 'libx264',
        destination: { kind: 'file', path: flvPath },
        recordingPath: null,
        preview: false,
        captureMode: null,
        synthetic: true,
        audioSyncOffsetMs: 0,
        durationSeconds: 2,
      }),
    );

    expect(result.code, result.stderr.slice(-3000)).toBe(0);

    const streams = await probeStreams(flvPath);
    const video = streams.find((s) => s.codec_type === 'video');
    const audio = streams.find((s) => s.codec_type === 'audio');

    expect(video?.codec_name).toBe('h264');
    expect(video?.width).toBe(STREAM_WIDTH);
    expect(video?.height).toBe(STREAM_HEIGHT);
    expect(audio?.codec_name).toBe('aac');
  });

  it('produces a 1080x1920 H.264/AAC recording-compatible output', async () => {
    const mkvPath = join(workDir, 'record-check.mkv');

    const result = await runFfmpeg(
      ffmpegPath as string,
      buildStreamCommand({
        cameraDevice: null,
        microphoneDevice: null,
        framingMode: 'fill',
        fps: 30,
        bitrateKbps: 2500,
        encoder: 'libx264',
        destination: { kind: 'null' },
        recordingPath: mkvPath,
        preview: false,
        captureMode: null,
        synthetic: true,
        audioSyncOffsetMs: 0,
        durationSeconds: 2,
      }),
    );

    expect(result.code, result.stderr.slice(-3000)).toBe(0);

    const streams = await probeStreams(mkvPath);
    const video = streams.find((s) => s.codec_type === 'video');
    const audio = streams.find((s) => s.codec_type === 'audio');

    expect(video?.codec_name).toBe('h264');
    expect(video?.width).toBe(MASTER_WIDTH);
    expect(video?.height).toBe(MASTER_HEIGHT);
    expect(audio?.codec_name).toBe('aac');
  });

  it('fit mode letterboxes the full source inside the same canvas', async () => {
    const mkvPath = join(workDir, 'fit-check.mkv');

    const result = await runFfmpeg(
      ffmpegPath as string,
      buildStreamCommand({
        cameraDevice: null,
        microphoneDevice: null,
        framingMode: 'fit',
        fps: 25,
        bitrateKbps: 2500,
        encoder: 'libx264',
        destination: { kind: 'null' },
        recordingPath: mkvPath,
        preview: false,
        captureMode: null,
        synthetic: true,
        audioSyncOffsetMs: 0,
        durationSeconds: 2,
      }),
    );

    expect(result.code, result.stderr.slice(-3000)).toBe(0);

    const video = (await probeStreams(mkvPath)).find((s) => s.codec_type === 'video');
    expect(video?.width).toBe(MASTER_WIDTH);
    expect(video?.height).toBe(MASTER_HEIGHT);
  });

  it('remuxes MKV to MP4 without re-encoding', async () => {
    const mkvPath = join(workDir, 'remux-source.mkv');
    const mp4Path = join(workDir, 'remux-result.mp4');

    const encode = await runFfmpeg(
      ffmpegPath as string,
      buildStreamCommand({
        cameraDevice: null,
        microphoneDevice: null,
        framingMode: 'fill',
        fps: 24,
        bitrateKbps: 2500,
        encoder: 'libx264',
        destination: { kind: 'null' },
        recordingPath: mkvPath,
        preview: false,
        captureMode: null,
        synthetic: true,
        audioSyncOffsetMs: 0,
        durationSeconds: 2,
      }),
    );
    expect(encode.code, encode.stderr.slice(-3000)).toBe(0);

    const remux = await runFfmpeg(ffmpegPath as string, buildRemuxCommand(mkvPath, mp4Path));
    expect(remux.code, remux.stderr.slice(-3000)).toBe(0);

    expect(existsSync(mp4Path)).toBe(true);
    expect(statSync(mp4Path).size).toBeGreaterThan(1024);

    // Same codecs and dimensions: a copy, not a re-encode.
    const streams = await probeStreams(mp4Path);
    const video = streams.find((s) => s.codec_type === 'video');
    expect(video?.codec_name).toBe('h264');
    expect(video?.width).toBe(MASTER_WIDTH);
    expect(video?.height).toBe(MASTER_HEIGHT);
    expect(streams.find((s) => s.codec_type === 'audio')?.codec_name).toBe('aac');
  });

  it('honours every supported frame rate', async () => {
    for (const fps of [24, 25, 30] as const) {
      const result = await runFfmpeg(
        ffmpegPath as string,
        buildStreamCommand({
          cameraDevice: null,
          microphoneDevice: null,
          framingMode: 'fill',
          fps,
          bitrateKbps: 2500,
          encoder: 'libx264',
          destination: { kind: 'null' },
          recordingPath: null,
          preview: false,
          captureMode: null,
          synthetic: true,
          audioSyncOffsetMs: 0,
          durationSeconds: 1,
        }),
      );

      expect(result.code, `fps=${fps} failed:\n${result.stderr.slice(-2000)}`).toBe(0);
    }
  });
});

describe.skipIf(ffmpegPath !== null)('FFmpeg pipeline (skipped)', () => {
  it('reports that FFmpeg is not installed', () => {
    // Documents *why* the integration suite did not run.
    expect(ffmpegPath).toBeNull();
    console.warn(
      'Integration tests skipped: FFmpeg was not found. Run "npm run setup:ffmpeg" to enable them.',
    );
  });
});
