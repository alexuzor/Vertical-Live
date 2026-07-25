/**
 * The complete IPC channel surface.
 *
 * These names are the only strings the preload bridge is allowed to use. Any
 * channel not listed here does not exist as far as the renderer is concerned.
 */

export const IPC = {
  /* Request / response (invoke) */
  getAppInfo: 'vl:get-app-info',
  getFfmpegInfo: 'vl:get-ffmpeg-info',
  listDevices: 'vl:list-devices',
  getDeviceCapabilities: 'vl:get-device-capabilities',
  detectEncoders: 'vl:detect-encoders',
  getSettings: 'vl:get-settings',
  saveSettings: 'vl:save-settings',
  clearStreamKey: 'vl:clear-stream-key',
  chooseRecordingFolder: 'vl:choose-recording-folder',
  openRecordingFolder: 'vl:open-recording-folder',
  startPreview: 'vl:start-preview',
  stopPreview: 'vl:stop-preview',
  setMeter: 'vl:set-meter',
  startStream: 'vl:start-stream',
  stopStream: 'vl:stop-stream',
  startRecording: 'vl:start-recording',
  stopRecording: 'vl:stop-recording',
  getStatus: 'vl:get-status',
  getSystemMetrics: 'vl:get-system-metrics',
  testConnection: 'vl:test-connection',
  copyDiagnostics: 'vl:copy-diagnostics',
  openLogFile: 'vl:open-log-file',

  /* Auto-update */
  updateGetStatus: 'vl:update-get-status',
  updateCheck: 'vl:update-check',
  updateDownload: 'vl:update-download',
  updateInstall: 'vl:update-install',

  /* Window controls (custom frameless title bar) */
  windowMinimize: 'vl:window-minimize',
  windowToggleMaximize: 'vl:window-toggle-maximize',
  windowClose: 'vl:window-close',
  windowIsMaximized: 'vl:window-is-maximized',

  /* Main -> renderer (send) */
  windowMaximizedChanged: 'vl:window-maximized-changed',
  /** One-time handoff of the dedicated MessagePort that carries preview frames. */
  previewPort: 'vl:preview-port',
  previewFrame: 'vl:preview-frame',
  streamStatus: 'vl:stream-status',
  streamStats: 'vl:stream-stats',
  streamError: 'vl:stream-error',
  audioLevel: 'vl:audio-level',
  updateStatus: 'vl:update-status',
} as const;

export type IpcInvokeChannel = (typeof IPC)[keyof typeof IPC];

/** Channels the renderer may subscribe to. Enforced in the preload bridge. */
export const RENDERER_EVENT_CHANNELS = [
  IPC.previewFrame,
  IPC.streamStatus,
  IPC.streamStats,
  IPC.streamError,
  IPC.audioLevel,
  IPC.windowMaximizedChanged,
  IPC.updateStatus,
] as const;
