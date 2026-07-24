/**
 * Encrypted storage for the Facebook stream key.
 *
 * Rules, enforced here rather than by convention:
 *  - the key is encrypted with Electron `safeStorage` (DPAPI on Windows) before
 *    it ever touches the disk
 *  - if the OS cannot provide encryption, the key is held in memory for this
 *    session only and NEVER written -- silently persisting it in plaintext
 *    would be worse than forgetting it
 *  - the key is registered for redaction the moment it enters the process, so
 *    it cannot appear in a log, an error, or a diagnostics report
 *  - the plaintext is never returned to the renderer; the renderer only ever
 *    learns whether a key exists
 */

import { renameSync, writeFileSync } from 'node:fs';
import { readFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';

import type { Logger } from '../logging/Logger';
import { registerSecret, unregisterSecret } from '../logging/redact';

const CREDENTIALS_FILE = 'credentials.json';

/** Minimal surface of Electron's safeStorage, so tests can substitute it. */
export interface SafeStorageLike {
  isEncryptionAvailable(): boolean;
  encryptString(plainText: string): Buffer;
  decryptString(encrypted: Buffer): string;
}

interface CredentialsFile {
  version: 1;
  /** base64 of the safeStorage ciphertext. */
  streamKey: string | null;
}

export interface CredentialStoreOptions {
  directory: string;
  logger: Logger;
  safeStorage: SafeStorageLike;
}

export class CredentialStore {
  private readonly path: string;
  private sessionKey: string | null = null;
  private loaded = false;
  private encryptionAvailable = false;
  private writeChain: Promise<void> = Promise.resolve();

  constructor(private readonly options: CredentialStoreOptions) {
    this.path = join(options.directory, CREDENTIALS_FILE);
  }

  /** True when the OS can encrypt secrets at rest. */
  get canEncrypt(): boolean {
    return this.encryptionAvailable;
  }

  /** True when a key is available for this session. */
  get hasKey(): boolean {
    return this.sessionKey !== null;
  }

  /** True when a key exists but could not be persisted safely. */
  get isSessionOnly(): boolean {
    return this.sessionKey !== null && !this.encryptionAvailable;
  }

  async load(): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;

    try {
      this.encryptionAvailable = this.options.safeStorage.isEncryptionAvailable();
    } catch {
      this.encryptionAvailable = false;
    }

    if (!this.encryptionAvailable) {
      this.options.logger.warn(
        'OS credential encryption is unavailable; the stream key will only be kept for this session.',
      );
      return;
    }

    try {
      const raw = await readFile(this.path, 'utf8');
      const parsed = JSON.parse(raw) as Partial<CredentialsFile>;
      if (typeof parsed.streamKey === 'string' && parsed.streamKey.length > 0) {
        const plain = this.options.safeStorage.decryptString(
          Buffer.from(parsed.streamKey, 'base64'),
        );
        this.setSessionKey(plain);
        this.options.logger.info('Loaded an encrypted stream key from disk.');
      }
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT') {
        // Never log the payload, only that it failed.
        this.options.logger.warn(
          'The stored stream key could not be decrypted and has been ignored.',
        );
      }
    }
  }

  /** Returns the plaintext key. Main-process use only. */
  getKey(): string | null {
    return this.sessionKey;
  }

  /**
   * Stores a key. Persists it encrypted when `remember` is true and the OS
   * supports encryption; otherwise keeps it in memory for this session only.
   *
   * @returns whether the key was written to disk.
   */
  async setKey(key: string | null, remember: boolean): Promise<boolean> {
    if (key === null || key.trim().length === 0) {
      await this.clear();
      return false;
    }

    this.setSessionKey(key.trim());

    if (!remember) {
      await this.deleteFile();
      return false;
    }

    if (!this.encryptionAvailable) {
      this.options.logger.warn(
        'Refusing to save the stream key: encryption is unavailable on this system.',
      );
      await this.deleteFile();
      return false;
    }

    try {
      const cipher = this.options.safeStorage.encryptString(this.sessionKey as string);
      const payload: CredentialsFile = { version: 1, streamKey: cipher.toString('base64') };
      await this.write(payload);
      this.options.logger.info('Saved the stream key (encrypted).');
      return true;
    } catch (error) {
      this.options.logger.error(
        `Could not encrypt the stream key: ${String((error as Error).message)}`,
      );
      await this.deleteFile();
      return false;
    }
  }

  /** Forgets the key entirely, in memory and on disk. */
  async clear(): Promise<void> {
    if (this.sessionKey) unregisterSecret(this.sessionKey);
    this.sessionKey = null;
    await this.deleteFile();
  }

  private setSessionKey(key: string): void {
    if (this.sessionKey) unregisterSecret(this.sessionKey);
    this.sessionKey = key;
    registerSecret(key);
  }

  private write(payload: CredentialsFile): Promise<void> {
    this.writeChain = this.writeChain.then(async () => {
      const temporary = `${this.path}.${process.pid}.tmp`;
      try {
        writeFileSync(temporary, JSON.stringify(payload), { encoding: 'utf8', mode: 0o600 });
        renameSync(temporary, this.path);
      } catch (error) {
        this.options.logger.error(
          `Could not write the credential file: ${String((error as Error).message)}`,
        );
        await unlink(temporary).catch(() => undefined);
      }
    });
    return this.writeChain;
  }

  private deleteFile(): Promise<void> {
    this.writeChain = this.writeChain.then(() => unlink(this.path).catch(() => undefined));
    return this.writeChain;
  }
}
