/**
 * Provider error normalisation.
 *
 * Two jobs, both of which matter more than they look:
 *
 * 1. REDACTION. An error surfaced to the UI, copied into a GitHub issue, or
 *    written to the console must never contain a key. Provider errors routinely
 *    echo request context, and a URL can carry a key in a query parameter.
 *    Everything passes through `redactString` before it escapes this module.
 *
 * 2. ACTIONABILITY. "Request failed with status 401" tells the user nothing.
 *    The four providers use the same status codes for the same conditions, so
 *    one mapping produces advice that is actually useful: which of their
 *    settings to go change.
 */

import { redactString } from '~/lib/redact';
import type { ProviderId } from './types';

export type ProviderErrorKind =
  | 'auth'
  | 'rate-limit'
  | 'quota'
  | 'bad-request'
  | 'model-not-found'
  | 'server'
  | 'network'
  | 'cors'
  | 'timeout'
  | 'aborted'
  | 'unknown';

export class ProviderError extends Error {
  readonly kind: ProviderErrorKind;
  readonly provider: ProviderId;
  readonly status: number | null;
  /** Whether retrying, or falling back to another provider, could succeed. */
  readonly retryable: boolean;

  constructor(options: {
    kind: ProviderErrorKind;
    provider: ProviderId;
    message: string;
    status?: number | null;
    retryable?: boolean;
  }) {
    // Redact at construction so no code path can leak by forgetting to.
    super(redactString(options.message));
    this.name = 'ProviderError';
    this.kind = options.kind;
    this.provider = options.provider;
    this.status = options.status ?? null;
    this.retryable = options.retryable ?? RETRYABLE_KINDS.has(options.kind);
  }

  /** Sentence shown in the options page or the panel. */
  get userMessage(): string {
    return `${ADVICE[this.kind]} (${this.message})`;
  }
}

const RETRYABLE_KINDS: ReadonlySet<ProviderErrorKind> = new Set<ProviderErrorKind>([
  'rate-limit',
  'server',
  'network',
  'timeout',
]);

const ADVICE: Readonly<Record<ProviderErrorKind, string>> = Object.freeze({
  auth: 'The API key was rejected. Check it is correct and still active.',
  'rate-limit': 'The provider is rate limiting this key. Wait, or slow down requests.',
  quota: 'This key has no credit or has hit a spend cap. Top up with the provider.',
  'bad-request': 'The provider rejected the request as malformed.',
  'model-not-found': 'That model is not available to this key. Pick another from the list.',
  server: 'The provider had a server error. Not your fault; try again.',
  network: 'Could not reach the provider. Check your connection.',
  cors: 'The provider refused a browser-originated request.',
  timeout: 'The provider did not respond in time.',
  aborted: 'Cancelled.',
  unknown: 'The request failed for an unrecognised reason.',
});

/** Map an HTTP status to a kind. Consistent across all four providers. */
export function kindForStatus(status: number): ProviderErrorKind {
  if (status === 401 || status === 403) return 'auth';
  if (status === 404) return 'model-not-found';
  if (status === 429) return 'rate-limit';
  if (status === 402) return 'quota';
  if (status >= 400 && status < 500) return 'bad-request';
  if (status >= 500) return 'server';
  return 'unknown';
}

/**
 * Extract the most useful message from an error response body.
 *
 * All four providers nest it differently, and any of them may return HTML from
 * a proxy instead of JSON.
 */
export function messageFromErrorBody(body: string, status: number): string {
  const fallback = `HTTP ${status}`;
  if (body.trim() === '') return fallback;

  try {
    const parsed: unknown = JSON.parse(body);
    if (typeof parsed !== 'object' || parsed === null) return fallback;

    const record = parsed as Record<string, unknown>;

    // OpenAI / DeepSeek / NIM: { error: { message } }
    // Anthropic:               { error: { type, message } }
    const error = record.error;
    if (typeof error === 'object' && error !== null) {
      const message = (error as Record<string, unknown>).message;
      if (typeof message === 'string' && message !== '') return message;
    }
    if (typeof error === 'string' && error !== '') return error;

    // Some gateways use { message } or { detail } at the top level.
    for (const key of ['message', 'detail']) {
      const value = record[key];
      if (typeof value === 'string' && value !== '') return value;
    }

    return fallback;
  } catch {
    // Not JSON — a proxy error page, most likely. Take a short prefix so the
    // user sees something recognisable without pasting a page of HTML.
    const text = body.replace(/\s+/g, ' ').trim();
    return text.length > 200 ? `${text.slice(0, 200)}…` : text;
  }
}

/**
 * Convert a thrown value from `fetch` into a ProviderError.
 *
 * `fetch` rejects with an opaque `TypeError` for network failures, CORS
 * rejections and DNS problems alike, so the distinction has to come from the
 * message text. Imperfect, but better than reporting every one as "network".
 */
export function fromThrown(thrown: unknown, provider: ProviderId): ProviderError {
  if (thrown instanceof ProviderError) return thrown;

  if (thrown instanceof DOMException && thrown.name === 'AbortError') {
    return new ProviderError({ kind: 'aborted', provider, message: 'Request cancelled' });
  }

  const raw = thrown instanceof Error ? thrown.message : String(thrown);
  const lower = raw.toLowerCase();

  if (lower.includes('cors') || lower.includes('access-control')) {
    return new ProviderError({ kind: 'cors', provider, message: raw });
  }
  if (lower.includes('timed out') || lower.includes('timeout')) {
    return new ProviderError({ kind: 'timeout', provider, message: raw });
  }

  return new ProviderError({ kind: 'network', provider, message: raw });
}
