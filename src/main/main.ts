/**
 * Main-process entry point.
 *
 * Startup order matters:
 *   1. single-instance lock, so two copies cannot fight over the camera
 *   2. logger (everything after this is logged and redacted)
 *   3. reap FFmpeg processes orphaned by a previous abnormal exit
 *   4. settings + encrypted credentials
 *   5. FFmpeg location and capability validation
 *   6. IPC handlers, then the window
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { app, dialog, ipcMain, safeStorage, screen } from 'electron';
import type { BrowserWindow } from 'electron';

import { ENV_DRY_RUN, ENV_SYNTHETIC_INPUT } from '../shared/constants';
import type {
  StreamErrorPayload,
  StreamStats,
  StreamStatus,
  WindowBounds,
} from '../shared/types';
import { isRecoverable } from '../shared/errors';

import { IPC } from './ipc/channels';
import { buildAppInfo, registerIpcHandlers } from './ipc/registerIpcHandlers';
import { Logger, setLogger } from './logging/Logger';
import { redact } from './logging/redact';
import { FfmpegLocator } from './ffmpeg/FfmpegLocator';
import { CredentialStore } from './settings/CredentialStore';
import { SettingsStore } from './settings/SettingsStore';
import { StreamingEngine } from './streaming/StreamingEngine';
import { isStreamActive } from './streaming/StateMachine';
import { UpdateService } from './update/UpdateService';
import {
  createMainWindow,
  resolveIndexHtmlPath,
  resolvePreloadPath,
  sanitiseBounds,
} from './window';

const isDev = !app.isPackaged;

/**
 * `out/` in development (electron-vite output), `<app>/out` when packaged.
 * `app.getAppPath()` points at the asar root in a packaged build, which already
 * contains the `out` directory.
 */
const APP_OUT_DIR = join(app.getAppPath(), 'out');

let mainWindow: BrowserWindow | null = null;
let engine: StreamingEngine | null = null;
let logger: Logger | null = null;
let disposeIpc: (() => void) | null = null;
let settingsStore: SettingsStore | null = null;
let updateService: UpdateService | null = null;
let confirmedQuit = false;
let saveBoundsTimer: NodeJS.Timeout | null = null;

/* -------------------------------------------------------------------- */
/* Single instance                                                       */
/* -------------------------------------------------------------------- */

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });
  void bootstrap();
}

/* -------------------------------------------------------------------- */
/* Bootstrap                                                             */
/* -------------------------------------------------------------------- */

async function bootstrap(): Promise<void> {
  // Chromium's media stack is unused (FFmpeg does all capture); disabling the
  // in-renderer GPU sandbox warning noise keeps startup clean on Windows.
  app.commandLine.appendSwitch('disable-features', 'MediaFoundationVideoCapture');

  await app.whenReady();

  const userDataPath = app.getPath('userData');
  const logDirectory = join(userDataPath, 'logs');

  logger = new Logger({
    directory: logDirectory,
    minLevel: isDev ? 'debug' : 'info',
    echoToConsole: isDev,
  });
  setLogger(logger);

  logger.info('==================================================');
  logger.info(`Vertical Live ${app.getVersion()} starting.`);
  logger.info(
    `Electron ${process.versions.electron ?? '?'} / Chrome ${process.versions.chrome ?? '?'} / Node ${process.versions.node}`,
  );
  logger.info(`Packaged: ${String(app.isPackaged)}  userData: ${userDataPath}`);
  if (process.env[ENV_SYNTHETIC_INPUT] === 'true') {
    logger.warn(
      'Synthetic input mode is ON: FFmpeg will use testsrc2/sine, not real hardware.',
    );
  }
  if (process.env[ENV_DRY_RUN] === 'true') {
    logger.warn('Dry-run mode is ON: the Facebook branch writes to a local file.');
  }

  installProcessGuards();

  /* ---- FFmpeg -------------------------------------------------- */

  const locator = new FfmpegLocator({
    isPackaged: app.isPackaged,
    resourcesPath: process.resourcesPath ?? null,
    appPath: app.getAppPath(),
  });

  const ffmpegInfo = await locator.validate();
  if (ffmpegInfo.available) {
    logger.info(
      `FFmpeg ${ffmpegInfo.version ?? 'unknown'} at ${ffmpegInfo.path} (${ffmpegInfo.source}); ` +
        `rtmps=${String(ffmpegInfo.hasRtmps)} dshow=${String(ffmpegInfo.hasDshow)}`,
    );
    if (!ffmpegInfo.hasRtmps) {
      logger.warn(
        'This FFmpeg build has no rtmps protocol; only rtmp:// destinations will work.',
      );
    }
  } else {
    logger.error(`FFmpeg unavailable: ${ffmpegInfo.error ?? 'unknown reason'}`);
  }

  /* ---- Storage ------------------------------------------------- */

  settingsStore = new SettingsStore({ directory: userDataPath, logger });
  const settings = await settingsStore.load();

  const credentials = new CredentialStore({
    directory: userDataPath,
    logger,
    safeStorage,
  });
  await credentials.load();

  /* ---- Engine -------------------------------------------------- */

  engine = new StreamingEngine({
    locator,
    logger,
    userDataPath,
  });

  const reaped = await engine.reapOrphans();
  if (reaped.length > 0) {
    logger.warn(`Cleaned up ${reaped.length} orphaned FFmpeg process(es) from a previous run.`);
  }

  /* ---- Window -------------------------------------------------- */

  const displayArea = screen.getPrimaryDisplay().workArea;
  const bounds = sanitiseBounds(settings.windowBounds, displayArea);

  const devServerUrl = process.env.ELECTRON_RENDERER_URL ?? null;

  // The real brand icon, resolved for both dev and packaged layouts.
  const iconPath = app.isPackaged
    ? join(process.resourcesPath, 'icon.png')
    : join(app.getAppPath(), 'build', 'icon.png');

  mainWindow = createMainWindow({
    preloadPath: resolvePreloadPath(APP_OUT_DIR),
    devServerUrl,
    indexHtmlPath: resolveIndexHtmlPath(APP_OUT_DIR),
    bounds: bounds.width !== undefined ? (bounds as WindowBounds) : null,
    icon: existsSync(iconPath) ? iconPath : undefined,
  });

  wireEngineEvents(engine, () => mainWindow);
  wireWindowEvents(mainWindow);

  /* ---- Auto-update ---------------------------------------------- */

  updateService = new UpdateService({
    logger,
    isPackaged: app.isPackaged,
    notify: (status) => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send(IPC.updateStatus, status);
      }
    },
    // Before the installer relaunches us, stop any live stream/recording the
    // same graceful way a confirmed quit does, so FFmpeg is never orphaned.
    beforeInstall: async () => {
      confirmedQuit = true;
      try {
        await engine?.shutdown();
      } catch (error) {
        logger?.error(`Shutdown before update install failed: ${redact(error)}`);
      }
    },
  });

  disposeIpc = registerIpcHandlers({
    ipcMain,
    getWindow: () => mainWindow,
    engine,
    settings: settingsStore,
    credentials,
    locator,
    logger,
    update: updateService,
    appInfo: () =>
      buildAppInfo({
        name: 'Vertical Live',
        version: app.getVersion(),
        userDataPath,
        logPath: logger?.path ?? '',
        isDev,
      }),
  });

  // Kick off the background update check (packaged builds only).
  updateService.start();

  // Surface a hard FFmpeg failure as a native dialog: without FFmpeg nothing
  // else in the app can work, and a silent UI would be dishonest.
  if (!ffmpegInfo.available) {
    void dialog.showMessageBox(mainWindow, {
      type: 'error',
      title: 'FFmpeg is missing',
      message: 'Vertical Live cannot start streaming without FFmpeg.',
      detail:
        (ffmpegInfo.error ?? 'FFmpeg was not found.') +
        '\n\nRun "npm run setup:ffmpeg" from the project folder, or reinstall Vertical Live.',
      buttons: ['Continue anyway'],
    });
  }
}

/* -------------------------------------------------------------------- */
/* Event wiring                                                          */
/* -------------------------------------------------------------------- */

function wireEngineEvents(
  active: StreamingEngine,
  getWindow: () => BrowserWindow | null,
): void {
  const send = (channel: string, payload: unknown): void => {
    const window = getWindow();
    if (!window || window.isDestroyed()) return;
    window.webContents.send(channel, payload);
  };

  active.on('status', (status: StreamStatus) => send(IPC.streamStatus, status));
  active.on('stats', (stats: StreamStats) => send(IPC.streamStats, stats));
  active.on('preview-frame', (frame: Buffer) => send(IPC.previewFrame, frame));
  active.on('audio-level', (level: number) => send(IPC.audioLevel, level));
  active.on(
    'error',
    (payload: { code: StreamErrorPayload['code']; message: string; detail: string | null }) => {
      send(IPC.streamError, {
        ...payload,
        recoverable: isRecoverable(payload.code),
        timestamp: Date.now(),
      } satisfies StreamErrorPayload);
    },
  );
}

function wireWindowEvents(window: BrowserWindow): void {
  const persistBounds = (): void => {
    if (!settingsStore || window.isDestroyed() || window.isMinimized()) return;
    const { x, y, width, height } = window.getNormalBounds();
    if (saveBoundsTimer) clearTimeout(saveBoundsTimer);
    saveBoundsTimer = setTimeout(() => {
      void settingsStore?.update({ windowBounds: { x, y, width, height } });
    }, 500);
    saveBoundsTimer.unref?.();
  };

  window.on('resize', persistBounds);
  window.on('move', persistBounds);

  // Keep the custom title-bar maximise/restore glyph in sync with the OS.
  const emitMaximized = (maximized: boolean): void => {
    if (!window.isDestroyed()) window.webContents.send(IPC.windowMaximizedChanged, maximized);
  };
  window.on('maximize', () => emitMaximized(true));
  window.on('unmaximize', () => emitMaximized(false));

  window.on('close', (event) => {
    if (confirmedQuit || !engine) return;
    if (!isStreamActive(engine.getState()) && engine.getState() !== 'finalising-recording') {
      return;
    }

    // A live broadcast (and possibly a recording) is in flight: never let it be
    // torn down without an explicit, informed confirmation.
    event.preventDefault();
    void confirmAndShutdown(window);
  });

  window.on('closed', () => {
    mainWindow = null;
  });
}

async function confirmAndShutdown(window: BrowserWindow): Promise<void> {
  const status = engine?.getStatus();
  const recordingActive = status?.recording.phase === 'recording';

  const { response } = await dialog.showMessageBox(window, {
    type: 'warning',
    title: 'Stop streaming and quit?',
    message: 'Vertical Live is still sending video to Facebook.',
    detail: recordingActive
      ? 'Quitting will stop the stream and finalise the local recording. This may take a few seconds.'
      : 'Quitting will stop the stream. This may take a few seconds.',
    buttons: ['Keep streaming', 'Stop and quit'],
    defaultId: 0,
    cancelId: 0,
    noLink: true,
  });

  if (response !== 1) return;

  confirmedQuit = true;
  logger?.info('User confirmed shutdown while streaming; stopping gracefully.');

  try {
    await engine?.shutdown();
  } catch (error) {
    logger?.error(`Graceful shutdown failed: ${redact(error)}`);
  }

  if (!window.isDestroyed()) window.destroy();
  app.quit();
}

/* -------------------------------------------------------------------- */
/* Process lifecycle                                                     */
/* -------------------------------------------------------------------- */

function installProcessGuards(): void {
  process.on('uncaughtException', (error) => {
    logger?.error(`Uncaught exception: ${redact(error)}`);
  });
  process.on('unhandledRejection', (reason) => {
    logger?.error(`Unhandled rejection: ${redact(reason)}`);
  });
}

app.on('window-all-closed', () => {
  // Windows-only app: quitting with the last window is the expected behaviour.
  app.quit();
});

app.on('before-quit', () => {
  confirmedQuit = true;
});

app.on('will-quit', (event) => {
  if (!engine) return;
  if (!isStreamActive(engine.getState()) && engine.getState() !== 'finalising-recording') {
    return;
  }
  // Last line of defence: never leave an orphaned FFmpeg holding the camera.
  event.preventDefault();
  void engine
    .forceStop()
    .catch(() => undefined)
    .finally(() => {
      engine = null;
      app.quit();
    });
});

app.on('quit', () => {
  updateService?.dispose();
  disposeIpc?.();
  void logger?.dispose();
});
