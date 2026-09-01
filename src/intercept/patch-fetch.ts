/**
 * fetch patch.
 *
 * FIXES OVER THE BRIEF'S REFERENCE IMPLEMENTATION:
 *
 * 1. URL EXTRACTION IS INCOMPLETE. The brief does
 *    `typeof input === 'string' ? input : input.url`. `fetch` accepts a
 *    `string`, a `URL`, or a `Request`. A `URL` object is neither a string nor
 *    has a `.url` property, so the brief yields `undefined`, `classify` throws
 *    or silently misses, and the request goes uncaptured. YouTube does pass
 *    `Request` objects. We normalise all three.
 *
 * 2. IT READS `clone.status`, NOT `res.status`. Harmless today because a clone
 *    carries the same status, but it reads the wrong object and would confuse
 *    the next person; we read the response.
 *
 * 3. UNBOUNDED CLONING. `res.clone()` followed by `clone.text()` buffers the
 *    entire body a second time. On a page that already streams megabytes, doing
 *    this for every matched response doubles peak memory. We check
 *    `content-length` first and skip oversized bodies before cloning.
 *
 * 4. A REJECTED FETCH IS SWALLOWED. The brief awaits the original fetch with no
 *    catch, so a network failure produces no signal at all. We report it, then
 *    re-throw so the page's own error handling is completely unaffected.
 *
 * Cloning caveat worth knowing: `res.clone()` must be called before anything
 * reads `res.body`, and the clone's buffer is retained until read. We read it on
 * a detached promise chain and never block the page's own consumption.
 */

import type { CapturedExchange, SkipReason } from './protocol';
import { MAX_BODY_BYTES } from './protocol';
import { classifyRoute } from './routes';

/**
 * Extract a URL from any `fetch` first argument.
 *
 * Ordered by likelihood on YouTube: string, then Request, then URL.
 */
export function resolveFetchUrl(input: unknown): string {
  if (typeof input === 'string') return input;

  if (typeof Request !== 'undefined' && input instanceof Request) return input.url;
  if (typeof URL !== 'undefined' && input instanceof URL) return input.href;

  // Anything else with a string `url` (a Request-like from another realm).
  if (typeof input === 'object' && input !== null) {
    const maybe = (input as { url?: unknown }).url;
    if (typeof maybe === 'string') return maybe;
  }

  return '';
}

/** Extract the method, honouring a Request object's own method. */
function resolveMethod(input: unknown, init: RequestInit | undefined): string {
  if (init?.method) return init.method;
  if (typeof Request !== 'undefined' && input instanceof Request) return input.method;
  return 'GET';
}

/** Coerce an init body to a string when it is text-shaped, else null. */
function resolveRequestBody(init: RequestInit | undefined): string | null {
  const body = init?.body;
  if (body == null) return null;
  if (typeof body === 'string') return body.length > MAX_BODY_BYTES ? null : body;
  if (typeof URLSearchParams !== 'undefined' && body instanceof URLSearchParams) {
    return body.toString();
  }
  return null;
}

/**
 * Decide whether the body is worth cloning, using the declared length.
 *
 * Returning a skip reason here avoids the clone entirely, which is the whole
 * point — checking after buffering would defeat it.
 */
function oversizedByHeader(response: Response): boolean {
  const declared = response.headers.get('content-length');
  if (declared === null) return false;
  const length = Number(declared);
  return Number.isFinite(length) && length > MAX_BODY_BYTES;
}

/** Install the patch. */
export function patchFetch(emit: (exchange: CapturedExchange) => void): void {
  // eslint-disable-next-line @typescript-eslint/unbound-method -- captured to delegate to; always re-invoked as `originalFetch.call(window, ...)`
  const originalFetch = window.fetch;

  const patched = async function patchedFetch(
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> {
    let url = '';
    let kind: ReturnType<typeof classifyRoute> = null;

    // Classification is wrapped because it must never affect the request.
    try {
      url = resolveFetchUrl(input);
      kind = url ? classifyRoute(url) : null;
    } catch {
      kind = null;
    }

    if (!kind) {
      return originalFetch.call(window, input, init);
    }

    const method = resolveMethod(input, init);
    const requestBody = resolveRequestBody(init);

    const report = (status: number, responseText: string, skipped: SkipReason | null): void => {
      emit({
        kind,
        url,
        method,
        status,
        responseText,
        requestBody,
        at: performance.now(),
        skipped,
      });
    };

    let response: Response;
    try {
      response = await originalFetch.call(window, input, init);
    } catch (error) {
      // Report, then re-throw untouched so the page's own handling is intact.
      try {
        report(0, '', 'read-failed');
      } catch {
        /* reporting must not mask the original failure */
      }
      throw error;
    }

    try {
      if (oversizedByHeader(response)) {
        report(response.status, '', 'too-large');
        return response;
      }

      // Clone before anything reads the body, and read on a detached chain so
      // the page is never made to wait on us.
      const clone = response.clone();
      const status = response.status;

      void clone
        .text()
        .then((text) => {
          if (text.length > MAX_BODY_BYTES) {
            report(status, '', 'too-large');
          } else {
            report(status, text, null);
          }
        })
        .catch(() => {
          report(status, '', 'read-failed');
        });
    } catch {
      // A body already-consumed or an unclonable response. The page's response
      // is untouched either way.
      try {
        report(response.status, '', 'read-failed');
      } catch {
        /* nothing further to do */
      }
    }

    return response;
  };

  (patched as unknown as Record<symbol, unknown>)[FETCH_MARK] = true;
  window.fetch = patched;
}

const FETCH_MARK = Symbol('neuratube.fetchPatched');

/** Whether the current `window.fetch` is ours. */
export function isFetchPatched(): boolean {
  return (window.fetch as unknown as Record<symbol, unknown>)[FETCH_MARK] === true;
}
