/**
 * Interceptor — MAIN world, document_start.
 *
 * This is the only NeuraTube code that runs in YouTube's own JavaScript heap,
 * and it is deliberately the smallest and dumbest part of the extension:
 *
 *  - It holds NO secrets. It has no `chrome.*` access at all, so there is
 *    nothing here for a hostile page to steal.
 *  - It has NO privileged capability. It classifies URLs and forwards response
 *    text. That is the entire attack surface it offers.
 *  - It must NEVER throw into a YouTube call frame. Every entry point is
 *    wrapped, because an exception escaping `open`, `send` or `fetch` would
 *    break Studio and the user would blame the page.
 *  - It must not use a string-to-HTML sink. Trusted Types ARE enforced in this
 *    world (measured: Chromium 151 blocks `innerHTML` here while exempting
 *    isolated-world content scripts). It touches no DOM beyond `postMessage`,
 *    so this is free — but it is why the repo-wide ESLint ban exists.
 *
 * WHY document_start MATTERS: the patch has to be installed before YouTube's
 * application bundle issues its first InnerTube request. Statically-declared
 * manifest content scripts are injected before any other injection mechanism at
 * the same lifecycle stage, which is the only reason this is reliable.
 */

import { emitExchange, startTransport } from '~/intercept/transport';
import { startPageDataWatcher } from '~/intercept/pageData';
import { isOurPatch, patchXhr } from '~/intercept/patch-xhr';
import { isFetchPatched, patchFetch } from '~/intercept/patch-fetch';

/**
 * Re-assertion schedule, in milliseconds after injection.
 *
 * YouTube's bundle, or another extension patching the same prototypes, can
 * replace `XMLHttpRequest.prototype.open` or `window.fetch` after us — the last
 * writer wins, and we do not control injection order relative to other
 * extensions. Rather than hold a permanent timer (which would be a small but
 * perpetual cost on every YouTube page), we re-check on a decaying schedule
 * covering the window in which a competing patch realistically lands.
 */
const REASSERT_SCHEDULE_MS: readonly number[] = [0, 50, 250, 1000, 3000, 10_000];

/** Guard against double injection into the same page. */
const GUARD = '__neuratubeInterceptorLoaded';
type GuardedWindow = Window & { [GUARD]?: true };

function alreadyLoaded(): boolean {
  const scope = window as GuardedWindow;
  if (scope[GUARD]) return true;
  scope[GUARD] = true;
  return false;
}

/**
 * Install, or re-install, both patches.
 *
 * Checks before patching so a re-assertion that finds our own patch still in
 * place does nothing — patching over ourselves would nest the wrappers and
 * emit every exchange twice.
 */
function assertPatches(): void {
  try {
    /* eslint-disable-next-line @typescript-eslint/unbound-method -- identity check only; the functions are never invoked here */
    if (!isOurPatch(XMLHttpRequest.prototype.open) || !isOurPatch(XMLHttpRequest.prototype.send)) {
      patchXhr(emitExchange);
    }
  } catch {
    // A locked-down prototype. Nothing we can do; fetch may still work.
  }

  try {
    if (!isFetchPatched()) {
      patchFetch(emitExchange);
    }
  } catch {
    // Ditto.
  }
}

function main(): void {
  if (alreadyLoaded()) return;

  // Listen for the handshake FIRST. The panel's content script does not run
  // until document_idle, so everything captured before then is buffered by the
  // transport and flushed on hello. Without this ordering the primary
  // get_creator_videos payload — which fires during page load — would be lost.
  startTransport();

  // Read YouTube's own page globals. Only useful on a watch page; the reader
  // returns early elsewhere rather than being gated here, so a client-side
  // navigation INTO a watch page is still picked up.
  startPageDataWatcher();

  for (const delay of REASSERT_SCHEDULE_MS) {
    if (delay === 0) {
      assertPatches();
    } else {
      setTimeout(assertPatches, delay);
    }
  }
}

try {
  main();
} catch {
  // Absolute last resort. A throw at this level would land in the page's
  // document_start execution and could break YouTube's own startup.
}
