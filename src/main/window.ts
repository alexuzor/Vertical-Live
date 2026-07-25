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
  /** Persisted bounds from a previous session, or null on first launch. */
  savedBounds: WindowBounds | null;
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

/** Minimum on-screen slice, in px, that keeps a window grabbable. */
const MIN_VISIBLE_PX = 96;

/**
 * A saved position is honoured only when the window would stay substantially
 * on-screen: enough horizontal overlap to grab it, and a title bar that is
 * neither above the work area nor below its bottom edge. This is what rejects a
 * rectangle saved on a monitor that is no longer attached.
 */
function isPositionVisible(bounds: WindowBounds, width: number, work: WorkArea): boolean {
  const overlapsHorizontally =
    bounds.x + width - MIN_VISIBLE_PX > work.x &&
    bounds.x + MIN_VISIBLE_PX < work.x + work.width;
  const titleBarOnScreen =
    bounds.y >= work.y && bounds.y <= work.y + work.height - MIN_VISIBLE_PX;
  return overlapsHorizontally && titleBarOnScreen;
}

/**
 * The window's initial size and position.
 *
 * Uses the saved bounds when they are still valid and visible; otherwise the
 * default size centred on the work area. Size is always clamped to the work
 * area (never below the minimum), so a small display — or a stale rectangle from
 * a disconnected second monitor — can never open the window oversized or
 * off-screen. Pure and side-effect free, so it is unit-tested directly.
 */
export function computeInitialBounds(saved: WindowBounds | null, work: WorkArea): WindowBounds {
  const width = Math.min(
    work.width,
    Math.max(MIN_WINDOW_WIDTH, Math.round(saved?.width ?? DEFAULT_WINDOW_WIDTH)),
  );
  const height = Math.min(
    work.height,
    Math.max(MIN_WINDOW_HEIGHT, Math.round(saved?.height ?? DEFAULT_WINDOW_HEIGHT)),
  );

  if (saved && isPositionVisible(saved, width, work)) {
    return { x: Math.round(saved.x), y: Math.round(saved.y), width, height };
  }

  // Centre on the work area.
  return {
    x: Math.round(work.x + (work.width - width) / 2),
    y: Math.round(work.y + (work.height - height) / 2),
    width,
    height,
  };
}

export function createMainWindow(options: CreateWindowOptions): BrowserWindow {
  // Restore to a valid on-screen rectangle (or the centred default). Explicit
  // x/y/width/height — never a bare `center: true` — so restore is deterministic
  // and testable, and maximising still fills the desktop normally.
  const bounds = computeInitialBounds(options.savedBounds, options.workArea);

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
