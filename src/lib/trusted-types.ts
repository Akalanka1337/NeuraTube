/**
 * https://github.com/Akalanka1337/NeuraTube
 * 
 * Trusted Types compatibility.
 *
 * Google enforces Trusted Types on YouTube (announced 2024-07-25) and states
 * plainly that third-party extension DOM manipulation which is not
 * Trusted-Types compliant "will be blocked by the browser". Under enforcement,
 * assigning a *string* to `innerHTML`, `outerHTML`, `insertAdjacentHTML` or
 * `script.src` throws a TypeError.
 *
 * NeuraTube's strategy is to never need a policy:
 *
 *  - The panel is built with Preact, which goes through `document.createElement`
 *    and property assignment. Those are not Trusted Types sinks.
 *  - Styles are injected as a constructed `CSSStyleSheet` via
 *    `adoptedStyleSheets`, not a `<style>` element with string content.
 *  - ESLint bans every string-HTML sink outright (see eslint.config.js).
 *
 * MEASURED BEHAVIOUR (Chromium 151, verified by tests/e2e):
 * with `require-trusted-types-for 'script'` served on the page, a
 * string-to-innerHTML assignment is
 *
 *   - BLOCKED (TypeError) in the MAIN world
 *   - ALLOWED in an ISOLATED-world content script
 *
 * Content scripts in the isolated world run under the *extension's* CSP, not
 * the page's, so the panel is exempt today. Two consequences:
 *
 *   1. Do not rely on that exemption. It is an implementation detail, Google's
 *      announcement explicitly warns extensions will break, and the panel costs
 *      nothing to keep compliant. The ESLint ban stays repo-wide.
 *   2. The M2 interceptor runs in the MAIN world and is therefore NOT exempt.
 *      It must never touch a string-HTML sink. It has no reason to — it patches
 *      function prototypes — but the constraint is real and load-bearing there.
 *
 * This module reports enforcement for the *calling world* so the debug view can
 * state the truth on a real Studio page, and exposes one narrow escape hatch
 * that shipped code does not currently use.
 */

import { createLogger } from './logger';

const log = createLogger('trusted-types');

/** Minimal structural types — `lib.dom` does not ship Trusted Types yet. */
interface TrustedTypePolicy {
  createHTML(input: string): string;
}
interface TrustedTypePolicyFactory {
  createPolicy(name: string, rules: { createHTML: (input: string) => string }): TrustedTypePolicy;
  readonly defaultPolicy: TrustedTypePolicy | null;
}

function factory(): TrustedTypePolicyFactory | undefined {
  return (globalThis as { trustedTypes?: TrustedTypePolicyFactory }).trustedTypes;
}

/**
 * Whether this document has a Trusted Types policy factory at all.
 *
 * A `true` result means the browser supports Trusted Types; it does not by
 * itself prove the page enforces them via CSP. Combined with a known-enforcing
 * origin (youtube.com), it is the signal we surface in the debug view.
 */
export function isTrustedTypesAvailable(): boolean {
  return typeof factory()?.createPolicy === 'function';
}

/**
 * Probe whether string-to-HTML assignment is actually blocked *in this world*.
 *
 * Performed against a detached element so nothing can touch the live document.
 * Returns `true` when the assignment threw, i.e. enforcement applies here.
 *
 * Expect `false` from an isolated-world content script even on a page that
 * enforces Trusted Types — see the note at the top of this file.
 */
export function isTrustedTypesEnforced(): boolean {
  if (!isTrustedTypesAvailable()) return false;
  try {
    const probe = document.createElement('div');
    // eslint-disable-next-line no-restricted-properties -- deliberate detached probe; this is the only place a string-HTML sink may be touched
    probe.innerHTML = '';
    return false;
  } catch {
    return true;
  }
}

let cachedPolicy: TrustedTypePolicy | null | undefined;

/**
 * Lazily create NeuraTube's policy.
 *
 * Deliberately identity-only: it does not sanitise. Any future caller must
 * pass markup that is already known-safe (built by us, never user or page
 * derived). Returns `null` when Trusted Types are unavailable or the page's CSP
 * refuses our policy name, in which case callers must fall back to node
 * construction.
 */
export function getTrustedTypesPolicy(): TrustedTypePolicy | null {
  if (cachedPolicy !== undefined) return cachedPolicy;

  const tt = factory();
  if (!tt) {
    cachedPolicy = null;
    return cachedPolicy;
  }

  try {
    cachedPolicy = tt.createPolicy('neuratube', { createHTML: (input) => input });
  } catch (error) {
    // `trusted-types` CSP directive did not allow our name. Expected on
    // hardened pages; node construction is unaffected.
    log.warn('policy creation refused, falling back to node construction', error);
    cachedPolicy = null;
  }
  return cachedPolicy;
}

/** Reset memoised state. Test-only. */
export function resetTrustedTypesCacheForTests(): void {
  cachedPolicy = undefined;
}
