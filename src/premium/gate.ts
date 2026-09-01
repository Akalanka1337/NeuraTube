/**
 * The premium boundary.
 *
 * https://github.com/Akalanka1337/NeuraTube
 * https://cyberscap.com
 * 
 * NeuraTube is open source. Anyone can fork this file, make `isPremium` return
 * true, and rebuild — in about a minute. That is fine, and it is the whole point
 * of the design: there is nothing behind this gate worth unlocking.
 *
 * Every premium capability (Stage 2) is a SERVER round trip:
 *
 *  - keyword and search-volume estimates are computed server-side,
 *  - the curated prompt library is served as JSON from an authenticated
 *    endpoint and is not in this repository,
 *  - managed inference uses our keys, which never ship.
 *
 * The server re-validates entitlement on every request. A patched client with
 * this function forced to `true` gets a 401 from every gated endpoint, and
 * Stage 2 has an explicit test asserting exactly that.
 *
 * So what is this for? Purely UX: it decides whether to show a feature as
 * available or as an upsell, and it lets the extension work offline without
 * blocking on a network call. It is NOT a security boundary and no code should
 * treat it as one.
 *
 * Chrome Web Store policy permits this shape explicitly: remotely fetched JSON
 * is data, not remote code, and only the extension's *logic* must be bundled.
 */

import type { TaskType } from '~/orchestrator/tasks';

/** Capabilities that will require a licence in Stage 2. */
export type PremiumFeature =
  /** Keyword and search-volume estimates. */
  | 'keyword-research'
  /** Curated prompt library, served from the API. */
  | 'vip-prompts'
  /** Inference paid for by us rather than the user's own key. */
  | 'managed-inference'
  /** Batched operations across a video catalogue. */
  | 'bulk-operations';

export interface Entitlement {
  readonly active: boolean;
  readonly features: readonly PremiumFeature[];
  /** Unix ms. Null when there is no licence. */
  readonly expiresAt: number | null;
}

/** No licence. The state every open-source build is in. */
export const NO_ENTITLEMENT: Entitlement = Object.freeze({
  active: false,
  features: Object.freeze([]),
  expiresAt: null,
});

/**
 * Current entitlement.
 *
 * Stage 2 replaces this with a cached, Ed25519-verified token read from storage.
 * Until then it is honestly and unconditionally "no licence" — not a stub that
 * pretends to check something.
 */
export function currentEntitlement(): Entitlement {
  return NO_ENTITLEMENT;
}

/** Whether a feature is available. UX only — see the note above. */
export function isPremium(feature: PremiumFeature): boolean {
  return currentEntitlement().features.includes(feature);
}

/**
 * Whether a task runs on the user's own key.
 *
 * Every task in v1 does. This exists so that when managed inference arrives, the
 * decision has one home rather than being spread across call sites.
 */
export function usesOwnKey(_task: TaskType): boolean {
  return !isPremium('managed-inference');
}
