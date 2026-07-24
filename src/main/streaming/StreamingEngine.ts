/**
 * The orchestrator. Owns the state machine, the single FFmpeg process, the
 * preview pipe, progress statistics, recording lifecycle and error recovery.
 *
 * Invariants this class exists to guarantee:
 *  - the camera is opened by at most one process at a time
 *  - the preview always shows the same composition Facebook receives
 *  - "sending to Facebook" is only claimed once FFmpeg has actually muxed
 *    frames to the destination, never merely because a process started
 *  - a recording is finalised on every exit path, including failures
 *  - the app always returns to a usable state
 */

import { join } from 'node:path';

import {
  DEVICE_RELEASE_SETTLE_MS,
  ENV_DRY_RUN,
  ENV_SYNTHETIC_INPUT,
  HARDWARE_FALLBACK_WINDOW_MS,
  NETWORK_DEGRADED_DROP_DELTA,
  NETWORK_DEGRADED_SAMPLES,
  NETWORK_DEGRADED_SPEED,
  NETWORK_RECOVERED_SAMPLES,
  NETWORK_RECOVERED_SPEED,
  PREVIEW_MIN_FRAME_INTERVAL_MS,
} from '../../shared/constants';
import { ERROR_MESSAGES, VerticalLiveError, isRecoverable } from '../../shared/errors';
import type { ErrorCode } from '../../shared/errors';
import type {
  ApplicationState,
  DeviceCapabilities,
  DeviceList,
  EncoderCapabilities,
  EncoderId,
  PreviewConfig,
  RecordingConfig,
  RecordingStatus,
  SelectedCaptureMode,
  StartRecordingResult,
  StartStreamResult,
  StopResult,
  StreamConfig,
  StreamPhase,
  StreamStats,
  StreamStatus,
} from '../../shared/types';
import type { FfmpegLocator } from '../ffmpeg/FfmpegLocator';
import type { Logger } from '../logging/Logger';
import { redact, registerSecret, unregisterSecret } from '../logging/redact';

import { DeviceCapabilityService, selectCaptureMode } from './DeviceCapabilityService';
import { DeviceDiscovery, resolveDshowName } from './DeviceDiscovery';
import { EncoderDetector, SOFTWARE_ENCODER } from './EncoderDetector';
import {
  buildErrorDetail,
  classifyFfmpegOutput,
  isHardwareEncoderFailure,
} from './ErrorClassifier';
import type { StreamDestination } from './FfmpegCommandBuilder';
import {
  buildFacebookUrl,
  buildPreviewCommand,
  buildRecordingCommand,
  buildStreamCommand,
} from './FfmpegCommandBuilder';
import { FfmpegProcess } from './FfmpegProcess';
import type { FfmpegExitResult, Spawner } from './FfmpegProcess';
import { AudioLevelParser } from './AudioLevelParser';
import { LatestFrameThrottle, PreviewFrameParser } from './PreviewFrameParser';
import { ProcessRegistry } from './ProcessRegistry';
import { ProgressParser } from './ProgressParser';
import {
  ensureWritableDirectory,
  finaliseRecording,
  reserveRecordingPaths,
} from './RecordingFinalizer';
import { StateMachine, canStopRecording, canStopStream } from './StateMachine';
import { TypedEmitter } from '../util/TypedEmitter';

const IDLE_RECORDING: RecordingStatus = {
  phase: 'disabled',
  workingPath: null,
  finalPath: null,
  bytesWritten: null,
  message: null,
};

export interface StreamingEngineOptions {
  locator: FfmpegLocator;
  logger: Logger;
  /** Directory for the orphan-PID registry and dry-run output. */
  userDataPath: string;
  env?: NodeJS.ProcessEnv;
  /** Injected in tests so no real process is spawned. */
  spawner?: Spawner;
}

export interface StreamingEngineErrorPayload {
  code: ErrorCode;
  message: string;
  detail: string | null;
}

export interface StreamingEngineEvents {
  status: [status: StreamStatus];
  stats: [stats: StreamStats];
  'preview-frame': [frame: Buffer];
  'audio-level': [level: number];
  error: [payload: StreamingEngineErrorPayload];
  [key: string]: readonly unknown[];
}

interface ActiveRun {
  process: FfmpegProcess;
  kind: 'preview' | 'stream' | 'record';
  startedAt: number;
  config: StreamConfig | null;
  encoder: EncoderId | null;
  captureMode: SelectedCaptureMode | null;
  recordingPaths: { mkvPath: string; mp4Path: string } | null;
  previewParser: PreviewFrameParser;
  throttle: LatestFrameThrottle;
  progress: ProgressParser;
  /** Set once FFmpeg reports encoded frames, proving the destination opened. */
  reachedSending: boolean;
  stopping: boolean;
}

export class StreamingEngine extends TypedEmitter<StreamingEngineEvents> {
  private readonly machine = new StateMachine('idle');
  private readonly discovery: DeviceDiscovery;
  private readonly capabilities: DeviceCapabilityService;
  private readonly encoders: EncoderDetector;
  private readonly registry: ProcessRegistry;
  private readonly logger: Logger;
  private readonly locator: FfmpegLocator;
  private readonly env: NodeJS.ProcessEnv;
  private readonly spawner: Spawner | undefined;
  private readonly userDataPath: string;

  private run: ActiveRun | null = null;
  private phase: StreamPhase = 'idle';
  private streamingSince: number | null = null;
  private recordingSince: number | null = null;
  private recording: RecordingStatus = IDLE_RECORDING;
  private networkQuality: 'good' | 'degraded' = 'good';
  private netBadStreak = 0;
  private netGoodStreak = 0;
  private lastDroppedFrames = 0;
  private activeEncoder: EncoderId | null = null;
  private encoderFallbackApplied = false;
  private captureMode: SelectedCaptureMode | null = null;
  private statusMessage: string | null = null;
  private lastStreamKey: string | null = null;
  private fallbackInFlight = false;
  private shuttingDown = false;

  constructor(options: StreamingEngineOptions) {
    super();
    this.logger = options.logger;
    this.locator = options.locator;
    this.env = options.env ?? process.env;
    this.spawner = options.spawner;
    this.userDataPath = options.userDataPath;

    const getExecutable = (): string => this.locator.requirePath();

    this.discovery = new DeviceDiscovery({ getExecutable, env: this.env });
    this.capabilities = new DeviceCapabilityService({ getExecutable, env: this.env });
    this.encoders = new EncoderDetector({
      getExecutable,
      onLog: (message) => this.logger.info(message),
    });
    this.registry = new ProcessRegistry({
      directory: this.userDataPath,
      onLog: (message) => this.logger.warn(message),
    });

    this.machine.onChange((to, from) => {
      this.logger.info(`State: ${from} -> ${to}`);
      this.emitStatus();
    });
  }

  /* ---------------------------------------------------------------- */
  /* Introspection                                                     */
  /* ---------------------------------------------------------------- */

  getState(): ApplicationState {
    return this.machine.state;
  }

  getStatus(): StreamStatus {
    return {
      state: this.machine.state,
      phase: this.phase,
      streamingSince: this.streamingSince,
      recordingSince: this.recordingSince,
      recording: this.recording,
      encoder: this.activeEncoder,
      encoderFallbackApplied: this.encoderFallbackApplied,
      captureMode: this.captureMode,
      networkQuality: this.networkQuality,
      message: this.statusMessage,
    };
  }

  get syntheticInput(): boolean {
    return this.env[ENV_SYNTHETIC_INPUT] === 'true';
  }

  get dryRun(): boolean {
    return this.env[ENV_DRY_RUN] === 'true';
  }

  /** Reaps FFmpeg processes orphaned by a previous abnormal exit. */
  async reapOrphans(): Promise<number[]> {
    return this.registry.reapOrphans();
  }

  /* ---------------------------------------------------------------- */
  /* Discovery                                                         */
  /* ---------------------------------------------------------------- */

  async discoverDevices(refresh = false): Promise<DeviceList> {
    const previous = this.machine.state;
    this.machine.tryTransition('discovering-devices');
    try {
      const list = await this.discovery.list(refresh);
      this.logger.info(
        `Discovered ${list.cameras.length} camera(s) and ${list.microphones.length} microphone(s).`,
      );
      return list;
    } finally {
      if (this.machine.state === 'discovering-devices') {
        this.machine.forceTransition(previous === 'discovering-devices' ? 'idle' : previous);
      }
    }
  }

  async getDeviceCapabilities(deviceId: string): Promise<DeviceCapabilities> {
    const camera = await this.discovery.findCamera(deviceId);
    if (!camera) {
      throw new VerticalLiveError('camera-not-found', `No camera matches "${deviceId}".`);
    }
    return this.capabilities.get(deviceId, resolveDshowName(camera));
  }

  async detectEncoders(force = false): Promise<EncoderCapabilities> {
    return this.encoders.detect(force);
  }

  /* ---------------------------------------------------------------- */
  /* Preview                                                           */
  /* ---------------------------------------------------------------- */

  /**
   * Starts a preview-only FFmpeg run. Uses the same master composition as a
   * live send so what the user sees is exactly what Facebook would receive.
   */
  async startPreview(config: PreviewConfig): Promise<void> {
    if (this.run?.kind === 'stream') {
      // The live pipeline already produces preview frames.
      return;
    }

    await this.stopPreview();

    if (!this.machine.can('preview-starting')) {
      throw new VerticalLiveError(
        'invalid-state-transition',
        `Preview cannot start while the app is "${this.machine.state}".`,
      );
    }
    this.machine.transition('preview-starting');

    try {
      const { dshowName, captureMode } = await this.resolveCamera(
        config.cameraDevice,
        config.fps,
      );
      this.captureMode = captureMode;

      // The mic is opened only to drive the live audio meter; a missing mic is
      // not fatal to a preview, so a lookup failure just disables metering.
      let microphoneName: string | null = null;
      if (config.microphoneDevice && !this.syntheticInput) {
        const microphone = await this.discovery.findMicrophone(config.microphoneDevice);
        if (microphone) {
          microphoneName = resolveDshowName(microphone);
        } else {
          this.logger.warn(
            `Preview meter: microphone "${config.microphoneDevice}" not found; metering disabled.`,
          );
        }
      }

      const args = buildPreviewCommand({
        cameraDevice: this.syntheticInput ? null : dshowName,
        microphoneDevice: this.syntheticInput ? null : microphoneName,
        framingMode: config.framingMode,
        fps: config.fps,
        captureMode,
        synthetic: this.syntheticInput,
      });

      this.logger.info(
        `Starting preview (${config.framingMode}, ${config.fps} fps` +
          `${microphoneName ? ', metering' : ''}).`,
      );
      this.spawnRun('preview', args, null, null, captureMode, null);
    } catch (error) {
      this.machine.forceTransition('idle');
      throw error;
    }
  }

  async stopPreview(): Promise<void> {
    if (!this.run || this.run.kind !== 'preview') return;
    const active = this.run;
    active.stopping = true;
    this.logger.info('Stopping preview.');
    await active.process.stop();
    // `handleExit` clears `this.run` and returns the machine to idle.
  }

  /* ---------------------------------------------------------------- */
  /* Streaming                                                         */
  /* ---------------------------------------------------------------- */

  async start(config: StreamConfig): Promise<StartStreamResult> {
    if (!this.machine.can('stream-starting')) {
      throw new VerticalLiveError(
        'invalid-state-transition',
        `A stream cannot start while the app is "${this.machine.state}".`,
      );
    }

    // Release the camera before the streaming process tries to claim it.
    const hadPreview = this.run?.kind === 'preview';
    await this.stopPreview();
    if (hadPreview) {
      // FFmpeg has exited, but DirectShow does not always hand the device back
      // to the next opener instantly. A short settle avoids a spurious
      // "camera in use" failure on real hardware.
      await this.settleDevice();
    }

    this.machine.transition('stream-starting');
    this.setPhase('launching');
    this.encoderFallbackApplied = false;
    this.fallbackInFlight = false;
    this.resetNetworkQuality();

    try {
      return await this.launchStream(config, null);
    } catch (error) {
      this.machine.forceTransition('idle');
      this.setPhase('idle');
      this.recording = IDLE_RECORDING;
      throw error;
    }
  }

  /**
   * Builds and spawns the live pipeline.
   * `forcedEncoder` is used by the automatic hardware -> software fallback.
   */
  private async launchStream(
    config: StreamConfig,
    forcedEncoder: EncoderId | null,
  ): Promise<StartStreamResult> {
    const { dshowName, captureMode } = await this.resolveCamera(
      config.cameraDevice,
      config.fps,
    );
    this.captureMode = captureMode;

    let microphoneName: string | null = null;
    if (config.microphoneDevice) {
      const microphone = await this.discovery.findMicrophone(config.microphoneDevice);
      if (!microphone) {
        throw new VerticalLiveError(
          'microphone-unavailable',
          `No microphone matches "${config.microphoneDevice}".`,
        );
      }
      microphoneName = resolveDshowName(microphone);
    }

    const encoder = forcedEncoder ?? (await this.chooseEncoder());
    this.activeEncoder = encoder;

    let recordingPaths: { mkvPath: string; mp4Path: string } | null = null;
    if (config.recordingEnabled) {
      if (!config.recordingDirectory) {
        throw new VerticalLiveError(
          'invalid-configuration',
          'Recording is enabled but no folder was chosen.',
        );
      }
      await ensureWritableDirectory(config.recordingDirectory);
      const reserved = await reserveRecordingPaths(config.recordingDirectory);
      recordingPaths = { mkvPath: reserved.mkvPath, mp4Path: reserved.mp4Path };
      this.recording = {
        phase: 'recording',
        workingPath: reserved.mkvPath,
        finalPath: null,
        bytesWritten: 0,
        message: null,
      };
      this.recordingSince = Date.now();
    } else {
      this.recording = IDLE_RECORDING;
      this.recordingSince = null;
    }

    // Register the key for redaction *before* it can appear anywhere.
    registerSecret(config.facebookStreamKey);
    this.lastStreamKey = config.facebookStreamKey;

    const destination = this.buildDestination(config);

    const args = buildStreamCommand({
      cameraDevice: this.syntheticInput ? null : dshowName,
      microphoneDevice: this.syntheticInput ? null : microphoneName,
      framingMode: config.framingMode,
      fps: config.fps,
      bitrateKbps: config.bitrateKbps,
      encoder,
      destination,
      recordingPath: recordingPaths?.mkvPath ?? null,
      preview: true,
      captureMode,
      synthetic: this.syntheticInput,
      audioSyncOffsetMs: config.audioSyncOffsetMs,
    });

    this.logger.info(
      `Starting stream: encoder=${encoder} fps=${config.fps} bitrate=${config.bitrateKbps}kbps ` +
        `framing=${config.framingMode} recording=${config.recordingEnabled} ` +
        `destination=${destination.kind}`,
    );
    this.logger.debug(`FFmpeg args: ${redact(args.join(' '))}`);

    this.setPhase('connecting');
    this.spawnRun('stream', args, config, encoder, captureMode, recordingPaths);

    return {
      encoder,
      captureMode,
      recordingPath: recordingPaths?.mkvPath ?? null,
      dryRun: destination.kind !== 'rtmp',
    };
  }

  async stop(): Promise<StopResult> {
    if (!canStopStream(this.machine.state) || !this.run || this.run.kind !== 'stream') {
      throw new VerticalLiveError(
        'invalid-state-transition',
        `There is no stream to stop (state "${this.machine.state}").`,
      );
    }

    const active = this.run;
    if (active.stopping) {
      // Duplicate Stop clicks wait for the first one rather than racing it.
      const result = await active.process.waitForExit();
      return {
        stopped: true,
        recording: this.recording,
        exitCode: result.code,
        forced: result.forced,
      };
    }

    active.stopping = true;
    this.machine.tryTransition('stream-stopping');
    this.setStatusMessage('Closing the connection to Facebook…');
    this.logger.info('Stopping stream (graceful quit requested).');

    const result = await active.process.stop();
    // `handleExit` performs recording finalisation and returns to idle.
    await this.settled();

    return {
      stopped: true,
      recording: this.recording,
      exitCode: result.code,
      forced: result.forced,
    };
  }

  /* ---------------------------------------------------------------- */
  /* Recording (no outgoing stream)                                    */
  /* ---------------------------------------------------------------- */

  /**
   * Starts a local recording with no Facebook branch. Uses the same master
   * composition as a live send, so the recorded file matches the preview.
   */
  async startRecording(config: RecordingConfig): Promise<StartRecordingResult> {
    if (!this.machine.can('recording-starting')) {
      throw new VerticalLiveError(
        'invalid-state-transition',
        `Recording cannot start while the app is "${this.machine.state}".`,
      );
    }

    const hadPreview = this.run?.kind === 'preview';
    await this.stopPreview();
    if (hadPreview) await this.settleDevice();

    this.machine.transition('recording-starting');
    this.encoderFallbackApplied = false;
    this.fallbackInFlight = false;

    try {
      return await this.launchRecording(config);
    } catch (error) {
      this.machine.forceTransition('idle');
      this.recording = IDLE_RECORDING;
      this.recordingSince = null;
      throw error;
    }
  }

  private async launchRecording(config: RecordingConfig): Promise<StartRecordingResult> {
    const { dshowName, captureMode } = await this.resolveCamera(config.cameraDevice, config.fps);
    this.captureMode = captureMode;

    let microphoneName: string | null = null;
    if (config.microphoneDevice) {
      const microphone = await this.discovery.findMicrophone(config.microphoneDevice);
      if (!microphone) {
        throw new VerticalLiveError(
          'microphone-unavailable',
          `No microphone matches "${config.microphoneDevice}".`,
        );
      }
      microphoneName = resolveDshowName(microphone);
    }

    const encoder = await this.chooseEncoder();
    this.activeEncoder = encoder;

    await ensureWritableDirectory(config.recordingDirectory);
    const reserved = await reserveRecordingPaths(config.recordingDirectory);
    const recordingPaths = { mkvPath: reserved.mkvPath, mp4Path: reserved.mp4Path };
    this.recording = {
      phase: 'recording',
      workingPath: reserved.mkvPath,
      finalPath: null,
      bytesWritten: 0,
      message: null,
    };
    this.recordingSince = Date.now();

    const args = buildRecordingCommand({
      cameraDevice: this.syntheticInput ? null : dshowName,
      microphoneDevice: this.syntheticInput ? null : microphoneName,
      framingMode: config.framingMode,
      fps: config.fps,
      encoder,
      recordingPath: reserved.mkvPath,
      preview: true,
      captureMode,
      synthetic: this.syntheticInput,
      audioSyncOffsetMs: config.audioSyncOffsetMs,
    });

    this.logger.info(
      `Starting recording: encoder=${encoder} fps=${config.fps} ` +
        `framing=${config.framingMode} path=${reserved.mkvPath}`,
    );

    this.spawnRun('record', args, null, encoder, captureMode, recordingPaths);

    return { encoder, captureMode, recordingPath: reserved.mkvPath };
  }

  async stopRecording(): Promise<StopResult> {
    if (!canStopRecording(this.machine.state) || !this.run || this.run.kind !== 'record') {
      throw new VerticalLiveError(
        'invalid-state-transition',
        `There is no recording to stop (state "${this.machine.state}").`,
      );
    }

    const active = this.run;
    if (active.stopping) {
      const result = await active.process.waitForExit();
      return {
        stopped: true,
        recording: this.recording,
        exitCode: result.code,
        forced: result.forced,
      };
    }

    active.stopping = true;
    this.machine.tryTransition('recording-stopping');
    this.setStatusMessage('Finishing the recording…');
    this.logger.info('Stopping recording (graceful quit requested).');

    const result = await active.process.stop();
    await this.settled();

    return {
      stopped: true,
      recording: this.recording,
      exitCode: result.code,
      forced: result.forced,
    };
  }

  /** Immediate termination. Only used during an emergency app shutdown. */
  async forceStop(): Promise<void> {
    const active = this.run;
    if (!active) return;
    active.stopping = true;
    await active.process.forceStop();
    await this.settled();
  }

  /**
   * Graceful shutdown used when the window is closing: stops the stream,
   * finalises the recording, and never rejects.
   */
  async shutdown(): Promise<void> {
    this.shuttingDown = true;
    const active = this.run;
    if (!active) return;
    try {
      active.stopping = true;
      await active.process.stop();
      await this.settled();
    } catch (error) {
      this.logger.error(`Shutdown error: ${redact(error)}`);
      await this.forceStop().catch(() => undefined);
    }
  }

  /* ---------------------------------------------------------------- */
  /* Internals                                                         */
  /* ---------------------------------------------------------------- */

  private async resolveCamera(
    deviceId: string,
    fps: number,
  ): Promise<{ dshowName: string; captureMode: SelectedCaptureMode }> {
    if (this.syntheticInput) {
      return {
        dshowName: deviceId,
        captureMode: {
          width: 1280,
          height: 720,
          fps,
          vcodec: null,
          pixelFormat: null,
          substituted: false,
          note: null,
        },
      };
    }

    const list = await this.discovery.list();
    if (list.cameras.length === 0) {
      throw new VerticalLiveError('no-camera-found', 'FFmpeg reported no DirectShow cameras.');
    }

    const camera = list.cameras.find((device) => device.id === deviceId);
    if (!camera) {
      throw new VerticalLiveError(
        'camera-not-found',
        `The camera "${deviceId}" is no longer connected.`,
      );
    }

    const dshowName = resolveDshowName(camera);
    const capabilities = await this.capabilities.get(deviceId, dshowName);
    const selection = selectCaptureMode(capabilities.modes, fps);

    if (selection.substituted && selection.note) {
      this.logger.warn(selection.note);
      this.setStatusMessage(selection.note);
    }

    const captureMode: SelectedCaptureMode = {
      width: selection.width,
      height: selection.height,
      fps: selection.fps,
      vcodec: selection.vcodec,
      pixelFormat: selection.pixelFormat,
      substituted: selection.substituted,
      note: selection.note,
    };

    this.logger.info(
      `Camera "${camera.name}" capture mode: ` +
        `${captureMode.width ?? 'auto'}x${captureMode.height ?? 'auto'} @ ` +
        `${captureMode.fps ?? 'auto'} fps (${captureMode.vcodec ?? captureMode.pixelFormat ?? 'driver default'})`,
    );

    return { dshowName, captureMode };
  }

  private async chooseEncoder(): Promise<EncoderId> {
    const capabilities = await this.encoders.detect();
    if (!capabilities.selected) {
      const detail = capabilities.probes
        .map((probe) => `${probe.id}: ${probe.detail ?? 'unusable'}`)
        .join('; ');
      throw new VerticalLiveError('encoder-unavailable', detail);
    }
    return capabilities.selected;
  }

  /**
   * Resolves the output destination. In dry-run mode the RTMP endpoint is
   * replaced by a local FLV file so the whole pipeline can be exercised without
   * ever contacting Facebook.
   */
  private buildDestination(config: StreamConfig): StreamDestination {
    if (this.dryRun) {
      const path = join(this.userDataPath, `dry-run-${Date.now()}.flv`);
      this.logger.warn(
        `Dry-run mode: writing the Facebook branch to ${path} instead of RTMPS.`,
      );
      return { kind: 'file', path };
    }
    return {
      kind: 'rtmp',
      url: buildFacebookUrl(config.facebookServerUrl, config.facebookStreamKey),
    };
  }

  private spawnRun(
    kind: 'preview' | 'stream' | 'record',
    args: string[],
    config: StreamConfig | null,
    encoder: EncoderId | null,
    captureMode: SelectedCaptureMode | null,
    recordingPaths: { mkvPath: string; mp4Path: string } | null,
  ): void {
    const executable = this.locator.requirePath();

    const previewParser = new PreviewFrameParser({
      onFrame: (frame) => throttle.submit(frame),
      onDrop: (reason, bytes) =>
        this.logger.debug(`Preview frame dropped (${reason}, ${bytes}B).`),
    });

    const throttle = new LatestFrameThrottle(PREVIEW_MIN_FRAME_INTERVAL_MS, (frame) => {
      this.emit('preview-frame', frame);
    });

    const progress = new ProgressParser({
      onStats: (stats) => this.handleStats(stats),
      onLogLine: (line) => this.handleLogLine(line),
    });

    const audioLevel = new AudioLevelParser({
      onLevel: (level) => this.emit('audio-level', level),
    });

    const ffmpeg = new FfmpegProcess({
      executable,
      args,
      spawner: this.spawner,
      onStdoutChunk: (chunk) => previewParser.push(chunk),
      // ebur128 measurement lines drive the meter (and are not logged); every
      // other stderr line goes to the progress / diagnostics parser.
      onStderrLine: (line) => {
        if (!audioLevel.push(line)) progress.push(line);
      },
      onSpawn: (pid) => {
        this.registry.add(pid);
        this.logger.info(`FFmpeg started (pid ${String(pid)}, ${kind}).`);
      },
    });

    const active: ActiveRun = {
      process: ffmpeg,
      kind,
      startedAt: Date.now(),
      config,
      encoder,
      captureMode,
      recordingPaths,
      previewParser,
      throttle,
      progress,
      reachedSending: false,
      stopping: false,
    };

    this.run = active;

    ffmpeg.on('spawn-error', (error) => {
      this.logger.error(`FFmpeg could not be started: ${redact(error)}`);
    });

    ffmpeg.on('exit', (result) => {
      void this.handleExit(active, result);
    });

    ffmpeg.start();
  }

  private handleStats(stats: StreamStats): void {
    const active = this.run;
    if (!active) return;

    if (active.kind === 'preview') {
      if (this.machine.state === 'preview-starting' && stats.frames > 0) {
        this.machine.tryTransition('previewing');
      }
      return;
    }

    if (active.kind === 'record') {
      // Frames prove FFmpeg has opened the file and is writing to it.
      if (!active.reachedSending && stats.frames > 0) {
        active.reachedSending = true;
        this.recordingSince = Date.now();
        this.machine.tryTransition('recording');
        this.setStatusMessage(null);
        this.logger.info('Recording is capturing frames.');
      }
      this.emit('stats', stats);
      return;
    }

    // Frames only exist once FFmpeg has written the output header, which for
    // FLV over RTMP means the connect + publish handshake already succeeded.
    if (!active.reachedSending && stats.frames > 0) {
      active.reachedSending = true;
      this.streamingSince = Date.now();
      this.lastDroppedFrames = stats.droppedFrames;
      this.setPhase('sending');
      this.setStatusMessage(null);
      this.machine.tryTransition('streaming');
      this.logger.info('Facebook ingest connected; video is being sent.');
    }

    if (active.reachedSending) this.evaluateNetworkQuality(stats);

    this.emit('stats', stats);
  }

  /**
   * Turns the per-sample encode `speed` and dropped-frame trend into a stable
   * `good`/`degraded` uplink flag. The stream is never stopped on a weak
   * network — FFmpeg buffers and keeps trying — so this only drives the amber
   * UI state and recovers to green on its own once the link catches up.
   */
  private evaluateNetworkQuality(stats: StreamStats): void {
    const dropDelta = Math.max(0, stats.droppedFrames - this.lastDroppedFrames);
    this.lastDroppedFrames = stats.droppedFrames;

    // `speed` is 0 for the first sample or two; ignore it until it is real.
    const slow = stats.speed > 0 && stats.speed < NETWORK_DEGRADED_SPEED;
    const dropping = dropDelta >= NETWORK_DEGRADED_DROP_DELTA;
    const healthy = stats.speed >= NETWORK_RECOVERED_SPEED && dropDelta === 0;

    if (slow || dropping) {
      this.netBadStreak += 1;
      this.netGoodStreak = 0;
    } else if (healthy) {
      this.netGoodStreak += 1;
      this.netBadStreak = 0;
    }

    if (this.networkQuality === 'good' && this.netBadStreak >= NETWORK_DEGRADED_SAMPLES) {
      this.networkQuality = 'degraded';
      this.statusMessage = 'Weak network — buffering. The stream will keep trying.';
      this.logger.warn(`Network degraded (speed=${stats.speed.toFixed(2)}x).`);
      this.emitStatus();
    } else if (
      this.networkQuality === 'degraded' &&
      this.netGoodStreak >= NETWORK_RECOVERED_SAMPLES
    ) {
      this.networkQuality = 'good';
      this.statusMessage = null;
      this.logger.info('Network recovered; stream back to normal.');
      this.emitStatus();
    }
  }

  private resetNetworkQuality(): void {
    this.networkQuality = 'good';
    this.netBadStreak = 0;
    this.netGoodStreak = 0;
    this.lastDroppedFrames = 0;
  }

  private handleLogLine(line: string): void {
    // Already redacted by FfmpegProcess.
    if (/^\[?(error|fatal)/i.test(line) || /\berror\b/i.test(line)) {
      this.logger.warn(`ffmpeg: ${line}`);
    } else {
      this.logger.debug(`ffmpeg: ${line}`);
    }
  }

  private async handleExit(active: ActiveRun, result: FfmpegExitResult): Promise<void> {
    if (this.run !== active) return;

    active.throttle.dispose();
    active.previewParser.reset();
    this.registry.remove(active.process.pid);
    this.run = null;

    if (active.kind === 'preview') {
      this.setPhase('idle');
      this.machine.forceTransition('idle');
      if (!active.stopping && result.code !== 0) {
        this.reportProcessFailure(result, 'preview');
      }
      return;
    }

    const isRecord = active.kind === 'record';
    const requested = active.stopping || result.requested;
    this.logger.info(
      `FFmpeg exited (code ${String(result.code)}, requested=${String(requested)}, forced=${String(result.forced)}).`,
    );

    // Attempt a controlled software fallback when a hardware encoder failed
    // before anything was published.
    if (!requested && !this.shuttingDown && this.shouldAttemptFallback(active, result)) {
      const config = active.config;
      if (config) {
        this.encoderFallbackApplied = true;
        this.fallbackInFlight = true;
        this.setStatusMessage(
          'The hardware encoder failed to start. Retrying with software encoding…',
        );
        this.logger.warn(`Falling back from ${String(active.encoder)} to ${SOFTWARE_ENCODER}.`);
        try {
          await this.launchStream(config, SOFTWARE_ENCODER);
          this.fallbackInFlight = false;
          return;
        } catch (error) {
          this.fallbackInFlight = false;
          this.logger.error(`Software fallback also failed: ${redact(error)}`);
        }
      }
    }

    this.machine.tryTransition(isRecord ? 'recording-stopping' : 'stream-stopping');

    // Finalise on every exit path, including failures: an MKV written up to the
    // moment of failure is a complete, playable recording and must not be lost.
    if (active.recordingPaths) {
      this.machine.tryTransition('finalising-recording');
      this.recording = { ...this.recording, phase: 'finalising', message: null };
      this.emitStatus();

      this.recording = await finaliseRecording({
        mkvPath: active.recordingPaths.mkvPath,
        mp4Path: active.recordingPaths.mp4Path,
        getExecutable: () => this.locator.requirePath(),
        onLog: (message) => this.logger.info(message),
      });
      this.logger.info(
        `Recording finalised: phase=${this.recording.phase} path=${this.recording.finalPath ?? this.recording.workingPath ?? 'none'}`,
      );
    }

    this.setPhase('idle');
    this.streamingSince = null;
    this.recordingSince = null;
    this.activeEncoder = null;
    this.resetNetworkQuality();

    if (!requested) {
      this.reportProcessFailure(result, isRecord ? 'record' : 'stream');
    } else {
      this.setStatusMessage(null);
    }

    if (this.lastStreamKey) {
      unregisterSecret(this.lastStreamKey);
      this.lastStreamKey = null;
    }

    this.machine.forceTransition('idle');
  }

  private shouldAttemptFallback(active: ActiveRun, result: FfmpegExitResult): boolean {
    if (this.encoderFallbackApplied || this.fallbackInFlight) return false;
    if (active.encoder === SOFTWARE_ENCODER || active.encoder === null) return false;
    if (active.reachedSending) return false;
    if (Date.now() - active.startedAt > HARDWARE_FALLBACK_WINDOW_MS) return false;
    const { code } = classifyFfmpegOutput(result.stderrTail);
    return isHardwareEncoderFailure(code);
  }

  private reportProcessFailure(
    result: FfmpegExitResult,
    kind: 'preview' | 'stream' | 'record',
  ): void {
    const classified = classifyFfmpegOutput(result.stderrTail);
    const detail = buildErrorDetail(result.stderrTail);
    const message = ERROR_MESSAGES[classified.code];

    this.logger.error(
      `${kind} failed: code=${classified.code} exit=${String(result.code)} evidence=${classified.evidence ?? 'none'}`,
    );

    this.statusMessage = message;
    this.emit('error', { code: classified.code, message, detail });

    if (!isRecoverable(classified.code)) {
      this.machine.forceTransition('error');
    }
  }

  private setPhase(phase: StreamPhase): void {
    if (this.phase === phase) return;
    this.phase = phase;
    this.emitStatus();
  }

  private setStatusMessage(message: string | null): void {
    if (this.statusMessage === message) return;
    this.statusMessage = message;
    this.emitStatus();
  }

  private emitStatus(): void {
    this.emit('status', this.getStatus());
  }

  /** Brief pause to let Windows release a DirectShow device between opens. */
  private settleDevice(): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, DEVICE_RELEASE_SETTLE_MS);
      timer.unref?.();
    });
  }

  /** Waits until no FFmpeg process is active and finalisation has finished. */
  private async settled(): Promise<void> {
    for (let attempt = 0; attempt < 600; attempt += 1) {
      if (this.run === null && this.machine.state !== 'finalising-recording') return;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
}
