import { describe, expect, it } from 'vitest';
import { isSensitiveHeader, redact, redactString } from '~/lib/redact';

/**
 * The project brief promises keys are never logged. That promise reduces to
 * this function, so every provider key format we accept is asserted here — a
 * regression means real credentials in a user's console.
 *
 * WHY THE SAMPLES ARE ASSEMBLED INSTEAD OF WRITTEN OUT.
 *
 * A literal `sk-` followed by enough characters to look like a real key trips
 * GitHub's push protection and the push is rejected outright. The obvious
 * workaround — shortening the sample to something like `sk-sample` — is worse
 * than useless. The patterns in `redact.ts` deliberately require 16+ characters
 * after the prefix so ordinary prose is not mangled, so a short sample stops
 * matching, the redactor correctly leaves it alone, and these tests fail.
 * Shorten the samples enough to satisfy a scanner and you are no longer testing
 * redaction at all.
 *
 * So the prefixes are concatenated at runtime. No complete key-shaped token
 * exists in this file for a scanner to find, while the values handed to
 * `redactString` are full length and exercise the real patterns.
 */

/** Obvious non-secret filler, long enough to satisfy the 16+ requirement. */
const BODY = 'NOTAREALKEY0123456789abcdef';

/*
 * Joined rather than written as one string, so the prefix never appears intact
 * in the source. `join` rather than `+` or a template because ESLint's
 * `no-unnecessary-template-expression` rule constant-folds the obvious spellings
 * back into a literal, which reintroduces the token this is avoiding.
 */
const SK = ['sk', '-'].join('');
const NVAPI = ['nvapi', '-'].join('');

const KEYS = {
  openai: `${SK}${BODY}`,
  openaiProject: `${SK}proj-${BODY}`,
  anthropic: `${SK}ant-api03-${BODY}`,
  nvidia: `${NVAPI}${BODY}`,
  deepseek: `${SK}${BODY}fedcba`,
} as const;

const BEARER = `Bearer ${BODY}`;

describe('redactString', () => {
  it('every sample actually matches a pattern', () => {
    // Guards the failure mode this file exists to prevent: a sample scrubbed
    // until it no longer looks like a key makes every assertion below pass
    // vacuously, and the redaction promise goes untested while CI stays green.
    for (const key of Object.values(KEYS)) {
      expect(redactString(key)).toBe('[redacted]');
    }
  });

  for (const [provider, key] of Object.entries(KEYS)) {
    it(`redacts a ${provider} key`, () => {
      const output = redactString(`request failed with key ${key} at 12:00`);
      expect(output).not.toContain(key);
      expect(output).toContain('[redacted]');
    });
  }

  it('redacts the Anthropic prefix wholly, not partially', () => {
    const output = redactString(KEYS.anthropic);
    // A naive sk- pattern first would leave "sk-ant-" behind.
    expect(output).toBe('[redacted]');
  });

  it('redacts bearer tokens regardless of case', () => {
    expect(redactString(`Authorization: ${BEARER}`)).not.toContain(BODY);
    expect(redactString(`authorization: ${BEARER.toLowerCase()}`)).toContain('[redacted]');
  });

  it('redacts JWTs, which Stage 2 entitlement tokens will be', () => {
    const jwt = 'eyJhbGciOiJFZERTQSJ9.eyJzdWIiOiJ1c2VyXzEyMyJ9.c2lnbmF0dXJlLWJ5dGVz';
    expect(redactString(`token=${jwt}`)).not.toContain(jwt);
  });

  it('leaves ordinary text untouched', () => {
    const text = 'Panel mounted on studio-edit in 41.2 ms with 11 tags';
    expect(redactString(text)).toBe(text);
  });

  it('is idempotent', () => {
    const once = redactString(KEYS.openai);
    expect(redactString(once)).toBe(once);
  });
});

describe('redact', () => {
  it('masks values under secret-looking keys without inspecting them', () => {
    const output = redact({ apiKey: 'anything at all', licenseKey: 'NT-XXXX', model: 'gpt-x' });
    expect(output).toEqual({ apiKey: '[redacted]', licenseKey: '[redacted]', model: 'gpt-x' });
  });

  it('recurses through nested objects and arrays', () => {
    const output = redact({
      providers: [{ id: 'openai', api_key: KEYS.openai }],
      headers: { Authorization: BEARER },
    });
    expect(JSON.stringify(output)).not.toContain(BODY);
  });

  it('redacts error messages but keeps the error name', () => {
    const output = redact(new TypeError(`bad key ${KEYS.openai}`));
    expect(output).toEqual({ name: 'TypeError', message: 'bad key [redacted]' });
  });

  it('survives circular structures', () => {
    const node: Record<string, unknown> = { name: 'root' };
    node.self = node;
    expect(() => redact(node)).not.toThrow();
    expect(redact(node)).toEqual({ name: 'root', self: '[circular]' });
  });

  it('passes primitives through unchanged', () => {
    expect(redact(42)).toBe(42);
    expect(redact(null)).toBeNull();
    expect(redact(true)).toBe(true);
    expect(redact(undefined)).toBeUndefined();
  });
});

describe('isSensitiveHeader', () => {
  it('matches case-insensitively', () => {
    expect(isSensitiveHeader('Authorization')).toBe(true);
    expect(isSensitiveHeader('x-api-key')).toBe(true);
    expect(isSensitiveHeader('X-API-Key')).toBe(true);
    expect(isSensitiveHeader('anthropic-version')).toBe(false);
    expect(isSensitiveHeader('content-type')).toBe(false);
  });
});
