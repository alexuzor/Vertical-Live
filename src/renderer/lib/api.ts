/**
 * Bridge accessor.
 *
 * In Electron the real, preload-injected `window.verticalLive` is used. When the
 * page is opened in a plain browser (used for visual verification and for the
 * `?demo` / `?modal` showcase states), a self-contained mock stands in so the
 * dashboard renders and its handlers behave realistically without a backend.
 *
 * The mock never claims to have contacted Facebook or written a real file — it
 * only returns shapes the UI can render, and the controller marks anything it
 * drives from the mock as demo state.
 */

import type {
  AppInfo,
  ChooseDirectoryResult,
  ConnectionTestResult,
  DeviceList,
  DiagnosticsReport,
  EncoderCapabilities,
  FfmpegInfo,
  IpcResult,
  SettingsSnapshot,
  StartRecordingResult,
  StartStreamResult,
  StopResult,
  StreamStatus,
  SystemMetrics,
  UpdateStatus,
  VerticalLiveApi,
} from '@shared/types';

export const isElectron = typeof window !== 'undefined' && Boolean(window.verticalLive);

function ok<T>(value: T): IpcResult<T> {
  return { ok: true, value };
}

const MOCK_SETTINGS: SettingsSnapshot = {
  settings: {
    cameraDevice: 'Logitech Brio (USB)',
    microphoneDevice: 'Blue Yeti (USB)',
    audioEnabled: true,
    framingMode: 'fill',
    fps: 30,
    bitratePreset: 'standard',
    customBitrateKbps: 3500,
    facebookServerUrl: 'rtmps://live-api-s.facebook.com:443/rtmp/',
    recordingEnabled: false,
    recordingDirectory: 'C:\\Users\\user\\Videos\\Vertical Live',
    rememberStreamKey: true,
    audioSyncOffsetMs: 0,
    noiseSuppression: false,
    windowBounds: null,
  },
  hasStoredStreamKey: true,
  encryptionAvailable: true,
  streamKeySessionOnly: false,
};

const MOCK_DEVICES: DeviceList = {
  cameras: [
    { name: 'Logitech Brio (USB)', alternativeName: null, id: 'Logitech Brio (USB)', index: 0 },
    { name: 'Integrated Camera', alternativeName: null, id: 'Integrated Camera', index: 1 },
  ],
  microphones: [
    { name: 'Blue Yeti (USB)', alternativeName: null, id: 'Blue Yeti (USB)', index: 0 },
    {
      name: 'Microphone (Realtek)',
      alternativeName: null,
      id: 'Microphone (Realtek)',
      index: 1,
    },
  ],
  warnings: [],
};

const MOCK_STATUS: StreamStatus = {
  state: 'idle',
  phase: 'idle',
  streamingSince: null,
  recordingSince: null,
  recording: {
    phase: 'disabled',
    workingPath: null,
    finalPath: null,
    bytesWritten: null,
    message: null,
  },
  encoder: 'h264_nvenc',
  encoderFallbackApplied: false,
  captureMode: {
    width: 1920,
    height: 1080,
    fps: 30,
    vcodec: 'mjpeg',
    pixelFormat: null,
    substituted: false,
    note: null,
  },
  networkQuality: 'good',
  message: null,
};

const noop = (): void => undefined;

/**
 * Browser-preview only: synthesises a gently moving 360x640 JPEG at ~15 fps so
 * the real canvas renderer (usePreviewCanvas) can be exercised without Electron.
 * The shipped app feeds the same handler real FFmpeg MJPEG over the MessagePort.
 */
function createSyntheticPreview(handler: (frame: Uint8Array) => void): () => void {
  if (typeof document === 'undefined') return noop;
  const canvas = document.createElement('canvas');
  canvas.width = 360;
  canvas.height = 640;
  const ctx = canvas.getContext('2d');
  if (!ctx) return noop;

  let t = 0;
  let stopped = false;
  const id = window.setInterval(() => {
    if (stopped) return;
    t += 0.05;
    const g = ctx.createLinearGradient(0, 0, 360, 640);
    g.addColorStop(0, `hsl(${(t * 40) % 360}, 55%, 22%)`);
    g.addColorStop(1, '#0c151d');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, 360, 640);
    ctx.fillStyle = '#27dc73';
    ctx.beginPath();
    ctx.arc(180 + Math.sin(t) * 120, 320 + Math.cos(t * 1.3) * 240, 26, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = 'rgba(244,247,250,0.85)';
    ctx.font = '15px sans-serif';
    ctx.fillText('browser preview (mock)', 16, 36);
    canvas.toBlob(
      (blob) => {
        if (!blob || stopped) return;
        void blob.arrayBuffer().then((ab) => {
          if (!stopped) handler(new Uint8Array(ab));
        });
      },
      'image/jpeg',
      0.7,
    );
  }, 66);

  return () => {
    stopped = true;
    window.clearInterval(id);
  };
}

/**
 * Browser-preview updater. Inert by default so opening the page never nags;
 * append `?update` to the URL to act out the whole banner flow (available →
 * downloading → downloaded) without any real download.
 */
function createMockUpdater(): VerticalLiveApi['update'] {
  const demo = queryFlag('update') !== null;
  const listeners = new Set<(status: UpdateStatus) => void>();
  let status: UpdateStatus = demo
    ? { state: 'available', version: '1.2.0', percent: 0, message: null }
    : { state: 'unsupported', version: null, percent: 0, message: null };

  const emit = (next: UpdateStatus): void => {
    status = next;
    for (const listener of listeners) listener(next);
  };

  return {
    getStatus: () => Promise.resolve(status),
    check: () => Promise.resolve(ok(status)),
    download: () => {
      if (demo && status.state === 'available') {
        emit({ state: 'downloading', version: status.version, percent: 0, message: null });
        let percent = 0;
        const id = setInterval(() => {
          percent += 15;
          if (percent >= 100) {
            clearInterval(id);
            emit({ state: 'downloaded', version: status.version, percent: 100, message: null });
          } else {
            emit({ state: 'downloading', version: status.version, percent, message: null });
          }
        }, 320);
      }
      return Promise.resolve(ok(status));
    },
    install: noop,
    onStatus: (handler) => {
      listeners.add(handler);
      return () => listeners.delete(handler);
    },
  };
}

function createMockApi(): VerticalLiveApi {
  const delay = <T>(value: T, ms = 260): Promise<T> =>
    new Promise((resolve) => setTimeout(() => resolve(value), ms));

  return {
    getAppInfo: () =>
      Promise.resolve<AppInfo>({
        name: 'Vertical Live',
        version: '1.1.0',
        electron: 'browser-preview',
        chrome: 'browser-preview',
        node: 'browser-preview',
        platform: 'browser',
        syntheticInput: false,
        dryRun: false,
        isDev: true,
        userDataPath: '',
        logPath: '',
      }),
    getFfmpegInfo: () =>
      Promise.resolve<FfmpegInfo>({
        available: true,
        path: '(preview)',
        version: '8.1.2',
        source: 'dev-resource',
        hasDshow: true,
        hasRtmp: true,
        hasRtmps: true,
        hasLibx264: true,
        error: null,
      }),
    listDevices: () => delay(ok<DeviceList>(MOCK_DEVICES)),
    getDeviceCapabilities: () =>
      Promise.resolve(
        ok({ deviceId: 'mock', modes: [], unknown: true, error: null }),
      ) as Promise<IpcResult<never>> as ReturnType<VerticalLiveApi['getDeviceCapabilities']>,
    detectEncoders: () =>
      Promise.resolve(
        ok<EncoderCapabilities>({
          selected: 'h264_nvenc',
          probes: [
            {
              id: 'h264_nvenc',
              label: 'NVIDIA NVENC',
              listed: true,
              usable: true,
              detail: null,
              hardware: true,
            },
          ],
        }),
      ),
    getSettings: () => Promise.resolve(MOCK_SETTINGS),
    saveSettings: () => Promise.resolve(ok(MOCK_SETTINGS)),
    clearStreamKey: () => Promise.resolve(ok({ ...MOCK_SETTINGS, hasStoredStreamKey: false })),
    chooseRecordingFolder: () =>
      Promise.resolve<ChooseDirectoryResult>({
        canceled: false,
        directory: 'C:\\Users\\user\\Videos\\Vertical Live',
        writable: true,
        error: null,
      }),
    openRecordingFolder: () => Promise.resolve(ok(true)),
    startPreview: () => delay(ok(true)),
    stopPreview: () => Promise.resolve(ok(true)),
    setMeter: () => Promise.resolve(ok(true)),
    startStream: () =>
      delay(
        ok<StartStreamResult>({
          encoder: 'h264_nvenc',
          captureMode: MOCK_STATUS.captureMode!,
          recordingPath: null,
          dryRun: true,
        }),
        500,
      ),
    stopStream: () =>
      delay(
        ok<StopResult>({
          stopped: true,
          recording: MOCK_STATUS.recording,
          exitCode: 0,
          forced: false,
        }),
        500,
      ),
    startRecording: () =>
      delay(
        ok<StartRecordingResult>({
          encoder: 'h264_nvenc',
          captureMode: MOCK_STATUS.captureMode!,
          recordingPath: 'C:\\Users\\user\\Videos\\Vertical Live\\Vertical-Live-preview.mkv',
        }),
        400,
      ),
    stopRecording: () =>
      delay(
        ok<StopResult>({
          stopped: true,
          recording: MOCK_STATUS.recording,
          exitCode: 0,
          forced: false,
        }),
        400,
      ),
    setStreamRecording: () => Promise.resolve(ok(MOCK_STATUS)),
    getStatus: () => Promise.resolve(MOCK_STATUS),
    getSystemMetrics: () =>
      Promise.resolve<SystemMetrics>({
        cpuPercent: 0,
        freeDiskBytes: null,
        totalDiskBytes: null,
      }),
    testConnection: () =>
      Promise.resolve<ConnectionTestResult>({
        reachable: false,
        message: 'Reachability is checked in the desktop app, not the browser preview.',
        target: null,
      }),
    copyDiagnostics: () =>
      Promise.resolve(
        ok<DiagnosticsReport>({ text: '=== Vertical Live diagnostics (browser preview) ===' }),
      ),
    openLogFile: () => Promise.resolve(ok(true)),
    window: {
      minimize: noop,
      toggleMaximize: noop,
      close: noop,
      isMaximized: () => Promise.resolve(false),
      onMaximizedChanged: () => noop,
    },
    update: createMockUpdater(),
    onPreviewFrame: (handler) => createSyntheticPreview(handler),
    onStreamStatus: () => noop,
    onStreamStats: () => noop,
    onStreamError: () => noop,
    onAudioLevel: (handler) => {
      // Browser-preview demo only: a gentle oscillation so the meter visibly
      // moves. The real app derives this from FFmpeg's ebur128 measurements.
      let t = 0;
      const id = setInterval(() => {
        t += 0.12;
        const level = 0.32 + 0.32 * Math.abs(Math.sin(t)) + 0.05 * Math.random();
        handler(Math.min(1, level));
      }, 100);
      return () => clearInterval(id);
    },
  };
}

let mock: VerticalLiveApi | null = null;

/** The real bridge in Electron, else a shared mock instance. */
export function getApi(): VerticalLiveApi {
  if (window.verticalLive) return window.verticalLive;
  if (!mock) mock = createMockApi();
  return mock;
}

/** Reads a query-string flag used only by the dev/demo showcase. */
export function queryFlag(name: string): string | null {
  if (typeof window === 'undefined') return null;
  return new URLSearchParams(window.location.search).get(name);
}
