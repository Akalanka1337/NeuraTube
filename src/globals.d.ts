/**
 * Build-time constants.
 *
 * https://github.com/Akalanka1337/NeuraTube
 *
 * Substituted by Vite's `define` at build time (see build/build.mjs) and by
 * Vitest's `define` in tests, so they are compile-time literals rather than
 * runtime lookups — which is why they are declared here rather than read off
 * `process.env` or `chrome.runtime.getManifest()`.
 */

/** Version from package.json, mirrored into the manifest. */
declare const __NEURATUBE_VERSION__: string;

/** True for development builds. Gates verbose logging and diagnostics. */
declare const __DEV__: boolean;
