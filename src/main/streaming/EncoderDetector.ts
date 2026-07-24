/**
 * H.264 encoder detection.
 *
 * Being listed in `ffmpeg -encoders` proves only that the binary was compiled
 * with support, not that this machine's GPU and driver can actually use it. So
 * every candidate is verified by encoding 20 frames of `testsrc2` with the
 * exact argument set the app will use in production. Anything that fails is
 * excluded, which is what makes the "Encoder: Automatic" label honest.
 */

import { ENCODER_TEST_TIMEOUT_MS } from '../../shared/constants';
import type { EncoderCapabilities, EncoderId, EncoderProbe } from '../../shared/types';
import { buildEncoderTestCommand } from './FfmpegCommandBuilder';
import type { ProbeRunner } from './runProbe';
import { runProbe } from './runProbe';

interface EncoderDefinition {
  id: EncoderId;
  label: string;
  hardware: boolean;
}

/** Preference order: NVENC, Quick Sync, AMF, then software. */
export const ENCODER_PREFERENCE: readonly EncoderDefinition[] = [
  { id: 'h264_nvenc', label: 'NVIDIA NVENC', hardware: true },
  { id: 'h264_qsv', label: 'Intel Quick Sync', hardware: true },
  { id: 'h264_amf', label: 'AMD AMF', hardware: true },
  { id: 'libx264', label: 'Software (libx264)', hardware: false },
];

export const SOFTWARE_ENCODER: EncoderId = 'libx264';

/** Extracts the set of H.264 encoders FFmpeg was built with. */
export function parseListedEncoders(output: string): Set<EncoderId> {
  const listed = new Set<EncoderId>();
  for (const definition of ENCODER_PREFERENCE) {
    // `-encoders` rows look like: ` V....D h264_nvenc   NVIDIA NVENC H.264 ...`
    const pattern = new RegExp(`^\\s*[A-Z.]{6}\\s+${definition.id}\\b`, 'm');
    if (pattern.test(output) || new RegExp(`\\b${definition.id}\\b`).test(output)) {
      listed.add(definition.id);
    }
  }
  return listed;
}

/**
 * Picks the best usable encoder from a set of probe results, honouring
 * `ENCODER_PREFERENCE` order.
 */
export function selectPreferredEncoder(probes: readonly EncoderProbe[]): EncoderId | null {
  for (const definition of ENCODER_PREFERENCE) {
    const probe = probes.find((candidate) => candidate.id === definition.id);
    if (probe?.usable) return probe.id;
  }
  return null;
}

/** Trims FFmpeg's error output down to something a diagnostics pane can show. */
export function summariseEncoderFailure(output: string): string {
  const lines = output
    .split(/\r\n|\n|\r/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .filter((line) => !/^\s*(built with|configuration:|lib[a-z]+\s)/i.test(line));

  const meaningful = lines.filter((line) =>
    /error|failed|cannot|unable|invalid|no /i.test(line),
  );
  const chosen = meaningful.length > 0 ? meaningful : lines;
  return chosen.slice(-3).join(' | ').slice(0, 400) || 'The encoder test produced no output.';
}

export interface EncoderDetectorOptions {
  getExecutable: () => string;
  runner?: ProbeRunner;
  /** Skip the synthetic encode test. Used only by unit tests. */
  skipRuntimeTest?: boolean;
  onLog?: (message: string) => void;
}

export class EncoderDetector {
  private cache: EncoderCapabilities | null = null;
  private inFlight: Promise<EncoderCapabilities> | null = null;
  private readonly runner: ProbeRunner;

  constructor(private readonly options: EncoderDetectorOptions) {
    this.runner = options.runner ?? runProbe;
  }

  get cached(): EncoderCapabilities | null {
    return this.cache;
  }

  async detect(force = false): Promise<EncoderCapabilities> {
    if (this.cache && !force) return this.cache;
    if (this.inFlight && !force) return this.inFlight;

    this.inFlight = this.run();
    try {
      this.cache = await this.inFlight;
      return this.cache;
    } finally {
      this.inFlight = null;
    }
  }

  private async run(): Promise<EncoderCapabilities> {
    const executable = this.options.getExecutable();
    const encodersOutput = await this.runner(executable, ['-hide_banner', '-encoders']);
    const listed = parseListedEncoders(encodersOutput.output);

    const probes: EncoderProbe[] = [];

    for (const definition of ENCODER_PREFERENCE) {
      const isListed = listed.has(definition.id);

      if (!isListed) {
        probes.push({
          id: definition.id,
          label: definition.label,
          listed: false,
          usable: false,
          detail: 'This FFmpeg build does not include the encoder.',
          hardware: definition.hardware,
        });
        continue;
      }

      if (this.options.skipRuntimeTest) {
        probes.push({
          id: definition.id,
          label: definition.label,
          listed: true,
          usable: true,
          detail: null,
          hardware: definition.hardware,
        });
        continue;
      }

      const test = await this.runner(
        executable,
        buildEncoderTestCommand(definition.id),
        ENCODER_TEST_TIMEOUT_MS,
      );

      const usable = test.code === 0 && !test.timedOut && !test.spawnError;
      const detail = usable
        ? null
        : test.timedOut
          ? 'The encoder test timed out.'
          : summariseEncoderFailure(test.output);

      this.options.onLog?.(
        `Encoder probe ${definition.id}: ${usable ? 'usable' : `unusable (${detail})`}`,
      );

      probes.push({
        id: definition.id,
        label: definition.label,
        listed: true,
        usable,
        detail,
        hardware: definition.hardware,
      });
    }

    return { probes, selected: selectPreferredEncoder(probes) };
  }

  invalidate(): void {
    this.cache = null;
  }
}
