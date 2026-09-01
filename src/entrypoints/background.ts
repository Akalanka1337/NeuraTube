/**
 * Service worker.
 *
 * Design constraints that shape every line here:
 *
 *  - The worker is terminated after 30 seconds of inactivity, after a single
 *    task exceeding 5 minutes, or if a fetch takes over 30 seconds to return
 *    headers. Therefore: NO module-scope mutable state that matters. Anything
 *    that must survive goes to storage. Module scope holds constants only.
 *  - Provider calls live here (M3). API keys are read from storage per call and
 *    never cached in a module variable — a cached credential is both a
 *    correctness bug (stale after the user edits it) and a lifetime bug (gone
 *    after termination anyway).
 *  - Streaming runs over a long-lived port with a heartbeat, because opening a
 *    port does NOT reset the idle timer; only sending messages does. See
 *    orchestrator/stream.ts.
 *  - Listeners must be registered synchronously at top level. Registering
 *    inside an async callback means the worker can wake for an event it has no
 *    handler for yet, and the event is dropped.
 */

import { createLogger, setLoggingEnabled } from '~/lib/logger';
import { PROTOCOL_VERSION, sendToTab } from '~/types/messages';
import type { FromBackground, ToBackground } from '~/types/messages';
import { STATE_KEY, readState, writeState } from '~/storage/local';
import { migrate } from '~/storage/schema';
import { isSupportedHostname } from '~/types/hosts';
import { createProvider } from '~/providers/index';
import { ProviderError } from '~/providers/errors';
import { isFresh, normaliseModelCache } from '~/providers/modelCache';
import type { ModelInfo, ProviderId } from '~/providers/types';
import { readCredential } from '~/storage/credentials';
import { updateState } from '~/storage/local';
import { TASK_PORT, serveTaskPort } from '~/orchestrator/stream';
import { loadTranscript, saveTranscript } from '~/state/transcriptStore';

const log = createLogger('sw');

/* -------------------------------------------------------------------------- */
/* Lifecycle                                                                   */
/* -------------------------------------------------------------------------- */

chrome.runtime.onInstalled.addListener((details) => {
  void (async () => {
    // Reading through `migrate` and writing back normalises whatever shape is
    // on disk, so an upgrade lands on a known-good state before any content
    // script reads it.
    const state = await readState();
    await writeState(state);
    setLoggingEnabled(state.settings.debugLogging);
    log.info('installed', { reason: details.reason, version: __NEURATUBE_VERSION__ });
  })();
});

chrome.runtime.onStartup.addListener(() => {
  void (async () => {
    const { settings } = await readState();
    setLoggingEnabled(settings.debugLogging);
  })();
});

// The worker may wake for any event, so pick up the logging preference on every
// cold start rather than only on install.
void (async () => {
  const { settings } = await readState();
  setLoggingEnabled(settings.debugLogging);
})();

/* -------------------------------------------------------------------------- */
/* Hotkey                                                                      */
/* -------------------------------------------------------------------------- */

chrome.commands.onCommand.addListener((command) => {
  if (command !== 'toggle-panel') return;
  void (async () => {
    const tab = await activeSupportedTab();
    if (!tab?.id) {
      log.debug('toggle ignored: no supported tab in focus');
      return;
    }
    const reply = await sendToTab(tab.id, { type: 'toggle-panel', reason: 'command' });
    if (!reply) {
      // Content script not present: the tab was open before the extension was
      // installed or reloaded. Chrome does not retroactively inject, and we
      // deliberately hold no `scripting` permission to do it ourselves, so the
      // honest outcome is to tell the user to reload.
      log.warn('no content script in the active tab — reload the page');
    }
  })();
});

/* -------------------------------------------------------------------------- */
/* Task streaming                                                              */
/* -------------------------------------------------------------------------- */

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== TASK_PORT) return;
  log.debug('task port connected');
  serveTaskPort(port);
});

/* -------------------------------------------------------------------------- */
/* Provider operations                                                         */
/* -------------------------------------------------------------------------- */

/**
 * Build a provider from stored configuration.
 *
 * Returns null when no key is stored. Reads per call, deliberately — see the
 * lifecycle note at the top of this file.
 */
async function providerFor(id: ProviderId) {
  const apiKey = await readCredential(id);
  if (apiKey === null) return null;

  const state = await readState();
  const settings = state.providers[id];
  return createProvider(id, {
    apiKey,
    model: settings.model,
    baseUrl: settings.baseUrl,
    enabled: settings.enabled,
  });
}

async function handleTestProvider(id: ProviderId): Promise<FromBackground> {
  const provider = await providerFor(id);
  if (!provider) {
    return {
      type: 'provider-test',
      result: {
        ok: false,
        latencyMs: 0,
        modelCount: null,
        error: 'No API key stored for this provider.',
      },
    };
  }
  return { type: 'provider-test', result: await provider.testConnection() };
}

/**
 * Fetch a model list, cache-first.
 *
 * Cached for 24 hours: NeuraTube hardcodes no model IDs, so the options page
 * needs a list before the user can choose, but a catalogue that changes weekly
 * at most does not warrant a round trip on every page open.
 */
async function handleListModels(id: ProviderId, force: boolean): Promise<FromBackground> {
  const state = await readState();
  const cached = normaliseModelCache(state.modelCache)[id];

  if (!force && isFresh(cached) && cached) {
    return {
      type: 'models',
      models: cached.models,
      fetchedAt: cached.fetchedAt,
      fromCache: true,
      error: null,
    };
  }

  const provider = await providerFor(id);
  if (!provider) {
    return {
      type: 'models',
      models: cached?.models ?? [],
      fetchedAt: cached?.fetchedAt ?? 0,
      fromCache: true,
      error: 'No API key stored for this provider.',
    };
  }

  try {
    const models: readonly ModelInfo[] = await provider.listModels();
    const fetchedAt = Date.now();

    await updateState((current) => ({
      ...current,
      modelCache: { ...current.modelCache, [id]: { models, fetchedAt } },
    }));

    return { type: 'models', models, fetchedAt, fromCache: false, error: null };
  } catch (thrown) {
    const message =
      thrown instanceof ProviderError ? thrown.userMessage : 'Could not fetch the model list.';
    // Serve the stale list alongside the error: a stale list the user can still
    // pick from beats an empty dropdown.
    return {
      type: 'models',
      models: cached?.models ?? [],
      fetchedAt: cached?.fetchedAt ?? 0,
      fromCache: true,
      error: message,
    };
  }
}

/* -------------------------------------------------------------------------- */
/* Messaging                                                                   */
/* -------------------------------------------------------------------------- */

chrome.runtime.onMessage.addListener((raw, sender, respond: (value: FromBackground) => void) => {
  const message = raw as ToBackground;

  switch (message.type) {
    case 'ping':
      respond({ type: 'pong', version: __NEURATUBE_VERSION__, protocol: PROTOCOL_VERSION });
      return false;

    case 'surface-changed':
      log.debug('surface', { tab: sender.tab?.id, surface: message.surface.surface });
      respond({ type: 'ack' });
      return false;

    case 'panel-ready':
      log.debug('panel ready', {
        tab: sender.tab?.id,
        firstPaintMs: message.status.firstPaintMs,
        trustedTypes: message.status.trustedTypesEnforced,
      });
      respond({ type: 'ack' });
      return false;

    case 'test-provider':
      // Returning true keeps the response channel open for the async reply.
      void handleTestProvider(message.provider).then(respond);
      return true;

    case 'list-models':
      void handleListModels(message.provider, message.force ?? false).then(respond);
      return true;

    case 'transcript-captured':
      // The worker is the single writer for session-scoped transcripts; see
      // state/transcriptStore.ts for why.
      void saveTranscript(message.transcript).then(() => {
        respond({ type: 'ack' });
      });
      return true;

    case 'get-transcript':
      void loadTranscript(message.videoId).then((transcript) => {
        respond({ type: 'transcript', transcript });
      });
      return true;

    default:
      // An unknown message is a version skew between contexts, not a crash.
      log.warn('unknown message', message);
      respond({ type: 'ack' });
      return false;
  }
});

/* -------------------------------------------------------------------------- */
/* Storage                                                                     */
/* -------------------------------------------------------------------------- */

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  const change = changes[STATE_KEY];
  if (!change) return;
  setLoggingEnabled(migrate(change.newValue).settings.debugLogging);
});

/* -------------------------------------------------------------------------- */
/* Helpers                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * The focused tab, if it is a surface we attach to.
 *
 * `tab.url` is readable without the `tabs` permission because our
 * `host_permissions` cover these origins.
 */
async function activeSupportedTab(): Promise<chrome.tabs.Tab | null> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.url) return null;
  try {
    const { hostname } = new URL(tab.url);
    return isSupportedHostname(hostname) ? tab : null;
  } catch {
    return null;
  }
}
