/**
 * Build stamp, injected at compile time by electron-vite's `define`
 * (see electron.vite.config.ts). It lets a running app prove exactly which
 * source it was built from — the antidote to "is dev actually running my
 * changes?".
 *
 * `typeof` guards keep this safe when the defines are absent (e.g. under Vitest,
 * which does not apply the electron-vite config): `typeof` never throws on an
 * undeclared identifier, so the fallbacks apply cleanly.
 */

declare const __BUILD_REV__: string | undefined;
declare const __BUILD_TIME__: string | undefined;

/** Short git revision (with `-dirty` when the tree had uncommitted changes). */
export const BUILD_REV: string = typeof __BUILD_REV__ !== 'undefined' ? __BUILD_REV__ : 'dev';

/** ISO timestamp of the build, or empty when unstamped. */
export const BUILD_TIME: string = typeof __BUILD_TIME__ !== 'undefined' ? __BUILD_TIME__ : '';
