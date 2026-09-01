/**
 * Reading YouTube's own page globals from the MAIN world.
 *
 * WHY THIS EXISTS. On a public watch page there is no InnerTube response we can
 * intercept that carries the video's title, description and — crucially — its
 * TAGS. The obvious fallback is to scrape the rendered DOM, and NeuraTube does
 * keep a DOM reader for the few things only the DOM has. But the DOM is the worst
 * available source here:
 *
 *   - the description is TRUNCATED until the viewer clicks "...more", so a
 *     scraper reads a fragment ending in an ellipsis and hands that to a model
 *   - tags are not rendered ANYWHERE in the DOM, at any point
 *   - class names are generated and change without notice
 *
 * YouTube already has all of it parsed, in `ytInitialPlayerResponse` — a plain
 * object on `window`, which is reachable precisely because this script runs in
 * the page's own JS heap rather than an isolated world. That is the same property
 * that makes the XHR patch possible, used for reading instead of patching.
 *
 * WHAT IS EXTRACTED, AND WHAT DELIBERATELY IS NOT. Only the descriptive fields
 * below. `ytInitialPlayerResponse` also contains `streamingData` (signed,
 * expiring media URLs), playback tracking parameters and ad configuration. None
 * of that is read, so none of it can reach a log, a prompt or storage — the same
 * rule the network parsers follow.
 *
 * This does NOT make NeuraTube a DOM-scraping extension: the data still comes
 * from YouTube's own parsed payload, just delivered as a page global instead of
 * an HTTP response. It rides the existing capture pipeline as a synthetic
 * exchange so it gets the same nonce validation, buffering and ordering.
 */

import { emitExchange } from './transport';
import { extractWatchPageData } from '~/parsers/playerResponse';

/**
 * When to look.
 *
 * `document_start` is too early — the global is written by an inline script later
 * in the document. A watch page also mutates it on client-side navigation without
 * a document load, so a single read would go stale the moment the viewer clicks a
 * suggested video. Hence: a short ramp to catch first paint, then a slow poll
 * that only emits when the video id actually changes.
 */
const INITIAL_SCHEDULE_MS: readonly number[] = [0, 100, 400, 1200, 3000];
const POLL_INTERVAL_MS = 2000;

/** Guards against emitting the same video repeatedly. */
let lastEmittedId: string | null = null;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/** Read the globals once and emit a synthetic capture if the video changed. */
function readAndEmit(): void {
  let payload: string | null = null;
  try {
    payload = extractWatchPageData(window);
  } catch {
    // A page global we do not control. Never let a read break the page.
    return;
  }
  if (payload === null) return;

  let videoId = '';
  try {
    const parsed: unknown = JSON.parse(payload);
    videoId = isRecord(parsed) ? str(parsed.videoId) : '';
  } catch {
    return;
  }

  if (videoId === '' || videoId === lastEmittedId) return;
  lastEmittedId = videoId;

  emitExchange({
    kind: 'PUBLIC_PAGE_DATA',
    // Synthetic: there was no request. The location is what the data describes,
    // and the diagnostics log shows it as the path so it is obvious where it
    // came from.
    url: location.href,
    method: 'PAGE',
    status: 200,
    responseText: payload,
    requestBody: null,
    at: performance.now(),
    skipped: null,
  });
}

/** Start watching the page globals. Safe to call once, at document_start. */
export function startPageDataWatcher(): void {
  for (const delay of INITIAL_SCHEDULE_MS) {
    if (delay === 0) {
      readAndEmit();
    } else {
      setTimeout(readAndEmit, delay);
    }
  }
  setInterval(readAndEmit, POLL_INTERVAL_MS);
}

/** Reset for tests. */
export function resetPageDataForTests(): void {
  lastEmittedId = null;
}
