/**
 * Ambient declarations so the renderer can import bundled image assets. Vite
 * turns each import into a hashed URL under the app's own origin, which the
 * strict `img-src 'self'` CSP allows.
 */

declare module '*.png' {
  const src: string;
  export default src;
}
declare module '*.jpg' {
  const src: string;
  export default src;
}
declare module '*.svg' {
  const src: string;
  export default src;
}
