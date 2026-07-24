/**
 * Standalone Vite config for visually previewing the renderer in a plain
 * browser (no Electron). The bridge falls back to the mock, so the dashboard is
 * fully interactive for screenshot comparison. Not used for production builds.
 */

import { resolve } from 'node:path';

import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
import type { Plugin } from 'vite';

function cspPlugin(): Plugin {
  return {
    name: 'preview-csp',
    transformIndexHtml(html) {
      // Permissive policy for local preview only.
      return html.replace(
        '%CSP%',
        "default-src 'self'; img-src 'self' blob: data:; style-src 'self' 'unsafe-inline'; " +
          "script-src 'self' 'unsafe-inline' 'unsafe-eval'; connect-src 'self' ws:;",
      );
    },
  };
}

export default defineConfig({
  root: resolve(__dirname, 'src/renderer'),
  resolve: {
    alias: {
      '@shared': resolve(__dirname, 'src/shared'),
      '@renderer': resolve(__dirname, 'src/renderer'),
    },
  },
  plugins: [react(), cspPlugin()],
  server: { port: 5199, strictPort: true },
});
