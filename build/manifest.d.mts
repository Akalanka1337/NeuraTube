/**
 * Types for build/manifest.mjs.
 *
 * The manifest generator is authored in plain JavaScript because the build
 * script consumes it before any TypeScript exists, so this hand-written
 * declaration is what lets the unit tests import it type-safely.
 */

/** Match patterns for the content scripts and host permissions. */
export declare const MATCH_PATTERNS: readonly string[];

/** AI provider origins. Mirrors PROVIDER_ORIGINS in src/providers/specs.ts. */
export declare const PROVIDER_ORIGINS: readonly string[];

export declare function createManifest(options: {
  version: string;
  mode: 'development' | 'production';
}): Record<string, unknown>;
