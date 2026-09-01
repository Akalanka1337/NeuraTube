/**
 * Typed accessor over `chrome.storage.local`.
 *
 * The whole state lives under a single key. One key means one atomic read, one
 * atomic write, and a single `onChanged` entry to subscribe to — which matters
 * because this is read on every content-script startup and sits directly in
 * front of the first-paint budget.
 */

import { createLogger } from '~/lib/logger';
import type { NeuraTubeState, PanelPrefs, Settings } from './schema';
import { DEFAULT_PANEL_PREFS, defaultState, migrate } from './schema';
import type { Surface } from '~/types/surface';

const log = createLogger('storage');

/** Single top-level key holding the entire state blob. */
export const STATE_KEY = 'neuratube:state';

/** Read and migrate the full state. Never rejects; falls back to defaults. */
export async function readState(): Promise<NeuraTubeState> {
  try {
    const bag = await chrome.storage.local.get(STATE_KEY);
    return migrate(bag[STATE_KEY]);
  } catch (error) {
    log.warn('read failed, using defaults', error);
    return defaultState();
  }
}

/** Persist the full state. Resolves `false` if the write failed. */
export async function writeState(state: NeuraTubeState): Promise<boolean> {
  try {
    await chrome.storage.local.set({ [STATE_KEY]: state });
    return true;
  } catch (error) {
    log.warn('write failed', error);
    return false;
  }
}

/**
 * Read-modify-write.
 *
 * `chrome.storage` offers no transaction, so two contexts updating different
 * fields concurrently can clobber each other. In practice the writers are one
 * content script per tab plus the popup, all updating disjoint subtrees, and
 * the loss window is a few milliseconds — acceptable for panel preferences.
 * Anything that ever needs true atomicity must move to the service worker
 * and be serialised there.
 */
/**
 * Serialises `updateState` within this JS context.
 *
 * Each call is a read-modify-write with an await in the middle, so two
 * overlapping calls both read the same snapshot and the later write discards the
 * earlier one's change. That is not hypothetical — it already produced a visible
 * bug once (hiding the panel, then watching it reappear as a settings write
 * clobbered the visibility write), and every feature that adds a new persisted
 * control adds another chance of it.
 *
 * Chaining every mutation onto one promise removes the window entirely for
 * same-context writers, which is all of them that matter: the panel's own
 * controls. A cross-context race (popup vs content script) is still possible and
 * still bounded to a few milliseconds on disjoint subtrees.
 */
let writeQueue: Promise<unknown> = Promise.resolve();

export async function updateState(
  mutate: (current: NeuraTubeState) => NeuraTubeState,
): Promise<NeuraTubeState> {
  const run = writeQueue.then(async () => {
    const current = await readState();
    const next = mutate(current);
    await writeState(next);
    return next;
  });

  // Keep the chain alive even if this caller's mutation throws, or one rejection
  // would wedge every later write.
  writeQueue = run.catch(() => undefined);
  return run;
}

export async function readSettings(): Promise<Settings> {
  return (await readState()).settings;
}

/**
 * Patch settings.
 *
 * WARNING: this and `patchPanelPrefs` each perform their own
 * read-modify-write. Do NOT call them concurrently — both will read the same
 * snapshot and the later write will silently discard the earlier one's change.
 * To update more than one subtree, make a single `updateState` call.
 */
export async function patchSettings(patch: Partial<Settings>): Promise<Settings> {
  const next = await updateState((current) => ({
    ...current,
    settings: { ...current.settings, ...patch },
  }));
  return next.settings;
}

export async function readPanelPrefs(surface: Surface): Promise<PanelPrefs> {
  const state = await readState();
  return { ...DEFAULT_PANEL_PREFS, ...state.panel[surface] };
}

/** Patch one surface's panel prefs. See the concurrency warning on `patchSettings`. */
export async function patchPanelPrefs(
  surface: Surface,
  patch: Partial<PanelPrefs>,
): Promise<PanelPrefs> {
  const next = await updateState((current) => ({
    ...current,
    panel: {
      ...current.panel,
      [surface]: { ...DEFAULT_PANEL_PREFS, ...current.panel[surface], ...patch },
    },
  }));
  return { ...DEFAULT_PANEL_PREFS, ...next.panel[surface] };
}

/**
 * Subscribe to external state changes.
 *
 * Fires when another context (popup, another tab, the service worker) writes.
 * Returns an unsubscribe function.
 */
export function onStateChanged(handler: (state: NeuraTubeState) => void): () => void {
  const listener = (
    changes: Record<string, chrome.storage.StorageChange>,
    areaName: string,
  ): void => {
    if (areaName !== 'local') return;
    const change = changes[STATE_KEY];
    if (!change) return;
    handler(migrate(change.newValue));
  };

  chrome.storage.onChanged.addListener(listener);
  return () => {
    chrome.storage.onChanged.removeListener(listener);
  };
}
