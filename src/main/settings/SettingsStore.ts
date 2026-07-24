/**
 * Non-sensitive settings persistence.
 *
 * Written atomically (temp file + rename) so a crash mid-write can never leave
 * a truncated JSON file behind, and validated leniently on load so a single
 * corrupt field falls back to its default rather than resetting everything.
 *
 * The Facebook stream key is deliberately NOT stored here -- see CredentialStore.
 */

import { renameSync, writeFileSync } from 'node:fs';
import { readFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';

import { DEFAULT_SETTINGS, parseSettingsLenient } from '../../shared/schemas';
import type { PersistedSettings } from '../../shared/types';
import type { Logger } from '../logging/Logger';

const SETTINGS_FILE = 'settings.json';

export interface SettingsStoreOptions {
  directory: string;
  logger: Logger;
}

export class SettingsStore {
  private readonly path: string;
  private cache: PersistedSettings | null = null;
  private writeChain: Promise<void> = Promise.resolve();

  constructor(private readonly options: SettingsStoreOptions) {
    this.path = join(options.directory, SETTINGS_FILE);
  }

  get filePath(): string {
    return this.path;
  }

  async load(): Promise<PersistedSettings> {
    if (this.cache) return this.cache;

    try {
      const raw = await readFile(this.path, 'utf8');
      const { settings, repaired } = parseSettingsLenient(JSON.parse(raw));
      if (repaired.length > 0) {
        this.options.logger.warn(
          `Reset ${repaired.length} invalid setting(s) to defaults: ${repaired.join(', ')}`,
        );
      }
      this.cache = settings;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT') {
        this.options.logger.warn('Settings file could not be read; using defaults.');
      }
      this.cache = { ...DEFAULT_SETTINGS };
    }

    return this.cache;
  }

  /** Current settings without touching disk. Loads defaults if not yet read. */
  get current(): PersistedSettings {
    return this.cache ?? { ...DEFAULT_SETTINGS };
  }

  /** Merges a partial update and persists it. */
  async update(patch: Partial<PersistedSettings>): Promise<PersistedSettings> {
    const base = await this.load();
    const next: PersistedSettings = { ...base, ...patch };
    this.cache = next;
    await this.persist(next);
    return next;
  }

  private persist(settings: PersistedSettings): Promise<void> {
    // Serialise writes so rapid updates cannot interleave their renames.
    this.writeChain = this.writeChain.then(async () => {
      const temporary = `${this.path}.${process.pid}.tmp`;
      try {
        // Synchronous inside an already-serialised async chain: the payload is
        // under a kilobyte and this only runs on explicit user actions, never
        // during streaming.
        writeFileSync(temporary, JSON.stringify(settings, null, 2), 'utf8');
        renameSync(temporary, this.path);
      } catch (error) {
        this.options.logger.error(
          `Could not save settings: ${String((error as Error).message)}`,
        );
        await unlink(temporary).catch(() => undefined);
      }
    });
    return this.writeChain;
  }
}
