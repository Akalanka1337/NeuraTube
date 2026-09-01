/**
 * MAIN-world side of the transport.
 *
 * THE BUFFERING PROBLEM (the brief's design loses data without this):
 *
 * The interceptor runs at `document_start`, because it must patch
 * `XMLHttpRequest` before YouTube's application bundle issues its first
 * request. The panel's content script runs at `document_idle`, because
 * injecting it at `document_start` would block page load.
 *
 * That gap is hundreds of milliseconds on a real Studio page, and
 * `get_creator_videos` — the single most important payload NeuraTube consumes —
 * fires inside it. A transport that posts captures immediately would throw the
 * primary payload into a void where nothing is listening yet, and the panel
 * would show an empty context until the user happened to trigger another
 * request.
 *
 * So captures are buffered until the isolated world says hello, then flushed in
 * order. The buffer is bounded and drops OLDEST-first, because for every route
 * we care about the newest response is the truthful one.
 *
 * No `chrome.*` here: the MAIN world has no extension APIs.
 */

import type { CapturedExchange } from './protocol';
import { createEnvelope, parseHello } from './protocol';

/**
 * Captures held before the handshake.
 *
 * Sized for a Studio page load, which issues a handful of matched requests
 * before `document_idle`. Anything beyond this means the page is doing
 * something unexpected and the newest data is what matters.
 */
const MAX_BUFFERED = 32;

interface TransportState {
  nonce: string | null;
  seq: number;
  buffer: CapturedExchange[];
  dropped: number;
  listening: boolean;
}

const state: TransportState = {
  nonce: null,
  seq: 0,
  buffer: [],
  dropped: 0,
  listening: false,
};

/**
 * Post one envelope.
 *
 * Targeted at `location.origin` rather than `'*'`. The brief used `'*'`, which
 * broadcasts to every frame regardless of origin; scoping it means a
 * cross-origin frame cannot receive our payloads even incidentally.
 */
function post(exchange: CapturedExchange): void {
  const nonce = state.nonce;
  if (nonce === null) return;

  state.seq += 1;
  try {
    window.postMessage(createEnvelope(nonce, state.seq, exchange), location.origin);
  } catch {
    // postMessage throws if the payload is not structured-cloneable. Everything
    // we send is plain data, so this should be unreachable — but an exception
    // escaping here would surface inside YouTube's own call stack, which is
    // never acceptable.
  }
}

/** Queue or send a capture, depending on whether the handshake has happened. */
export function emitExchange(exchange: CapturedExchange): void {
  if (state.nonce !== null) {
    post(exchange);
    return;
  }

  if (state.buffer.length >= MAX_BUFFERED) {
    // Drop oldest: the newest response for a given route is the truthful one.
    state.buffer.shift();
    state.dropped += 1;
  }
  state.buffer.push(exchange);
}

/**
 * Begin listening for the isolated world's handshake.
 *
 * Installed at `document_start`, i.e. before any page script can run, so the
 * listener is in place well ahead of the hello. Re-handshaking is allowed and
 * resets the sequence: the panel's content script can be re-injected on
 * extension reload while this MAIN-world script survives in the page.
 */
export function startTransport(
  onHandshake?: (bufferedCount: number, dropped: number) => void,
): void {
  if (state.listening) return;
  state.listening = true;

  window.addEventListener(
    'message',
    (event: MessageEvent) => {
      // Only same-window, same-origin messages can be our handshake.
      if (event.source !== window) return;
      if (event.origin !== location.origin) return;

      const hello = parseHello(event.data);
      if (!hello) return;

      state.nonce = hello.nonce;
      state.seq = 0;

      const buffered = state.buffer;
      const dropped = state.dropped;
      state.buffer = [];
      state.dropped = 0;

      // Flush in capture order so the isolated world's reducer sees the same
      // sequence it would have seen live.
      for (const exchange of buffered) post(exchange);

      onHandshake?.(buffered.length, dropped);
    },
    // Not `once`: see the re-handshake note above.
    false,
  );
}

/** Reset transport state. Test-only. */
export function resetTransportForTests(): void {
  state.nonce = null;
  state.seq = 0;
  state.buffer = [];
  state.dropped = 0;
  state.listening = false;
}

/** Inspect transport state. Test-only. */
export function transportStateForTests(): Readonly<TransportState> {
  return state;
}
