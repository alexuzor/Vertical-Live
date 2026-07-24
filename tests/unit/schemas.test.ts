/**
 * IPC and settings validation. The renderer is untrusted input, so these
 * schemas are the boundary that keeps a malformed (or malicious) payload from
 * reaching FFmpeg.
 */

import { describe, expect, it } from 'vitest';

import {
  BITRATE_PRESETS,
  MAX_CUSTOM_BITRATE_KBPS,
  MIN_CUSTOM_BITRATE_KBPS,
} from '../../src/shared/constants';
import {
  DEFAULT_SETTINGS,
  coerceFps,
  facebookServerUrlSchema,
  parseSettingsLenient,
  persistedSettingsSchema,
  resolveBitrateKbps,
  saveSettingsRequestSchema,
  streamKeySchema,
  validatedStreamConfigSchema,
} from '../../src/shared/schemas';

const VALID_CONFIG = {
  cameraDevice: 'Integrated Camera',
  microphoneDevice: 'Microphone (Realtek)',
  framingMode: 'fill' as const,
  fps: 30,
  bitrateKbps: 3500,
  facebookServerUrl: 'rtmps://live-api-s.facebook.com:443/rtmp/',
  facebookStreamKey: 'FB-1234-abcd',
  recordingEnabled: false,
  recordingDirectory: null,
  audioSyncOffsetMs: 0,
};

describe('facebookServerUrlSchema', () => {
  it('accepts rtmps and rtmp', () => {
    expect(
      facebookServerUrlSchema.safeParse('rtmps://live-api-s.facebook.com:443/rtmp/').success,
    ).toBe(true);
    expect(
      facebookServerUrlSchema.safeParse('rtmp://live-api-s.facebook.com/rtmp/').success,
    ).toBe(true);
  });

  it('rejects other schemes', () => {
    for (const url of ['https://x.com/rtmp', 'file:///c/', 'ftp://x', 'javascript:alert(1)']) {
      expect(facebookServerUrlSchema.safeParse(url).success).toBe(false);
    }
  });

  it('rejects a URL carrying userinfo, which could smuggle credentials', () => {
    expect(
      facebookServerUrlSchema.safeParse('rtmps://user:pass@x.facebook.com/rtmp').success,
    ).toBe(false);
  });

  it('rejects an empty value', () => {
    expect(facebookServerUrlSchema.safeParse('   ').success).toBe(false);
  });

  it('trims whitespace', () => {
    const result = facebookServerUrlSchema.safeParse('  rtmps://x.facebook.com/rtmp/  ');
    expect(result.success).toBe(true);
    if (result.success) expect(result.data).toBe('rtmps://x.facebook.com/rtmp/');
  });
});

describe('streamKeySchema', () => {
  it('accepts a realistic Facebook key with query parameters', () => {
    expect(streamKeySchema.safeParse('FB-123456?s_bl=1&s_sw=0&s_vt=api-s&a=AbCd').success).toBe(
      true,
    );
  });

  it('rejects an empty key', () => {
    expect(streamKeySchema.safeParse('').success).toBe(false);
    expect(streamKeySchema.safeParse('    ').success).toBe(false);
  });

  it('rejects whitespace and control characters that would break the URL', () => {
    expect(streamKeySchema.safeParse('key with space').success).toBe(false);
    expect(streamKeySchema.safeParse('key\nnewline').success).toBe(false);
    expect(streamKeySchema.safeParse('key\u0000null').success).toBe(false);
  });

  it('trims surrounding whitespace', () => {
    const result = streamKeySchema.safeParse('  KEY123  ');
    expect(result.success).toBe(true);
    if (result.success) expect(result.data).toBe('KEY123');
  });
});

describe('validatedStreamConfigSchema', () => {
  it('accepts a complete valid config', () => {
    expect(validatedStreamConfigSchema.safeParse(VALID_CONFIG).success).toBe(true);
  });

  it('allows a null microphone (camera-only broadcast)', () => {
    expect(
      validatedStreamConfigSchema.safeParse({ ...VALID_CONFIG, microphoneDevice: null })
        .success,
    ).toBe(true);
  });

  it('rejects an unsupported frame rate', () => {
    for (const fps of [15, 29, 60, 0, -30]) {
      expect(validatedStreamConfigSchema.safeParse({ ...VALID_CONFIG, fps }).success).toBe(
        false,
      );
    }
  });

  it('accepts every supported frame rate', () => {
    for (const fps of [24, 25, 30]) {
      expect(validatedStreamConfigSchema.safeParse({ ...VALID_CONFIG, fps }).success).toBe(
        true,
      );
    }
  });

  it('enforces the bitrate bounds', () => {
    expect(
      validatedStreamConfigSchema.safeParse({ ...VALID_CONFIG, bitrateKbps: 1999 }).success,
    ).toBe(false);
    expect(
      validatedStreamConfigSchema.safeParse({ ...VALID_CONFIG, bitrateKbps: 6001 }).success,
    ).toBe(false);
    expect(
      validatedStreamConfigSchema.safeParse({ ...VALID_CONFIG, bitrateKbps: 2000 }).success,
    ).toBe(true);
    expect(
      validatedStreamConfigSchema.safeParse({ ...VALID_CONFIG, bitrateKbps: 6000 }).success,
    ).toBe(true);
  });

  it('rejects a non-integer bitrate', () => {
    expect(
      validatedStreamConfigSchema.safeParse({ ...VALID_CONFIG, bitrateKbps: 3500.5 }).success,
    ).toBe(false);
  });

  it('rejects recording without a folder', () => {
    const result = validatedStreamConfigSchema.safeParse({
      ...VALID_CONFIG,
      recordingEnabled: true,
      recordingDirectory: null,
    });
    expect(result.success).toBe(false);
  });

  it('accepts recording with a folder', () => {
    expect(
      validatedStreamConfigSchema.safeParse({
        ...VALID_CONFIG,
        recordingEnabled: true,
        recordingDirectory: 'C:\\Users\\me\\Videos',
      }).success,
    ).toBe(true);
  });

  it('rejects an empty camera', () => {
    expect(
      validatedStreamConfigSchema.safeParse({ ...VALID_CONFIG, cameraDevice: '' }).success,
    ).toBe(false);
  });

  it('rejects unknown framing modes', () => {
    expect(
      validatedStreamConfigSchema.safeParse({ ...VALID_CONFIG, framingMode: 'stretch' })
        .success,
    ).toBe(false);
  });

  it('rejects a completely wrong payload shape', () => {
    expect(validatedStreamConfigSchema.safeParse(null).success).toBe(false);
    expect(validatedStreamConfigSchema.safeParse('nope').success).toBe(false);
    expect(validatedStreamConfigSchema.safeParse({}).success).toBe(false);
  });
});

describe('resolveBitrateKbps', () => {
  it('maps each named preset to its documented value', () => {
    expect(resolveBitrateKbps('data-saver', 0)).toBe(2500);
    expect(resolveBitrateKbps('standard', 0)).toBe(3500);
    expect(resolveBitrateKbps('high', 0)).toBe(5000);
    expect(resolveBitrateKbps('maximum', 0)).toBe(6000);
  });

  it('matches the exported preset table', () => {
    expect(BITRATE_PRESETS['data-saver']).toBe(2500);
    expect(BITRATE_PRESETS.standard).toBe(3500);
    expect(BITRATE_PRESETS.high).toBe(5000);
    expect(BITRATE_PRESETS.maximum).toBe(6000);
  });

  it('uses the custom value when the preset is custom', () => {
    expect(resolveBitrateKbps('custom', 4200)).toBe(4200);
  });

  it('clamps a custom value into range', () => {
    expect(resolveBitrateKbps('custom', 100)).toBe(MIN_CUSTOM_BITRATE_KBPS);
    expect(resolveBitrateKbps('custom', 99_999)).toBe(MAX_CUSTOM_BITRATE_KBPS);
  });

  it('rounds a fractional custom value', () => {
    expect(resolveBitrateKbps('custom', 3500.7)).toBe(3501);
  });
});

describe('coerceFps', () => {
  it('passes supported rates through', () => {
    expect(coerceFps(24)).toBe(24);
    expect(coerceFps(25)).toBe(25);
    expect(coerceFps(30)).toBe(30);
  });

  it('falls back to 30 for anything else', () => {
    expect(coerceFps(60)).toBe(30);
    expect(coerceFps(0)).toBe(30);
  });
});

describe('parseSettingsLenient', () => {
  it('returns defaults for a missing file', () => {
    expect(parseSettingsLenient(undefined).settings).toEqual(DEFAULT_SETTINGS);
    expect(parseSettingsLenient(null).settings).toEqual(DEFAULT_SETTINGS);
  });

  it('returns defaults for a non-object', () => {
    const { settings, repaired } = parseSettingsLenient('garbage');
    expect(settings).toEqual(DEFAULT_SETTINGS);
    expect(repaired.length).toBeGreaterThan(0);
  });

  it('keeps valid fields and repairs only the broken ones', () => {
    const { settings, repaired } = parseSettingsLenient({
      framingMode: 'fit',
      fps: 999,
      bitratePreset: 'high',
      cameraDevice: 'My Cam',
      recordingEnabled: 'yes-please',
    });

    expect(settings.framingMode).toBe('fit');
    expect(settings.cameraDevice).toBe('My Cam');
    expect(settings.bitratePreset).toBe('high');
    expect(settings.fps).toBe(DEFAULT_SETTINGS.fps);
    expect(settings.recordingEnabled).toBe(DEFAULT_SETTINGS.recordingEnabled);
    expect(repaired).toContain('fps');
    expect(repaired).toContain('recordingEnabled');
  });

  it('keeps the custom bitrate coherent with a named preset', () => {
    const { settings } = parseSettingsLenient({
      bitratePreset: 'maximum',
      customBitrateKbps: 2000,
    });
    expect(settings.customBitrateKbps).toBe(6000);
  });

  it('preserves an explicit custom bitrate', () => {
    const { settings } = parseSettingsLenient({
      bitratePreset: 'custom',
      customBitrateKbps: 4321,
    });
    expect(settings.customBitrateKbps).toBe(4321);
  });

  it('never resurrects a stream key from the settings file', () => {
    const { settings } = parseSettingsLenient({
      facebookStreamKey: 'SHOULD-NOT-SURVIVE',
      framingMode: 'fit',
    });
    expect(JSON.stringify(settings)).not.toContain('SHOULD-NOT-SURVIVE');
  });

  it('validates restored window bounds', () => {
    const good = parseSettingsLenient({
      windowBounds: { x: 10, y: 20, width: 1200, height: 800 },
    });
    expect(good.settings.windowBounds).toEqual({ x: 10, y: 20, width: 1200, height: 800 });

    const bad = parseSettingsLenient({
      windowBounds: { x: 'a', y: 20, width: 1200, height: 800 },
    });
    expect(bad.settings.windowBounds).toBeNull();
  });
});

describe('DEFAULT_SETTINGS', () => {
  it('defaults to 30 fps and the standard 3500 Kbps preset', () => {
    expect(DEFAULT_SETTINGS.fps).toBe(30);
    expect(DEFAULT_SETTINGS.bitratePreset).toBe('standard');
    expect(DEFAULT_SETTINGS.customBitrateKbps).toBe(3500);
  });

  it('defaults to fill framing', () => {
    expect(DEFAULT_SETTINGS.framingMode).toBe('fill');
  });

  it('is itself valid', () => {
    expect(persistedSettingsSchema.safeParse(DEFAULT_SETTINGS).success).toBe(true);
  });

  it('contains no credentials', () => {
    expect(Object.keys(DEFAULT_SETTINGS)).not.toContain('facebookStreamKey');
  });
});

describe('saveSettingsRequestSchema', () => {
  it('accepts a partial settings patch', () => {
    expect(saveSettingsRequestSchema.safeParse({ settings: { fps: 24 } }).success).toBe(true);
  });

  it('accepts an explicit null stream key to clear it', () => {
    expect(saveSettingsRequestSchema.safeParse({ settings: {}, streamKey: null }).success).toBe(
      true,
    );
  });

  it('rejects an invalid stream key', () => {
    expect(
      saveSettingsRequestSchema.safeParse({ settings: {}, streamKey: 'has space' }).success,
    ).toBe(false);
  });

  it('distinguishes an omitted key from an explicit null', () => {
    const omitted = saveSettingsRequestSchema.parse({ settings: {} });
    expect('streamKey' in omitted).toBe(false);

    const cleared = saveSettingsRequestSchema.parse({ settings: {}, streamKey: null });
    expect(cleared.streamKey).toBeNull();
  });
});
