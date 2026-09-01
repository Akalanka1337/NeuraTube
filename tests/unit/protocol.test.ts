import { describe, expect, it } from 'vitest';
import {
  MAX_BODY_BYTES,
  WIRE_MARKER,
  WIRE_VERSION,
  createEnvelope,
  createHello,
  parseHello,
  validateEnvelope,
} from '~/intercept/protocol';
import type { CapturedExchange } from '~/intercept/protocol';

const NONCE = '0b3f7c2a-9d1e-4a5b-8c6d-7e8f90a1b2c3';

function exchange(overrides: Partial<CapturedExchange> = {}): CapturedExchange {
  return {
    kind: 'CREATOR_VIDEOS',
    url: 'https://studio.youtube.com/youtubei/v1/creator/get_creator_videos?alt=json',
    method: 'POST',
    status: 200,
    responseText: '{"videos":[]}',
    requestBody: '{"videoIds":["tqygzPrAkjY"]}',
    at: 1234.5,
    skipped: null,
    ...overrides,
  };
}

/**
 * This is the hostile boundary. `validateEnvelope` is the only thing standing
 * between a page script and NeuraTube's data model, so it is tested against the
 * forgeries a page would actually attempt.
 */
describe('validateEnvelope', () => {
  it('accepts a well-formed envelope', () => {
    const result = validateEnvelope(createEnvelope(NONCE, 1, exchange()), NONCE, 0);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.envelope.exchange.kind).toBe('CREATOR_VIDEOS');
      expect(result.envelope.seq).toBe(1);
    }
  });

  it("rejects the brief's original marker-only message shape", () => {
    // The original design keyed solely on `__neuratube: true`, so any page
    // script could inject arbitrary text into an AI prompt. This is the exact
    // payload that used to be accepted.
    const forged = { __neuratube: true, kind: 'CREATOR_VIDEOS', responseText: '{"videos":[]}' };
    expect(validateEnvelope(forged, NONCE, 0)).toEqual({ ok: false, reason: 'not-ours' });
  });

  it('rejects a forged envelope with the wrong nonce', () => {
    const forged = createEnvelope('attacker-nonce-aaaaaaaaaaaa', 1, exchange());
    expect(validateEnvelope(forged, NONCE, 0)).toEqual({ ok: false, reason: 'bad-nonce' });
  });

  it('rejects a replayed sequence number', () => {
    const envelope = createEnvelope(NONCE, 5, exchange());
    expect(validateEnvelope(envelope, NONCE, 5)).toEqual({ ok: false, reason: 'bad-sequence' });
    expect(validateEnvelope(envelope, NONCE, 9)).toEqual({ ok: false, reason: 'bad-sequence' });
  });

  it('requires a strictly increasing integer sequence', () => {
    for (const seq of [0, -1, 1.5, Number.NaN, '2', null, undefined]) {
      const forged = { [WIRE_MARKER]: WIRE_VERSION, nonce: NONCE, seq, exchange: exchange() };
      expect(validateEnvelope(forged, NONCE, 0).ok, String(seq)).toBe(false);
    }
  });

  it('rejects a version it does not understand', () => {
    const forged = { [WIRE_MARKER]: 99, nonce: NONCE, seq: 1, exchange: exchange() };
    expect(validateEnvelope(forged, NONCE, 0)).toEqual({ ok: false, reason: 'wrong-version' });
  });

  it('rejects every malformed exchange field', () => {
    const cases: Partial<Record<keyof CapturedExchange, unknown>>[] = [
      { kind: '' },
      { kind: 123 },
      { url: null },
      { method: 42 },
      { status: 'ok' },
      { status: Number.NaN },
      { responseText: null },
      { requestBody: 42 },
      { at: 'now' },
      { skipped: 'not-a-real-reason' },
    ];
    for (const override of cases) {
      const forged = {
        [WIRE_MARKER]: WIRE_VERSION,
        nonce: NONCE,
        seq: 1,
        exchange: { ...exchange(), ...override },
      };
      expect(validateEnvelope(forged, NONCE, 0), JSON.stringify(override)).toEqual({
        ok: false,
        reason: 'malformed-exchange',
      });
    }
  });

  it('accepts the valid skip reasons', () => {
    for (const skipped of ['too-large', 'unreadable-response-type', 'read-failed', 'aborted']) {
      const envelope = createEnvelope(NONCE, 1, exchange({ skipped: skipped as never }));
      expect(validateEnvelope(envelope, NONCE, 0).ok, skipped).toBe(true);
    }
  });

  it('rejects an oversized body rather than retaining it', () => {
    const envelope = createEnvelope(
      NONCE,
      1,
      exchange({ responseText: 'x'.repeat(MAX_BODY_BYTES + 1) }),
    );
    expect(validateEnvelope(envelope, NONCE, 0)).toEqual({ ok: false, reason: 'body-too-large' });
  });

  it('rejects non-objects without throwing', () => {
    for (const data of [null, undefined, 42, 'string', [], true]) {
      expect(() => validateEnvelope(data, NONCE, 0)).not.toThrow();
      expect(validateEnvelope(data, NONCE, 0).ok).toBe(false);
    }
  });

  it('does not pass through extra attacker-controlled properties', () => {
    const forged = {
      ...createEnvelope(NONCE, 1, exchange()),
      // A page adding fields hoping they reach the parser.
      injected: 'malicious',
    };
    const result = validateEnvelope(forged, NONCE, 0);
    expect(result.ok).toBe(true);
    if (result.ok) {
      // The validator rebuilds the envelope field by field rather than spreading.
      expect(Object.keys(result.envelope).sort()).toEqual(
        [WIRE_MARKER, 'exchange', 'nonce', 'seq'].sort(),
      );
      expect(Object.keys(result.envelope.exchange).sort()).toEqual(
        ['at', 'kind', 'method', 'requestBody', 'responseText', 'skipped', 'status', 'url'].sort(),
      );
    }
  });
});

describe('parseHello', () => {
  it('round-trips a hello', () => {
    expect(parseHello(createHello(NONCE))).toEqual(createHello(NONCE));
  });

  it('rejects a nonce that is not plausibly a UUID', () => {
    expect(parseHello({ __neuratube_hello: WIRE_VERSION, nonce: 'short' })).toBeNull();
    expect(parseHello({ __neuratube_hello: WIRE_VERSION, nonce: 'x'.repeat(65) })).toBeNull();
    expect(parseHello({ __neuratube_hello: WIRE_VERSION, nonce: 42 })).toBeNull();
  });

  it('rejects anything that is not a hello, without throwing', () => {
    for (const data of [
      null,
      undefined,
      42,
      'hello',
      {},
      { __neuratube_hello: 99, nonce: NONCE },
    ]) {
      expect(() => parseHello(data)).not.toThrow();
      expect(parseHello(data)).toBeNull();
    }
  });
});
