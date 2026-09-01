/**
 * https://github.com/Akalanka1337/NeuraTube
 * 
 * Clipboard writes from a content script.
 *
 * THIS IS HARDER THAN IT LOOKS INSIDE AN EXTENSION.
 *
 * `navigator.clipboard.writeText` requires a secure context (fine — YouTube is
 * HTTPS) AND transient user activation AND, in a content script, the page to be
 * focused. All three usually hold when the user clicks a Copy button, but not
 * always: if the click landed while an iframe held focus, or the document is not
 * the active one, the promise rejects with a NotAllowedError.
 *
 * So there is a fallback, and it deliberately uses the deprecated
 * `document.execCommand('copy')` path. That is not laziness — it is the only
 * mechanism that still works without the Permissions API, and it is what every
 * extension that copies reliably still ships. The textarea it needs is created,
 * used and removed synchronously inside the user gesture.
 *
 * Trusted Types note: this touches `value` and `textContent`, never `innerHTML`,
 * so it stays compliant on YouTube.
 */

import { createLogger } from './logger';

const log = createLogger('clipboard');

/**
 * Copy text, returning whether it worked.
 *
 * Never throws: a failed copy is a UI state ("couldn't copy"), not an exception
 * for the caller to handle.
 */
export async function copyText(text: string): Promise<boolean> {
  if (text === '') return false;

  // Preferred path.
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch (error) {
    // Expected when the document lacks focus or activation; fall through.
    log.debug('async clipboard refused, falling back', error);
  }

  return copyViaExecCommand(text);
}

/**
 * Synchronous fallback.
 *
 * The textarea is positioned off-screen rather than hidden: `display: none` and
 * `visibility: hidden` both make it unselectable, so the copy silently produces
 * an empty clipboard.
 */
function copyViaExecCommand(text: string): boolean {
  const area = document.createElement('textarea');
  area.value = text;
  area.setAttribute('readonly', '');
  area.setAttribute('aria-hidden', 'true');
  area.style.setProperty('position', 'fixed');
  area.style.setProperty('top', '-9999px');
  area.style.setProperty('left', '-9999px');
  area.style.setProperty('opacity', '0');
  // Prevents the page scrolling to the element on focus.
  area.style.setProperty('pointer-events', 'none');

  document.body.append(area);

  try {
    area.select();
    area.setSelectionRange(0, text.length);
    // eslint-disable-next-line @typescript-eslint/no-deprecated -- the only mechanism that works without transient activation; see the note above
    const ok = document.execCommand('copy');
    return ok;
  } catch (error) {
    log.warn('clipboard fallback failed', error);
    return false;
  } finally {
    area.remove();
  }
}

/**
 * Extract a comma-separated tag list from model output.
 *
 * The tag prompt asks for exactly this shape, but a model occasionally wraps it
 * in a sentence or a code fence. Rather than trusting the format, normalise it —
 * the user is going to paste this straight into Studio's tag field, where a
 * stray "Here are your tags:" would become a tag.
 */
export function normaliseTagList(output: string): string {
  const text = output
    // Strip code fences.
    .replace(/```[a-z]*\n?/gi, '')
    // Drop a leading label like "Tags:" on its own line or before the list.
    .replace(/^\s*(?:tags?|here (?:are|is)[^:]*)\s*:\s*/i, '')
    .trim();

  const tags = text
    .split(',')
    .map((tag) =>
      tag
        .replace(/^[\s\-*•\d.)]+/, '')
        .replace(/^#/, '')
        .trim(),
    )
    .filter((tag) => tag !== '' && tag.length <= 100);

  // De-duplicate case-insensitively, keeping first-seen order — Studio rejects
  // duplicates and silently drops them, which looks like data loss.
  const seen = new Set<string>();
  const unique: string[] = [];
  for (const tag of tags) {
    const key = tag.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(tag);
  }

  // YouTube's total tag budget is 500 characters including separators; stop
  // short of it rather than letting Studio truncate mid-tag.
  const LIMIT = 460;
  const kept: string[] = [];
  let length = 0;
  for (const tag of unique) {
    const addition = kept.length === 0 ? tag.length : tag.length + 2;
    if (length + addition > LIMIT) break;
    kept.push(tag);
    length += addition;
  }

  return kept.join(', ');
}
