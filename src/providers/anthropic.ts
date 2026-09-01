/**
 * Anthropic Messages adapter.
 *
 * THE HEADER THE BRIEF'S PROVIDER MATRIX IS MISSING.
 *
 * Anthropic rejects browser-originated requests unless
 * `anthropic-dangerous-direct-browser-access: true` is present. Without it every
 * Claude call fails with a CORS error, which would have broken this milestone on
 * the first click of "Test connection". The header is an explicit
 * acknowledgement that the key is being used from a browser context; that is
 * exactly NeuraTube's model — the user's own key, on the user's own machine,
 * never passing through any server we run — so sending it is correct rather
 * than a workaround.
 *
 * THREE OTHER WAYS THIS WIRE FORMAT DIFFERS, EACH OF WHICH BREAKS NAIVE CODE:
 *
 * 1. `system` IS A TOP-LEVEL PARAMETER, not a message role. A system message
 *    left in the `messages` array is rejected outright.
 * 2. USAGE IS CUMULATIVE AND UNCONDITIONAL. No `stream_options` flag is needed
 *    or accepted. `message_start` carries input tokens, then every
 *    `message_delta` carries the running output total. Treating those as
 *    increments double-counts badly; each is a replacement.
 * 3. EVENTS ARE NAMED. Text arrives as `content_block_delta` with a
 *    `text_delta`, not as `choices[0].delta.content`, and `ping` events are
 *    interleaved throughout.
 *
 * `max_tokens` is also REQUIRED here, unlike the OpenAI shape where it is
 * optional.
 */

import { ProviderError, fromThrown, kindForStatus, messageFromErrorBody } from './errors';
import { parseSse, parseSseJson } from './sse';
import { joinUrl, specFor } from './specs';
import type {
  ChatOpts,
  LLMProvider,
  Message,
  ModelInfo,
  ProviderConfig,
  StreamEvent,
  TestResult,
  Usage,
} from './types';

const PROVIDER_ID = 'anthropic' as const;

/** The only supported value. There is no newer version string. */
export const ANTHROPIC_VERSION = '2023-06-01';

/** Required for any browser-originated request. See the note above. */
export const BROWSER_ACCESS_HEADER = 'anthropic-dangerous-direct-browser-access';

const HEADER_TIMEOUT_MS = 25_000;
const DEFAULT_MAX_TOKENS = 2048;

export function createAnthropicProvider(config: ProviderConfig): LLMProvider {
  const spec = specFor(PROVIDER_ID);
  const baseUrl = config.baseUrl || spec.defaultBaseUrl;

  const headers = (): HeadersInit => ({
    'content-type': 'application/json',
    // Anthropic uses x-api-key, NOT a bearer token.
    'x-api-key': config.apiKey,
    'anthropic-version': ANTHROPIC_VERSION,
    [BROWSER_ACCESS_HEADER]: 'true',
  });

  const withTimeout = (
    signal: AbortSignal | undefined,
  ): { signal: AbortSignal; done: () => void } => {
    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort(new DOMException('Header timeout', 'TimeoutError'));
    }, HEADER_TIMEOUT_MS);

    const onAbort = (): void => {
      controller.abort(signal?.reason);
    };
    if (signal) {
      if (signal.aborted) onAbort();
      else signal.addEventListener('abort', onAbort, { once: true });
    }

    return {
      signal: controller.signal,
      done: () => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
      },
    };
  };

  async function request(path: string, init: RequestInit, signal?: AbortSignal): Promise<Response> {
    const guard = withTimeout(signal);
    let response: Response;
    try {
      response = await fetch(joinUrl(baseUrl, path), {
        ...init,
        headers: headers(),
        signal: guard.signal,
      });
    } catch (thrown) {
      throw fromThrown(thrown, PROVIDER_ID);
    } finally {
      guard.done();
    }

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new ProviderError({
        kind: kindForStatus(response.status),
        provider: PROVIDER_ID,
        status: response.status,
        message: messageFromErrorBody(body, response.status),
      });
    }

    return response;
  }

  return {
    id: PROVIDER_ID,

    async *chat(messages: readonly Message[], opts: ChatOpts): AsyncIterable<StreamEvent> {
      const { system, conversation } = splitSystem(messages);

      const response = await request(
        spec.chatPath,
        {
          method: 'POST',
          body: JSON.stringify({
            model: opts.model,
            // Required by this API, unlike the OpenAI shape.
            max_tokens: opts.maxTokens ?? DEFAULT_MAX_TOKENS,
            ...(system === null ? {} : { system }),
            messages: conversation,
            ...(opts.temperature === undefined ? {} : { temperature: opts.temperature }),
            stream: true,
          }),
        },
        opts.signal,
      );

      if (!response.body) {
        throw new ProviderError({
          kind: 'server',
          provider: PROVIDER_ID,
          message: 'Provider returned no response body',
        });
      }

      // Usage is cumulative: input arrives once in message_start, output grows
      // with each message_delta. Held so each report is a full replacement.
      let inputTokens = 0;
      let cachedInputTokens: number | null = null;
      let finishReason: string | null = null;

      for await (const event of parseSse(response.body, opts.signal)) {
        // Keep-alives, sent throughout a long generation.
        if (event.event === 'ping') continue;

        const frame = parseSseJson(event.data);
        if (!frame) continue;

        // Anthropic signals mid-stream failures with a typed error event.
        if (event.event === 'error') {
          const error = frame.error;
          const reported =
            typeof error === 'object' && error !== null
              ? (error as Record<string, unknown>).message
              : undefined;
          const message = typeof reported === 'string' ? reported : 'stream error';
          throw new ProviderError({ kind: 'server', provider: PROVIDER_ID, message });
        }

        switch (event.event) {
          case 'message_start': {
            const message = frame.message;
            const usage =
              typeof message === 'object' && message !== null
                ? readAnthropicUsage((message as Record<string, unknown>).usage)
                : null;
            if (usage) {
              inputTokens = usage.inputTokens;
              cachedInputTokens = usage.cachedInputTokens ?? null;
              yield { type: 'usage', usage };
            }
            break;
          }

          case 'content_block_delta': {
            const delta = frame.delta;
            if (typeof delta !== 'object' || delta === null) break;
            const deltaRecord = delta as Record<string, unknown>;
            /*
             * Thinking deltas are surfaced, not dropped. With extended thinking
             * enabled the model can exhaust its budget before emitting any text,
             * and reporting that is the difference between an explanation and an
             * empty box.
             */
            if (deltaRecord.type === 'thinking_delta') {
              const thinking = deltaRecord.thinking;
              if (typeof thinking === 'string' && thinking !== '') {
                yield { type: 'reasoning', text: thinking };
              }
              break;
            }

            // Only text deltas concern us beyond that; tool_use blocks are
            // ignored until a later milestone needs them.
            if (deltaRecord.type !== 'text_delta') break;
            const text = deltaRecord.text;
            if (typeof text === 'string' && text !== '') {
              yield { type: 'text', text };
            }
            break;
          }

          case 'message_delta': {
            const usage = readAnthropicUsage(frame.usage);
            if (usage) {
              // message_delta reports output only; carry input forward so the
              // meter always receives a complete picture.
              yield {
                type: 'usage',
                usage: {
                  inputTokens: usage.inputTokens || inputTokens,
                  outputTokens: usage.outputTokens,
                  ...(cachedInputTokens === null ? {} : { cachedInputTokens }),
                },
              };
            }
            const delta = frame.delta;
            if (typeof delta === 'object' && delta !== null) {
              const reason = (delta as Record<string, unknown>).stop_reason;
              if (typeof reason === 'string' && reason !== '') finishReason = reason;
            }
            break;
          }

          case 'message_stop':
            yield { type: 'done', finishReason };
            return;

          default:
            // content_block_start / content_block_stop and anything added later.
            break;
        }
      }

      // Stream ended without message_stop — a dropped connection.
      yield { type: 'done', finishReason };
    },

    async listModels(): Promise<readonly ModelInfo[]> {
      const response = await request(spec.modelsPath, { method: 'GET' });
      const payload: unknown = await response.json().catch(() => null);
      return readAnthropicModelList(payload);
    },

    async testConnection(): Promise<TestResult> {
      const started = performance.now();
      try {
        const models = await this.listModels();
        return {
          ok: true,
          latencyMs: Math.round(performance.now() - started),
          modelCount: models.length,
          error: null,
        };
      } catch (thrown) {
        const error = thrown instanceof ProviderError ? thrown : fromThrown(thrown, PROVIDER_ID);
        return {
          ok: false,
          latencyMs: Math.round(performance.now() - started),
          modelCount: null,
          error: error.userMessage,
        };
      }
    },
  };
}

/**
 * Hoist system messages out of the conversation.
 *
 * Anthropic takes `system` as a top-level string and rejects a `system` role in
 * `messages`. Several system messages are joined, which is what a prompt built
 * from a base template plus guardrails (M5) will produce.
 */
export function splitSystem(messages: readonly Message[]): {
  system: string | null;
  conversation: { role: 'user' | 'assistant'; content: string }[];
} {
  const systemParts: string[] = [];
  const conversation: { role: 'user' | 'assistant'; content: string }[] = [];

  for (const message of messages) {
    if (message.role === 'system') {
      if (message.content !== '') systemParts.push(message.content);
    } else {
      conversation.push({ role: message.role, content: message.content });
    }
  }

  return {
    system: systemParts.length > 0 ? systemParts.join('\n\n') : null,
    conversation,
  };
}

/** Read Anthropic's usage shape, which names its fields differently. */
export function readAnthropicUsage(raw: unknown): Usage | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const record = raw as Record<string, unknown>;

  const input = record.input_tokens;
  const output = record.output_tokens;
  if (typeof input !== 'number' && typeof output !== 'number') return null;

  const cacheRead = record.cache_read_input_tokens;

  return {
    inputTokens: typeof input === 'number' ? input : 0,
    outputTokens: typeof output === 'number' ? output : 0,
    ...(typeof cacheRead === 'number' ? { cachedInputTokens: cacheRead } : {}),
  };
}

/** Read Anthropic's `/models` shape: `{ data: [{ id, display_name, created_at }] }`. */
export function readAnthropicModelList(payload: unknown): readonly ModelInfo[] {
  const entries =
    typeof payload === 'object' &&
    payload !== null &&
    Array.isArray((payload as Record<string, unknown>).data)
      ? ((payload as Record<string, unknown>).data as unknown[])
      : [];

  const models: ModelInfo[] = [];
  for (const entry of entries) {
    if (typeof entry !== 'object' || entry === null) continue;
    const record = entry as Record<string, unknown>;
    const modelId = record.id;
    if (typeof modelId !== 'string' || modelId === '') continue;

    const displayName = record.display_name;
    // ISO 8601 here, not a unix timestamp.
    const createdAt = record.created_at;
    const created = typeof createdAt === 'string' ? Date.parse(createdAt) : null;

    models.push({
      id: modelId,
      label: typeof displayName === 'string' && displayName !== '' ? displayName : modelId,
      created: created !== null && Number.isFinite(created) ? created : null,
    });
  }

  return models.sort((a, b) => {
    if (a.created !== null && b.created !== null) return b.created - a.created;
    return a.id.localeCompare(b.id);
  });
}
