/**
 * Task runner.
 *
 * Resolves a task to a provider, assembles the messages, streams the response,
 * and falls back when a provider fails in a way another provider could survive.
 *
 * Runs ONLY in the service worker. Two consequences that shape everything here:
 *
 *  - Credentials are read per call from storage and never cached. The worker is
 *    terminated after 30 seconds idle, so a cache buys nothing and would serve a
 *    stale key after the user edits one.
 *  - Nothing may be held in module scope between calls.
 */

import { createLogger } from '~/lib/logger';
import { ProviderError } from '~/providers/errors';
import { createProvider } from '~/providers/index';
import { PROVIDER_IDS } from '~/providers/types';
import type { Message, ProviderId, StreamEvent, Usage } from '~/providers/types';
import { readCredential, readCredentials } from '~/storage/credentials';
import { readState } from '~/storage/local';
import type { NeuraTubeState } from '~/storage/schema';
import type { VideoContext } from '~/types/VideoContext';
import type { TaskInputs } from './context';
import { renderUserInstruction, renderVideoContext } from './context';
import { guardrailMessages, guardrailsFor } from './guardrails';
import type { Guardrail } from './guardrails';
import { resolvePrompt } from './promptStore';
import type { TaskType } from './tasks';
import { taskDefinition } from './tasks';

const log = createLogger('task');

export interface RunTaskRequest {
  readonly task: TaskType;
  readonly video: VideoContext | null;
  readonly inputs?: TaskInputs;
  /** Overrides the resolved provider. Used by the options page's try-it control. */
  readonly forceProvider?: ProviderId;
  /**
   * Token ceiling and temperature for this run, when the user has overridden the
   * task's shipped defaults.
   *
   * Passed IN rather than read from storage here, so the budget the panel quotes
   * when explaining an empty result is provably the one the request used.
   */
  readonly limits?: { readonly maxTokens?: number; readonly temperature?: number };
  readonly signal?: AbortSignal;
}

/** Everything a consumer needs to render a run, including which provider ran it. */
export type TaskEvent =
  | {
      readonly type: 'provider';
      readonly provider: ProviderId;
      readonly model: string;
      /** Constraints derived from Studio state that were applied to this run. */
      readonly guardrails: readonly Guardrail[];
    }
  | { readonly type: 'text'; readonly text: string }
  /**
   * Chain-of-thought tokens, which are NOT the answer.
   *
   * Reasoning models (DeepSeek R1, QwQ, and several NVIDIA NIM models) stream
   * their thinking in a separate field and only then start emitting `content`.
   * These were previously discarded, which produced the single most confusing
   * failure this product had: a successful 200 response, tokens billed, and an
   * empty output box. Surfacing them lets the panel say what actually happened.
   */
  | { readonly type: 'reasoning'; readonly text: string }
  | { readonly type: 'usage'; readonly usage: Usage }
  | {
      readonly type: 'done';
      readonly finishReason: string | null;
      readonly provider: ProviderId;
      readonly model: string;
    }
  | {
      readonly type: 'error';
      readonly message: string;
      readonly kind: string;
      readonly provider: ProviderId | null;
      readonly retryable: boolean;
    };

/** A provider that is configured, enabled, and has a model selected. */
export interface ResolvedProvider {
  readonly id: ProviderId;
  readonly model: string;
}

export type ResolutionFailure =
  'no-keys' | 'none-enabled' | 'no-model-selected' | 'primary-unavailable';

export interface Resolution {
  /** In attempt order: primary first, then fallbacks. */
  readonly chain: readonly ResolvedProvider[];
  readonly failure: ResolutionFailure | null;
}

/**
 * Decide which providers to try, in order.
 *
 * Exported and pure so the whole matrix is unit-testable without a network or a
 * storage stub. The rules:
 *
 *  1. A provider is usable only if it has a key, is enabled, and has a model
 *     selected. No model selected is a real state — NeuraTube hardcodes no model
 *     IDs, so a fresh install has a key but no model until the user picks one.
 *  2. A pinned primary goes first when usable.
 *  3. Configured fallbacks follow, in the user's order.
 *  4. Any remaining usable provider is appended. A task that could run should
 *     run; refusing because the user did not configure a fallback chain is
 *     pedantry.
 */
export function resolveProviders(
  task: TaskType,
  state: NeuraTubeState,
  configured: readonly ProviderId[],
  forceProvider?: ProviderId,
): Resolution {
  const usable = (id: ProviderId): ResolvedProvider | null => {
    if (!configured.includes(id)) return null;
    const settings = state.providers[id];
    if (!settings.enabled) return null;
    if (settings.model === '') return null;
    return { id, model: settings.model };
  };

  if (forceProvider) {
    const forced = usable(forceProvider);
    return forced
      ? { chain: [forced], failure: null }
      : { chain: [], failure: 'primary-unavailable' };
  }

  if (configured.length === 0) return { chain: [], failure: 'no-keys' };

  const routing = state.routing[task];
  const chain: ResolvedProvider[] = [];
  const seen = new Set<ProviderId>();

  const push = (id: ProviderId): void => {
    if (seen.has(id)) return;
    const resolved = usable(id);
    if (!resolved) return;
    seen.add(id);
    chain.push(resolved);
  };

  if (routing?.primary) push(routing.primary);
  for (const id of routing?.fallbacks ?? []) push(id);
  for (const id of PROVIDER_IDS) push(id);

  if (chain.length > 0) return { chain, failure: null };

  // Distinguish the failure modes so the UI can give real advice rather than
  // "no provider available".
  const anyEnabled = configured.some((id) => state.providers[id].enabled);
  if (!anyEnabled) return { chain: [], failure: 'none-enabled' };
  return { chain: [], failure: 'no-model-selected' };
}

export const RESOLUTION_ADVICE: Readonly<Record<ResolutionFailure, string>> = Object.freeze({
  'no-keys': 'No API key configured. Add one in NeuraTube options.',
  'none-enabled': 'Every configured provider is disabled. Enable one in NeuraTube options.',
  'no-model-selected':
    'No model selected. Open NeuraTube options and pick a model for your provider.',
  'primary-unavailable': 'That provider is not configured, enabled, or has no model selected.',
});

/** Build the message list. */
export function buildMessages(
  task: TaskType,
  state: NeuraTubeState,
  video: VideoContext | null,
  inputs: TaskInputs = {},
): readonly Message[] {
  const prompt = resolvePrompt(task, state.prompts[task]);

  // Guardrails go FIRST, before the task prompt.
  //
  // The task prompt is user-editable; guardrails are derived from the video's
  // own Studio settings and include at least one requirement with legal weight
  // (paid-promotion disclosure). Putting them ahead of the prompt means a user
  // who rewrites a prompt cannot accidentally delete them, and the model cannot
  // read the prompt as overriding them.
  const messages: Message[] = [
    ...guardrailMessages(guardrailsFor(task, video)),
    { role: 'system', content: prompt.text },
  ];

  // Metadata and the user's own instruction are separate messages, deliberately.
  // Concatenating them would let text scraped from a page borrow the authority
  // of something the user actually typed. See context.ts.
  messages.push({ role: 'user', content: renderVideoContext(video, inputs) });

  const instruction = renderUserInstruction(inputs);
  if (instruction !== null) {
    messages.push({ role: 'user', content: `The creator asks: ${instruction}` });
  }

  return messages;
}

/**
 * Run a task, streaming events.
 *
 * Never throws: failures are yielded as `error` events so a consumer reading the
 * stream in a `for await` does not need a separate try/catch, and a fallback
 * attempt is not mistaken for a fatal error.
 */
export async function* runTask(request: RunTaskRequest): AsyncGenerator<TaskEvent> {
  const definition = taskDefinition(request.task);
  const state = await readState();
  const credentials = await readCredentials();
  const configured = PROVIDER_IDS.filter((id) => (credentials[id] ?? '') !== '');

  const resolution = resolveProviders(request.task, state, configured, request.forceProvider);

  if (resolution.chain.length === 0) {
    const failure = resolution.failure ?? 'no-keys';
    yield {
      type: 'error',
      kind: 'configuration',
      message: RESOLUTION_ADVICE[failure],
      provider: null,
      retryable: false,
    };
    return;
  }

  const messages = buildMessages(request.task, state, request.video, request.inputs);
  // Reported to the consumer so the panel can tell the user why a task behaved
  // differently, rather than leaving the behaviour unexplained.
  const appliedGuardrails = guardrailsFor(request.task, request.video);

  let lastError: TaskEvent | null = null;

  for (const [index, candidate] of resolution.chain.entries()) {
    const apiKey = await readCredential(candidate.id);
    if (apiKey === null) continue;

    const settings = state.providers[candidate.id];
    const provider = createProvider(candidate.id, {
      apiKey,
      model: candidate.model,
      baseUrl: settings.baseUrl,
      enabled: settings.enabled,
    });

    yield {
      type: 'provider',
      provider: candidate.id,
      model: candidate.model,
      guardrails: appliedGuardrails,
    };

    /**
     * Whether any text has been emitted yet.
     *
     * Falling back AFTER partial output would splice two different models'
     * responses together and produce nonsense, so once a stream has produced
     * text the run is committed to that provider.
     */
    let produced = false;

    try {
      const stream = provider.chat(messages, {
        model: candidate.model,
        temperature: request.limits?.temperature ?? definition.temperature,
        maxTokens: request.limits?.maxTokens ?? definition.maxTokens,
        ...(request.signal ? { signal: request.signal } : {}),
      });

      for await (const event of stream) {
        if (event.type === 'text') {
          produced = true;
          yield event satisfies StreamEvent;
        } else if (event.type === 'usage' || event.type === 'reasoning') {
          /*
           * Reasoning does NOT set `produced`, deliberately.
           *
           * `produced` gates fallback to the next provider. A model that thought
           * and then ran out of budget has produced no answer, so the run should
           * still be allowed to fall over to another provider rather than being
           * treated as a success that happened to be blank.
           */
          yield event satisfies StreamEvent;
        } else {
          yield {
            type: 'done',
            finishReason: event.finishReason,
            provider: candidate.id,
            model: candidate.model,
          };
        }
      }
      return;
    } catch (thrown) {
      const error =
        thrown instanceof ProviderError
          ? thrown
          : new ProviderError({
              kind: 'unknown',
              provider: candidate.id,
              message: thrown instanceof Error ? thrown.message : String(thrown),
            });

      lastError = {
        type: 'error',
        kind: error.kind,
        message: error.userMessage,
        provider: candidate.id,
        retryable: error.retryable,
      };

      if (error.kind === 'aborted') {
        yield lastError;
        return;
      }

      const hasFallback = index < resolution.chain.length - 1;
      if (produced || !error.retryable || !hasFallback) {
        yield lastError;
        return;
      }

      log.warn('provider failed, falling back', { from: candidate.id, kind: error.kind });
    }
  }

  yield lastError ?? {
    type: 'error',
    kind: 'unknown',
    message: 'Every configured provider failed.',
    provider: null,
    retryable: false,
  };
}
