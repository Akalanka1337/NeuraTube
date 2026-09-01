/**
 * Client-side navigation watcher.
 *
 * YouTube and YouTube Studio are single-page apps: navigating from the content
 * list to a video's edit page never reloads the document, so the content script
 * is injected exactly once and must notice the URL changing on its own.
 *
 * Why polling, and why no `webNavigation` permission:
 *
 *  - A content script in the ISOLATED world cannot observe the page's own
 *    `history.pushState` calls. The page's `History` methods live on the MAIN
 *    world heap; patching them from here is impossible by design.
 *  - `chrome.webNavigation.onHistoryStateUpdated` would report it precisely,
 *    but costs a broad extra permission that Chrome Web Store review flags and
 *    that we cannot justify under the Limited Use policy for a cosmetic
 *    concern.
 *  - `popstate` and `hashchange` do fire here, and cover back/forward plus
 *    hash routing. They miss programmatic `pushState`, so a cheap `location.href`
 *    string comparison on an interval closes the gap.
 *
 * The poll is a single string compare against a cached value — nanoseconds,
 * off the render path, and it stops when the document is hidden.
 */

import { createLogger } from '~/lib/logger';
import type { SurfaceInfo } from '~/types/surface';
import { detectSurface } from '~/types/surface';

const log = createLogger('surface');

/** How often to reconcile `location.href` with the last seen value. */
const POLL_INTERVAL_MS = 500;

export interface SurfaceWatcher {
  /** The most recently detected surface. */
  readonly current: SurfaceInfo;
  /** Stop all listeners and timers. */
  stop(): void;
}

/**
 * Start watching. `onChange` fires immediately for the initial surface and then
 * on every detected navigation, but only when the *classification* changed —
 * not on every query-parameter tweak YouTube makes.
 */
export function watchSurface(onChange: (info: SurfaceInfo) => void): SurfaceWatcher {
  let lastHref = location.href;
  let current = detectSurface(lastHref);

  const reconcile = (): void => {
    const href = location.href;
    if (href === lastHref) return;
    lastHref = href;

    const next = detectSurface(href);
    if (isSameSurface(next, current)) return;

    log.debug('surface changed', {
      from: current.surface,
      to: next.surface,
      videoId: next.videoId,
    });
    current = next;
    onChange(next);
  };

  let timer: ReturnType<typeof setInterval> | null = null;

  const startPolling = (): void => {
    if (timer !== null) return;
    timer = setInterval(reconcile, POLL_INTERVAL_MS);
  };

  const stopPolling = (): void => {
    if (timer === null) return;
    clearInterval(timer);
    timer = null;
  };

  const onVisibilityChange = (): void => {
    if (document.hidden) {
      stopPolling();
    } else {
      // Reconcile once on return: the URL may well have changed while hidden.
      reconcile();
      startPolling();
    }
  };

  window.addEventListener('popstate', reconcile);
  window.addEventListener('hashchange', reconcile);
  document.addEventListener('visibilitychange', onVisibilityChange);
  if (!document.hidden) startPolling();

  // Report the initial surface synchronously so callers never render an
  // "unknown" state they then have to reconcile.
  onChange(current);

  return {
    get current() {
      return current;
    },
    stop() {
      stopPolling();
      window.removeEventListener('popstate', reconcile);
      window.removeEventListener('hashchange', reconcile);
      document.removeEventListener('visibilitychange', onVisibilityChange);
    },
  };
}

/**
 * Whether two detections are equivalent for panel purposes.
 *
 * Studio rewrites the URL for tab and period changes within the same video;
 * treating those as navigations would tear down and rebuild the panel for no
 * reason.
 */
export function isSameSurface(a: SurfaceInfo, b: SurfaceInfo): boolean {
  return a.surface === b.surface && a.videoId === b.videoId && a.channelId === b.channelId;
}
