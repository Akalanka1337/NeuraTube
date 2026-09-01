import type { JSX } from 'preact';
import { useState } from 'preact/hooks';
import { PROVIDER_SPECS } from '~/providers/specs';
import { PROVIDER_IDS } from '~/providers/types';
import { PRICING_VERIFIED_AT, formatUsd, priceFor } from '~/providers/pricing';
import { formatTokens, totalsFor } from '~/orchestrator/costMeter';
import type { Store } from './useStore';

/**
 * Cost meter and pricing.
 *
 * The product positions cost transparency against vidIQ's credit system, which
 * obliges us to be honest in a specific way: token counts always come from the
 * provider and are never estimated, and when a model's price is unknown this says
 * "unknown" rather than substituting a similar model's rate. A creator who
 * budgets against an invented figure is worse off than one who was told we do not
 * know.
 */
export function UsagePanel({ store }: { readonly store: Store }): JSX.Element {
  const { usage, pricingOverrides, providers } = store.state;
  const totals = totalsFor(usage.byProvider);

  return (
    <>
      <section class="card">
        <header class="provider-head">
          <div>
            <h3>Spend this month</h3>
            <p class="muted small">
              {usage.month} · counted from provider-reported tokens, never estimated locally.
            </p>
          </div>
          <button
            type="button"
            class="ghost"
            onClick={() => {
              void store.resetUsage();
            }}
          >
            Reset counter
          </button>
        </header>

        <div class="totals">
          <div>
            <span class="totals-value">{totals.requests}</span>
            <span class="muted small">requests</span>
          </div>
          <div>
            <span class="totals-value">{formatTokens(totals.inputTokens)}</span>
            <span class="muted small">input tokens</span>
          </div>
          <div>
            <span class="totals-value">{formatTokens(totals.outputTokens)}</span>
            <span class="muted small">output tokens</span>
          </div>
          <div>
            <span class="totals-value">{totals.costLabel}</span>
            <span class="muted small">estimated cost</span>
          </div>
        </div>

        {totals.requests === 0 ? (
          <p class="muted small">
            Nothing run yet. Counts appear here as soon as a task completes.
          </p>
        ) : null}

        {totals.costUsd === null && totals.requests > 0 ? (
          <p class="banner warn small">
            At least one model used has no known price, so the total cannot be completed. Set a
            price below to fix it.
          </p>
        ) : null}

        <table class="routing">
          <thead>
            <tr>
              <th scope="col">Provider</th>
              <th scope="col">Requests</th>
              <th scope="col">Input</th>
              <th scope="col">Output</th>
              <th scope="col">Cost</th>
            </tr>
          </thead>
          <tbody>
            {PROVIDER_IDS.map((id) => {
              const record = usage.byProvider[id];
              if (!record) return null;
              return (
                <tr key={id}>
                  <th scope="row">{PROVIDER_SPECS[id].label}</th>
                  <td>{record.requests}</td>
                  <td>{formatTokens(record.inputTokens)}</td>
                  <td>{formatTokens(record.outputTokens)}</td>
                  <td>{record.costUsd === null ? 'unknown' : formatUsd(record.costUsd)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </section>

      <section class="card">
        <h3>Token pricing</h3>
        <p class="muted small">
          Bundled rates were last checked on {PRICING_VERIFIED_AT}. Provider prices change, run
          off-peak discounts, and in NVIDIA NIM&apos;s case are not published per-token publicly at
          all — so every rate here is overridable, and an unpriced model is reported as unknown
          rather than guessed.
        </p>

        {PROVIDER_IDS.map((id) => {
          const model = providers[id].model;
          if (model === '') return null;
          return (
            <PriceRow
              key={id}
              store={store}
              providerLabel={PROVIDER_SPECS[id].label}
              model={model}
              known={priceFor(id, model, pricingOverrides)}
              isOverridden={pricingOverrides[model] !== undefined}
            />
          );
        })}

        {PROVIDER_IDS.every((id) => providers[id].model === '') ? (
          <p class="muted small">Select a model on the Providers tab to set its price.</p>
        ) : null}
      </section>
    </>
  );
}

interface PriceRowProps {
  readonly store: Store;
  readonly providerLabel: string;
  readonly model: string;
  readonly known: { readonly inputPerMillion: number; readonly outputPerMillion: number } | null;
  readonly isOverridden: boolean;
}

function PriceRow({
  store,
  providerLabel,
  model,
  known,
  isOverridden,
}: PriceRowProps): JSX.Element {
  const [input, setInput] = useState(known ? String(known.inputPerMillion) : '');
  const [output, setOutput] = useState(known ? String(known.outputPerMillion) : '');

  const inputValue = Number(input);
  const outputValue = Number(output);
  const valid =
    input.trim() !== '' &&
    output.trim() !== '' &&
    Number.isFinite(inputValue) &&
    Number.isFinite(outputValue) &&
    inputValue >= 0 &&
    outputValue >= 0;

  return (
    <div class="field">
      <label>
        {providerLabel} · <code>{model}</code>{' '}
        {known === null ? (
          <span class="pill err">no known price</span>
        ) : isOverridden ? (
          <span class="pill warn">your price</span>
        ) : (
          <span class="pill">bundled default</span>
        )}
      </label>
      <div class="row">
        <input
          type="number"
          min="0"
          step="0.01"
          value={input}
          placeholder="input $ / 1M"
          aria-label={`Input price per million tokens for ${model}`}
          onInput={(event) => {
            setInput(event.currentTarget.value);
          }}
        />
        <input
          type="number"
          min="0"
          step="0.01"
          value={output}
          placeholder="output $ / 1M"
          aria-label={`Output price per million tokens for ${model}`}
          onInput={(event) => {
            setOutput(event.currentTarget.value);
          }}
        />
        <button
          type="button"
          disabled={!valid}
          onClick={() => {
            void store.setPricingOverride(model, inputValue, outputValue);
          }}
        >
          Set
        </button>
        {isOverridden ? (
          <button
            type="button"
            class="ghost"
            onClick={() => {
              void store.clearPricingOverride(model);
            }}
          >
            Use default
          </button>
        ) : null}
      </div>
    </div>
  );
}
