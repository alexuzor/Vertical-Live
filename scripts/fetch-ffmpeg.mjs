#!/usr/bin/env node
/**
 * Downloads a Windows FFmpeg build into `resources/ffmpeg/`.
 *
 * The repository never commits a binary, and never commits a fake placeholder
 * pretending to be one. This script is the documented, repeatable way to put a
 * real FFmpeg where `FfmpegLocator` expects it.
 *
 * Usage:
 *   node scripts/fetch-ffmpeg.mjs
 *   node scripts/fetch-ffmpeg.mjs --sha256=<hex>        verify against a pin
 *   node scripts/fetch-ffmpeg.mjs --from-zip=<path>     use an already-downloaded zip
 *   node scripts/fetch-ffmpeg.mjs --url=<url>           use a different build
 *   node scripts/fetch-ffmpeg.mjs --force               re-install over an existing copy
 *
 * Environment overrides: FFMPEG_ZIP_URL, FFMPEG_ZIP_SHA256
 *
 * After extraction the script *verifies the binary actually works* -- version,
 * dshow input, rtmp/rtmps protocols and the libx264 encoder -- so a build that
 * cannot do what Vertical Live needs fails here rather than at runtime.
 */

import { createHash } from 'node:crypto';
import {
  createWriteStream,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  copyFileSync,
} from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { pipeline } from 'node:stream/promises';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const TARGET_DIR = join(ROOT, 'resources', 'ffmpeg');
const TEMP_DIR = join(ROOT, 'node_modules', '.ffmpeg-download');

/**
 * gyan.dev's "essentials" build is the pragmatic default: it is the canonical
 * Windows FFmpeg distribution, it is a stable URL that always resolves to the
 * current release, and it ships dshow, libx264, NVENC, QSV, AMF and schannel
 * TLS (which is what makes rtmps work).
 *
 * Because that URL tracks the latest release, a hard-coded hash would break on
 * every FFmpeg release. Instead the script prints the SHA-256 of whatever it
 * downloaded so a team can pin it with --sha256 / FFMPEG_ZIP_SHA256, and it
 * always functionally verifies the result.
 */
const DEFAULT_URL = 'https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip';

const args = process.argv.slice(2);

function flag(name) {
  return args.includes(`--${name}`);
}

function option(name, fallback) {
  const prefix = `--${name}=`;
  const found = args.find((arg) => arg.startsWith(prefix));
  return found ? found.slice(prefix.length) : fallback;
}

const url = option('url', process.env.FFMPEG_ZIP_URL ?? DEFAULT_URL);
const expectedSha = option('sha256', process.env.FFMPEG_ZIP_SHA256 ?? null);
const fromZip = option('from-zip', null);
const force = flag('force');

const EXECUTABLE = process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg';
const targetExecutable = join(TARGET_DIR, EXECUTABLE);

function log(message) {
  console.log(`[ffmpeg-setup] ${message}`);
}

function fatal(message) {
  console.error(`[ffmpeg-setup] ERROR: ${message}`);
  process.exit(1);
}

function sha256(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

/** Recursively finds a file by name. */
function findFile(directory, fileName) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const full = join(directory, entry.name);
    if (entry.isDirectory()) {
      const nested = findFile(full, fileName);
      if (nested) return nested;
    } else if (entry.name.toLowerCase() === fileName.toLowerCase()) {
      return full;
    }
  }
  return null;
}

async function download(sourceUrl, destination) {
  log(`Downloading ${sourceUrl}`);
  log('This is a ~100 MB archive and can take several minutes.');

  let response;
  try {
    response = await fetch(sourceUrl, { redirect: 'follow' });
  } catch (error) {
    fatal(
      `Could not reach ${sourceUrl}: ${error?.cause?.message ?? error.message}\n` +
        '  If you are behind a proxy or offline, download the archive manually and re-run with\n' +
        '  node scripts/fetch-ffmpeg.mjs --from-zip=<path-to-zip>',
    );
  }

  if (!response.ok || !response.body) {
    fatal(`Download failed with HTTP ${response.status} ${response.statusText}`);
  }

  const total = Number(response.headers.get('content-length') ?? 0);
  let received = 0;
  let lastPercent = -1;

  // `Readable.fromWeb` is used rather than `pipeThrough(new TransformStream())`:
  // the latter is noticeably less reliable across Node versions for large
  // bodies and swallows the underlying socket error into a bare "fetch failed".
  const source = Readable.fromWeb(response.body);
  source.on('data', (chunk) => {
    received += chunk.length;
    if (total > 0) {
      const percent = Math.floor((received / total) * 100);
      if (percent >= lastPercent + 10) {
        lastPercent = percent;
        log(`  ${percent}% (${(received / 1024 / 1024).toFixed(1)} MB)`);
      }
    }
  });

  try {
    await pipeline(source, createWriteStream(destination));
  } catch (error) {
    fatal(`The download was interrupted: ${error.message}`);
  }

  log(`Downloaded ${(statSync(destination).size / 1024 / 1024).toFixed(1)} MB`);
}

/** Extracts a zip using PowerShell's Expand-Archive (present on Win10/11). */
function extract(zipPath, destination) {
  log('Extracting…');
  rmSync(destination, { recursive: true, force: true });
  mkdirSync(destination, { recursive: true });

  if (process.platform === 'win32') {
    const result = spawnSync(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        `Expand-Archive -LiteralPath '${zipPath.replace(/'/g, "''")}' -DestinationPath '${destination.replace(/'/g, "''")}' -Force`,
      ],
      { stdio: 'inherit', windowsHide: true },
    );
    if (result.status !== 0) fatal('Expand-Archive failed.');
    return;
  }

  const result = spawnSync('unzip', ['-q', zipPath, '-d', destination], { stdio: 'inherit' });
  if (result.status !== 0) fatal('unzip failed (install unzip, or use --from-zip on Windows).');
}

/** Runs the installed FFmpeg and confirms it has everything the app needs. */
function verify(executable) {
  log('Verifying the installed binary…');

  const run = (flags) =>
    spawnSync(executable, flags, {
      encoding: 'utf8',
      windowsHide: true,
      maxBuffer: 32 * 1024 * 1024,
    });

  const version = run(['-hide_banner', '-version']);
  if (version.status !== 0) {
    fatal(
      `The extracted binary could not be executed: ${version.stderr ?? version.error ?? ''}`,
    );
  }
  const versionLine = (version.stdout ?? '').split('\n')[0]?.trim();
  log(`  ${versionLine}`);

  const checks = [
    [
      'dshow input device',
      run(['-hide_banner', '-demuxers']),
      /\bdshow\b/,
      process.platform === 'win32',
    ],
    ['rtmp protocol', run(['-hide_banner', '-protocols']), /\brtmp\b/, true],
    ['rtmps protocol', run(['-hide_banner', '-protocols']), /\brtmps\b/, false],
    ['libx264 encoder', run(['-hide_banner', '-encoders']), /\blibx264\b/, true],
  ];

  let failed = false;
  for (const [label, result, pattern, required] of checks) {
    const present = pattern.test(`${result.stdout ?? ''}${result.stderr ?? ''}`);
    if (present) {
      log(`  OK   ${label}`);
    } else if (required) {
      console.error(`[ffmpeg-setup]   FAIL ${label} (required)`);
      failed = true;
    } else {
      console.warn(
        `[ffmpeg-setup]   WARN ${label} missing — rtmps:// destinations will not work`,
      );
    }
  }

  // Hardware encoders are reported but never required: the app probes them at
  // runtime and falls back to libx264.
  const encoders = run(['-hide_banner', '-encoders']);
  const encoderText = `${encoders.stdout ?? ''}${encoders.stderr ?? ''}`;
  const hardware = ['h264_nvenc', 'h264_qsv', 'h264_amf'].filter((id) =>
    new RegExp(`\\b${id}\\b`).test(encoderText),
  );
  log(`  Hardware encoders compiled in: ${hardware.length > 0 ? hardware.join(', ') : 'none'}`);

  if (failed) fatal('This FFmpeg build is missing features Vertical Live requires.');
}

async function main() {
  if (existsSync(targetExecutable) && !force) {
    log(`FFmpeg is already installed at ${targetExecutable}`);
    log('Pass --force to reinstall.');
    verify(targetExecutable);
    return;
  }

  mkdirSync(TARGET_DIR, { recursive: true });
  mkdirSync(TEMP_DIR, { recursive: true });

  const zipPath = fromZip ? resolve(fromZip) : join(TEMP_DIR, 'ffmpeg.zip');

  if (fromZip) {
    if (!existsSync(zipPath)) fatal(`No such file: ${zipPath}`);
    log(`Using local archive ${zipPath}`);
  } else {
    await download(url, zipPath);
  }

  const digest = sha256(zipPath);
  log(`SHA-256: ${digest}`);

  if (expectedSha) {
    if (digest.toLowerCase() !== expectedSha.toLowerCase()) {
      fatal(`Checksum mismatch.\n  expected ${expectedSha}\n  actual   ${digest}`);
    }
    log('Checksum matches the pin.');
  } else {
    log('No --sha256 pin supplied. To pin this exact build in CI, re-run with:');
    log(`  node scripts/fetch-ffmpeg.mjs --force --sha256=${digest}`);
  }

  const extractDir = join(TEMP_DIR, 'extracted');
  extract(zipPath, extractDir);

  const sourceExecutable = findFile(extractDir, EXECUTABLE);
  if (!sourceExecutable) fatal(`No ${EXECUTABLE} was found inside the archive.`);

  copyFileSync(sourceExecutable, targetExecutable);
  log(`Installed ${targetExecutable}`);

  // ffprobe is not required by the app but is handy for manual debugging.
  const probeName = process.platform === 'win32' ? 'ffprobe.exe' : 'ffprobe';
  const sourceProbe = findFile(extractDir, probeName);
  if (sourceProbe) {
    copyFileSync(sourceProbe, join(TARGET_DIR, probeName));
    log(`Installed ${join(TARGET_DIR, probeName)}`);
  }

  verify(targetExecutable);

  rmSync(extractDir, { recursive: true, force: true });
  if (!fromZip) rmSync(zipPath, { force: true });

  log('Done. Vertical Live will now find FFmpeg automatically.');
}

main().catch((error) => {
  fatal(error instanceof Error ? error.message : String(error));
});
