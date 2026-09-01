/**
 * Credential redaction.
 *
 * The project brief is explicit: never log keys, never include them in error
 * messages, redact them in the debug tab. That promise is only as good as the
 * one function that enforces it, so it lives here, is used by the logger and
 * (from M3) the provider error normaliser, and is unit-tested against every
 * key format we accept.
 */

/**
 * Known provider key shapes, most specific first. `sk-ant-` must be tried
 * before `sk-` or the Anthropic prefix would be partially preserved.
 */
const KEY_PATTERNS: readonly RegExp[] = [
  /sk-ant-[A-Za-z0-9_-]{16,}/g, // Anthropic
  /nvapi-[A-Za-z0-9_-]{16,}/g, // NVIDIA NIM
  /sk-proj-[A-Za-z0-9_-]{16,}/g, // OpenAI project keys
  /sk-[A-Za-z0-9_-]{16,}/g, // OpenAI / DeepSeek
  /\bBearer\s+[A-Za-z0-9._~+/=-]{16,}/gi, // any bearer token
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, // JWTs (Stage 2 entitlements)
];

/** Header names whose values must never be printed. */
const SENSITIVE_HEADERS = new Set([
  'authorization',
  'x-api-key',
  'x-goog-api-key',
  'cookie',
  'set-cookie',
]);

const MASK = '[redacted]';

/** Replace anything that looks like a credential in a string. */
export function redactString(input: string): string {
  let output = input;
  for (const pattern of KEY_PATTERNS) {
    // Patterns are module-level and `g`-flagged, so reset lastIndex defensively.
    pattern.lastIndex = 0;
    output = output.replace(pattern, MASK);
  }
  return output;
}

/** True if a header name must be masked before logging. */
export function isSensitiveHeader(name: string): boolean {
  return SENSITIVE_HEADERS.has(name.toLowerCase());
}

/**
 * Deep-redact an arbitrary value for logging or display.
 *
 * Keys named like secrets are masked wholesale; string values are pattern
 * scrubbed. Cycles are handled, because a redaction helper that can throw on a
 * self-referencing object is worse than no redaction helper at all.
 */
export function redact(value: unknown, seen = new WeakSet<object>()): unknown {
  if (typeof value === 'string') return redactString(value);
  if (value === null || typeof value !== 'object') return value;

  if (seen.has(value)) return '[circular]';
  seen.add(value);

  if (Array.isArray(value)) return value.map((item) => redact(item, seen));

  if (value instanceof Error) {
    return { name: value.name, message: redactString(value.message) };
  }

  const output: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    output[key] = isSecretKeyName(key) ? MASK : redact(item, seen);
  }
  return output;
}

const SECRET_KEY_NAME =
  /(api[_-]?key|apikey|secret|token|password|credential|authorization|licen[cs]e[_-]?key)/i;

function isSecretKeyName(key: string): boolean {
  return SECRET_KEY_NAME.test(key) || isSensitiveHeader(key);
}
