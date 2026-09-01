import type { JSX } from 'preact';
import { AboutPanel } from './AboutPanel';
import { AdvancedPanel } from './AdvancedPanel';
import { useState } from 'preact/hooks';
import { PROVIDER_IDS } from '~/providers/types';
import { ProviderCard } from './ProviderCard';
import { PromptsPanel } from './PromptsPanel';
import { RoutingPanel } from './RoutingPanel';
import { UsagePanel } from './UsagePanel';
import { DataPanel } from './DataPanel';
import { TryItPanel } from './TryItPanel';
import { useStore } from './useStore';

type Tab = 'providers' | 'prompts' | 'routing' | 'usage' | 'data' | 'advanced' | 'about';

const TABS: readonly { id: Tab; label: string }[] = [
  { id: 'providers', label: 'Providers' },
  { id: 'prompts', label: 'Prompts' },
  { id: 'routing', label: 'Routing' },
  { id: 'usage', label: 'Usage & cost' },
  { id: 'data', label: 'Privacy & data' },
  { id: 'advanced', label: 'Advanced' },
  { id: 'about', label: 'About' },
];

export function App(): JSX.Element {
  const store = useStore();
  const [tab, setTab] = useState<Tab>('providers');

  const configuredCount = PROVIDER_IDS.filter((id) => (store.credentials[id] ?? '') !== '').length;

  if (!store.ready) {
    return (
      <main class="shell">
        <p class="muted">Loading settings…</p>
      </main>
    );
  }

  return (
    <>
      <header class="topbar">
        <div class="brand">
          <span class="mark" aria-hidden="true">
            N
          </span>
          <div>
            <strong>NeuraTube</strong>
            <span class="muted small block">
              {__NEURATUBE_VERSION__} · {configuredCount} of {PROVIDER_IDS.length} providers
              configured
            </span>
          </div>
        </div>
      </header>

      <nav class="tabs" role="tablist" aria-label="Settings sections">
        {TABS.map((entry) => (
          <button
            key={entry.id}
            type="button"
            role="tab"
            id={`tab-${entry.id}`}
            aria-selected={tab === entry.id}
            aria-controls={`panel-${entry.id}`}
            class={`tab ${tab === entry.id ? 'is-active' : ''}`}
            onClick={() => {
              setTab(entry.id);
            }}
          >
            {entry.label}
          </button>
        ))}
      </nav>

      <main class="shell" id={`panel-${tab}`} role="tabpanel" aria-labelledby={`tab-${tab}`}>
        {tab === 'providers' ? (
          <>
            {configuredCount === 0 ? (
              <section class="card intro">
                <h2>Add a provider key to get started</h2>
                <p class="small">
                  NeuraTube runs on your own API key. Nothing is sent anywhere until you add one,
                  and it goes only to the provider you choose — never through a server we operate,
                  because we operate none.
                </p>
                <p class="small">
                  One key is enough. Add more if you want per-task routing or a fallback when a
                  provider is rate limited.
                </p>
              </section>
            ) : null}

            {PROVIDER_IDS.map((id) => (
              <ProviderCard key={id} id={id} store={store} />
            ))}

            <TryItPanel store={store} />
          </>
        ) : null}

        {tab === 'prompts' ? <PromptsPanel store={store} /> : null}
        {tab === 'routing' ? <RoutingPanel store={store} /> : null}
        {tab === 'usage' ? <UsagePanel store={store} /> : null}
        {tab === 'data' ? <DataPanel store={store} /> : null}
        {tab === 'advanced' ? <AdvancedPanel store={store} /> : null}
        {tab === 'about' ? <AboutPanel store={store} /> : null}
      </main>
    </>
  );
}
