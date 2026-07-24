/**
 * The complete contract between the main process, the preload bridge and the
 * renderer. Nothing in here may import Node or Electron.
 */

import type { BITRATE_PRESETS, SUPPORTED_FPS } from './constants';
import type { ErrorCode } from './errors';

/* ------------------------------------------------------------------ */
/* Core configuration                                                  */
/* ------------------------------------------------------------------ */

export type FramingMode = 'fill' | 'fit';

export type StreamFps = (typeof SUPPORTED_FPS)[number];

export type BitratePreset = keyof typeof BITRATE_PRESETS | 'custom';

export interface StreamConfig {
  cameraDevice: string;
  microphoneDevice: string | null;
  framingMode: FramingMode;
  fps: StreamFps;
  bitrateKbps: number;
  facebookServerUrl: string;
  facebookStreamKey: string;
  recordingEnabled: boolean;
  recordingDirectory: string | null;
  /** Manual audio→video offset in ms (see MIN/MAX_AUDIO_SYNC_OFFSET_MS). */
  audioSyncOffsetMs: number;
}

export interface PreviewConfig {
  cameraDevice: string;
  /**
   * Microphone to open purely for the live audio meter, or null to leave the
   * mic closed (monitoring off). Never encoded or played back during preview.
   */
  microphoneDevice: string | null;
  framingMode: FramingMode;
  fps: StreamFps;
}

/**
 * What the renderer sends to start a local recording with no outgoing stream.
 * The same pipeline as a live send minus the Facebook branch and its key.
 */
export interface RecordingConfig {
  cameraDevice: string;
  microphoneDevice: string | null;
  framingMode: FramingMode;
  fps: StreamFps;
  recordingDirectory: string;
  /** Manual audio→video offset in ms (see MIN/MAX_AUDIO_SYNC_OFFSET_MS). */
  audioSyncOffsetMs: number;
}

/**
 * What the renderer actually sends to start a stream.
 *
 * The key is optional: once it has been saved, the renderer no longer holds it
 * and the main process reads it from the encrypted CredentialStore instead.
 */
export type StartStreamRequest = Omit<StreamConfig, 'facebookStreamKey'> & {
  facebookStreamKey?: string;
};

/* ------------------------------------------------------------------ */
/* Application state machine                                           */
/* ------------------------------------------------------------------ */

export type ApplicationState =
  | 'idle'
  | 'discovering-devices'
  | 'preview-starting'
  | 'previewing'
  | 'stream-starting'
  | 'streaming'
  | 'stream-stopping'
  // Recording without an outgoing stream: the same single-process pipeline, but
  // the network branch is omitted and only the local file (and preview) is
  // written.
  | 'recording-starting'
  | 'recording'
  | 'recording-stopping'
  | 'finalising-recording'
  | 'error';

/**
 * Sub-phase of an outgoing stream. `launching` means the process exists but has
 * not opened the destination; `connecting` means the RTMP handshake is in
 * flight; `sending` means FFmpeg has actually muxed frames to the destination.
 */
export type StreamPhase = 'idle' | 'launching' | 'connecting' | 'sending';

/* ------------------------------------------------------------------ */
/* Devices                                                             */
/* ------------------------------------------------------------------ */

export interface MediaDevice {
  /** Friendly DirectShow name, e.g. "Integrated Camera". */
  name: string;
  /** DirectShow "Alternative name" (device path), when FFmpeg reported one. */
  alternativeName: string | null;
  /** Stable identifier used by settings persistence and the renderer. */
  id: string;
  /** Index among devices of the same kind, used to disambiguate duplicates. */
  index: number;
}

export interface DeviceList {
  cameras: MediaDevice[];
  microphones: MediaDevice[];
  /** Non-fatal notes produced while parsing FFmpeg's device dump. */
  warnings: string[];
}

/** A single DirectShow capture mode reported by `-list_options`. */
export interface CameraMode {
  /** `mjpeg`, `h264`, ... when FFmpeg reported vcodec. */
  vcodec: string | null;
  /** `yuyv422`, `nv12`, ... when FFmpeg reported pixel_format. */
  pixelFormat: string | null;
  minWidth: number;
  minHeight: number;
  maxWidth: number;
  maxHeight: number;
  minFps: number;
  maxFps: number;
}

export interface DeviceCapabilities {
  deviceId: string;
  modes: CameraMode[];
  /** True when FFmpeg produced no parsable modes (we then let it auto-pick). */
  unknown: boolean;
  error: string | null;
}

/** The capture mode actually chosen for a run. */
export interface SelectedCaptureMode {
  width: number | null;
  height: number | null;
  fps: number | null;
  vcodec: string | null;
  pixelFormat: string | null;
  /** True when the user's requested mode was unavailable and we substituted. */
  substituted: boolean;
  /** Human-readable explanation shown in the UI when `substituted` is true. */
  note: string | null;
}

/* ------------------------------------------------------------------ */
/* Encoders                                                            */
/* ------------------------------------------------------------------ */

export type EncoderId = 'h264_nvenc' | 'h264_qsv' | 'h264_amf' | 'libx264';

export interface EncoderProbe {
  id: EncoderId;
  label: string;
  /** FFmpeg lists the encoder in `-encoders`. */
  listed: boolean;
  /** A real short encode with our production arguments succeeded. */
  usable: boolean;
  /** Redacted failure detail when `usable` is false. */
  detail: string | null;
  hardware: boolean;
}

export interface EncoderCapabilities {
  probes: EncoderProbe[];
  /** Best usable encoder, or null when even libx264 failed. */
  selected: EncoderId | null;
}

/* ------------------------------------------------------------------ */
/* FFmpeg environment                                                  */
/* ------------------------------------------------------------------ */

export interface FfmpegInfo {
  available: boolean;
  path: string | null;
  /** e.g. "7.1.1-essentials_build". */
  version: string | null;
  source: 'env-override' | 'packaged-resource' | 'dev-resource' | 'system-path' | 'not-found';
  hasDshow: boolean;
  hasRtmp: boolean;
  hasRtmps: boolean;
  hasLibx264: boolean;
  /** Fatal, user-facing reason FFmpeg cannot be used. */
  error: string | null;
}

/* ------------------------------------------------------------------ */
/* Runtime status                                                      */
/* ------------------------------------------------------------------ */

export interface StreamStatus {
  state: ApplicationState;
  phase: StreamPhase;
  /** Epoch ms at which the current stream started sending, else null. */
  streamingSince: number | null;
  /** Epoch ms at which the current recording began writing, else null. */
  recordingSince: number | null;
  recording: RecordingStatus;
  encoder: EncoderId | null;
  /** True when we automatically fell back from hardware to software. */
  encoderFallbackApplied: boolean;
  captureMode: SelectedCaptureMode | null;
  /**
   * Live uplink health. `degraded` means FFmpeg is falling behind real time
   * (weak network); the stream stays up and buffers, and the UI shows amber.
   * Always `good` when not sending.
   */
  networkQuality: 'good' | 'degraded';
  /** Free-form, already-redacted message shown next to the state badge. */
  message: string | null;
}

export type RecordingPhase =
  'disabled' | 'recording' | 'finalising' | 'completed' | 'kept-as-mkv' | 'failed';

export interface RecordingStatus {
  phase: RecordingPhase;
  /** Working MKV path while live. */
  workingPath: string | null;
  /** Final MP4 path once remuxing succeeded. */
  finalPath: string | null;
  bytesWritten: number | null;
  message: string | null;
}

export interface StreamStats {
  /** Encoded frames reported by FFmpeg. */
  frames: number;
  /** Instantaneous encode rate. */
  fps: number;
  /** Total output time in milliseconds. */
  outTimeMs: number;
  /** Measured output bitrate in Kbps (aggregate across FFmpeg outputs). */
  bitrateKbps: number;
  /** Encode speed relative to real time (1.0 == real time). */
  speed: number;
  droppedFrames: number;
  duplicatedFrames: number;
  totalBytes: number;
  /** Epoch ms of this sample. */
  timestamp: number;
}

export interface StreamErrorPayload {
  code: ErrorCode;
  /** Short, friendly, already-redacted sentence for the error banner. */
  message: string;
  /** Longer redacted technical detail for the diagnostics disclosure. */
  detail: string | null;
  /** True when the app has returned itself to a usable state. */
  recoverable: boolean;
  timestamp: number;
}

export interface StopResult {
  stopped: boolean;
  recording: RecordingStatus;
  /** Exit code of the FFmpeg process, when one was observed. */
  exitCode: number | null;
  /** True when we had to escalate past the graceful quit. */
  forced: boolean;
}

/* ------------------------------------------------------------------ */
/* Settings                                                            */
/* ------------------------------------------------------------------ */

export interface PersistedSettings {
  cameraDevice: string | null;
  microphoneDevice: string | null;
  audioEnabled: boolean;
  framingMode: FramingMode;
  fps: StreamFps;
  bitratePreset: BitratePreset;
  customBitrateKbps: number;
  facebookServerUrl: string;
  recordingEnabled: boolean;
  recordingDirectory: string | null;
  rememberStreamKey: boolean;
  /** Manual audio→video offset in ms (see MIN/MAX_AUDIO_SYNC_OFFSET_MS). */
  audioSyncOffsetMs: number;
  windowBounds: WindowBounds | null;
}

export interface WindowBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface SettingsSnapshot {
  settings: PersistedSettings;
  /** True when a stream key is currently held (encrypted on disk or in memory). */
  hasStoredStreamKey: boolean;
  /** True when the OS provides working `safeStorage` encryption. */
  encryptionAvailable: boolean;
  /** True when the key is only held for this session because encryption is off. */
  streamKeySessionOnly: boolean;
}

export interface SaveSettingsRequest {
  settings: Partial<PersistedSettings>;
  /**
   * When present, replaces the stored stream key. `null` clears it. Omit the
   * property entirely to leave the existing key untouched.
   */
  streamKey?: string | null;
}

/* ------------------------------------------------------------------ */
/* IPC envelopes                                                       */
/* ------------------------------------------------------------------ */

export type IpcResult<T> = { ok: true; value: T } | { ok: false; error: StreamErrorPayload };

export interface ChooseDirectoryResult {
  canceled: boolean;
  directory: string | null;
  writable: boolean;
  error: string | null;
}

export interface DiagnosticsReport {
  /** Fully redacted, ready to paste into a bug report. */
  text: string;
}

export interface AppInfo {
  name: string;
  version: string;
  electron: string;
  chrome: string;
  node: string;
  platform: string;
  syntheticInput: boolean;
  dryRun: boolean;
  isDev: boolean;
  userDataPath: string;
  logPath: string;
}

export interface StartStreamResult {
  encoder: EncoderId;
  captureMode: SelectedCaptureMode;
  recordingPath: string | null;
  /** True when the destination was replaced by a local dry-run sink. */
  dryRun: boolean;
}

export interface StartRecordingResult {
  encoder: EncoderId;
  captureMode: SelectedCaptureMode;
  /** Absolute path of the MKV being written while recording. */
  recordingPath: string;
}

/** A point-in-time host metrics sample for the footer readouts. */
export interface SystemMetrics {
  /** Aggregate CPU usage of the app's processes, 0–100. */
  cpuPercent: number;
  /** Free bytes on the volume holding the recording folder, or null. */
  freeDiskBytes: number | null;
  /** Total bytes of that volume, or null. */
  totalDiskBytes: number | null;
}

/** Result of a reachability probe against the Facebook ingest host. */
export interface ConnectionTestResult {
  reachable: boolean;
  /** Friendly, already-redacted sentence for the status line. */
  message: string;
  /** The host:port that was probed, for display. */
  target: string | null;
}

/* ------------------------------------------------------------------ */
/* Auto-update                                                         */
/* ------------------------------------------------------------------ */

/**
 * Lifecycle of the GitHub-Releases updater.
 *
 * `unsupported` is the resting state in a dev run or an unpackaged build, where
 * electron-updater cannot operate; the UI stays silent in that state. Downloads
 * never start on their own (`autoDownload` is off): `available` waits for the
 * user to opt in, which moves it to `downloading` → `downloaded`.
 */
export type UpdateState =
  | 'unsupported'
  | 'idle'
  | 'checking'
  | 'available'
  | 'downloading'
  | 'downloaded'
  | 'not-available'
  | 'error';

export interface UpdateStatus {
  state: UpdateState;
  /** The version offered by the release feed, when one is known. */
  version: string | null;
  /** Download progress 0–100 while `state` is `downloading`, else 0. */
  percent: number;
  /** Already-redacted, user-facing reason when `state` is `error`. */
  message: string | null;
}

/* ------------------------------------------------------------------ */
/* Preload-exposed API                                                 */
/* ------------------------------------------------------------------ */

export type Unsubscribe = () => void;

export interface VerticalLiveApi {
  getAppInfo(): Promise<AppInfo>;
  getFfmpegInfo(): Promise<FfmpegInfo>;
  listDevices(refresh?: boolean): Promise<IpcResult<DeviceList>>;
  getDeviceCapabilities(deviceId: string): Promise<IpcResult<DeviceCapabilities>>;
  detectEncoders(force?: boolean): Promise<IpcResult<EncoderCapabilities>>;
  getSettings(): Promise<SettingsSnapshot>;
  saveSettings(request: SaveSettingsRequest): Promise<IpcResult<SettingsSnapshot>>;
  clearStreamKey(): Promise<IpcResult<SettingsSnapshot>>;
  chooseRecordingFolder(): Promise<ChooseDirectoryResult>;
  openRecordingFolder(path: string): Promise<IpcResult<boolean>>;
  startPreview(config: PreviewConfig): Promise<IpcResult<boolean>>;
  stopPreview(): Promise<IpcResult<boolean>>;
  startStream(config: StartStreamRequest): Promise<IpcResult<StartStreamResult>>;
  stopStream(): Promise<IpcResult<StopResult>>;
  startRecording(config: RecordingConfig): Promise<IpcResult<StartRecordingResult>>;
  stopRecording(): Promise<IpcResult<StopResult>>;
  getStatus(): Promise<StreamStatus>;
  getSystemMetrics(recordingDirectory?: string | null): Promise<SystemMetrics>;
  testConnection(facebookServerUrl: string): Promise<ConnectionTestResult>;
  copyDiagnostics(): Promise<IpcResult<DiagnosticsReport>>;
  /** Opens the rotating log file in the OS default handler. */
  openLogFile(): Promise<IpcResult<boolean>>;

  /** Custom title-bar window controls (the window is frameless). */
  window: {
    minimize(): void;
    toggleMaximize(): void;
    close(): void;
    isMaximized(): Promise<boolean>;
    onMaximizedChanged(handler: (maximized: boolean) => void): Unsubscribe;
  };

  /** GitHub-Releases auto-updater. No-ops (returns `unsupported`) in dev. */
  update: {
    /** The updater's current state, for the initial render. */
    getStatus(): Promise<UpdateStatus>;
    /** Ask the feed whether a newer release exists (does not download). */
    check(): Promise<IpcResult<UpdateStatus>>;
    /** Begin downloading the offered update after the user opts in. */
    download(): Promise<IpcResult<UpdateStatus>>;
    /** Quit and install a downloaded update now; a no-op until `downloaded`. */
    install(): void;
    onStatus(handler: (status: UpdateStatus) => void): Unsubscribe;
  };

  onPreviewFrame(handler: (frame: Uint8Array) => void): Unsubscribe;
  onStreamStatus(handler: (status: StreamStatus) => void): Unsubscribe;
  onStreamStats(handler: (stats: StreamStats) => void): Unsubscribe;
  onStreamError(handler: (error: StreamErrorPayload) => void): Unsubscribe;
  /** Live microphone level in 0..1, emitted ~10x/sec while the mic is open. */
  onAudioLevel(handler: (level: number) => void): Unsubscribe;
}
