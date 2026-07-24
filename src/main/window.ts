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
  bounds: WindowBounds | null;
  /** Window / taskbar icon (the real brand PNG). */
  icon?: string;
  onReadyToShow?: () => void;
}

// The dashboard needs room for two full control columns; the reference design
// is 16:9, so the defaults and floor keep that shape.
export const MIN_WINDOW_WIDTH = 1280;
export const MIN_WINDOW_HEIGHT = 760;
export const DEFAULT_WINDOW_WIDTH = 1648;
export const DEFAULT_WINDOW_HEIGHT = 928;

/**
 * Keeps restored bounds usable: a window saved on a monitor that is no longer
 * attached would otherwise open off-screen.
 */
export function sanitiseBounds(
  bounds: WindowBounds | null,
  displayArea: { x: number; y: number; width: number; height: number } | null,
): Partial<WindowBounds> {
  if (!bounds) return {};

  const width = Math.max(MIN_WINDOW_WIDTH, Math.round(bounds.width));
  const height = Math.max(MIN_WINDOW_HEIGHT, Math.round(bounds.height));

  if (!displayArea) return { width, height };

  const maxX = displayArea.x + displayArea.width;
  const maxY = displayArea.y + displayArea.height;
  const visible = bounds.x < maxX && bounds.y < maxY && bounds.x + width > displayArea.x;

  if (!visible) return { width, height };

  return { x: Math.round(bounds.x), y: Math.round(bounds.y), width, height };
}

export function createMainWindow(options: CreateWindowOptions): BrowserWindow {
  const window = new BrowserWindow({
    // The dashboard is laid out to fit exactly at the default dimensions, but the
    // window can be maximised to fill the desktop. The layout never scrolls at
    // any size (the renderer clips overflow), and the minimum floor stops it from
    // being dragged small enough to hide controls. Maximising needs `resizable`
    // AND `maximizable` on Windows, so both are enabled.
    width: DEFAULT_WINDOW_WIDTH,
    height: DEFAULT_WINDOW_HEIGHT,
    minWidth: MIN_WINDOW_WIDTH,
    minHeight: MIN_WINDOW_HEIGHT,
    ...(options.bounds?.x !== undefined ? { x: options.bounds.x } : {}),
    ...(options.bounds?.y !== undefined ? { y: options.bounds.y } : {}),
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
