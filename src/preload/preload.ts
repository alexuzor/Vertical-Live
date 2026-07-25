/**
 * The security boundary.
 *
 * This script runs sandboxed (`sandbox: true`, `contextIsolation: true`,
 * `nodeIntegration: false`) and exposes exactly one frozen object to the page.
 *
 * The renderer therefore gets:
 *   - no `require`, no `process`, no `Buffer`, no `fs`, no `child_process`
 *   - no `ipcRenderer`, so it cannot reach a channel that is not listed below
 *   - no way to name a channel: every method hard-codes its own channel
 */

import { contextBridge, ipcRenderer } from 'electron';
import type { IpcRendererEvent } from 'electron';

import { IPC } from '../main/ipc/channels';
import type {
  AppInfo,
  ChooseDirectoryResult,
  ConnectionTestResult,
  DeviceCapabilities,
  DeviceList,
  DiagnosticsReport,
  EncoderCapabilities,
  FfmpegInfo,
  IpcResult,
  PreviewConfig,
  RecordingConfig,
  SaveSettingsRequest,
  SettingsSnapshot,
  StartRecordingResult,
  StartStreamRequest,
  StartStreamResult,
  StopResult,
  StreamErrorPayload,
  StreamStats,
  StreamStatus,
  SystemMetrics,
  Unsubscribe,
  UpdateStatus,
  VerticalLiveApi,
} from '../shared/types';

/** Subscribes to a main-process event and returns an unsubscribe function. */
function subscribe<T>(channel: string, handler: (payload: T) => void): Unsubscribe {
  const listener = (_event: IpcRendererEvent, payload: T): void => {
    handler(payload);
  };
  ipcRenderer.on(channel, listener);
  return () => {
    ipcRenderer.removeListener(channel, listener);
  };
}

/*
 * Dedicated preview-frame transport.
 *
 * The main process hands over one end of a MessageChannel (once per page load).
 * Preview JPEGs arrive here as transferred ArrayBuffers — off the ordinary IPC
 * channel, so they never contend with commands/status — and are relayed to the
 * single registered frame handler in the page (the canvas renderer). Frames are
 * never queued here: the handler keeps only the newest.
 */
// Structural shape of the renderer MessagePort, so this file (compiled without
// the DOM lib) need not name the DOM `MessagePort`/`MessageEvent` types.
interface PreviewPort {
  start(): void;
  close(): void;
  onmessage: ((event: { data: ArrayBuffer }) => void) | null;
}

let previewPort: PreviewPort | null = null;
let previewFrameHandler: ((frame: Uint8Array) => void) | null = null;

ipcRenderer.on(IPC.previewPort, (event: IpcRendererEvent) => {
  previewPort?.close();
  previewPort = (event.ports[0] as PreviewPort | undefined) ?? null;
  if (!previewPort) return;
  previewPort.onmessage = (message) => {
    previewFrameHandler?.(new Uint8Array(message.data));
  };
  previewPort.start();
});

const api: VerticalLiveApi = {
  getAppInfo: () => ipcRenderer.invoke(IPC.getAppInfo) as Promise<AppInfo>,

  getFfmpegInfo: () => ipcRenderer.invoke(IPC.getFfmpegInfo) as Promise<FfmpegInfo>,

  listDevices: (refresh?: boolean) =>
    ipcRenderer.invoke(IPC.listDevices, { refresh: refresh === true }) as Promise<
      IpcResult<DeviceList>
    >,

  getDeviceCapabilities: (deviceId: string) =>
    ipcRenderer.invoke(IPC.getDeviceCapabilities, { deviceId }) as Promise<
      IpcResult<DeviceCapabilities>
    >,

  detectEncoders: (force?: boolean) =>
    ipcRenderer.invoke(IPC.detectEncoders, { force: force === true }) as Promise<
      IpcResult<EncoderCapabilities>
    >,

  getSettings: () => ipcRenderer.invoke(IPC.getSettings) as Promise<SettingsSnapshot>,

  saveSettings: (request: SaveSettingsRequest) =>
    ipcRenderer.invoke(IPC.saveSettings, request) as Promise<IpcResult<SettingsSnapshot>>,

  clearStreamKey: () =>
    ipcRenderer.invoke(IPC.clearStreamKey) as Promise<IpcResult<SettingsSnapshot>>,

  chooseRecordingFolder: () =>
    ipcRenderer.invoke(IPC.chooseRecordingFolder) as Promise<ChooseDirectoryResult>,

  openRecordingFolder: (path: string) =>
    ipcRenderer.invoke(IPC.openRecordingFolder, { path }) as Promise<IpcResult<boolean>>,

  startPreview: (config: PreviewConfig) =>
    ipcRenderer.invoke(IPC.startPreview, config) as Promise<IpcResult<boolean>>,

  stopPreview: () => ipcRenderer.invoke(IPC.stopPreview) as Promise<IpcResult<boolean>>,

  setMeter: (microphoneDevice: string | null) =>
    ipcRenderer.invoke(IPC.setMeter, { microphoneDevice }) as Promise<IpcResult<boolean>>,

  startStream: (config: StartStreamRequest) =>
    ipcRenderer.invoke(IPC.startStream, config) as Promise<IpcResult<StartStreamResult>>,

  stopStream: () => ipcRenderer.invoke(IPC.stopStream) as Promise<IpcResult<StopResult>>,

  startRecording: (config: RecordingConfig) =>
    ipcRenderer.invoke(IPC.startRecording, config) as Promise<IpcResult<StartRecordingResult>>,

  stopRecording: () => ipcRenderer.invoke(IPC.stopRecording) as Promise<IpcResult<StopResult>>,

  setStreamRecording: (on: boolean) =>
    ipcRenderer.invoke(IPC.setStreamRecording, { on }) as Promise<IpcResult<StreamStatus>>,

  getStatus: () => ipcRenderer.invoke(IPC.getStatus) as Promise<StreamStatus>,

  getSystemMetrics: (recordingDirectory?: string | null) =>
    ipcRenderer.invoke(IPC.getSystemMetrics, {
      recordingDirectory: recordingDirectory ?? null,
    }) as Promise<SystemMetrics>,

  testConnection: (facebookServerUrl: string) =>
    ipcRenderer.invoke(IPC.testConnection, {
      facebookServerUrl,
    }) as Promise<ConnectionTestResult>,

  openLogFile: () => ipcRenderer.invoke(IPC.openLogFile) as Promise<IpcResult<boolean>>,

  copyDiagnostics: () =>
    ipcRenderer.invoke(IPC.copyDiagnostics) as Promise<IpcResult<DiagnosticsReport>>,

  window: {
    minimize: () => ipcRenderer.send(IPC.windowMinimize),
    toggleMaximize: () => ipcRenderer.send(IPC.windowToggleMaximize),
    close: () => ipcRenderer.send(IPC.windowClose),
    isMaximized: () => ipcRenderer.invoke(IPC.windowIsMaximized) as Promise<boolean>,
    onMaximizedChanged: (handler) => subscribe<boolean>(IPC.windowMaximizedChanged, handler),
  },

  update: {
    getStatus: () => ipcRenderer.invoke(IPC.updateGetStatus) as Promise<UpdateStatus>,
    check: () => ipcRenderer.invoke(IPC.updateCheck) as Promise<IpcResult<UpdateStatus>>,
    download: () => ipcRenderer.invoke(IPC.updateDownload) as Promise<IpcResult<UpdateStatus>>,
    install: () => ipcRenderer.send(IPC.updateInstall),
    onStatus: (handler) => subscribe<UpdateStatus>(IPC.updateStatus, handler),
  },

  onPreviewFrame: (handler) => {
    // A single consumer (the canvas renderer). Frames flow over the MessagePort,
    // not this call, so registering just points the relay at the handler.
    previewFrameHandler = handler;
    return () => {
      if (previewFrameHandler === handler) previewFrameHandler = null;
    };
  },
  onStreamStatus: (handler) => subscribe<StreamStatus>(IPC.streamStatus, handler),
  onStreamStats: (handler) => subscribe<StreamStats>(IPC.streamStats, handler),
  onStreamError: (handler) => subscribe<StreamErrorPayload>(IPC.streamError, handler),
  onAudioLevel: (handler) => subscribe<number>(IPC.audioLevel, handler),
};

contextBridge.exposeInMainWorld('verticalLive', Object.freeze(api));
