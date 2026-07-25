/**
 * Browser window creation and hardening.
 *
 * Security posture:
 *   nodeIntegration:        false
 *   contextIsolation:       true
 *   sandbox:                true
 *   webSecurity:            true
 *   webviewTag:             false
 *   navigation:             blocked except the app's own origin
 *   new windows:            always denied, external links open in the OS browser
 *   permission requests:    denied by default (the app needs no web APIs)
 */

import { join } from 'node:path';

import { BrowserWindow, shell } from 'electron';

import type { WindowBounds } from '../shared/types';

export interface CreateWindowOptions {
  preloadPath: string;
  /** Vite dev-server URL in development, else null. */
  devServerUrl: string | null;
  /** Absolute path to the built index.html in production. */
  indexHtmlPath: string;
  /** Usable area of the display to open on (for centring and clamping). */
  workArea: WorkArea;
  /** Window / taskbar icon (the real brand PNG). */
  icon?: string;
  onReadyToShow?: () => void;
}

// The restored window opens at ~1230x830, centred; the renderer scales its fixed
// design to fit, so a smaller window (or display) simply shows a smaller
// dashboard. The floor stays below the restore size so the restore size is
// always achievable, even on modest laptops.
export const DEFAULT_WINDOW_WIDTH = 1230;
export const DEFAULT_WINDOW_HEIGHT = 830;
export const MIN_WINDOW_WIDTH = 1000;
export const MIN_WINDOW_HEIGHT = 680;

/** A display's usable area (excludes the taskbar), from `Display.workArea`. */
export interface WorkArea {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * The window's initial size and position: always the 1230x830 default, centred
 * on the work area.
 *
 * The default is honoured over any previously saved bounds — the window never
 * restores a resized or maximised size, so it opens at exactly 1230x830 every
 * time. The size is clamped down to the work area on a small display (never below
 * the minimum floor), so it can never open oversized or off-screen. Pure and
 * side-effect free, so it is unit-tested directly.
 */
export function computeInitialBounds(work: WorkArea): WindowBounds {
  const width = Math.max(MIN_WINDOW_WIDTH, Math.min(DEFAULT_WINDOW_WIDTH, work.width));
  const height = Math.max(MIN_WINDOW_HEIGHT, Math.min(DEFAULT_WINDOW_HEIGHT, work.height));

  return {
    x: Math.round(work.x + (work.width - width) / 2),
    y: Math.round(work.y + (work.height - height) / 2),
    width,
    height,
  };
}

export function createMainWindow(options: CreateWindowOptions): BrowserWindow {
  // Always the centred 1230x830 default (never a restored size). Explicit
  // x/y/width/height — not a bare `center: true` — so it is deterministic and
  // testable, and maximising still fills the desktop normally.
  const bounds = computeInitialBounds(options.workArea);

  const window = new BrowserWindow({
    // The renderer scales its fixed design to fit the window, so any size from the
    // minimum floor up works; maximising fills the desktop. Maximising needs
    // `resizable` AND `maximizable` on Windows, so both are enabled.
    x: bounds.x,
    y: bounds.y,
    width: bounds.width,
    height: bounds.height,
    minWidth: MIN_WINDOW_WIDTH,
    minHeight: MIN_WINDOW_HEIGHT,
    resizable: true,
    maximizable: true,
    fullscreenable: true,
    show: false,
    backgroundColor: '#060b10',
    title: 'Vertical Live',
    autoHideMenuBar: true,
    // Frameless: the renderer draws its own title bar (logo, activity pills and
    // minimise / maximise / close), which is what the reference design shows.
    frame: false,
    ...(options.icon ? { icon: options.icon } : {}),
    webPreferences: {
      preload: options.preloadPath,
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      experimentalFeatures: false,
      webviewTag: false,
      spellcheck: false,
    },
  });

  window.once('ready-to-show', () => {
    window.show();
    options.onReadyToShow?.();
  });

  // The app never needs camera, microphone, geolocation or notifications in the
  // renderer -- all capture happens in FFmpeg -- so deny every request.
  window.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => {
    callback(false);
  });
  window.webContents.session.setPermissionCheckHandler(() => false);

  // Block navigation away from the app's own document.
  window.webContents.on('will-navigate', (event, url) => {
    const allowed = options.devServerUrl
      ? url.startsWith(options.devServerUrl)
      : url.startsWith('file://');
    if (!allowed) {
      event.preventDefault();
      void shell.openExternal(url);
    }
  });

  // Never let the page open a second Electron window.
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });

  // Refuse to attach a preload to any child webContents.
  window.webContents.on('will-attach-webview', (event) => {
    event.preventDefault();
  });

  if (options.devServerUrl) {
    void window.loadURL(options.devServerUrl);
  } else {
    void window.loadFile(options.indexHtmlPath);
  }

  return window;
}

/** Resolves the preload script path for both dev and packaged builds. */
export function resolvePreloadPath(appOutDir: string): string {
  return join(appOutDir, 'preload', 'preload.js');
}

/** Resolves the built renderer entry point. */
export function resolveIndexHtmlPath(appOutDir: string): string {
  return join(appOutDir, 'renderer', 'index.html');
}
