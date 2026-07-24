import { resolve } from 'node:path';

import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      '@shared': resolve(__dirname, 'src/shared'),
      '@main': resolve(__dirname, 'src/main'),
    },
  },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    // The integration test spawns a real FFmpeg and encodes a few seconds of
    // synthetic video, so the default 5s timeout is far too tight.
    testTimeout: 120_000,
    hookTimeout: 60_000,
    reporters: ['default'],
  },
});
