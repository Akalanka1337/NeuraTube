/**
 * MAIN <-> ISOLATED world wire protocol.
 *
 * This is the hostile boundary. The MAIN world is shared with YouTube's own
 * code and with any other extension operating there, so everything arriving
 * from it is untrusted input.
 *
 * ============================================================================
 * WHAT THE NONCE ACTUALLY BUYS, AND WHAT IT DOES NOT
 * ============================================================================
 *
 * The original project brief used `window.postMessage({ __neuratube: true, ... }, '*')`
 * with the receiver keying only on the `__neuratube` marker. That is genuinely
 * unsafe: any page script could post a matching object and inject arbitrary
 * text straight into an AI prompt. So we added a nonce, an origin check and a
 * sequence number.
 *
 * But it is worth being precise, because it would be easy to over-claim:
 *
 *   A MAIN-world content script cannot hold a secret from the page.
 *
 * It has no `chrome.*` access, so it cannot read a nonce from extension
 * storage; the nonce has to be handed to it over `postMessage`, which every
 * script on the page can observe. A determined attacker specifically targeting
 * NeuraTube can read the nonce and forge messages. No amount of cryptography
 * fixes this — the shared heap is the vulnerability.
 *
 * So what is the point?
 *
 *  1. CONFIDENTIALITY IS MOOT HERE. The data we intercept is the page's own
 *     traffic, which the page already has. There is nothing to leak to it.
 *  2. The nonce and sequence number eliminate ACCIDENTAL cross-talk: other
 *     extensions in the MAIN world, stale interceptors after an extension
 *     reload, and replayed or duplicated messages.
 *  3. The origin and source checks eliminate CROSS-FRAME and CROSS-ORIGIN
 *     injection, which are real and cheap to attack otherwise.
 *  4. They raise casual spoofing from "post an object with one known key" to
 *     "actively race the handshake at document_start and track a rotating
 *     sequence" — worth the ~40 lines.
 *
 * The actual defence against a targeted attacker is downstream, and is not
 * optional:
 *
 *  - `validateEnvelope` rejects anything structurally wrong before it is
 *    touched. Nothing is trusted by shape alone.
 *  - Parsers coerce every field and never assume a type (`src/parsers/`).
 *  - Intercepted content is never executed, never becomes HTML, and never
 *    reaches a privileged API.
 *  - From M5, AI prompts must treat video metadata as quoted data, not as
 *    instructions, precisely because this channel can be poisoned. That is a
 *    prompt-construction requirement, recorded here so it is not forgotten.
 *
 * This module must stay free of `chrome.*` and of any DOM dependency beyond
 * `postMessage`, because it is bundled into the MAIN-world script.
 */

import type { RouteKind } from './routes';

/** Bumped when the envelope shape changes incompatibly. */
export const WIRE_VERSION = 1 as const;

/** Marker key. Deliberately obscure to avoid collision, not for security. */
export const WIRE_MARKER = '__neuratube_wire';

/** Handshake message: ISOLATED -> MAIN, carrying the session nonce. */
export const HELLO_MARKER = '__neuratube_hello';

/** A captured InnerTube exchange. */
export interface CapturedExchange {
  readonly kind: RouteKind;
  readonly url: string;
  readonly method: string;
  readonly status: number;
  /** Raw response body. Empty string when the body was unreadable or skipped. */
  readonly responseText: string;
  /** Raw request body, when the transport exposed one. */
  readonly requestBody: string | null;
  /** `performance.now()` at capture, for staleness checks. */
  readonly at: number;
  /** Why the body is absent, when it is. */
  readonly skipped: SkipReason | null;
}

/** Reasons a matched response's body was not captured. */
export type SkipReason = 'too-large' | 'unreadable-response-type' | 'read-failed' | 'aborted';

/** The envelope every MAIN -> ISOLATED message travels in. */
export interface WireEnvelope {
  readonly [WIRE_MARKER]: typeof WIRE_VERSION;
  readonly nonce: string;
  /** Monotonically increasing per session. Detects replay and gaps. */
  readonly seq: number;
  readonly exchange: CapturedExchange;
}

export interface HelloMessage {
  readonly [HELLO_MARKER]: typeof WIRE_VERSION;
  readonly nonce: string;
}

/** Largest response body we will move across the boundary: 4 MB. */
export const MAX_BODY_BYTES = 4 * 1024 * 1024;

const VALID_SKIP_REASONS: ReadonlySet<string> = new Set<SkipReason>([
  'too-large',
  'unreadable-response-type',
  'read-failed',
  'aborted',
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Build a hello message. Called by the isolated world. */
export function createHello(nonce: string): HelloMessage {
  return { [HELLO_MARKER]: WIRE_VERSION, nonce };
}

/** Recognise a hello. Called by the MAIN world, so it must not throw. */
export function parseHello(data: unknown): HelloMessage | null {
  if (!isRecord(data)) return null;
  if (data[HELLO_MARKER] !== WIRE_VERSION) return null;
  const nonce = data.nonce;
  // A nonce is a UUID; anything else is not ours.
  if (typeof nonce !== 'string' || nonce.length < 16 || nonce.length > 64) return null;
  return { [HELLO_MARKER]: WIRE_VERSION, nonce };
}

/** Build an envelope. Called by the MAIN world. */
export function createEnvelope(
  nonce: string,
  seq: number,
  exchange: CapturedExchange,
): WireEnvelope {
  return { [WIRE_MARKER]: WIRE_VERSION, nonce, seq, exchange };
}

export type ValidationFailure =
  | 'not-ours'
  | 'wrong-version'
  | 'bad-nonce'
  | 'bad-sequence'
  | 'malformed-exchange'
  | 'body-too-large';

export type ValidationResult =
  | { readonly ok: true; readonly envelope: WireEnvelope }
  | { readonly ok: false; readonly reason: ValidationFailure };

/**
 * Validate an inbound message.
 *
 * Called by the isolated world for every `message` event on the window — which
 * on YouTube includes a great deal of the page's own traffic — so the reject
 * path is ordered cheapest-first and never throws.
 *
 * `expectedNonce` and `lastSeq` are supplied by the caller rather than held
 * here, because this module is shared with the MAIN world and must not own
 * session state.
 */
export function validateEnvelope(
  data: unknown,
  expectedNonce: string,
  lastSeq: number,
): ValidationResult {
  if (!isRecord(data)) return { ok: false, reason: 'not-ours' };

  const marker = data[WIRE_MARKER];
  if (marker === undefined) return { ok: false, reason: 'not-ours' };
  if (marker !== WIRE_VERSION) return { ok: false, reason: 'wrong-version' };

  // Constant-time comparison is pointless here: the nonce is observable to the
  // page by construction (see the note at the top of this file).
  if (data.nonce !== expectedNonce) return { ok: false, reason: 'bad-nonce' };

  const seq = data.seq;
  // Strictly increasing. Rejects replays and duplicate deliveries.
  if (typeof seq !== 'number' || !Number.isInteger(seq) || seq <= lastSeq) {
    return { ok: false, reason: 'bad-sequence' };
  }

  const exchange = data.exchange;
  if (!isRecord(exchange)) return { ok: false, reason: 'malformed-exchange' };

  const kind = exchange.kind;
  const url = exchange.url;
  const method = exchange.method;
  const status = exchange.status;
  const responseText = exchange.responseText;
  const requestBody = exchange.requestBody;
  const at = exchange.at;
  const skipped = exchange.skipped;

  if (typeof kind !== 'string' || kind.length === 0)
    return { ok: false, reason: 'malformed-exchange' };
  if (typeof url !== 'string') return { ok: false, reason: 'malformed-exchange' };
  if (typeof method !== 'string') return { ok: false, reason: 'malformed-exchange' };
  if (typeof status !== 'number' || !Number.isFinite(status)) {
    return { ok: false, reason: 'malformed-exchange' };
  }
  if (typeof responseText !== 'string') return { ok: false, reason: 'malformed-exchange' };
  if (requestBody !== null && typeof requestBody !== 'string') {
    return { ok: false, reason: 'malformed-exchange' };
  }
  if (typeof at !== 'number' || !Number.isFinite(at)) {
    return { ok: false, reason: 'malformed-exchange' };
  }
  if (skipped !== null && (typeof skipped !== 'string' || !VALID_SKIP_REASONS.has(skipped))) {
    return { ok: false, reason: 'malformed-exchange' };
  }

  // A body over the cap indicates either a bug in our own sender or a
  // deliberate attempt to exhaust memory in the isolated world.
  if (responseText.length > MAX_BODY_BYTES) return { ok: false, reason: 'body-too-large' };

  return {
    ok: true,
    envelope: {
      [WIRE_MARKER]: WIRE_VERSION,
      nonce: expectedNonce,
      seq,
      exchange: {
        kind: kind as RouteKind,
        url,
        method,
        status,
        responseText,
        requestBody,
        at,
        skipped: skipped as SkipReason | null,
      },
    },
  };
}
