/**
 * Provider factory.
 *
 * Constructed per call, never memoised. The service worker is terminated after
 * 30 seconds idle, so a cached instance would be pointless — and worse, it would
 * hold a stale API key after the user edited one.
 */

import { createAnthropicProvider } from './anthropic';
import { createOpenAiCompatibleProvider } from './openai-compatible';
import { specFor } from './specs';
import type { LLMProvider, ProviderConfig, ProviderId } from './types';

export function createProvider(id: ProviderId, config: ProviderConfig): LLMProvider {
  // Anthropic could go through the OpenAI-compatible adapter — they ship a
  // compatible endpoint — but that layer drops prompt caching, citations, PDF
  // input and strict tool schemas, which later milestones want.
  return specFor(id).wire === 'anthropic'
    ? createAnthropicProvider(config)
    : createOpenAiCompatibleProvider(id, config);
}

export * from './types';
export { PROVIDER_ORIGINS, PROVIDER_SPECS, specFor } from './specs';
export { ProviderError } from './errors';
