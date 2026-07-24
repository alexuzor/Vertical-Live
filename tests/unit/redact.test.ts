/**
 * Redaction is the single most security-critical piece of pure logic in the
 * app: if it fails, a Facebook stream key ends up in a log file or a
 * user-submitted diagnostics report.
 */

import { afterEach, describe, expect, it } from 'vitest';

import { REDACTION_PLACEHOLDER } from '../../src/shared/constants';
import {
  clearSecrets,
  redact,
  redactArgs,
  redactRtmpUrls,
  registerSecret,
  registeredSecretCount,
  unregisterSecret,
} from '../../src/main/logging/redact';

const KEY = 'FB-1234567890-abcdefghijklmnop';
const SERVER = 'rtmps://live-api-s.facebook.com:443/rtmp';

afterEach(() => {
  clearSecrets();
});

describe('registerSecret', () => {
  it('registers and forgets secrets', () => {
    registerSecret(KEY);
    expect(registeredSecretCount()).toBe(1);
    unregisterSecret(KEY);
    expect(registeredSecretCount()).toBe(0);
  });

  it('ignores values too short to be a real secret', () => {
    registerSecret('ab');
    registerSecret('');
    registerSecret(null);
    registerSecret(undefined);
    expect(registeredSecretCount()).toBe(0);
  });

  it('trims before storing so whitespace cannot defeat matching', () => {
    registerSecret(`  ${KEY}  `);
    expect(redact(`key=${KEY}`)).toBe(`key=${REDACTION_PLACEHOLDER}`);
  });
});

describe('redact', () => {
  it('removes a registered stream key from arbitrary text', () => {
    registerSecret(KEY);
    const output = redact(`Opening ${SERVER}/${KEY} for writing`);
    expect(output).not.toContain(KEY);
    expect(output).toContain(REDACTION_PLACEHOLDER);
  });

  it('removes every occurrence, not just the first', () => {
    registerSecret(KEY);
    const output = redact(`${KEY} then ${KEY} then ${KEY}`);
    expect(output).not.toContain(KEY);
    expect(output.split(REDACTION_PLACEHOLDER).length - 1).toBeGreaterThanOrEqual(3);
  });

  it('redacts an RTMP destination path even when no secret is registered', () => {
    // This is the safety net: a code path that forgets to register the key must
    // still not leak it.
    const output = redact(`[flv @ 0x1] Opening ${SERVER}/${KEY} for writing`);
    expect(output).not.toContain(KEY);
    expect(output).toContain('rtmps://live-api-s.facebook.com:443/');
  });

  it('keeps the scheme, host and port so messages stay diagnosable', () => {
    const output = redactRtmpUrls(`connect to ${SERVER}/${KEY}`);
    expect(output).toContain('rtmps://live-api-s.facebook.com:443');
    expect(output).not.toContain(KEY);
  });

  it('handles rtmp as well as rtmps', () => {
    const output = redact(`rtmp://example.com/live/${KEY}`);
    expect(output).not.toContain(KEY);
  });

  it('leaves a bare origin with no path alone apart from a trailing slash', () => {
    expect(redactRtmpUrls('rtmps://live-api-s.facebook.com:443')).toBe(
      'rtmps://live-api-s.facebook.com:443/',
    );
  });

  it('replaces the longest secret first so nested values are fully masked', () => {
    registerSecret('abcd1234');
    registerSecret('abcd1234efgh5678');
    const output = redact('token=abcd1234efgh5678');
    expect(output).toBe(`token=${REDACTION_PLACEHOLDER}`);
  });

  it('escapes regular-expression metacharacters in secrets', () => {
    const trickyKey = 'a+b(c)[d]*e?f.g$h^i|j';
    registerSecret(trickyKey);
    expect(redact(`value=${trickyKey}`)).toBe(`value=${REDACTION_PLACEHOLDER}`);
  });

  it('redacts extra ad-hoc secrets passed per call', () => {
    expect(redact('hello world secret-value', ['secret-value'])).toContain(
      REDACTION_PLACEHOLDER,
    );
  });

  it('stringifies non-string input defensively', () => {
    registerSecret(KEY);
    expect(redact(new Error(`failed for ${KEY}`))).not.toContain(KEY);
    expect(redact({ url: `${SERVER}/${KEY}` })).not.toContain(KEY);
    expect(redact(null)).toBe('');
    expect(redact(undefined)).toBe('');
    expect(redact(42)).toBe('42');
  });

  it('redacts an argv array', () => {
    registerSecret(KEY);
    const args = redactArgs(['-f', 'flv', `${SERVER}/${KEY}`]);
    expect(args).toHaveLength(3);
    expect(args.join(' ')).not.toContain(KEY);
  });

  it('never leaks a key through a full FFmpeg error line', () => {
    registerSecret(KEY);
    const line = `[rtmp @ 000001f2] Server error: Failed to publish to ${SERVER}/${KEY}?s_bl=1&s_sw=0`;
    const output = redact(line);
    expect(output).not.toContain(KEY);
    expect(output).not.toContain('s_bl=1');
  });
});
