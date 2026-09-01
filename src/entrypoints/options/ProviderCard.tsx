import type { JSX } from 'preact';
import { useState } from 'preact/hooks';
import { PROVIDER_SPECS } from '~/providers/specs';
import type { ProviderId } from '~/providers/types';
import { maskKey } from '~/storage/credentials';
import type { ModelsState, Store } from './useStore';

export interface ProviderCardProps {
  readonly id: ProviderId;
  readonly store: Store;
}

function relativeTime(timestamp: number): string {
  if (timestamp === 0) return 'never';
  const seconds = Math.round((Date.now() - timestamp) / 1000);
  if (seconds < 60) return 'just now';
  if (seconds < 3600) return `${Math.round(seconds / 60)}m ago`;
  if (seconds < 86_400) return `${Math.round(seconds / 3600)}h ago`;
  return `${Math.round(seconds / 86_400)}d ago`;
}

/**
 * One provider's configuration.
 *
 * Two deliberate behaviours worth knowing:
 *
 *  - A STORED KEY IS NEVER RETURNED TO THE UI. The input starts empty and shows
 *    a masked preview beside it. Round-tripping the real value into a DOM node
 *    would put it in the accessibility tree, in a screenshot, and in any DOM
 *    dump — for no benefit, since the user cannot meaningfully verify a 100-
 *    character secret by eye anyway.
 *  - THE MODEL LIST IS FETCHED, NEVER HARDCODED. Provider catalogues churn
 *    faster than releases and the IDs in the original spec were already stale,
 *    so the dropdown is populated from the provider's own /models endpoint and
 *    cached for 24 hours with an explicit refresh.
 */
export function ProviderCard({ id, store }: ProviderCardProps): JSX.Element {
  const spec = PROVIDER_SPECS[id];
  const settings = store.state.providers[id];
  const storedKey = store.credentials[id];
  const models: ModelsState = store.models[id];
  const test = store.tests[id];

  const [draftKey, setDraftKey] = useState('');
  const [revealed, setRevealed] = useState(false);
  const [showAdvanced, setShowAdvanced] = useState(settings.baseUrl !== '');

  const hasKey = (storedKey ?? '') !== '';

  const onSaveKey = (): void => {
    if (draftKey.trim() === '') return;
    void store.saveKey(id, draftKey).then(() => {
      setDraftKey('');
      // Fetch the catalogue immediately: without a model selected the provider
      // cannot run a task, so the next thing the user needs is the list.
      return store.loadModels(id, true);
    });
  };

  return (
    <section class={`card provider ${hasKey ? '' : 'provider--unconfigured'}`}>
      <header class="provider-head">
        <div>
          <h3>{spec.label}</h3>
          <p class="muted small">
            {hasKey ? (
              <>
                Key stored: <code>{maskKey(storedKey ?? '')}</code>
              </>
            ) : (
              <>
                No key.{' '}
                <a href={spec.keyUrl} target="_blank" rel="noopener noreferrer">
                  Get one
                </a>{' '}
                — {spec.keyHint}.
              </>
            )}
          </p>
        </div>

        <label class="switch">
          <input
            type="checkbox"
            checked={settings.enabled}
            disabled={!hasKey}
            onChange={(event) => {
              void store.patchProvider(id, {
                enabled: event.currentTarget.checked,
              });
            }}
          />
          <span>Enabled</span>
        </label>
      </header>

      <div class="field">
        <label for={`key-${id}`}>API key</label>
        <div class="row">
          <input
            id={`key-${id}`}
            type={revealed ? 'text' : 'password'}
            value={draftKey}
            spellcheck={false}
            autocomplete="off"
            placeholder={
              hasKey ? 'Paste a new key to replace the stored one' : `Paste your ${spec.label} key`
            }
            onInput={(event) => {
              setDraftKey(event.currentTarget.value);
            }}
            onKeyDown={(event) => {
              if (event.key === 'Enter') onSaveKey();
            }}
          />
          <button
            type="button"
            class="ghost"
            onClick={() => {
              setRevealed((value) => !value);
            }}
            title={revealed ? 'Hide' : 'Show what you are typing'}
          >
            {revealed ? 'Hide' : 'Show'}
          </button>
          <button type="button" onClick={onSaveKey} disabled={draftKey.trim() === ''}>
            Save
          </button>
          {hasKey ? (
            <button
              type="button"
              class="danger ghost"
              onClick={() => {
                void store.saveKey(id, '');
              }}
            >
              Remove
            </button>
          ) : null}
        </div>
        <p class="muted small">
          Stored locally in this browser profile, never synced to Google, and sent only to{' '}
          {spec.label} when you run a task.
        </p>
      </div>

      <div class="field">
        <label for={`model-${id}`}>Model</label>
        <div class="row">
          <select
            id={`model-${id}`}
            value={settings.model}
            disabled={!hasKey || models.models.length === 0}
            onChange={(event) => {
              void store.patchProvider(id, {
                model: event.currentTarget.value,
              });
            }}
          >
            <option value="">
              {models.models.length === 0 ? 'Load the model list first' : 'Select a model…'}
            </option>
            {models.models.map((model) => (
              <option key={model.id} value={model.id}>
                {model.label === model.id ? model.id : `${model.label} — ${model.id}`}
              </option>
            ))}
          </select>
          <button
            type="button"
            class="ghost"
            disabled={!hasKey || models.loading}
            onClick={() => {
              void store.loadModels(id, true);
            }}
          >
            {models.loading ? 'Loading…' : models.models.length > 0 ? 'Refresh' : 'Load models'}
          </button>
        </div>

        {models.models.length > 0 ? (
          <p class="muted small">
            {models.models.length} models · fetched {relativeTime(models.fetchedAt)}
            {models.fromCache ? ' (cached)' : ''}
          </p>
        ) : null}
        {models.error !== null ? <p class="small error">{models.error}</p> : null}
        {settings.model === '' && hasKey ? (
          <p class="small warn">
            Tasks cannot run until a model is selected. NeuraTube ships no default model because
            provider catalogues change faster than extension releases.
          </p>
        ) : null}
      </div>

      <div class="row">
        <button
          type="button"
          disabled={!hasKey || test === 'running'}
          onClick={() => {
            void store.testProvider(id);
          }}
        >
          {test === 'running' ? 'Testing…' : 'Test connection'}
        </button>

        {test !== undefined && test !== 'running' ? (
          test.ok ? (
            <span class="pill ok">
              Connected · {test.latencyMs} ms · {test.modelCount ?? 0} models
            </span>
          ) : (
            <span class="pill err">Failed</span>
          )
        ) : null}
      </div>

      {test !== undefined && test !== 'running' && !test.ok && test.error !== null ? (
        <p class="small error">{test.error}</p>
      ) : null}

      <button
        type="button"
        class="ghost small-btn"
        onClick={() => {
          setShowAdvanced((value) => !value);
        }}
      >
        {showAdvanced ? 'Hide' : 'Show'} advanced
      </button>

      {showAdvanced ? (
        <div class="field">
          <label for={`base-${id}`}>Base URL override</label>
          <input
            id={`base-${id}`}
            type="url"
            spellcheck={false}
            value={settings.baseUrl}
            placeholder={spec.defaultBaseUrl}
            onChange={(event) => {
              void store.patchProvider(id, {
                baseUrl: event.currentTarget.value.trim(),
              });
            }}
          />
          <p class="muted small">
            For a self-hosted endpoint or a gateway. NeuraTube only holds permission for the four
            official provider origins, so a request to any other host will be blocked by Chrome —
            deliberately, rather than requesting broad access we do not need.
          </p>
        </div>
      ) : null}
    </section>
  );
}
