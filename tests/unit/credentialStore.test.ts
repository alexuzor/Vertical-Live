/**
 * The stream key must never be written in plain text, must never be logged, and
 * must be forgotten (not silently persisted) when the OS cannot encrypt it.
 */

import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { CredentialStore } from '../../src/main/settings/CredentialStore';
import type { SafeStorageLike } from '../../src/main/settings/CredentialStore';
import { clearSecrets, redact } from '../../src/main/logging/redact';
import { REDACTION_PLACEHOLDER } from '../../src/shared/constants';

const KEY = 'FB-9876543210-secretstreamkey';

/** A stand-in for Electron safeStorage that "encrypts" by reversible XOR. */
function fakeSafeStorage(available = true): SafeStorageLike {
  const xor = (input: Buffer): Buffer =>
    Buffer.from(Uint8Array.from(input, (byte) => byte ^ 0x5a));

  return {
    isEncryptionAvailable: () => available,
    encryptString: (plain) => xor(Buffer.from(plain, 'utf8')),
    decryptString: (cipher) => xor(Buffer.from(cipher)).toString('utf8'),
  };
}

function fakeLogger() {
  const lines: string[] = [];
  const record =
    (level: string) =>
    (message: string, meta?: unknown): void => {
      lines.push(`${level} ${message} ${meta === undefined ? '' : String(meta)}`);
    };
  return {
    lines,
    logger: {
      debug: record('debug'),
      info: record('info'),
      warn: record('warn'),
      error: record('error'),
      path: '',
      recentLines: () => lines,
      dispose: async () => undefined,
    } as never,
  };
}

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'vertical-live-cred-'));
});

afterEach(async () => {
  clearSecrets();
  await rm(dir, { recursive: true, force: true });
});

describe('CredentialStore with encryption available', () => {
  it('encrypts the key before writing it to disk', async () => {
    const { logger } = fakeLogger();
    const store = new CredentialStore({
      directory: dir,
      logger,
      safeStorage: fakeSafeStorage(),
    });

    await store.load();
    const written = await store.setKey(KEY, true);

    expect(written).toBe(true);

    const raw = await readFile(join(dir, 'credentials.json'), 'utf8');
    expect(raw).not.toContain(KEY);
    expect(JSON.parse(raw).streamKey).toBeTruthy();
  });

  it('round-trips the key across a restart', async () => {
    const first = new CredentialStore({
      directory: dir,
      logger: fakeLogger().logger,
      safeStorage: fakeSafeStorage(),
    });
    await first.load();
    await first.setKey(KEY, true);

    const second = new CredentialStore({
      directory: dir,
      logger: fakeLogger().logger,
      safeStorage: fakeSafeStorage(),
    });
    await second.load();

    expect(second.getKey()).toBe(KEY);
    expect(second.hasKey).toBe(true);
    expect(second.isSessionOnly).toBe(false);
  });

  it('registers the key for redaction the moment it is stored', async () => {
    const store = new CredentialStore({
      directory: dir,
      logger: fakeLogger().logger,
      safeStorage: fakeSafeStorage(),
    });
    await store.load();
    await store.setKey(KEY, true);

    expect(redact(`publishing to rtmps://x/rtmp/${KEY}`)).not.toContain(KEY);
  });

  it('registers the key for redaction when loaded from disk', async () => {
    const seed = new CredentialStore({
      directory: dir,
      logger: fakeLogger().logger,
      safeStorage: fakeSafeStorage(),
    });
    await seed.load();
    await seed.setKey(KEY, true);
    clearSecrets();

    const restored = new CredentialStore({
      directory: dir,
      logger: fakeLogger().logger,
      safeStorage: fakeSafeStorage(),
    });
    await restored.load();

    expect(redact(`key is ${KEY}`)).toBe(`key is ${REDACTION_PLACEHOLDER}`);
  });

  it('never writes the key when remember is off, but keeps it usable', async () => {
    const store = new CredentialStore({
      directory: dir,
      logger: fakeLogger().logger,
      safeStorage: fakeSafeStorage(),
    });
    await store.load();

    const written = await store.setKey(KEY, false);

    expect(written).toBe(false);
    expect(store.getKey()).toBe(KEY);
    expect(await readdir(dir)).not.toContain('credentials.json');
  });

  it('clears both memory and disk', async () => {
    const store = new CredentialStore({
      directory: dir,
      logger: fakeLogger().logger,
      safeStorage: fakeSafeStorage(),
    });
    await store.load();
    await store.setKey(KEY, true);

    await store.clear();

    expect(store.getKey()).toBeNull();
    expect(store.hasKey).toBe(false);
    expect(await readdir(dir)).not.toContain('credentials.json');
  });

  it('treats an empty key as a clear', async () => {
    const store = new CredentialStore({
      directory: dir,
      logger: fakeLogger().logger,
      safeStorage: fakeSafeStorage(),
    });
    await store.load();
    await store.setKey(KEY, true);

    await store.setKey('   ', true);
    expect(store.hasKey).toBe(false);
  });

  it('ignores a corrupt credential file instead of crashing', async () => {
    const { writeFile } = await import('node:fs/promises');
    await writeFile(join(dir, 'credentials.json'), '{ not json');

    const { lines, logger } = fakeLogger();
    const store = new CredentialStore({
      directory: dir,
      logger,
      safeStorage: fakeSafeStorage(),
    });
    await store.load();

    expect(store.hasKey).toBe(false);
    expect(lines.join('\n')).toContain('could not be decrypted');
  });

  it('never logs the key itself', async () => {
    const { lines, logger } = fakeLogger();
    const store = new CredentialStore({
      directory: dir,
      logger,
      safeStorage: fakeSafeStorage(),
    });

    await store.load();
    await store.setKey(KEY, true);
    await store.clear();

    expect(lines.join('\n')).not.toContain(KEY);
  });
});

describe('CredentialStore without encryption', () => {
  it('refuses to persist the key and says so', async () => {
    const { lines, logger } = fakeLogger();
    const store = new CredentialStore({
      directory: dir,
      logger,
      safeStorage: fakeSafeStorage(false),
    });

    await store.load();
    const written = await store.setKey(KEY, true);

    expect(written).toBe(false);
    expect(await readdir(dir)).not.toContain('credentials.json');
    expect(lines.join('\n')).toContain('Refusing to save');
  });

  it('still keeps the key usable for this session', async () => {
    const store = new CredentialStore({
      directory: dir,
      logger: fakeLogger().logger,
      safeStorage: fakeSafeStorage(false),
    });

    await store.load();
    await store.setKey(KEY, true);

    expect(store.getKey()).toBe(KEY);
    expect(store.hasKey).toBe(true);
    expect(store.isSessionOnly).toBe(true);
    expect(store.canEncrypt).toBe(false);
  });

  it('warns the user at load time', async () => {
    const { lines, logger } = fakeLogger();
    const store = new CredentialStore({
      directory: dir,
      logger,
      safeStorage: fakeSafeStorage(false),
    });

    await store.load();

    expect(lines.join('\n')).toContain('only be kept for this session');
  });

  it('does not persist even if encryption throws', async () => {
    const throwing: SafeStorageLike = {
      isEncryptionAvailable: () => true,
      encryptString: () => {
        throw new Error('DPAPI unavailable');
      },
      decryptString: () => '',
    };

    const store = new CredentialStore({
      directory: dir,
      logger: fakeLogger().logger,
      safeStorage: throwing,
    });

    await store.load();
    const written = await store.setKey(KEY, true);

    expect(written).toBe(false);
    expect(await readdir(dir)).not.toContain('credentials.json');
  });

  it('survives isEncryptionAvailable throwing', async () => {
    const hostile: SafeStorageLike = {
      isEncryptionAvailable: () => {
        throw new Error('no backend');
      },
      encryptString: () => Buffer.alloc(0),
      decryptString: () => '',
    };

    const store = new CredentialStore({
      directory: dir,
      logger: fakeLogger().logger,
      safeStorage: hostile,
    });

    await expect(store.load()).resolves.toBeUndefined();
    expect(store.canEncrypt).toBe(false);
  });
});

describe('CredentialStore lifecycle', () => {
  it('load() is idempotent', async () => {
    const isAvailable = vi.fn(() => true);
    const store = new CredentialStore({
      directory: dir,
      logger: fakeLogger().logger,
      safeStorage: { ...fakeSafeStorage(), isEncryptionAvailable: isAvailable },
    });

    await store.load();
    await store.load();

    expect(isAvailable).toHaveBeenCalledTimes(1);
  });

  it('replacing a key unregisters the previous one', async () => {
    const store = new CredentialStore({
      directory: dir,
      logger: fakeLogger().logger,
      safeStorage: fakeSafeStorage(),
    });
    await store.load();

    await store.setKey('FIRST-KEY-VALUE', true);
    await store.setKey('SECOND-KEY-VALUE', true);

    expect(store.getKey()).toBe('SECOND-KEY-VALUE');
    expect(redact('FIRST-KEY-VALUE')).toBe('FIRST-KEY-VALUE');
    expect(redact('SECOND-KEY-VALUE')).toBe(REDACTION_PLACEHOLDER);
  });
});
