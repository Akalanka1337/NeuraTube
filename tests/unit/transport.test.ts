import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  emitExchange,
  resetTransportForTests,
  startTransport,
  transportStateForTests,
} from '~/intercept/transport';
import { WIRE_MARKER, createHello, validateEnvelope } from '~/intercept/protocol';
import type { CapturedExchange } from '~/intercept/protocol';

const NONCE = '11111111-2222-4333-8444-555555555555';

function exchange(seqHint: number): CapturedExchange {
  return {
    kind: 'CREATOR_VIDEOS',
    url: `/youtubei/v1/creator/get_creator_videos?n=${seqHint}`,
    method: 'POST',
    status: 200,
    responseText: `{"videos":[],"n":${seqHint}}`,
    requestBody: null,
    at: seqHint,
    skipped: null,
  };
}

/** Collect envelopes the transport posts to the window. */
function collectEnvelopes(): { received: unknown[]; stop: () => void } {
  const received: unknown[] = [];
  const listener = (event: MessageEvent): void => {
    if (typeof event.data === 'object' && event.data !== null && WIRE_MARKER in event.data) {
      received.push(event.data);
    }
  };
  window.addEventListener('message', listener);
  return {
    received,
    stop: () => {
      window.removeEventListener('message', listener);
    },
  };
}

const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

/**
 * Deliver a hello the way a real browser does.
 *
 * The transport requires `event.source === window`, which is correct for
 * same-window `postMessage` in a browser and is a real security check — it is
 * what stops a cross-frame message being mistaken for our handshake. happy-dom
 * cannot satisfy it (it sets `source` to an internal EventTarget), so rather
 * than weaken production code to suit a test double, these tests construct the
 * event explicitly. The genuine same-window path is covered end-to-end in real
 * Chromium by tests/e2e.
 */
function deliverHello(data: unknown, origin: string = location.origin): void {
  window.dispatchEvent(new MessageEvent('message', { data, origin, source: window }));
}

/**
 * THE BUFFERING BEHAVIOUR IS THE POINT OF THIS MODULE.
 *
 * The interceptor patches XHR at document_start; the panel's content script does
 * not run until document_idle. On a real Studio page, `get_creator_videos` — the
 * primary payload — fires inside that gap. A transport that posted immediately
 * would drop it into a void with no listener, and the panel would show an empty
 * context until the user happened to trigger another request.
 */
describe('MAIN-world transport', () => {
  beforeEach(() => {
    resetTransportForTests();
  });

  afterEach(() => {
    resetTransportForTests();
  });

  it('buffers captures made before the handshake instead of dropping them', async () => {
    const sink = collectEnvelopes();
    startTransport();

    // Captured during page load, before the panel exists.
    emitExchange(exchange(1));
    emitExchange(exchange(2));
    await tick();

    // Nothing posted yet — there is no one to receive it.
    expect(sink.received).toHaveLength(0);
    expect(transportStateForTests().buffer).toHaveLength(2);

    sink.stop();
  });

  it('flushes the buffer in capture order once the panel says hello', async () => {
    const sink = collectEnvelopes();
    startTransport();

    emitExchange(exchange(1));
    emitExchange(exchange(2));
    await tick();

    deliverHello(createHello(NONCE));
    await tick();

    expect(sink.received).toHaveLength(2);

    // Sequence numbers start at 1 and increase, and order is preserved.
    const first = validateEnvelope(sink.received[0], NONCE, 0);
    expect(first.ok).toBe(true);
    if (first.ok) {
      expect(first.envelope.seq).toBe(1);
      expect(first.envelope.exchange.responseText).toContain('"n":1');

      const second = validateEnvelope(sink.received[1], NONCE, first.envelope.seq);
      expect(second.ok).toBe(true);
      if (second.ok) {
        expect(second.envelope.seq).toBe(2);
        expect(second.envelope.exchange.responseText).toContain('"n":2');
      }
    }

    sink.stop();
  });

  it('streams live once the handshake has happened', async () => {
    const sink = collectEnvelopes();
    startTransport();

    deliverHello(createHello(NONCE));
    await tick();
    expect(sink.received).toHaveLength(0);

    emitExchange(exchange(1));
    await tick();
    expect(sink.received).toHaveLength(1);
    expect(transportStateForTests().buffer).toHaveLength(0);

    sink.stop();
  });

  it('drops oldest when the buffer is full, because newest data is the truthful data', async () => {
    const sink = collectEnvelopes();
    startTransport();

    // 40 captures against a 32-entry bound.
    for (let i = 1; i <= 40; i += 1) emitExchange(exchange(i));

    expect(transportStateForTests().buffer).toHaveLength(32);
    expect(transportStateForTests().dropped).toBe(8);

    deliverHello(createHello(NONCE));
    await tick();

    expect(sink.received).toHaveLength(32);
    // The retained window is the most recent 32 (9..40), not the first 32.
    const first = validateEnvelope(sink.received[0], NONCE, 0);
    if (first.ok) expect(first.envelope.exchange.responseText).toContain('"n":9');

    sink.stop();
  });

  it('re-handshakes and resets the sequence when the panel is re-injected', async () => {
    const sink = collectEnvelopes();
    startTransport();

    deliverHello(createHello(NONCE));
    await tick();
    emitExchange(exchange(1));
    await tick();

    // An extension reload replaces the content script while this MAIN-world
    // script survives in the page, so a second hello with a new nonce arrives.
    const secondNonce = '99999999-8888-4777-8666-555555555555';
    deliverHello(createHello(secondNonce));
    await tick();
    emitExchange(exchange(2));
    await tick();

    const last = sink.received[sink.received.length - 1];
    const result = validateEnvelope(last, secondNonce, 0);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.envelope.seq).toBe(1);

    sink.stop();
  });

  it('ignores a hello that is not a hello', async () => {
    const sink = collectEnvelopes();
    startTransport();

    for (const junk of [null, 42, 'hello', {}, { __neuratube_hello: 99, nonce: NONCE }]) {
      deliverHello(junk);
    }
    await tick();

    emitExchange(exchange(1));
    await tick();

    // Still buffering: no valid handshake happened.
    expect(sink.received).toHaveLength(0);
    expect(transportStateForTests().nonce).toBeNull();

    sink.stop();
  });

  it('refuses a handshake from a different origin', async () => {
    const sink = collectEnvelopes();
    startTransport();

    deliverHello(createHello(NONCE), 'https://evil.example.com');
    await tick();
    emitExchange(exchange(1));
    await tick();

    expect(sink.received).toHaveLength(0);
    expect(transportStateForTests().nonce).toBeNull();

    sink.stop();
  });

  it('is idempotent, so a re-assertion does not install a second listener', async () => {
    const sink = collectEnvelopes();
    startTransport();
    startTransport();
    startTransport();

    deliverHello(createHello(NONCE));
    await tick();
    emitExchange(exchange(1));
    await tick();

    // Duplicate listeners would post the same exchange more than once.
    expect(sink.received).toHaveLength(1);

    sink.stop();
  });
});
