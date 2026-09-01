/**
 * API key storage.
 *
 * WHY THIS IS A SEPARATE STORAGE KEY FROM EVERYTHING ELSE.
 *
 * Be clear about what this is and is not. It is NOT a security boundary: a
 * content script can read `chrome.storage.local` directly, so separating keys
 * from the main state blob does not stop a compromised content script from
 * reaching them.
 *
 * What it does buy is real anyway:
 *
 *  1. The panel's content script reads the main state blob on every page load,
 *     and logs it in debug mode. Keys are not in that object, so they cannot be
 *     pulled into the page's isolated world by routine operation.
 *  2. M2 shipped a diagnostics view that dumps state as JSON for support. If
 *     keys lived in that blob they would be one screenshot away from disclosure.
 *  3. The service worker reads credentials per call and nothing else does, so
 *     the set of code paths that touch a key is small enough to audit.
 *
 * Storage area is `local`, never `sync` — sync replicates to Google's servers
 * and caps items at 8KB. ESLint bans `chrome.storage.sync` repo-wide.
 *
 * Honest limitation, also stated in PRIVACY.md: `storage.local` is not encrypted
 * at rest. Any process that can read the Chrome profile directory can read these
 * keys, which is equally true of every bring-your-own-key extension.
 */

import { createLogger } from '~/lib/logger';
import { PROVIDER_IDS } from '~/providers/types';
import type { ProviderId } from '~/providers/types';

const log = createLogger('credentials');

/** Deliberately distinct from the main state key. */
export const CREDENTIALS_KEY = 'neuratube:credentials';

export type Credentials = Partial<Record<ProviderId, string>>;

function normalise(raw: unknown): Credentials {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return {};

  const out: Credentials = {};
  for (const id of PROVIDER_IDS) {
    const value = (raw as Record<string, unknown>)[id];
    // Trim: a key pasted from a web page routinely carries whitespace, and a
    // leading space produces a baffling 401.
    if (typeof value === 'string' && value.trim() !== '') out[id] = value.trim();
  }
  return out;
}

/** Read all stored keys. Never rejects. */
export async function readCredentials(): Promise<Credentials> {
  try {
    const bag = await chrome.storage.local.get(CREDENTIALS_KEY);
    return normalise(bag[CREDENTIALS_KEY]);
  } catch (error) {
    // Deliberately does not log the error object: a storage error can echo the
    // value it failed to write.
    log.warn('credential read failed', error instanceof Error ? error.name : 'unknown');
    return {};
  }
}

/**
 * Read one provider's key.
 *
 * Called per request by the service worker. Never cache the result in a module
 * variable: the worker is terminated after 30 seconds idle, so a cache buys
 * nothing, and it would serve a stale key after the user edits one.
 */
export async function readCredential(id: ProviderId): Promise<string | null> {
  return (await readCredentials())[id] ?? null;
}

/** Store or clear one provider's key. Passing an empty string removes it. */
export async function writeCredential(id: ProviderId, apiKey: string): Promise<boolean> {
  try {
    const current = await readCredentials();
    const trimmed = apiKey.trim();
    // Destructuring-omit rather than `delete`, per the project lint policy.
    const { [id]: _removed, ...rest } = current;
    const next: Credentials = trimmed === '' ? rest : { ...rest, [id]: trimmed };

    await chrome.storage.local.set({ [CREDENTIALS_KEY]: next });
    return true;
  } catch (error) {
    log.warn('credential write failed', error instanceof Error ? error.name : 'unknown');
    return false;
  }
}

/** Remove every stored key. Wired to the options page's reset control. */
export async function clearCredentials(): Promise<void> {
  try {
    await chrome.storage.local.remove(CREDENTIALS_KEY);
  } catch {
    // Nothing useful to do; the caller reports failure from a subsequent read.
  }
}

/** Which providers have a key stored. Safe to send anywhere — no values. */
export async function configuredProviders(): Promise<readonly ProviderId[]> {
  const credentials = await readCredentials();
  return PROVIDER_IDS.filter((id) => (credentials[id] ?? '') !== '');
}

/**
 * A masked form for display.
 *
 * Shows enough for the user to recognise which key is stored without exposing
 * it — the options page never round-trips a real key back to the UI.
 */
export function maskKey(apiKey: string): string {
  if (apiKey.length <= 10) return '••••••';
  return `${apiKey.slice(0, 6)}…${apiKey.slice(-4)}`;
}
