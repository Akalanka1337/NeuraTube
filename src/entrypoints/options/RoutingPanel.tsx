import type { JSX } from 'preact';
import { PROVIDER_SPECS } from '~/providers/specs';
import { PROVIDER_IDS } from '~/providers/types';
import type { ProviderId } from '~/providers/types';
import { TASK_TYPES, TASKS, defaultRouting } from '~/orchestrator/tasks';
import type { Store } from './useStore';

/**
 * Per-task provider routing.
 *
 * `Automatic` is the default for every task, and that is not laziness: on a
 * fresh install the user has at most one key, so a pinned provider would produce
 * a task that cannot run. Automatic uses the first provider that has a key, is
 * enabled, and has a model selected.
 *
 * Fallback is a single checkbox rather than an ordered list. An ordered chain
 * sounds better than it is — the useful behaviour is "try something else when the
 * pinned provider is rate limited", and asking a user to rank four providers per
 * task for eleven tasks is a configuration surface nobody wants.
 */
export function RoutingPanel({ store }: { readonly store: Store }): JSX.Element {
  const usable = PROVIDER_IDS.filter((id) => {
    const hasKey = (store.credentials[id] ?? '') !== '';
    return hasKey && store.state.providers[id].enabled;
  });

  return (
    <section class="card">
      <h3>Task routing</h3>
      <p class="muted small">
        Which provider handles each task. Automatic picks the first provider that is configured,
        enabled, and has a model selected.
      </p>

      {usable.length === 0 ? (
        <p class="banner warn small">
          No provider is ready yet. Add a key and select a model on the Providers tab first.
        </p>
      ) : null}

      <table class="routing">
        <thead>
          <tr>
            <th scope="col">Task</th>
            <th scope="col">Provider</th>
            <th scope="col">Fall back</th>
          </tr>
        </thead>
        <tbody>
          {TASK_TYPES.map((task) => {
            const routing = store.state.routing[task] ?? defaultRouting();
            const hasFallback = routing.fallbacks.length > 0;

            return (
              <tr key={task}>
                <th scope="row">
                  <span>{TASKS[task].label}</span>
                  <span class="muted small block">{TASKS[task].description}</span>
                </th>
                <td>
                  <label class="sr-only" for={`route-${task}`}>
                    Provider for {TASKS[task].label}
                  </label>
                  <select
                    id={`route-${task}`}
                    value={routing.primary ?? ''}
                    onChange={(event) => {
                      const value = event.currentTarget.value;
                      const primary = value === '' ? null : (value as ProviderId);
                      void store.setRouting(task, {
                        primary,
                        fallbacks: hasFallback ? otherProviders(primary, usable) : [],
                      });
                    }}
                  >
                    <option value="">Automatic</option>
                    {usable.map((id) => (
                      <option key={id} value={id}>
                        {PROVIDER_SPECS[id].label}
                      </option>
                    ))}
                  </select>
                </td>
                <td>
                  <label class="switch">
                    <input
                      type="checkbox"
                      checked={hasFallback}
                      disabled={usable.length < 2}
                      onChange={(event) => {
                        const enabled = event.currentTarget.checked;
                        void store.setRouting(task, {
                          primary: routing.primary,
                          fallbacks: enabled ? otherProviders(routing.primary, usable) : [],
                        });
                      }}
                    />
                    <span class="sr-only">Fall back for {TASKS[task].label}</span>
                  </label>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>

      <p class="muted small">
        Fallback only triggers on a retryable failure — a rate limit, a server error, or a network
        problem — and never once a response has started streaming, because splicing two models&apos;
        output together produces nonsense.
      </p>
    </section>
  );
}

function otherProviders(
  primary: ProviderId | null,
  usable: readonly ProviderId[],
): readonly ProviderId[] {
  return usable.filter((id) => id !== primary);
}
