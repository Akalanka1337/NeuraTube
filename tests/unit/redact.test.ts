import { describe, expect, it } from 'vitest';
import { isSensitiveHeader, redact, redactString } from '~/lib/redact';

/**
 * The project brief promises keys are never logged. That promise reduces to
 * this function, so every provider key format we accept is asserted here — a
 * regression means real credentials in a user's console.
 */
describe('redactString', () => {
  const KEYS = {
    openai: 'x-sample',
    openaiProject: 'x-proj-sample',
    anthropic: 'x-ant-api03-sample',
    nvidia: 'x-sample',
    deepseek: 'x-sample',
  } as const;

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
    expect(redactString('Authorization: Bearer abcdef0123456789abcdef')).not.toContain(
      'abcdef0123',
    );
    expect(redactString('authorization: bearer abcdef0123456789abcdef')).toContain('[redacted]');
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
      providers: [{ id: 'openai', api_key: 'sk-sample' }],
      headers: { Authorization: 'Bearer abcdef0123456789abcdef' },
    });
    expect(JSON.stringify(output)).not.toContain('sk-abc');
    expect(JSON.stringify(output)).not.toContain('abcdef0123456789');
  });

  it('redacts error messages but keeps the error name', () => {
    const output = redact(new TypeError('bad key sk-sample'));
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
