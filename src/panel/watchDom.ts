/**
 * Reading the few watch-page facts that exist ONLY in the DOM.
 *
 * SCOPE, AND WHY IT IS THIS SMALL. Title, description and tags all come from
 * YouTube's own `ytInitialPlayerResponse` (see intercept/pageData.ts) because the
 * DOM's copies are worse: the description is truncated until the viewer clicks
 * "...more", and tags are not rendered at all. What is left is genuinely
 * DOM-only:
 *
 *   - the exact view count and publish date, which the page global reports as a
 *     rounded label ("1.4K views") and an ISO date respectively
 *   - the subscriber label, which is not in the player response
 *   - YouTube's own chapter list, which is useful as a comparison for our own
 *   - comments, which arrive by continuation and are not in any page global
 *
 * EVERY READ IS DEFENSIVE. YouTube's class names are generated and its element
 * ids move. So each field has several candidate selectors, every one returns
 * null rather than throwing, and a missing field degrades that one fact instead
 * of failing the read. This is read-only: `querySelector` and `textContent`, no
 * mutation, nothing Trusted Types would object to.
 *
 * LIMITATION WORTH KNOWING. Comments load lazily and by continuation, so this
 * sees the comments the viewer has actually scrolled to — not all of them. The
 * count is reported alongside so a prompt can say "of N" rather than implying a
 * complete sample.
 */

import { createLogger } from '~/lib/logger';

const log = createLogger('watch-dom');

function text(root: ParentNode, selectors: readonly string[]): string {
  for (const selector of selectors) {
    const found = root.querySelector(selector);
    const value = found?.textContent?.trim();
    if (value !== undefined && value !== '') return value;
  }
  return '';
}

function attr(root: ParentNode, selectors: readonly string[], name: string): string {
  for (const selector of selectors) {
    const value = root.querySelector(selector)?.getAttribute(name)?.trim();
    if (value !== undefined && value !== '') return value;
  }
  return '';
}

/* -------------------------------------------------------------------------- */
/* Metadata                                                                    */
/* -------------------------------------------------------------------------- */

export interface WatchDomFacts {
  readonly viewCountExact: number | null;
  readonly publishedAtMs: number | null;
  readonly subscriberText: string;
  readonly chapters: readonly { readonly label: string; readonly startSec: number }[];
}

/**
 * Parse a compact count label into a number.
 *
 * "1,443" -> 1443, "1.4K" -> 1400, "1.92M" -> 1920000. Returns null rather than
 * guessing when the shape is unfamiliar, because a wrong view count silently
 * skews every judgement a model makes about the video's performance.
 */
export function parseCount(label: string): number | null {
  // \u00A0 written as an escape, not pasted: YouTube separates counts with a
  // NON-BREAKING space, and a literal one here is invisible in review and trips
  // the no-irregular-whitespace rule.
  const cleaned = label.replace(/[\u00A0\s]/g, '');
  const match = /^([\d,.]+)([KMB])?/i.exec(cleaned);
  if (match === null) return null;

  const digits = match[1];
  if (digits === undefined) return null;

  const suffix = match[2]?.toUpperCase();
  // Without a suffix the separators are thousands groupings ("1,443"); with one
  // the dot is a decimal point ("1.4K"). Treating them alike turns 1,443 into 1.4.
  const base =
    suffix === undefined ? Number(digits.replace(/[,.]/g, '')) : Number(digits.replace(/,/g, ''));
  if (!Number.isFinite(base)) return null;

  const scale = suffix === 'K' ? 1_000 : suffix === 'M' ? 1_000_000 : suffix === 'B' ? 1e9 : 1;
  return Math.round(base * scale);
}

/**
 * The exact view count and date, read from the info tooltip.
 *
 * The visible line is rounded ("1.4K views  1 month ago") but the tooltip beside
 * it is exact ("1,443 views • Jul 15, 2026 • #AI"). Preferring the tooltip is the
 * difference between a real number and a rounded one.
 */
function readInfoTooltip(): { views: number | null; publishedAtMs: number | null } {
  const tooltip = text(document, [
    'ytd-watch-info-text tp-yt-paper-tooltip #tooltip',
    'ytd-watch-info-text tp-yt-paper-tooltip div',
  ]);

  if (tooltip === '') return { views: null, publishedAtMs: null };

  const parts = tooltip.split('•').map((part) => part.trim());
  const viewPart = parts.find((part) => /view/i.test(part));
  const views = viewPart === undefined ? null : parseCount(viewPart);

  // A real date, not "1 month ago" — the relative form is in the visible line.
  const datePart = parts.find((part) => /\d{4}/.test(part) && !/view/i.test(part));
  let publishedAtMs: number | null = null;
  if (datePart !== undefined) {
    const parsed = Date.parse(datePart);
    if (Number.isFinite(parsed)) publishedAtMs = parsed;
  }

  return { views, publishedAtMs };
}

/** Timestamp label ("1:06", "1:02:05") to seconds. */
export function timestampToSeconds(label: string): number | null {
  const parts = label.trim().split(':');
  if (parts.length < 2 || parts.length > 3) return null;

  let total = 0;
  for (const part of parts) {
    const value = Number(part);
    if (!Number.isFinite(value) || value < 0) return null;
    total = total * 60 + value;
  }
  return total;
}

/** YouTube's own chapter list, when the video has one. */
function readChapters(): readonly { label: string; startSec: number }[] {
  const items = document.querySelectorAll('ytd-macro-markers-list-item-renderer');
  const out: { label: string; startSec: number }[] = [];

  for (const item of items) {
    const label = attr(item, ['h3.macro-markers', 'h3'], 'title') || text(item, ['h3']);
    const stamp = text(item, ['#time']);
    const startSec = timestampToSeconds(stamp);
    if (label === '' || startSec === null) continue;

    // The renderer duplicates each entry in a hidden block; dedupe on time.
    if (out.some((existing) => existing.startSec === startSec)) continue;
    out.push({ label, startSec });
  }

  return out.sort((a, b) => a.startSec - b.startSec);
}

/** Read every DOM-only fact. Never throws. */
export function readWatchDom(): WatchDomFacts {
  try {
    const info = readInfoTooltip();
    return {
      viewCountExact: info.views,
      publishedAtMs: info.publishedAtMs,
      subscriberText: text(document, [
        '#owner-sub-count',
        'ytd-video-owner-renderer #owner-sub-count',
      ]),
      chapters: readChapters(),
    };
  } catch (error) {
    log.debug('watch DOM read failed', error);
    return { viewCountExact: null, publishedAtMs: null, subscriberText: '', chapters: [] };
  }
}

/* -------------------------------------------------------------------------- */
/* Comments                                                                    */
/* -------------------------------------------------------------------------- */

export interface WatchComment {
  readonly author: string;
  readonly text: string;
  readonly likes: number;
  readonly published: string;
  readonly replyCount: number;
  /** Whether the channel owner hearted it — a strong relevance signal. */
  readonly hearted: boolean;
}

export interface CommentsSnapshot {
  /** Comments currently rendered, newest-first as YouTube ordered them. */
  readonly comments: readonly WatchComment[];
  /** Total the header claims, which is usually larger than what is loaded. */
  readonly totalLabel: string;
  /** How YouTube is sorting — "Top" hides some comments entirely. */
  readonly sort: string;
}

const MAX_COMMENTS = 60;

/**
 * Read the comments currently in the DOM.
 *
 * Bounded at 60. A popular video can have thousands rendered after scrolling, and
 * sending all of them would blow the prompt budget while adding nothing: the
 * pattern in a creator's audience shows up long before then.
 */
export function readComments(): CommentsSnapshot {
  try {
    const threads = document.querySelectorAll('ytd-comment-thread-renderer');
    const comments: WatchComment[] = [];

    for (const thread of threads) {
      if (comments.length >= MAX_COMMENTS) break;

      const body = thread.querySelector('ytd-comment-view-model') ?? thread;
      const commentText = text(body, ['#content-text', 'yt-attributed-string#content-text']);
      if (commentText === '') continue;

      const author = text(body, ['#author-text span', '#author-text']).replace(/^@/, '');
      const likeLabel = text(body, ['#vote-count-middle', '#vote-count-left']);
      const replyLabel = text(thread, [
        '#more-replies-sub-thread yt-button-shape button',
        '#more-replies yt-button-shape button',
      ]);

      comments.push({
        author,
        text: commentText,
        likes: parseCount(likeLabel) ?? 0,
        published: text(body, ['#published-time-text a', '#published-time-text']),
        replyCount: parseCount(replyLabel) ?? 0,
        // The heart button only renders as "Remove heart" once given.
        hearted:
          body.querySelector('#creator-heart-button [aria-label*="Remove heart" i]') !== null ||
          body.querySelector('#creator-heart button[aria-label*="Remove heart" i]') !== null,
      });
    }

    return {
      comments,
      totalLabel: text(document, ['ytd-comments-header-renderer #count', '#count']),
      sort: text(document, ['ytd-comments-header-renderer #label .item', '#sort-menu .item']),
    };
  } catch (error) {
    log.debug('comment read failed', error);
    return { comments: [], totalLabel: '', sort: '' };
  }
}

/**
 * Render comments for a prompt.
 *
 * Includes like and reply counts because they are the difference between a stray
 * opinion and one the audience agreed with, and says plainly that the sample is
 * partial so the model does not present it as the whole picture.
 */
export function renderComments(snapshot: CommentsSnapshot): string {
  if (snapshot.comments.length === 0) return '';

  const header =
    `${snapshot.comments.length} comments currently loaded` +
    (snapshot.totalLabel !== '' ? ` (page reports ${snapshot.totalLabel})` : '') +
    (snapshot.sort !== '' ? `, sorted by ${snapshot.sort}` : '') +
    '. This is what has loaded, not every comment.';

  const lines = snapshot.comments.map((comment) => {
    const marks: string[] = [];
    if (comment.likes > 0) marks.push(`${comment.likes} likes`);
    if (comment.replyCount > 0) marks.push(`${comment.replyCount} replies`);
    if (comment.hearted) marks.push('hearted by creator');
    const suffix = marks.length > 0 ? ` [${marks.join(', ')}]` : '';
    return `- ${comment.text.replace(/\s+/g, ' ')}${suffix}`;
  });

  return `${header}\n\n${lines.join('\n')}`;
}
