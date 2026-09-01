/**
 * Panel content script — ISOLATED world, document_idle.
 *
 * This file is the extension's only presence on the page in M1. It is
 * deliberately NOT injected at document_start: doing so blocks page load and
 * puts NeuraTube on YouTube's critical rendering path, which the project's
 * non-functional requirements forbid. Only the MAIN-world interceptor (M2)
 * needs document_start, because it has to patch XMLHttpRequest before
 * YouTube's application bundle issues its first request.
 *
 * Responsibilities:
 *   - measure and report first paint
 *   - classify the surface and follow client-side navigation
 *   - mount the Shadow-DOM panel and keep it alive across SPA route changes
 *   - mirror panel state to and from chrome.storage.local
 *   - respond to the service worker's hotkey command
 *   - perform the handshake with the MAIN-world interceptor and reduce every
 *     validated capture into the context store (M2)
 */

import { markContentStart } from '~/lib/perf';
import { createLogger, setLoggingEnabled } from '~/lib/logger';
import { isTrustedTypesEnforced } from '~/lib/trusted-types';
import { mountPanel } from '~/panel/mount';
import { watchTheme } from '~/panel/theme';
import { watchSurface } from '~/state/surfaceWatcher';
import {
  collapsed,
  firstPaintMs,
  geometry,
  showDebug,
  status,
  surface,
  theme,
  trustedTypesEnforced,
  visible,
} from '~/state/panelState';
import {
  clampGeometry,
  readViewport,
  resolveGeometry,
  sameGeometry,
} from '~/panel/chrome/geometry';
import { startReceiver } from '~/intercept/receiver';
import {
  applyCachedTranscript,
  ingestExchange,
  setTranscriptCapturedHandler,
} from '~/state/contextStore';
import {
  resetForVideo,
  setPricingOverrides,
  setTaskLimits,
  setTaskLimitsPersister,
  setTranscriptOptOut,
  setTranscriptOptOutPersister,
} from '~/state/taskStore';
import { onStateChanged, readState, updateState } from '~/storage/local';
import { sendToBackground } from '~/types/messages';
import type { FromContent, ToContent } from '~/types/messages';
import type { NeuraTubeState, PanelPrefs } from '~/storage/schema';
import { DEFAULT_PANEL_PREFS } from '~/storage/schema';

const log = createLogger('content');

// Opens the first-paint measurement window. `lib/perf` already marks at module
// evaluation; this makes the intent explicit at the entrypoint and is what the
// test suite drives after a reset.
markContentStart();

/**
 * Re-injection guard.
 *
 * Chrome will not normally inject a declared content script twice, but a
 * developer reload plus a stale page can produce it. A second panel would
 * double every event handler, so bail early.
 */
const GUARD = '__neuratubePanelLoaded';
type GuardedWindow = Window & { [GUARD]?: true };

function alreadyLoaded(): boolean {
  const scope = window as GuardedWindow;
  if (scope[GUARD]) return true;
  scope[GUARD] = true;
  return false;
}

/** Debounce persistence: the user can spam Alt+N faster than storage settles. */
function debounce<A extends readonly unknown[]>(
  fn: (...args: A) => void,
  waitMs: number,
): (...args: A) => void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return (...args: A) => {
    if (timer !== undefined) clearTimeout(timer);
    timer = setTimeout(() => {
      fn(...args);
    }, waitMs);
  };
}

async function main(): Promise<void> {
  if (alreadyLoaded()) {
    log.debug('already loaded in this document, skipping');
    return;
  }

  // Kept in a mutable local so a surface change after a remote storage write
  // reads current preferences rather than the snapshot taken at startup.
  let currentState: NeuraTubeState = await readState();
  setLoggingEnabled(currentState.settings.debugLogging);
  showDebug.value = currentState.settings.showDebugPanel;
  // The task store computes per-request cost locally for the live meter, so it
  // needs the user's price overrides. (Lost once in a revert; the cost line then
  // silently ignored every override the user had entered.)
  setPricingOverrides(currentState.pricingOverrides);
  setTranscriptOptOut(currentState.transcriptOptOut);
  setTaskLimits(currentState.taskLimits);

  // Persist a transcript switch. Its own updateState call is safe alongside the
  // debounced panel persist below because updateState serialises writes within
  // this context.
  setTranscriptOptOutPersister((next) => {
    void updateState((current) => ({ ...current, transcriptOptOut: { ...next } }));
  });

  // Same pattern for a limit raised from the panel's empty-output diagnosis.
  setTaskLimitsPersister((next) => {
    void updateState((current) => ({ ...current, taskLimits: { ...next } }));
  });

  // Probe Trusted Types before touching the DOM, so the diagnostics view can
  // prove compliance on a real Studio page rather than asserting it.
  trustedTypesEnforced.value = isTrustedTypesEnforced();

  // Guards the storage write-back so applying a remote or startup value does
  // not echo straight back to storage.
  let suppressPersist = false;

  /**
   * Ask the worker whether it already has a transcript for this video.
   *
   * The capture happens on Studio's subtitles page but chapters are generated on
   * the details page, so on the page that needs it there is nothing to intercept
   * — the transcript can only come from the worker's session cache. This is the
   * normal path: the user visits Subtitles once, comes back, and it is waiting.
   *
   * A hoisted `function`, NOT a `const` arrow. The surface watcher below invokes
   * its callback synchronously on subscribe, so an arrow declared further down
   * left this in the temporal dead zone and every panel mount died with
   * `Cannot access 'loadCachedTranscript' before initialization` — no panel at
   * all, on every surface. A function declaration hoists, so moving the watcher
   * cannot reintroduce that.
   */
  function loadCachedTranscript(videoId: string | null): void {
    if (videoId === null) {
      applyCachedTranscript(null, null);
      return;
    }
    void sendToBackground({ type: 'get-transcript', videoId }).then((reply) => {
      if (reply?.type !== 'transcript') return;
      // Through applyCachedTranscript, NOT a plain set: this reply is async and
      // may land after a live capture, and a cache miss must not wipe it.
      applyCachedTranscript(videoId, reply.transcript);
    });
  }

  // Persist any transcript we intercept, so the page that needs it can read it
  // back. Registered before the receiver starts, so a capture in the
  // interceptor's initial buffer flush is not dropped.
  setTranscriptCapturedHandler((captured) => {
    void sendToBackground({ type: 'transcript-captured', transcript: captured });
  });

  // Track the surface first: the panel renders the detected context on its
  // first frame, so knowing it up front avoids a visible correction.
  const surfaceWatcher = watchSurface((info) => {
    surface.value = info;

    const prefs = currentState.panel[info.surface];
    suppressPersist = true;
    visible.value = prefs?.visible ?? info.supported;
    collapsed.value = prefs?.collapsed ?? false;
    // Resolved against the CURRENT viewport, not the one the geometry was saved
    // in: a position from a 3440px monitor would otherwise be off-screen here.
    geometry.value = resolveGeometry(prefs?.geometry ?? null, readViewport());
    suppressPersist = false;

    void sendToBackground({ type: 'surface-changed', surface: info });

    // A client-side route change to a DIFFERENT video must not leave the
    // previous video's generated titles, tags or transcript on screen. Both
    // calls are no-ops when the video is unchanged, so Studio's tab and period
    // URL rewrites do not discard work.
    resetForVideo(info.videoId);
    loadCachedTranscript(info.videoId);
  });

  const themeWatcher = watchTheme(
    () => currentState.settings.theme,
    (resolved) => {
      theme.value = resolved;
    },
  );

  const mount = mountPanel();
  log.info('panel mounted', { surface: surface.value.surface });

  /* ---------------------------------------------------------------------- */
  /* Interceptor handshake                                                   */
  /*                                                                         */
  /* Started AFTER the panel mounts so a slow handshake cannot delay first    */
  /* paint. Nothing is lost by waiting: the MAIN-world transport buffers      */
  /* everything captured before this point and flushes it on hello, which is  */
  /* essential because Studio fetches get_creator_videos during page load,    */
  /* well before this document_idle script runs.                             */
  /* ---------------------------------------------------------------------- */

  const receiver = startReceiver(ingestExchange);

  /* ---------------------------------------------------------------------- */
  /* Persist local changes                                                   */
  /* ---------------------------------------------------------------------- */

  const persist = debounce((prefs: PanelPrefs, debugOpen: boolean) => {
    // ONE read-modify-write, deliberately.
    //
    // Calling patchPanelPrefs() and patchSettings() together does not work:
    // chrome.storage offers no transaction, so each performs its own
    // read-modify-write, both read the same snapshot, and the second write
    // discards the first's change. That produced a visible bug — hiding the
    // panel, then watching it reappear 250ms later as the settings write
    // clobbered the visibility write.
    //
    // The diagnostics toggle has to be persisted at all because
    // `onStateChanged` below re-reads it on every external write, so a
    // signal-only toggle was being reverted by any other context's write,
    // including the service worker's own install-time write.
    const key = surface.value.surface;
    void updateState((current) => ({
      ...current,
      settings: { ...current.settings, showDebugPanel: debugOpen },
      panel: {
        ...current.panel,
        [key]: { ...DEFAULT_PANEL_PREFS, ...current.panel[key], ...prefs },
      },
    }));
  }, 250);

  const persistCurrent = (): void => {
    if (suppressPersist) return;
    persist(
      { visible: visible.value, collapsed: collapsed.value, geometry: geometry.value },
      showDebug.value,
    );
  };

  const unsubVisible = visible.subscribe(persistCurrent);
  const unsubCollapsed = collapsed.subscribe(persistCurrent);
  const unsubShowDebug = showDebug.subscribe(persistCurrent);
  const unsubGeometry = geometry.subscribe(persistCurrent);

  /* ---------------------------------------------------------------------- */
  /* Keep the panel reachable when the window changes size                   */
  /* ---------------------------------------------------------------------- */

  // Re-clamp on resize. Without this, shrinking the window or rotating a tablet
  // leaves the panel partly or wholly off-screen with no way to drag it back.
  const onResize = debounce(() => {
    const clamped = clampGeometry(geometry.value, readViewport());
    if (!sameGeometry(clamped, geometry.value)) {
      geometry.value = clamped;
    }
  }, 120);
  window.addEventListener('resize', onResize);

  /* ---------------------------------------------------------------------- */
  /* Adopt changes written by other contexts                                 */
  /* ---------------------------------------------------------------------- */

  const unsubStorage = onStateChanged((next) => {
    currentState = next;
    setLoggingEnabled(next.settings.debugLogging);
    theme.value = next.settings.theme === 'auto' ? theme.value : next.settings.theme;
    setPricingOverrides(next.pricingOverrides);
    setTranscriptOptOut(next.transcriptOptOut);
    setTaskLimits(next.taskLimits);

    // Applying a remote change must not echo straight back to storage.
    suppressPersist = true;
    showDebug.value = next.settings.showDebugPanel;
    const prefs = next.panel[surface.value.surface];
    if (prefs) {
      visible.value = prefs.visible;
      collapsed.value = prefs.collapsed;
    }
    suppressPersist = false;
  });

  /* ---------------------------------------------------------------------- */
  /* Commands from the service worker and popup                              */
  /* ---------------------------------------------------------------------- */

  const onMessage = (
    raw: unknown,
    _sender: chrome.runtime.MessageSender,
    respond: (value: FromContent) => void,
  ): boolean => {
    const message = raw as ToContent;
    switch (message.type) {
      case 'toggle-panel':
        if (visible.value && collapsed.value) {
          collapsed.value = false;
        } else {
          visible.value = !visible.value;
        }
        respond({ type: 'panel-status', status: status.value });
        return false;

      case 'set-panel-visible':
        visible.value = message.visible;
        respond({ type: 'panel-status', status: status.value });
        return false;

      case 'get-panel-status':
        respond({ type: 'panel-status', status: status.value });
        return false;

      default:
        respond({ type: 'ack' });
        return false;
    }
  };

  chrome.runtime.onMessage.addListener(onMessage);

  /* ---------------------------------------------------------------------- */
  /* Report readiness once the first paint measurement exists                */
  /* ---------------------------------------------------------------------- */

  const unsubPaint = firstPaintMs.subscribe((value) => {
    if (value === null) return;
    void sendToBackground({ type: 'panel-ready', status: status.value });
    unsubPaint();
  });

  // Tear everything down if the document goes away. Chrome usually discards the
  // whole isolated world with the document, but an explicit path keeps the
  // listeners honest during development reloads.
  window.addEventListener(
    'pagehide',
    () => {
      unsubVisible();
      unsubCollapsed();
      unsubShowDebug();
      unsubGeometry();
      unsubStorage();
      window.removeEventListener('resize', onResize);
      chrome.runtime.onMessage.removeListener(onMessage);
      receiver.stop();
      themeWatcher.stop();
      surfaceWatcher.stop();
      mount.destroy();
    },
    { once: true },
  );
}

void main().catch((error: unknown) => {
  // A thrown content script leaves the user with no panel and no explanation.
  log.error('startup failed', error);
});
