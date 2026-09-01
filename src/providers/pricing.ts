/**
 * Token pricing.
 *
 * The cost meter promises real numbers, and the honest position is that we
 * cannot know them reliably. Providers change prices, run off-peak discounts
 * (DeepSeek), price per-model with no API to query it, and in NVIDIA NIM's case
 * do not publish per-token rates publicly at all.
 *
 * So this table is a STARTING POINT with an explicit verification date, and
 * every entry is overridable by the user. When a model has no entry the meter
 * shows the token count and says the price is unknown, rather than inventing a
 * figure — a wrong cost estimate is worse than no cost estimate, because the
 * user will budget against it.
 *
 * The same reasoning as the model registry: rates churn faster than releases,
 * so the code must not pretend otherwise.
 */

import type { ProviderId } from './types';

/** When the bundled defaults were last checked against published pricing. */
export const PRICING_VERIFIED_AT = '2026-08-29';

/** USD per million tokens. */
export interface TokenPrice {
  readonly inputPerMillion: number;
  readonly outputPerMillion: number;
}

export interface PricingEntry extends TokenPrice {
  /** Matched against the model id as a case-insensitive prefix. */
  readonly modelPrefix: string;
  readonly provider: ProviderId;
}

/**
 * Bundled defaults.
 *
 * Intentionally sparse. Prefix matching means a family entry covers its
 * snapshots, and anything unmatched is reported as unknown rather than guessed.
 * Extend only with a figure taken from the provider's own pricing page, and move
 * PRICING_VERIFIED_AT when you do.
 */
export const DEFAULT_PRICING: readonly PricingEntry[] = Object.freeze([
  // OpenAI
  { provider: 'openai', modelPrefix: 'gpt-4o-mini', inputPerMillion: 0.15, outputPerMillion: 0.6 },
  { provider: 'openai', modelPrefix: 'gpt-4o', inputPerMillion: 2.5, outputPerMillion: 10 },
  // Anthropic
  { provider: 'anthropic', modelPrefix: 'claude-haiku', inputPerMillion: 1, outputPerMillion: 5 },
  { provider: 'anthropic', modelPrefix: 'claude-sonnet', inputPerMillion: 3, outputPerMillion: 15 },
  { provider: 'anthropic', modelPrefix: 'claude-opus', inputPerMillion: 15, outputPerMillion: 75 },
  // DeepSeek. Off-peak rates are materially cheaper and this does not model
  // that, so treat these as an upper bound.
  { provider: 'deepseek', modelPrefix: 'deepseek', inputPerMillion: 0.56, outputPerMillion: 1.68 },
]);

export type PricingOverrides = Record<string, TokenPrice>;

/**
 * Resolve a price for a model.
 *
 * User overrides win outright — they are keyed by exact model id and are the
 * mechanism by which a user corrects a stale bundled default or prices a model
 * we have never heard of. Returns null when nothing matches.
 */
export function priceFor(
  provider: ProviderId,
  model: string,
  overrides: PricingOverrides = {},
): TokenPrice | null {
  const override = overrides[model] ?? overrides[`${provider}:${model}`];
  if (override) return override;

  const needle = model.toLowerCase();
  // Longest prefix wins, so `gpt-4o-mini` is not captured by `gpt-4o`.
  let best: PricingEntry | null = null;
  for (const entry of DEFAULT_PRICING) {
    if (entry.provider !== provider) continue;
    if (!needle.startsWith(entry.modelPrefix.toLowerCase())) continue;
    if (!best || entry.modelPrefix.length > best.modelPrefix.length) best = entry;
  }
  return best;
}

/** Cost in USD, or null when the model has no known price. */
export function estimateCost(
  provider: ProviderId,
  model: string,
  inputTokens: number,
  outputTokens: number,
  overrides: PricingOverrides = {},
): number | null {
  const price = priceFor(provider, model, overrides);
  if (!price) return null;
  return (
    (inputTokens / 1_000_000) * price.inputPerMillion +
    (outputTokens / 1_000_000) * price.outputPerMillion
  );
}

/** Format a USD amount at a precision that stays meaningful for tiny sums. */
export function formatUsd(amount: number | null): string {
  if (amount === null) return 'unknown';
  if (amount === 0) return '$0.00';
  if (amount < 0.01) return `$${amount.toFixed(5)}`;
  if (amount < 1) return `$${amount.toFixed(4)}`;
  return `$${amount.toFixed(2)}`;
}
