/**
 * https://github.com/Akalanka1337/NeuraTube
 *
 * ISOLATED-world side of the transport.
 *
 * Generates the session nonce, performs the handshake, and validates every
 * inbound message before anything downstream sees it. Read the note at the top
 * of `protocol.ts` for an honest account of what that validation does and does
 * not protect against — in short, it stops accidents and casual injection, and
 * the real defence against a targeted attacker is that nothing here is trusted
 * by shape alone and nothing intercepted is ever executed.
 */

import { createLogger } from '~/lib/logger';
import type { CapturedExchange, ValidationFailure } from './protocol';
import { createHello, validateEnvelope } from './protocol';

const log = createLogger('receiver');

export interface ReceiverStats {
  /** Envelopes accepted. */
  accepted: number;
  /** Envelopes rejected, by reason. */
  rejected: Record<ValidationFailure, number>;
  /** Whether the handshake has been sent. */
  handshakeSent: boolean;
}

export interface Receiver {
  readonly stats: Readonly<ReceiverStats>;
  /** Re-send the handshake. Safe to call repeatedly. */
  handshake(): void;
  stop(): void;
}

function emptyRejections(): Record<ValidationFailure, number> {
  return {
    'not-ours': 0,
    'wrong-version': 0,
    'bad-nonce': 0,
    'bad-sequence': 0,
    'malformed-exchange': 0,
    'body-too-large': 0,
  };
}

/**
 * Generate a session nonce.
 *
 * `crypto.randomUUID` needs a secure context, which every page we attach to is.
 * The fallback exists so a unit test environment without WebCrypto still works;
 * it is not a security-relevant path (see protocol.ts — the nonce is observable
 * to the page by construction, so its unpredictability buys nothing against a
 * targeted attacker and everything against accidental collision).
 */
function generateNonce(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `nt-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 14)}`;
}

/**
 * Start receiving intercepted exchanges.
 *
 * `onExchange` is called once per validated capture, in the order the MAIN world
 * observed them — including the pre-handshake buffer, which is flushed first.
 */
export function startReceiver(onExchange: (exchange: CapturedExchange) => void): Receiver {
  const nonce = generateNonce();
  let lastSeq = 0;

  const stats: ReceiverStats = {
    accepted: 0,
    rejected: emptyRejections(),
    handshakeSent: false,
  };

  const onMessage = (event: MessageEvent): void => {
    // Cheapest rejections first: this fires for a great deal of YouTube's own
    // internal messaging, so the miss path must stay allocation-free.
    if (event.source !== window) return;
    if (event.origin !== location.origin) return;

    const result = validateEnvelope(event.data, nonce, lastSeq);
    if (!result.ok) {
      // 'not-ours' is the overwhelming majority — YouTube's own postMessage
      // traffic — and is not worth counting noise for.
      if (result.reason !== 'not-ours') {
        stats.rejected[result.reason] += 1;
        log.warn('rejected envelope', result.reason);
      }
      return;
    }

    lastSeq = result.envelope.seq;
    stats.accepted += 1;

    try {
      onExchange(result.envelope.exchange);
    } catch (error) {
      // A downstream parser failure must not kill the listener; the next
      // response should still be processed.
      log.error('exchange handler threw', error);
    }
  };

  window.addEventListener('message', onMessage);

  const handshake = (): void => {
    // Scoped to our own origin, never '*'.
    window.postMessage(createHello(nonce), location.origin);
    stats.handshakeSent = true;
    log.debug('handshake sent');
  };

  handshake();

  return {
    stats,
    handshake,
    stop() {
      window.removeEventListener('message', onMessage);
    },
  };
}
