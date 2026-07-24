/**
 * DirectShow camera and microphone enumeration.
 *
 * FFmpeg prints the device list to **stderr** and exits non-zero (it was asked
 * to open a device called `dummy`), so a non-zero exit code here is normal and
 * must not be treated as failure.
 *
 * Two output formats are supported:
 *
 *   ffmpeg >= 5:
 *     [dshow @ ...] "Integrated Camera" (video)
 *     [dshow @ ...]   Alternative name "@device_pnp_\\?\usb#vid_..."
 *
 *   ffmpeg 4.x:
 *     [dshow @ ...] DirectShow video devices (some may be both video and audio)
 *     [dshow @ ...]  "Integrated Camera"
 *     [dshow @ ...]     Alternative name "@device_pnp_..."
 */

import { ENV_SYNTHETIC_INPUT } from '../../shared/constants';
import { VerticalLiveError } from '../../shared/errors';
import type { DeviceList, MediaDevice } from '../../shared/types';
import { buildDeviceListCommand, isDshowNameUsable } from './FfmpegCommandBuilder';
import type { ProbeRunner } from './runProbe';
import { runProbe } from './runProbe';

type DeviceKind = 'video' | 'audio';

/** Strips the `[dshow @ 0x...]` prefix FFmpeg puts on every line. */
function stripPrefix(line: string): string {
  return line.replace(/^\s*\[[^\]]*\]\s?/, '');
}

const SECTION_RE = /^DirectShow\s+(video|audio)\s+devices/i;
/** `"Name"` optionally followed by any `(...)` suffix. Greedy so embedded
 *  quotes inside a device name survive; the suffix content is captured (not
 *  hard-coded to video/audio) so FFmpeg 7.x's `(none)` tag is still parsed. */
const DEVICE_RE = /^"(.+)"(?:\s*\(([^)]*)\))?\s*$/;
const ALTERNATIVE_RE = /^Alternative name\s+"(.+)"\s*$/i;

/**
 * Classifies a device from its `(…)` suffix, falling back to the current
 * enumeration region when the suffix is absent or unhelpful.
 *
 * FFmpeg 7.x dropped the `DirectShow video devices` / `DirectShow audio
 * devices` section headers AND tags some genuine cameras — external UVC
 * webcams and virtual cameras — as `(none)` rather than `(video)`. The old
 * parser required an exact `(video)`/`(audio)` suffix and silently dropped
 * everything else, so those cameras never appeared in the picker. dshow always
 * enumerates video devices before audio devices, so anything not explicitly
 * audio is treated as belonging to the current region, which starts at video.
 */
function classifyKind(suffix: string | undefined, region: DeviceKind | null): DeviceKind {
  const normalised = (suffix ?? '').toLowerCase();
  if (normalised.includes('video')) return 'video';
  if (normalised.includes('audio')) return 'audio';
  return region ?? 'video';
}

export interface ParsedDeviceList {
  cameras: MediaDevice[];
  microphones: MediaDevice[];
  warnings: string[];
}

/**
 * Parses `ffmpeg -list_devices true -f dshow -i dummy` output.
 * Exported separately from the I/O so it can be unit-tested against captured
 * fixtures from several FFmpeg versions.
 */
export function parseDeviceList(output: string): ParsedDeviceList {
  const cameras: MediaDevice[] = [];
  const microphones: MediaDevice[] = [];
  const warnings: string[] = [];

  let section: DeviceKind | null = null;
  let lastDevice: { device: MediaDevice; kind: DeviceKind } | null = null;

  for (const rawLine of output.split(/\r\n|\n|\r/)) {
    const line = stripPrefix(rawLine).trim();
    if (line.length === 0) continue;

    const sectionMatch = SECTION_RE.exec(line);
    if (sectionMatch) {
      section = (sectionMatch[1] as string).toLowerCase() as DeviceKind;
      lastDevice = null;
      continue;
    }

    const altMatch = ALTERNATIVE_RE.exec(line);
    if (altMatch && lastDevice) {
      lastDevice.device.alternativeName = altMatch[1] as string;
      continue;
    }

    const deviceMatch = DEVICE_RE.exec(line);
    if (!deviceMatch) continue;

    const name = deviceMatch[1] as string;
    const suffix = deviceMatch[2] as string | undefined;
    const kind = classifyKind(suffix, section);
    // Advance the running region so a later suffix-less or `(none)` device is
    // classified by the block it appears in (video block first, then audio).
    section = kind;

    const target = kind === 'video' ? cameras : microphones;
    const device: MediaDevice = {
      name,
      alternativeName: null,
      id: name,
      index: target.length,
    };
    target.push(device);
    lastDevice = { device, kind };
  }

  return { cameras, microphones, warnings };
}

/**
 * Chooses the string actually handed to the dshow demuxer.
 *
 * FFmpeg's `parse_device_name` splits on `:` with no escape support, so a
 * device whose friendly name contains a colon must be addressed by its
 * DirectShow "Alternative name" instead.
 */
export function resolveDshowName(device: MediaDevice): string {
  if (isDshowNameUsable(device.name)) return device.name;
  if (device.alternativeName && isDshowNameUsable(device.alternativeName)) {
    return device.alternativeName;
  }
  throw new VerticalLiveError(
    'invalid-configuration',
    `The device name "${device.name}" contains a colon, which FFmpeg's DirectShow ` +
      'input cannot address. Rename the device in Windows Device Manager.',
  );
}

const SYNTHETIC_DEVICES: DeviceList = {
  cameras: [
    {
      name: 'Synthetic test pattern (testsrc2)',
      alternativeName: null,
      id: 'synthetic:video',
      index: 0,
    },
  ],
  microphones: [
    {
      name: 'Synthetic tone (sine)',
      alternativeName: null,
      id: 'synthetic:audio',
      index: 0,
    },
  ],
  warnings: ['Synthetic input mode is enabled; no real hardware is being used.'],
};

export interface DeviceDiscoveryOptions {
  /** Resolves the FFmpeg executable path at call time. */
  getExecutable: () => string;
  runner?: ProbeRunner;
  env?: NodeJS.ProcessEnv;
}

export class DeviceDiscovery {
  private cache: DeviceList | null = null;
  private readonly runner: ProbeRunner;

  constructor(private readonly options: DeviceDiscoveryOptions) {
    this.runner = options.runner ?? runProbe;
  }

  private get synthetic(): boolean {
    return (this.options.env ?? process.env)[ENV_SYNTHETIC_INPUT] === 'true';
  }

  /** Returns the cached list, refreshing when asked or on first call. */
  async list(refresh = false): Promise<DeviceList> {
    if (this.cache && !refresh) return this.cache;

    if (this.synthetic) {
      this.cache = SYNTHETIC_DEVICES;
      return this.cache;
    }

    const result = await this.runner(this.options.getExecutable(), buildDeviceListCommand());

    if (result.spawnError) {
      throw new VerticalLiveError('ffmpeg-missing', result.spawnError);
    }
    if (result.timedOut) {
      throw new VerticalLiveError(
        'internal-error',
        'FFmpeg did not respond while listing DirectShow devices.',
      );
    }

    // A non-zero exit is expected: `-i dummy` always fails to open.
    const parsed = parseDeviceList(result.output);
    this.cache = {
      cameras: parsed.cameras,
      microphones: parsed.microphones,
      warnings: parsed.warnings,
    };
    return this.cache;
  }

  /** Looks a device up by id (its friendly name) among cameras. */
  async findCamera(id: string): Promise<MediaDevice | null> {
    const list = await this.list();
    return list.cameras.find((device) => device.id === id) ?? null;
  }

  /** Looks a device up by id among microphones. */
  async findMicrophone(id: string): Promise<MediaDevice | null> {
    const list = await this.list();
    return list.microphones.find((device) => device.id === id) ?? null;
  }

  invalidate(): void {
    this.cache = null;
  }
}
