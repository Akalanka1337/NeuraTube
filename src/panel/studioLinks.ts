/**
 * Locating and opening Studio's own subtitles control.
 *
 * CORRECTED AFTER A LIVE OBSERVATION. This module originally opened
 * `/video/<id>/translations` in a NEW TAB, on the assumption that the subtitles
 * editor was a separate page. It is not: on the video details page Studio opens
 * it as a MODAL over the same document, at the same URL. The endpoints therefore
 * fire in the page we are already running in, and there is nothing to navigate
 * to — a new tab was pure friction, and the user rightly objected to it.
 *
 * So the button now clicks Studio's own control IN PLACE. Same document, same
 * panel, modal opens, the request fires, we capture it. No navigation at all.
 *
 * `get_captions_timings` fires only when Studio's subtitles editor opens, and
 * that is the only place transcript text arrives with real timings. So the
 * transcript flow needs a way to get the user there.
 *
 * WHY WE READ STUDIO'S OWN LINK RATHER THAN BUILDING A URL. Hardcoding
 * `/video/<id>/translations` would work until YouTube renames the route, and
 * would then fail silently on a page where the correct link is sitting in the
 * DOM. Reading the `href` off Studio's existing anchor is strictly more robust:
 * whatever YouTube currently uses is what we follow.
 *
 * This is read-only DOM access from the isolated world — no injection, no
 * mutation, nothing that Trusted Types would object to. It is also the ONLY
 * place in the extension that reads Studio's DOM, and it is a fallback path
 * rather than the primary data source, which is the distinction that matters:
 * the product still reads canonical data from network responses, not by scraping.
 */

import { createLogger } from '~/lib/logger';

const log = createLogger('studio-links');

/**
 * Candidate selectors, most specific first.
 *
 * Href patterns before ids: a route rename would change the path, but any control
 * that opens the subtitles editor still points at one of these words, and Studio's
 * element ids change more often than its URLs do.
 */
const SELECTORS: readonly string[] = [
  'a#subtitles-editor-link',
  '#subtitles-editor-link a',
  'a[href*="/translations"]',
  'a[href*="/subtitles"]',
  'a[href*="/captions"]',
  '[href*="/translations"]',
];

/**
 * Find the URL of Studio's subtitles editor for the current video.
 *
 * Returns null rather than guessing when nothing is found and no video id is
 * known — sending the user to a constructed URL that 404s is worse than telling
 * them to click Subtitles themselves.
 */
export function findSubtitlesUrl(videoId: string | null): string | null {
  for (const selector of SELECTORS) {
    const anchor = document.querySelector<HTMLAnchorElement>(selector);
    const href = anchor?.href;
    if (href === undefined || href === '') continue;

    // Only follow links that stay on Studio; an off-site match is a false
    // positive from some other part of the page.
    try {
      if (new URL(href).hostname !== 'studio.youtube.com') continue;
    } catch {
      continue;
    }

    log.debug('found subtitles link via', selector);
    return href;
  }

  if (videoId !== null && videoId !== '') {
    // Last resort. Studio's own link is preferred precisely because this may go
    // stale, so it is used only when the DOM offers nothing.
    const constructed = `https://studio.youtube.com/video/${videoId}/translations`;
    log.debug('no subtitles link in the DOM, falling back to a constructed URL');
    return constructed;
  }

  return null;
}

/**
 * Find a clickable control that opens the subtitles editor on THIS page.
 *
 * Returns the element rather than a URL, because the useful action is a click:
 * Studio's router turns that into an in-place modal, which is what makes the
 * endpoints fire in the document we are already watching.
 */
export function findSubtitlesControl(): HTMLElement | null {
  for (const selector of SELECTORS) {
    const element = document.querySelector<HTMLElement>(selector);
    if (element === null) continue;

    // Ignore an off-site match: it is a false positive from elsewhere on the page.
    const href = element.getAttribute('href');
    if (href?.startsWith('http') === true) {
      try {
        if (new URL(href).hostname !== 'studio.youtube.com') continue;
      } catch {
        continue;
      }
    }

    log.debug('found subtitles control via', selector);
    return element;
  }
  return null;
}

/** What happened when the user asked for the subtitles editor. */
export type OpenResult = 'opened-in-place' | 'not-found';

/**
 * Open the subtitles editor in place.
 *
 * Deliberately does NOT fall back to opening a tab. If the control cannot be
 * found, saying so and letting the user click Subtitles themselves is honest;
 * launching a navigation they did not ask for is not, and a new tab would carry
 * a second copy of the panel while leaving this one none the wiser.
 */
export function openSubtitlesEditor(): OpenResult {
  const control = findSubtitlesControl();
  if (control === null) return 'not-found';

  // A plain click, the same event the user would produce. No DOM mutation, no
  // synthetic navigation — Studio's own handler does the work.
  control.click();
  return 'opened-in-place';
}
