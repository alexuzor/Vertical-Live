/**
 * Every IPC handler in the application.
 *
 * Security rules enforced here:
 *  - every payload is parsed with a Zod schema before it is used
 *  - every handler returns a discriminated `IpcResult`, never a raw throw, so a
 *    stack trace can never cross the bridge
 *  - the stream key is read from the main-process CredentialStore, so the
 *    renderer never has to hold or re-send it once it has been saved
 *  - all outbound text is redacted
 */

import { statfs } from 'node:fs/promises';
import { connect as netConnect } from 'node:net';

import { app, dialog, shell } from 'electron';
import type { BrowserWindow, IpcMain } from 'electron';

import { ENV_DRY_RUN, ENV_SYNTHETIC_INPUT } from '../../shared/constants';
import { ERROR_MESSAGES, VerticalLiveError, isRecoverable } from '../../shared/errors';
import type { ErrorCode } from '../../shared/errors';
import {
  deviceCapabilitiesRequestSchema,
  detectEncodersRequestSchema,
  listDevicesRequestSchema,
  meterConfigSchema,
  openFolderRequestSchema,
  previewConfigSchema,
  recordingConfigSchema,
  saveSettingsRequestSchema,
  streamConfigSchema,
  systemMetricsRequestSchema,
  testConnectionRequestSchema,
  validatedStreamConfigSchema,
} from '../../shared/schemas';
import type {
  AppInfo,
  ChooseDirectoryResult,
  ConnectionTestResult,
  DiagnosticsReport,
  FfmpegInfo,
  IpcResult,
  SettingsSnapshot,
  StreamErrorPayload,
  SystemMetrics,
} from '../../shared/types';
import type { FfmpegLocator } from '../ffmpeg/FfmpegLocator';
import type { Logger } from '../logging/Logger';
import { redact } from '../logging/redact';
import type { CredentialStore } from '../settings/CredentialStore';
import type { SettingsStore } from '../settings/SettingsStore';
import { ensureWritableDirectory } from '../streaming/RecordingFinalizer';
import { isConfigurationLocked } from '../streaming/StateMachine';
import type { StreamingEngine } from '../streaming/StreamingEngine';
import type { UpdateService } from '../update/UpdateService';

import { IPC } from './channels';

export interface IpcContext {
  ipcMain: IpcMain;
  getWindow: () => BrowserWindow | null;
  engine: StreamingEngine;
  settings: SettingsStore;
  credentials: CredentialStore;
  locator: FfmpegLocator;
  logger: Logger;
  update: UpdateService;
  appInfo: () => AppInfo;
}

function toErrorPayload(
  error: unknown,
  fallback: ErrorCode = 'internal-error',
): StreamErrorPayload {
  if (error instanceof VerticalLiveError) {
    return {
      code: error.code,
      message: error.message,
      detail: error.detail ? redact(error.detail) : null,
      recoverable: error.recoverable,
      timestamp: Date.now(),
    };
  }

  return {
    code: fallback,
    message: ERROR_MESSAGES[fallback],
    detail: redact(error),
    recoverable: isRecoverable(fallback),
    timestamp: Date.now(),
  };
}

function ok<T>(value: T): IpcResult<T> {
  return { ok: true, value };
}

/**
 * Wraps a handler so a validation failure or an unexpected throw always becomes
 * a structured, redacted result rather than an unhandled rejection.
 */
function guard<TArgs extends unknown[], TValue>(
  logger: Logger,
  label: string,
  handler: (...args: TArgs) => Promise<TValue>,
): (...args: TArgs) => Promise<IpcResult<TValue>> {
  return async (...args: TArgs) => {
    try {
      return ok(await handler(...args));
    } catch (error) {
      const payload = toErrorPayload(error);
      logger.error(`IPC ${label} failed: ${payload.code} ${payload.detail ?? payload.message}`);
      return { ok: false, error: payload };
    }
  };
}

export function registerIpcHandlers(context: IpcContext): () => void {
  const { ipcMain, engine, settings, credentials, locator, logger, update } = context;

  const snapshot = async (): Promise<SettingsSnapshot> => ({
    settings: await settings.load(),
    hasStoredStreamKey: credentials.hasKey,
    encryptionAvailable: credentials.canEncrypt,
    streamKeySessionOnly: credentials.isSessionOnly,
  });

  /* ---------------- Environment ---------------- */

  ipcMain.handle(IPC.getAppInfo, (): AppInfo => context.appInfo());

  ipcMain.handle(IPC.getFfmpegInfo, async (): Promise<FfmpegInfo> => locator.validate());

  /* ---------------- Devices -------------------- */

  ipcMain.handle(
    IPC.listDevices,
    guard(logger, 'listDevices', async (_event, payload: unknown) => {
      const { refresh } = listDevicesRequestSchema.parse(payload ?? {});
      return engine.discoverDevices(refresh ?? false);
    }),
  );

  ipcMain.handle(
    IPC.getDeviceCapabilities,
    guard(logger, 'getDeviceCapabilities', async (_event, payload: unknown) => {
      const { deviceId } = deviceCapabilitiesRequestSchema.parse(payload);
      return engine.getDeviceCapabilities(deviceId);
    }),
  );

  ipcMain.handle(
    IPC.detectEncoders,
    guard(logger, 'detectEncoders', async (_event, payload: unknown) => {
      const { force } = detectEncodersRequestSchema.parse(payload ?? {});
      return engine.detectEncoders(force ?? false);
    }),
  );

  /* ---------------- Settings ------------------- */

  ipcMain.handle(IPC.getSettings, async (): Promise<SettingsSnapshot> => snapshot());

  ipcMain.handle(
    IPC.saveSettings,
    guard(logger, 'saveSettings', async (_event, payload: unknown) => {
      const request = saveSettingsRequestSchema.parse(payload);

      // Settings must not change underneath a running stream or recording.
      if (isConfigurationLocked(engine.getState())) {
        throw new VerticalLiveError(
          'invalid-state-transition',
          'Settings cannot be changed while a stream or recording is active.',
        );
      }

      const updated = await settings.update(request.settings);

      if (Object.prototype.hasOwnProperty.call(request, 'streamKey')) {
        await credentials.setKey(request.streamKey ?? null, updated.rememberStreamKey);
      } else if (!updated.rememberStreamKey && credentials.hasKey) {
        // The user turned "remember" off: drop the stored copy immediately but
        // keep the key usable for the rest of this session.
        await credentials.setKey(credentials.getKey(), false);
      }

      return snapshot();
    }),
  );

  ipcMain.handle(
    IPC.clearStreamKey,
    guard(logger, 'clearStreamKey', async () => {
      await credentials.clear();
      return snapshot();
    }),
  );

  /* ---------------- Recording folder ----------- */

  ipcMain.handle(IPC.chooseRecordingFolder, async (): Promise<ChooseDirectoryResult> => {
    const window = context.getWindow();
    const result = window
      ? await dialog.showOpenDialog(window, {
          title: 'Choose a folder for recordings',
          properties: ['openDirectory', 'createDirectory'],
        })
      : await dialog.showOpenDialog({
          title: 'Choose a folder for recordings',
          properties: ['openDirectory', 'createDirectory'],
        });

    if (result.canceled || result.filePaths.length === 0) {
      return { canceled: true, directory: null, writable: false, error: null };
    }

    const directory = result.filePaths[0] as string;
    try {
      await ensureWritableDirectory(directory);
      await settings.update({ recordingDirectory: directory });
      return { canceled: false, directory, writable: true, error: null };
    } catch (error) {
      return {
        canceled: false,
        directory,
        writable: false,
        error: toErrorPayload(error).detail ?? ERROR_MESSAGES['recording-path-unwritable'],
      };
    }
  });

  ipcMain.handle(
    IPC.openRecordingFolder,
    guard(logger, 'openRecordingFolder', async (_event, payload: unknown) => {
      const { path } = openFolderRequestSchema.parse(payload);
      // `showItemInFolder` opens the containing folder and highlights the file;
      // it is safe for a path the user themselves chose.
      shell.showItemInFolder(path);
      return true;
    }),
  );

  /* ---------------- Preview -------------------- */

  ipcMain.handle(
    IPC.startPreview,
    guard(logger, 'startPreview', async (_event, payload: unknown) => {
      const config = previewConfigSchema.parse(payload);
      await engine.startPreview(config);
      return true;
    }),
  );

  ipcMain.handle(
    IPC.stopPreview,
    guard(logger, 'stopPreview', async () => {
      await engine.stopPreview();
      return true;
    }),
  );

  // The audio meter is a separate process, so switching the mic or toggling
  // monitoring here never restarts the camera preview.
  ipcMain.handle(
    IPC.setMeter,
    guard(logger, 'setMeter', async (_event, payload: unknown) => {
      const { microphoneDevice } = meterConfigSchema.parse(payload);
      await engine.setMeter(microphoneDevice);
      return true;
    }),
  );

  /* ---------------- Streaming ------------------ */

  ipcMain.handle(
    IPC.startStream,
    guard(logger, 'startStream', async (_event, payload: unknown) => {
      // Parse the shape first, then fill in the key from secure storage when the
      // renderer sent a placeholder rather than the real value.
      const partial = streamConfigSchema
        .omit({ facebookStreamKey: true })
        .extend({ facebookStreamKey: streamConfigSchema.shape.facebookStreamKey.optional() })
        .parse(payload);

      const storedKey = credentials.getKey();
      const key = partial.facebookStreamKey ?? storedKey;

      if (!key) {
        throw new VerticalLiveError(
          'invalid-stream-key',
          'No stream key was supplied and none is stored.',
        );
      }

      const config = validatedStreamConfigSchema.parse({ ...partial, facebookStreamKey: key });
      return engine.start(config);
    }),
  );

  ipcMain.handle(
    IPC.stopStream,
    guard(logger, 'stopStream', async () => engine.stop()),
  );

  /* ---------------- Recording (no stream) ------ */

  ipcMain.handle(
    IPC.startRecording,
    guard(logger, 'startRecording', async (_event, payload: unknown) => {
      const config = recordingConfigSchema.parse(payload);
      return engine.startRecording(config);
    }),
  );

  ipcMain.handle(
    IPC.stopRecording,
    guard(logger, 'stopRecording', async () => engine.stopRecording()),
  );

  ipcMain.handle(IPC.getStatus, () => engine.getStatus());

  /* ---------------- Host metrics --------------- */

  ipcMain.handle(
    IPC.getSystemMetrics,
    async (_event, payload: unknown): Promise<SystemMetrics> => {
      let recordingDirectory: string | null = null;
      try {
        recordingDirectory =
          systemMetricsRequestSchema.parse(payload ?? {}).recordingDirectory ?? null;
      } catch {
        recordingDirectory = null;
      }
      return collectSystemMetrics(recordingDirectory);
    },
  );

  ipcMain.handle(
    IPC.testConnection,
    async (_event, payload: unknown): Promise<ConnectionTestResult> => {
      try {
        const { facebookServerUrl } = testConnectionRequestSchema.parse(payload);
        return await probeReachability(facebookServerUrl);
      } catch (error) {
        logger.warn(`testConnection rejected: ${redact(error)}`);
        return {
          reachable: false,
          message: 'Enter a valid rtmps:// or rtmp:// server URL first.',
          target: null,
        };
      }
    },
  );

  /* ---------------- Diagnostics ---------------- */

  ipcMain.handle(
    IPC.copyDiagnostics,
    guard(logger, 'copyDiagnostics', async (): Promise<DiagnosticsReport> => {
      const info = context.appInfo();
      const ffmpeg = await locator.validate();
      const encoders = await engine.detectEncoders().catch(() => null);
      const status = engine.getStatus();
      const stored = await settings.load();

      const lines: string[] = [
        '=== Vertical Live diagnostics ===',
        `Generated:        ${new Date().toISOString()}`,
        `App version:      ${info.version}`,
        `Electron:         ${info.electron}`,
        `Chrome:           ${info.chrome}`,
        `Node:             ${info.node}`,
        `Platform:         ${info.platform}`,
        `Synthetic input:  ${String(info.syntheticInput)}`,
        `Dry run:          ${String(info.dryRun)}`,
        '',
        '--- FFmpeg ---',
        `Available:        ${String(ffmpeg.available)}`,
        `Path:             ${ffmpeg.path ?? 'not found'}`,
        `Version:          ${ffmpeg.version ?? 'unknown'}`,
        `Resolved from:    ${ffmpeg.source}`,
        `dshow / rtmp / rtmps / libx264: ${String(ffmpeg.hasDshow)} / ${String(ffmpeg.hasRtmp)} / ${String(ffmpeg.hasRtmps)} / ${String(ffmpeg.hasLibx264)}`,
        ffmpeg.error ? `Error:            ${ffmpeg.error}` : '',
        '',
        '--- Encoders ---',
        ...(encoders
          ? encoders.probes.map(
              (probe) =>
                `${probe.id.padEnd(12)} listed=${String(probe.listed)} usable=${String(probe.usable)}` +
                (probe.detail ? ` (${probe.detail})` : ''),
            )
          : ['encoder detection did not complete']),
        `Selected:         ${encoders?.selected ?? 'none'}`,
        '',
        '--- Current state ---',
        `State:            ${status.state}`,
        `Phase:            ${status.phase}`,
        `Encoder in use:   ${status.encoder ?? 'none'}`,
        `Fallback applied: ${String(status.encoderFallbackApplied)}`,
        `Capture mode:     ${
          status.captureMode
            ? `${status.captureMode.width ?? 'auto'}x${status.captureMode.height ?? 'auto'} @ ${status.captureMode.fps ?? 'auto'}fps`
            : 'none'
        }`,
        `Recording phase:  ${status.recording.phase}`,
        '',
        '--- Settings (non-sensitive) ---',
        `Camera:           ${stored.cameraDevice ?? 'none'}`,
        `Microphone:       ${stored.microphoneDevice ?? 'none'}`,
        `Audio enabled:    ${String(stored.audioEnabled)}`,
        `Noise reduction:  ${stored.noiseSuppression ? 'on' : 'off'}`,
        `Framing:          ${stored.framingMode}`,
        `FPS:              ${String(stored.fps)}`,
        `Bitrate preset:   ${stored.bitratePreset} (${String(stored.customBitrateKbps)} kbps)`,
        `Server URL:       ${stored.facebookServerUrl}`,
        `Stream key:       ${credentials.hasKey ? 'stored (encrypted, not shown)' : 'not set'}`,
        `Recording:        ${String(stored.recordingEnabled)} -> ${stored.recordingDirectory ?? 'no folder'}`,
        '',
        '--- Recent log ---',
        ...logger.recentLines().slice(-120),
      ];

      // Belt and braces: the whole report goes through redaction one more time.
      return { text: redact(lines.filter((line) => line !== '').join('\n')) };
    }),
  );

  ipcMain.handle(
    IPC.openLogFile,
    guard(logger, 'openLogFile', async () => {
      if (!logger.path) {
        throw new VerticalLiveError('internal-error', 'No log file is available yet.');
      }
      const error = await shell.openPath(logger.path);
      if (error) throw new VerticalLiveError('internal-error', error);
      return true;
    }),
  );

  /* ---------------- Auto-update ---------------- */

  ipcMain.handle(IPC.updateGetStatus, () => update.getStatus());

  ipcMain.handle(
    IPC.updateCheck,
    guard(logger, 'updateCheck', async () => update.check()),
  );

  ipcMain.handle(
    IPC.updateDownload,
    guard(logger, 'updateDownload', async () => update.download()),
  );

  // Install quits the app, so it is a fire-and-forget send like the window
  // controls rather than an invoke that expects a reply.
  ipcMain.on(IPC.updateInstall, () => update.install());

  /* ---------------- Window controls ------------ */

  const withWindow = (action: (window: BrowserWindow) => void): void => {
    const window = context.getWindow();
    if (window && !window.isDestroyed()) action(window);
  };

  ipcMain.on(IPC.windowMinimize, () => withWindow((window) => window.minimize()));
  ipcMain.on(IPC.windowClose, () => withWindow((window) => window.close()));
  ipcMain.on(IPC.windowToggleMaximize, () =>
    withWindow((window) => {
      if (window.isMaximized()) window.unmaximize();
      else window.maximize();
    }),
  );
  ipcMain.handle(IPC.windowIsMaximized, () => context.getWindow()?.isMaximized() ?? false);

  /* ---------------- Teardown ------------------- */

  const channels = Object.values(IPC);
  const sendChannels = [
    IPC.windowMinimize,
    IPC.windowClose,
    IPC.windowToggleMaximize,
    IPC.updateInstall,
  ];
  return () => {
    for (const channel of channels) {
      ipcMain.removeHandler(channel);
    }
    for (const channel of sendChannels) {
      ipcMain.removeAllListeners(channel);
    }
  };
}

/**
 * Samples real host metrics for the footer. CPU is the app's own aggregate
 * usage (the encode load the user cares about); disk is the free/total space on
 * the volume that holds the recording folder. Never throws — a missing folder
 * or an unsupported platform simply yields nulls.
 */
async function collectSystemMetrics(recordingDirectory: string | null): Promise<SystemMetrics> {
  let cpuPercent = 0;
  try {
    const total = app
      .getAppMetrics()
      .reduce((sum, metric) => sum + (metric.cpu?.percentCPUUsage ?? 0), 0);
    cpuPercent = Math.max(0, Math.min(100, Math.round(total)));
  } catch {
    cpuPercent = 0;
  }

  let freeDiskBytes: number | null = null;
  let totalDiskBytes: number | null = null;
  if (recordingDirectory) {
    try {
      const stats = await statfs(recordingDirectory);
      freeDiskBytes = stats.bavail * stats.bsize;
      totalDiskBytes = stats.blocks * stats.bsize;
    } catch {
      freeDiskBytes = null;
      totalDiskBytes = null;
    }
  }

  return { cpuPercent, freeDiskBytes, totalDiskBytes };
}

/**
 * Opens a plain TCP connection to the ingest host:port. This proves the
 * endpoint is reachable from this machine (DNS + routing + port open) without
 * performing a full RTMP handshake or sending any credentials.
 */
function probeReachability(serverUrl: string): Promise<ConnectionTestResult> {
  const secure = /^rtmps:/i.test(serverUrl);
  const probe = new URL(serverUrl.replace(/^rtmps?:/i, 'https:'));
  const host = probe.hostname;
  const port = probe.port ? Number(probe.port) : secure ? 443 : 1935;
  const target = `${host}:${String(port)}`;

  return new Promise<ConnectionTestResult>((resolve) => {
    const socket = netConnect({ host, port });
    let settled = false;
    const finish = (result: ConnectionTestResult): void => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(result);
    };

    socket.setTimeout(5000);
    socket.once('connect', () =>
      finish({
        reachable: true,
        message: `Reachable — ${target} accepted a connection.`,
        target,
      }),
    );
    socket.once('timeout', () =>
      finish({ reachable: false, message: `Timed out reaching ${target}.`, target }),
    );
    socket.once('error', (error) =>
      finish({
        reachable: false,
        message: `Could not reach ${target}: ${redact(error.message)}`,
        target,
      }),
    );
  });
}

/** Builds the static application information payload. */
export function buildAppInfo(params: {
  name: string;
  version: string;
  userDataPath: string;
  logPath: string;
  isDev: boolean;
  env?: NodeJS.ProcessEnv;
}): AppInfo {
  const env = params.env ?? process.env;
  return {
    name: params.name,
    version: params.version,
    electron: process.versions.electron ?? 'unknown',
    chrome: process.versions.chrome ?? 'unknown',
    node: process.versions.node,
    platform: `${process.platform} ${process.arch}`,
    syntheticInput: env[ENV_SYNTHETIC_INPUT] === 'true',
    dryRun: env[ENV_DRY_RUN] === 'true',
    isDev: params.isDev,
    userDataPath: params.userDataPath,
    logPath: params.logPath,
  };
}
