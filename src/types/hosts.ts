/**
 * The hostnames NeuraTube attaches to.
 *
 * This is the runtime counterpart to `MATCH_PATTERNS` in build/manifest.mjs.
 * The manifest is authored in plain JS because the build script consumes it
 * before TypeScript exists, so the two lists cannot literally share a module.
 * Instead, `tests/unit/manifest.test.ts` asserts they agree — drift fails CI
 * rather than shipping a content script that never matches, or host
 * permissions we do not use (which Chrome Web Store review penalises).
 */

export const SUPPORTED_HOSTNAMES = ['studio.youtube.com', 'www.youtube.com'] as const;

export type SupportedHostname = (typeof SUPPORTED_HOSTNAMES)[number];

const HOSTNAME_SET: ReadonlySet<string> = new Set(SUPPORTED_HOSTNAMES);

export function isSupportedHostname(hostname: string): hostname is SupportedHostname {
  return HOSTNAME_SET.has(hostname);
}

/** True if a full URL points at a surface we attach to. */
export function isSupportedUrl(href: string): boolean {
  try {
    const url = new URL(href);
    return url.protocol === 'https:' && isSupportedHostname(url.hostname);
  } catch {
    return false;
  }
}
