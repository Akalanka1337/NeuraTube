/**
 * OpenAI-compatible adapter.
 *
 * Covers OpenAI, DeepSeek and NVIDIA NIM with nothing but a base URL swap, as
 * the brief predicted. It would also serve Anthropic — they now ship an
 * OpenAI-compatible endpoint — but we prefer the native adapter there, because
 * the compatibility layer drops prompt caching, citations, PDF input and strict
 * tool schemas, all of which later milestones want.
 *
 * TWO THINGS THE BRIEF'S PROVIDER MATRIX OMITS:
 *
 * 1. USAGE IS OPT-IN. Without `stream_options: { include_usage: true }` an
 *    OpenAI-shaped stream reports no token counts at all, and the cost meter —
 *    a stated v1 feature — has nothing to display. The flag appends one final
 *    usage-only chunk before `[DONE]`, in which `choices` is empty. Sending it
 *    unconditionally is safe: providers that do not recognise `stream_options`
 *    ignore it.
 *
 * 2. THE FINAL CHUNK HAS NO CHOICES. Code that assumes `choices[0].delta`
 *    exists on every chunk throws on that last frame, which is exactly when the
 *    numbers arrive.
 */

import { createLogger } from '~/lib/logger';
import { ProviderError, fromThrown, kindForStatus, messageFromErrorBody } from './errors';
import { SSE_DONE, parseSse, parseSseJson } from './sse';
import { joinUrl, specFor } from './specs';
import type {
  ChatOpts,
  LLMProvider,
  Message,
  ModelInfo,
  ProviderConfig,
  ProviderId,
  StreamEvent,
  TestResult,
  Usage,
} from './types';

const log = createLogger('provider');

/**
 * Ceiling on how long we wait for response HEADERS.
 *
 * Not the whole response — a long generation legitimately takes minutes. But
 * Chrome terminates an extension service worker if a `fetch` takes more than 30
 * seconds to return headers, so a request that hangs longer than this is
 * already doomed; failing at 25s produces a real error message instead of a
 * silently killed worker.
 */
const HEADER_TIMEOUT_MS = 25_000;

/** Default output cap. Generous for metadata work, bounded for cost safety. */
const DEFAULT_MAX_TOKENS = 2048;

export function createOpenAiCompatibleProvider(
  id: ProviderId,
  config: ProviderConfig,
): LLMProvider {
  const spec = specFor(id);
  const baseUrl = config.baseUrl || spec.defaultBaseUrl;

  const headers = (): HeadersInit => ({
    'content-type': 'application/json',
    authorization: `Bearer ${config.apiKey}`,
  });

  /**
   * Combine the caller's abort signal with a header timeout.
   *
   * Returns a cleanup function the caller MUST invoke, or the timer keeps the
   * worker alive for its full duration.
   */
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
      throw fromThrown(thrown, id);
    } finally {
      // Headers have arrived (or failed); the body may still be streaming, and
      // must not be cut off by the header timer.
      guard.done();
    }

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new ProviderError({
        kind: kindForStatus(response.status),
        provider: id,
        status: response.status,
        message: messageFromErrorBody(body, response.status),
      });
    }

    return response;
  }

  return {
    id,

    async *chat(messages: readonly Message[], opts: ChatOpts): AsyncIterable<StreamEvent> {
      const response = await request(
        spec.chatPath,
        {
          method: 'POST',
          body: JSON.stringify({
            model: opts.model,
            messages: messages.map((message) => ({ role: message.role, content: message.content })),
            max_tokens: opts.maxTokens ?? DEFAULT_MAX_TOKENS,
            ...(opts.temperature === undefined ? {} : { temperature: opts.temperature }),
            stream: true,
            // Without this the stream carries no usage and the cost meter is blind.
            stream_options: { include_usage: true },
          }),
        },
        opts.signal,
      );

      if (!response.body) {
        throw new ProviderError({
          kind: 'server',
          provider: id,
          message: 'Provider returned no response body',
        });
      }

      let finishReason: string | null = null;
      let sawUsage = false;

      for await (const event of parseSse(response.body, opts.signal)) {
        if (event.data === SSE_DONE) break;

        const chunk = parseSseJson(event.data);
        if (!chunk) continue;

        // An error can arrive mid-stream, after a 200.
        const inlineError = chunk.error;
        if (typeof inlineError === 'object' && inlineError !== null) {
          const message = (inlineError as Record<string, unknown>).message;
          throw new ProviderError({
            kind: 'server',
            provider: id,
            message:
              typeof message === 'string' ? message : 'Provider reported an error mid-stream',
          });
        }

        const usage = readUsage(chunk.usage);
        if (usage) {
          sawUsage = true;
          yield { type: 'usage', usage };
        }

        // The final usage-only chunk has an empty `choices` array, so this must
        // not be assumed to exist.
        const choices = chunk.choices;
        if (!Array.isArray(choices) || choices.length === 0) continue;

        // Explicitly `unknown`: Array.isArray narrows to any[], and every
        // access below is guarded.
        const choice: unknown = choices[0];
        if (typeof choice !== 'object' || choice === null) continue;
        const choiceRecord = choice as Record<string, unknown>;

        const reason = choiceRecord.finish_reason;
        if (typeof reason === 'string' && reason !== '') finishReason = reason;

        const delta = choiceRecord.delta;
        if (typeof delta !== 'object' || delta === null) continue;

        const deltaRecord = delta as Record<string, unknown>;

        /*
         * REASONING FIELDS, WHICH ARE NOT THE ANSWER.
         *
         * A reasoning model streams its thinking first and its answer second.
         * DeepSeek calls the field `reasoning_content`; several NIM and
         * OpenRouter-style deployments call it `reasoning`. Neither is in the
         * OpenAI spec, and both were being dropped on the floor here.
         *
         * That silence was the bug: on a reasoning model with a modest
         * `max_tokens`, the entire budget is spent thinking, `content` never
         * arrives, and the panel showed an empty box after a perfectly
         * successful request. Emitting them lets the panel distinguish "the
         * model said nothing" from "the model thought until it ran out".
         */
        for (const field of ['reasoning_content', 'reasoning'] as const) {
          const value = deltaRecord[field];
          if (typeof value === 'string' && value !== '') {
            yield { type: 'reasoning', text: value };
          }
        }

        const content = deltaRecord.content;
        if (typeof content === 'string' && content !== '') {
          yield { type: 'text', text: content };
        }
      }

      if (!sawUsage) {
        // Not fatal — the cost meter shows "unreported" rather than a wrong
        // number — but worth knowing which providers honour the flag.
        log.debug('provider reported no usage', id);
      }

      yield { type: 'done', finishReason };
    },

    async listModels(): Promise<readonly ModelInfo[]> {
      const response = await request(spec.modelsPath, { method: 'GET' });
      // `unknown`, not the inferred `any`: readModelList guards every access.
      const payload: unknown = await response.json().catch(() => null);
      return readModelList(payload);
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
        const error = thrown instanceof ProviderError ? thrown : fromThrown(thrown, id);
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
 * Read usage from a chunk.
 *
 * Returns null when absent, which is normal for every chunk except the last.
 */
export function readUsage(raw: unknown): Usage | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const record = raw as Record<string, unknown>;

  const input = record.prompt_tokens;
  const output = record.completion_tokens;
  if (typeof input !== 'number' && typeof output !== 'number') return null;

  // Cached tokens are nested and named differently again; absent for most.
  const details = record.prompt_tokens_details;
  const cached =
    typeof details === 'object' && details !== null
      ? (details as Record<string, unknown>).cached_tokens
      : record.prompt_cache_hit_tokens;

  return {
    inputTokens: typeof input === 'number' ? input : 0,
    outputTokens: typeof output === 'number' ? output : 0,
    ...(typeof cached === 'number' ? { cachedInputTokens: cached } : {}),
  };
}

/**
 * https://github.com/Akalanka1337/NeuraTube
 * Read a `/models` response.
 *
 * OpenAI's shape is `{ data: [{ id, created }] }` and all three compatible
 * providers follow it, but NIM has been observed returning the array directly,
 * so both are accepted. Sorted newest-first where a date exists, because the
 * model a user wants is almost always a recent one.
 */
export function readModelList(payload: unknown): readonly ModelInfo[] {
  const entries = Array.isArray(payload)
    ? payload
    : typeof payload === 'object' &&
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

    const created = record.created;
    const displayName = record.display_name;

    models.push({
      id: modelId,
      label: typeof displayName === 'string' && displayName !== '' ? displayName : modelId,
      // OpenAI reports unix seconds.
      created: typeof created === 'number' && Number.isFinite(created) ? created * 1000 : null,
    });
  }

  return models.sort((a, b) => {
    if (a.created !== null && b.created !== null) return b.created - a.created;
    if (a.created !== null) return -1;
    if (b.created !== null) return 1;
    return a.id.localeCompare(b.id);
  });
}
