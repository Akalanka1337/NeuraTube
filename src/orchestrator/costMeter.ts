/**
 * Cost meter.
 *
 * The product promises "real-time token counter, monthly-spend estimate" and
 * positions cost transparency against vidIQ's credit system, so this has to be
 * honest in a specific way: when a model's price is unknown it must say
 * "unknown", not fall back to a similar model's rate. A creator who budgets
 * against an invented number is worse off than one who was told we do not know.
 *
 * Token counts, by contrast, always come from the provider — never estimated
 * client-side — which is why the stream carries usage events at all.
 */

import { estimateCost, formatUsd } from '~/providers/pricing';
import type { PricingOverrides } from '~/providers/pricing';
import type { ProviderId, Usage } from '~/providers/types';
import { updateState } from '~/storage/local';
import type { UsageRecord } from '~/storage/schema';
import { currentMonth, defaultUsageLedger } from '~/storage/schema';

/** One completed request, ready to fold into the ledger. */
export interface RequestCost {
  readonly provider: ProviderId;
  readonly model: string;
  readonly usage: Usage;
  /** Null when the model has no known price. */
  readonly costUsd: number | null;
}

export function computeRequestCost(
  provider: ProviderId,
  model: string,
  usage: Usage,
  overrides: PricingOverrides,
): RequestCost {
  return {
    provider,
    model,
    usage,
    costUsd: estimateCost(provider, model, usage.inputTokens, usage.outputTokens, overrides),
  };
}

/**
 * Fold a completed request into the monthly ledger.
 *
 * A single `updateState` call, deliberately: two concurrent `patch*` helpers
 * each read-modify-write and the later write discards the earlier one's change,
 * which is a bug this project has already shipped once (see the M2 changelog).
 */
export async function recordRequest(cost: RequestCost): Promise<void> {
  await updateState((current) => {
    // Roll the ledger over rather than accumulating across months.
    const ledger = current.usage.month === currentMonth() ? current.usage : defaultUsageLedger();

    const previous: UsageRecord = ledger.byProvider[cost.provider] ?? {
      requests: 0,
      inputTokens: 0,
      outputTokens: 0,
      costUsd: 0,
    };

    // A single unpriced model makes the whole provider total unknowable. Better
    // to report "partly unknown" than a total that silently omits requests.
    const nextCost =
      previous.costUsd === null || cost.costUsd === null ? null : previous.costUsd + cost.costUsd;

    return {
      ...current,
      usage: {
        month: ledger.month,
        byProvider: {
          ...ledger.byProvider,
          [cost.provider]: {
            requests: previous.requests + 1,
            inputTokens: previous.inputTokens + cost.usage.inputTokens,
            outputTokens: previous.outputTokens + cost.usage.outputTokens,
            costUsd: nextCost,
          },
        },
      },
    };
  });
}

export interface LedgerTotals {
  readonly requests: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  /** Null when any contributing provider had an unpriced model. */
  readonly costUsd: number | null;
  readonly costLabel: string;
}

/** Total across providers. */
export function totalsFor(byProvider: Partial<Record<ProviderId, UsageRecord>>): LedgerTotals {
  let requests = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  let costUsd: number | null = 0;

  for (const record of Object.values(byProvider)) {
    if (!record) continue;
    requests += record.requests;
    inputTokens += record.inputTokens;
    outputTokens += record.outputTokens;
    if (costUsd !== null) {
      costUsd = record.costUsd === null ? null : costUsd + record.costUsd;
    }
  }

  return {
    requests,
    inputTokens,
    outputTokens,
    costUsd,
    costLabel: costUsd === null ? 'partly unknown' : formatUsd(costUsd),
  };
}

/** Compact token count for a live counter. */
export function formatTokens(count: number): string {
  if (count < 1_000) return String(count);
  if (count < 1_000_000) return `${(count / 1_000).toFixed(1)}k`;
  return `${(count / 1_000_000).toFixed(2)}M`;
}
