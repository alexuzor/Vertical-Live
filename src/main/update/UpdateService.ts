/**
 * Auto-update, backed by electron-updater and the GitHub Releases feed declared
 * in electron-builder.yml (`publish: github`).
 *
 * Policy:
 *   - Downloads never start on their own. `autoDownload` is off, so a found
 *     update sits in `available` until the user opts in from the banner. This
 *     keeps the app from spending someone's bandwidth mid-broadcast.
 *   - A downloaded update installs when the app next quits (`autoInstallOnApp
 *     Quit`), or immediately when the user clicks "Restart now" (`install()`).
 *   - The whole thing is inert unless the app is packaged: electron-updater
 *     cannot resolve a feed from a dev checkout, so `start()` short-circuits to
 *     the `unsupported` state and every method becomes a no-op.
 *
 * The service owns a single `UpdateStatus` and pushes every change through the
 * `notify` sink, which the main process forwards to the renderer. All outbound
 * text is redacted, exactly like the streaming error path.
 */

import { autoUpdater } from 'electron-updater';
import type { ProgressInfo, UpdateInfo } from 'electron-updater';

import type { UpdateState, UpdateStatus } from '../../shared/types';
import type { Logger } from '../logging/Logger';
import { redact } from '../logging/redact';

export interface UpdateServiceOptions {
  logger: Logger;
  /** `app.isPackaged`. The updater only runs from an installed build. */
  isPackaged: boolean;
  /** Pushes each status change to the renderer. */
  notify: (status: UpdateStatus) => void;
  /**
   * Runs before `quitAndInstall`, so a live stream or recording is torn down
   * cleanly (FFmpeg reaped, files finalised) before the installer takes over.
   */
  beforeInstall?: () => Promise<void>;
}

/** How long after launch the first background check fires. */
const INITIAL_CHECK_DELAY_MS = 8_000;

export class UpdateService {
  private readonly logger: Logger;
  private readonly isPackaged: boolean;
  private readonly notify: (status: UpdateStatus) => void;
  private readonly beforeInstall?: () => Promise<void>;

  private status: UpdateStatus = {
    state: 'unsupported',
    version: null,
    percent: 0,
    message: null,
  };

  private wired = false;
  private installing = false;
  private initialCheckTimer: NodeJS.Timeout | null = null;

  constructor(options: UpdateServiceOptions) {
    this.logger = options.logger;
    this.isPackaged = options.isPackaged;
    this.notify = options.notify;
    this.beforeInstall = options.beforeInstall;
  }

  getStatus(): UpdateStatus {
    return this.status;
  }

  /**
   * Configures electron-updater and schedules the first background check. A
   * no-op (leaving the state at `unsupported`) when the app is not packaged.
   */
  start(): void {
    if (!this.isPackaged) {
      this.logger.info('Auto-update disabled: not a packaged build.');
      return;
    }

    this.configure();
    this.setState('idle');

    // Let startup (device discovery, first preview) settle before touching the
    // network. `unref` so a pending check never keeps the app alive on quit.
    this.initialCheckTimer = setTimeout(() => {
      this.initialCheckTimer = null;
      void this.check();
    }, INITIAL_CHECK_DELAY_MS);
    this.initialCheckTimer.unref?.();
  }

  /** Asks the feed whether a newer release exists. Never downloads. */
  async check(): Promise<UpdateStatus> {
    if (!this.isPackaged) return this.status;
    // A download or install already in flight owns the state machine.
    if (this.status.state === 'downloading' || this.status.state === 'downloaded') {
      return this.status;
    }
    try {
      this.configure();
      await autoUpdater.checkForUpdates();
    } catch (error) {
      this.fail(error);
    }
    return this.status;
  }

  /** Downloads the offered update after the user opts in. */
  async download(): Promise<UpdateStatus> {
    if (!this.isPackaged) return this.status;
    if (this.status.state === 'downloaded' || this.status.state === 'downloading') {
      return this.status;
    }
    try {
      this.setState('downloading', { percent: 0 });
      await autoUpdater.downloadUpdate();
    } catch (error) {
      this.fail(error);
    }
    return this.status;
  }

  /**
   * Quits and installs a downloaded update now. A no-op until an update has
   * actually been downloaded, and guarded so a double-click cannot re-enter.
   */
  install(): void {
    if (!this.isPackaged || this.status.state !== 'downloaded' || this.installing) return;
    this.installing = true;
    this.logger.info('Installing update on user request; shutting down gracefully first.');

    void (async () => {
      try {
        await this.beforeInstall?.();
      } catch (error) {
        this.logger.error(`Pre-install shutdown failed: ${redact(error)}`);
      }
      // Defer past the current tick so the shutdown's own quit path unwinds
      // before electron-updater relaunches into the installer.
      setImmediate(() => {
        try {
          autoUpdater.quitAndInstall();
        } catch (error) {
          this.logger.error(`quitAndInstall failed: ${redact(error)}`);
          this.installing = false;
        }
      });
    })();
  }

  dispose(): void {
    if (this.initialCheckTimer) {
      clearTimeout(this.initialCheckTimer);
      this.initialCheckTimer = null;
    }
  }

  /* ---------------------------------------------------------------- */

  private configure(): void {
    if (this.wired) return;
    this.wired = true;

    autoUpdater.autoDownload = false;
    autoUpdater.autoInstallOnAppQuit = true;
    // electron-updater logs verbosely; route it through our redacting logger at
    // a low level rather than to the console.
    autoUpdater.logger = {
      info: (m: unknown) => this.logger.debug(`[updater] ${redact(m)}`),
      warn: (m: unknown) => this.logger.warn(`[updater] ${redact(m)}`),
      error: (m: unknown) => this.logger.error(`[updater] ${redact(m)}`),
      debug: (m: unknown) => this.logger.debug(`[updater] ${redact(m)}`),
    };

    autoUpdater.on('checking-for-update', () => this.setState('checking'));
    autoUpdater.on('update-available', (info: UpdateInfo) => {
      this.logger.info(`Update available: ${info.version}`);
      this.setState('available', { version: info.version });
    });
    autoUpdater.on('update-not-available', (info: UpdateInfo) => {
      this.setState('not-available', { version: info.version });
    });
    autoUpdater.on('download-progress', (progress: ProgressInfo) => {
      this.setState('downloading', { percent: Math.round(progress.percent) });
    });
    autoUpdater.on('update-downloaded', (info: UpdateInfo) => {
      this.logger.info(`Update downloaded: ${info.version} — will install on quit.`);
      this.setState('downloaded', { version: info.version, percent: 100 });
    });
    autoUpdater.on('error', (error: Error) => this.fail(error));
  }

  private fail(error: unknown): void {
    const message = redact(error instanceof Error ? error.message : error);
    this.logger.error(`Auto-update error: ${message}`);
    this.setState('error', { message });
  }

  private setState(state: UpdateState, patch: Partial<Omit<UpdateStatus, 'state'>> = {}): void {
    this.status = {
      state,
      version: patch.version ?? this.status.version,
      // Percent is only meaningful mid-download; reset it everywhere else.
      percent:
        state === 'downloading' ? (patch.percent ?? this.status.percent) : (patch.percent ?? 0),
      message: state === 'error' ? (patch.message ?? this.status.message) : null,
    };
    this.notify(this.status);
  }
}
