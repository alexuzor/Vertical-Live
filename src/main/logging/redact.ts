/**
 * Secret redaction.
 *
 * Every string that could reach a log file, an error banner, a diagnostics
 * report or the renderer passes through here first. The rules are deliberately
 * belt-and-braces: we redact the exact registered secrets *and* we structurally
 * redact anything that looks like an RTMP destination, so a key can never leak
 * through a code path that forgot to register it.
 */

import { REDACTION_PLACEHOLDER } from '../../shared/constants';

/**
 * Secrets registered for redaction. A module-level set is intentional: FFmpeg
 * output arrives asynchronously from several places and every one of them must
 * redact against the same list.
 */
const secrets = new Set<string>();

/** Registers a secret. Values shorter than 4 characters are ignored. */
export function registerSecret(secret: string | null | undefined): void {
  if (typeof secret !== 'string') return;
  const trimmed = secret.trim();
  if (trimmed.length < 4) return;
  secrets.add(trimmed);
}

/** Forgets a single secret. */
export function unregisterSecret(secret: string | null | undefined): void {
  if (typeof secret !== 'string') return;
  secrets.delete(secret.trim());
}

/** Forgets every registered secret. */
export function clearSecrets(): void {
  secrets.clear();
}

/** Test/diagnostic helper. Never returns the secrets themselves. */
export function registeredSecretCount(): number {
  return secrets.size;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Replaces the path and query of any rtmp/rtmps URL with the placeholder,
 * keeping the scheme, host and port so the message stays diagnosable.
 *
 * `rtmps://live-api-s.facebook.com:443/rtmp/1234?x=y`
 *   becomes
 * `rtmps://live-api-s.facebook.com:443/[REDACTED]`
 */
export function redactRtmpUrls(input: string): string {
  return input.replace(
    /\b(rtmps?:\/\/[^\s/:]+(?::\d+)?)(\/\S*)?/gi,
    (_match, origin: string, rest: string | undefined) =>
      rest && rest.length > 1 ? `${origin}/${REDACTION_PLACEHOLDER}` : `${origin}/`,
  );
}

/**
 * Redacts all registered secrets plus any RTMP destination path from `input`.
 *
 * Accepts anything; non-strings are stringified defensively so a stray object
 * cannot bypass redaction.
 */
export function redact(input: unknown, extraSecrets: readonly string[] = []): string {
  let text: string;
  if (typeof input === 'string') {
    text = input;
  } else if (input instanceof Error) {
    text = `${input.name}: ${input.message}`;
  } else if (input === null || input === undefined) {
    return '';
  } else {
    try {
      text = JSON.stringify(input) ?? String(input);
    } catch {
      text = String(input);
    }
  }

  const all = [...secrets, ...extraSecrets.map((s) => s.trim()).filter((s) => s.length >= 4)];

  // Longest first, so a key that contains another registered value is replaced
  // whole rather than being partially masked.
  all.sort((a, b) => b.length - a.length);

  for (const secret of all) {
    text = text.replace(new RegExp(escapeRegExp(secret), 'g'), REDACTION_PLACEHOLDER);
  }

  return redactRtmpUrls(text);
}

/**
 * Redacts an argv array for logging. Values that follow an option known to
 * carry a destination are replaced wholesale.
 */
export function redactArgs(args: readonly string[]): string[] {
  return args.map((arg) => redact(arg));
}
