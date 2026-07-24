import { resolve } from 'node:path';

import react from '@vitejs/plugin-react';
import { defineConfig, externalizeDepsPlugin } from 'electron-vite';
import type { Plugin } from 'vite';

/**
 * Content Security Policy for the renderer.
 *
 * Production is strict: no remote origins at all, no inline or eval'd script.
 * Development additionally allows the Vite dev server origin plus its websocket
 * and the inline bootstrap that React Fast Refresh injects.
 */
const PROD_CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' blob: data:",
  "font-src 'self'",
  "connect-src 'self'",
  "media-src 'self' blob:",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
  "worker-src 'self' blob:",
].join('; ');

const DEV_CSP = [
  "default-src 'none'",
  "script-src 'self' 'unsafe-inline' 'unsafe-eval' http://localhost:* ws://localhost:*",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' blob: data:",
  "font-src 'self' data:",
  "connect-src 'self' http://localhost:* ws://localhost:*",
  "media-src 'self' blob:",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
  "worker-src 'self' blob:",
].join('; ');

/**
 * Swaps the `%CSP%` placeholder in index.html for the mode-appropriate policy so
 * the shipped HTML always carries a real, strict CSP.
 */
function cspPlugin(): Plugin {
  let isDev = false;
  return {
    name: 'vertical-live-csp',
    configResolved(config) {
      isDev = config.command === 'serve';
    },
    transformIndexHtml(html) {
      return html.replace('%CSP%', isDev ? DEV_CSP : PROD_CSP);
    },
  };
}

export default defineConfig({
  main: {
    // electron-updater is the one true runtime dependency: it must be required
    // from node_modules at runtime (it reads app-update.yml and spawns the
    // installer), so it is externalized here rather than bundled into main.js.
    // electron-builder then packs it — and only it — from the production
    // `dependencies`. Everything else (zod, etc.) stays a devDependency and is
    // bundled, so the app remains "out/ + package.json + electron-updater".
    plugins: [externalizeDepsPlugin()],
    build: {
      outDir: 'out/main',
      // Deliberately unminified: source maps are excluded from the installer,
      // so readable identifiers are what make a packaged-app stack trace in
      // the log file diagnosable.
      minify: false,
      sourcemap: true,
      rollupOptions: {
        input: { main: resolve(__dirname, 'src/main/main.ts') },
        output: { entryFileNames: '[name].js' },
      },
    },
    resolve: {
      alias: {
        '@shared': resolve(__dirname, 'src/shared'),
        '@main': resolve(__dirname, 'src/main'),
      },
    },
  },
  preload: {
    build: {
      outDir: 'out/preload',
      minify: false,
      sourcemap: true,
      rollupOptions: {
        input: { preload: resolve(__dirname, 'src/preload/preload.ts') },
        // The preload runs sandboxed, so it must be a single self-contained
        // CommonJS file with no runtime imports.
        output: { format: 'cjs', entryFileNames: '[name].js', inlineDynamicImports: true },
      },
    },
    resolve: {
      alias: { '@shared': resolve(__dirname, 'src/shared') },
    },
  },
  renderer: {
    root: resolve(__dirname, 'src/renderer'),
    build: {
      outDir: resolve(__dirname, 'out/renderer'),
      // The renderer is pure UI and reports failures through the app's own
      // error banner, so minifying it costs no diagnosability.
      minify: 'esbuild',
      sourcemap: true,
      rollupOptions: {
        input: { index: resolve(__dirname, 'src/renderer/index.html') },
      },
    },
    resolve: {
      alias: {
        '@shared': resolve(__dirname, 'src/shared'),
        '@renderer': resolve(__dirname, 'src/renderer'),
      },
    },
    plugins: [react(), cspPlugin()],
  },
});
