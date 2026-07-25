/**
 * Zod schemas used to validate every IPC payload before the main process acts
 * on it, and to validate settings loaded from disk.
 *
 * The renderer is treated as untrusted input: nothing crosses the bridge
 * without passing through one of these.
 */

import { z } from 'zod';

import {
  BITRATE_PRESETS,
  MAX_AUDIO_SYNC_OFFSET_MS,
  MAX_CUSTOM_BITRATE_KBPS,
  MIN_AUDIO_SYNC_OFFSET_MS,
  MIN_CUSTOM_BITRATE_KBPS,
} from './constants';
import type { BitratePreset, PersistedSettings, StreamConfig } from './types';

export const framingModeSchema = z.enum(['fill', 'fit']);

export const streamFpsSchema = z.union([z.literal(24), z.literal(25), z.literal(30)]);

export const bitratePresetSchema = z.enum([
  'data-saver',
  'standard',
  'high',
  'maximum',
  'custom',
] as const satisfies readonly BitratePreset[]);

/** Device identifiers are DirectShow names; only length and type are enforced. */
export const deviceIdSchema = z.string().trim().min(1).max(512);

/**
 * A Facebook ingest URL. Only rtmp/rtmps are accepted, and only a host plus an
 * application path — never a userinfo section, which could smuggle credentials
 * into logs.
 */
export const facebookServerUrlSchema = z
  .string()
  .trim()
  .min(1, 'A Facebook server URL is required.')
  .max(2048)
  .refine((value) => /^rtmps?:\/\//i.test(value), {
    message: 'The server URL must start with rtmps:// or rtmp://.',
  })
  .refine(
    (value) => {
      try {
        // The WHATWG URL parser does not know rtmp, so normalise to https for
        // structural checks only.
        const probe = new URL(value.replace(/^rtmps?:/i, 'https:'));
        return probe.hostname.length > 0 && probe.username === '' && probe.password === '';
      } catch {
        return false;
      }
    },
    { message: 'The server URL is not a valid address.' },
  );

/**
 * Facebook stream keys are opaque and may legitimately contain `?`, `&`, `=`,
 * `-` and `_`. We only reject whitespace and control characters, which would
 * break the RTMP URL, and obviously-empty values.
 */
export const streamKeySchema = z
  .string()
  .trim()
  .min(1, 'A stream key is required.')
  .max(2048)
  // eslint-disable-next-line no-control-regex
  .refine((value) => !/[\s\u0000-\u001F\u007F]/.test(value), {
    message: 'The stream key must not contain spaces or line breaks.',
  });

export const bitrateKbpsSchema = z
  .number()
  .int()
  .min(MIN_CUSTOM_BITRATE_KBPS)
  .max(MAX_CUSTOM_BITRATE_KBPS);

export const recordingDirectorySchema = z.string().trim().min(1).max(4096);

export const audioSyncOffsetMsSchema = z
  .number()
  .int()
  .min(MIN_AUDIO_SYNC_OFFSET_MS)
  .max(MAX_AUDIO_SYNC_OFFSET_MS);

export const previewConfigSchema = z.object({
  cameraDevice: deviceIdSchema,
  framingMode: framingModeSchema,
  fps: streamFpsSchema,
});

/** The standalone preview audio meter: a microphone to monitor, or null to stop. */
export const meterConfigSchema = z.object({
  microphoneDevice: deviceIdSchema.nullable(),
});

/** Toggle the independent mid-stream recording tap on or off. */
export const streamRecordingRequestSchema = z.object({ on: z.boolean() });

export const streamConfigSchema = z.object({
  cameraDevice: deviceIdSchema,
  microphoneDevice: deviceIdSchema.nullable(),
  framingMode: framingModeSchema,
  fps: streamFpsSchema,
  bitrateKbps: bitrateKbpsSchema,
  facebookServerUrl: facebookServerUrlSchema,
  facebookStreamKey: streamKeySchema,
  recordingEnabled: z.boolean(),
  recordingDirectory: recordingDirectorySchema.nullable(),
  audioSyncOffsetMs: audioSyncOffsetMsSchema,
  noiseSuppression: z.boolean(),
});

/** Recording cannot be enabled without somewhere to write to. */
export const validatedStreamConfigSchema = streamConfigSchema.refine(
  (config) => !config.recordingEnabled || Boolean(config.recordingDirectory),
  {
    message: 'Choose a recording folder before enabling recording.',
    path: ['recordingDirectory'],
  },
);

export const recordingConfigSchema = z.object({
  cameraDevice: deviceIdSchema,
  microphoneDevice: deviceIdSchema.nullable(),
  framingMode: framingModeSchema,
  fps: streamFpsSchema,
  recordingDirectory: recordingDirectorySchema,
  audioSyncOffsetMs: audioSyncOffsetMsSchema,
  noiseSuppression: z.boolean(),
});

export const testConnectionRequestSchema = z.object({
  facebookServerUrl: facebookServerUrlSchema,
});

export const systemMetricsRequestSchema = z.object({
  recordingDirectory: recordingDirectorySchema.nullable().optional(),
});

export const windowBoundsSchema = z.object({
  x: z.number().int(),
  y: z.number().int(),
  width: z.number().int().min(320).max(16384),
  height: z.number().int().min(240).max(16384),
});

export const persistedSettingsSchema = z.object({
  cameraDevice: deviceIdSchema.nullable(),
  microphoneDevice: deviceIdSchema.nullable(),
  audioEnabled: z.boolean(),
  framingMode: framingModeSchema,
  fps: streamFpsSchema,
  bitratePreset: bitratePresetSchema,
  customBitrateKbps: bitrateKbpsSchema,
  // Persisted URLs may legitimately be empty until the user types one, so this
  // is deliberately looser than `facebookServerUrlSchema`.
  facebookServerUrl: z.string().trim().max(2048),
  recordingEnabled: z.boolean(),
  recordingDirectory: recordingDirectorySchema.nullable(),
  rememberStreamKey: z.boolean(),
  audioSyncOffsetMs: audioSyncOffsetMsSchema,
  noiseSuppression: z.boolean(),
  windowBounds: windowBoundsSchema.nullable(),
});

export const saveSettingsRequestSchema = z.object({
  settings: persistedSettingsSchema.partial(),
  streamKey: z.union([streamKeySchema, z.null()]).optional(),
});

export const listDevicesRequestSchema = z.object({ refresh: z.boolean().optional() });
export const detectEncodersRequestSchema = z.object({ force: z.boolean().optional() });
export const deviceCapabilitiesRequestSchema = z.object({ deviceId: deviceIdSchema });
export const openFolderRequestSchema = z.object({ path: recordingDirectorySchema });

export const DEFAULT_SETTINGS: PersistedSettings = {
  cameraDevice: null,
  microphoneDevice: null,
  audioEnabled: true,
  framingMode: 'fill',
  fps: 30,
  bitratePreset: 'standard',
  customBitrateKbps: BITRATE_PRESETS.standard,
  facebookServerUrl: 'rtmps://live-api-s.facebook.com:443/rtmp/',
  recordingEnabled: false,
  recordingDirectory: null,
  rememberStreamKey: true,
  audioSyncOffsetMs: 0,
  noiseSuppression: false,
  windowBounds: null,
};

/**
 * Parses settings loaded from disk, discarding individual invalid fields rather
 * than throwing away the whole file.
 */
export function parseSettingsLenient(raw: unknown): {
  settings: PersistedSettings;
  repaired: string[];
} {
  const repaired: string[] = [];
  const result: PersistedSettings = { ...DEFAULT_SETTINGS };

  if (typeof raw !== 'object' || raw === null) {
    return { settings: result, repaired: ['settings file was not an object'] };
  }

  const source = raw as Record<string, unknown>;
  const shape = persistedSettingsSchema.shape;

  for (const key of Object.keys(shape) as (keyof PersistedSettings)[]) {
    if (!(key in source)) continue;
    const fieldSchema = shape[key] as z.ZodType;
    const parsed = fieldSchema.safeParse(source[key]);
    if (parsed.success) {
      // The per-field schema guarantees the runtime type matches the field.
      (result as unknown as Record<string, unknown>)[key] = parsed.data;
    } else {
      repaired.push(String(key));
    }
  }

  // Keep the custom bitrate coherent with the chosen preset.
  if (result.bitratePreset !== 'custom') {
    result.customBitrateKbps = BITRATE_PRESETS[result.bitratePreset];
  }

  return { settings: result, repaired };
}

// Re-exported for convenience: these are pure helpers with no Zod dependency,
// so the renderer imports them from `constants` directly instead.
export { coerceFps, resolveBitrateKbps } from './constants';

export type ValidatedStreamConfig = z.infer<typeof validatedStreamConfigSchema> & StreamConfig;
