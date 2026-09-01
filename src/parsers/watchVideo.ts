/**
 * Build a `VideoContext` from a public watch page.
 *
 * Source is the payload `intercept/pageData.ts` extracts from YouTube's own
 * `ytInitialPlayerResponse` — the same object the player reads, so the title and
 * description are the real ones rather than the truncated text the DOM shows, and
 * `keywords` gives the video's TAGS, which appear nowhere in the rendered page.
 *
 * A public video exposes less than a Studio one, and the gaps are represented
 * honestly rather than defaulted to something plausible: `paidPromotion` is
 * `false` because we cannot see it, not because we know it is false, so anything
 * consuming this must not treat a public context as authoritative about
 * compliance. The guardrail engine only runs on Studio surfaces for exactly that
 * reason.
 */

import type { DriftReport } from './drift';
import { createDriftCollector } from './drift';
import type { VideoContext } from '~/types/VideoContext';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/** Parse a numeric field YouTube sends as a string (`"317"`, `"1443"`). */
function num(value: unknown): number {
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

/** ISO date to epoch ms, or null. Never throws on a malformed date. */
function epochMs(value: unknown): number | null {
  const text = str(value);
  if (text === '') return null;
  const parsed = Date.parse(text);
  return Number.isFinite(parsed) ? parsed : null;
}

/** Hashtags written into the description, which is where creators put them. */
export function hashtagsIn(description: string): readonly string[] {
  const found = new Set<string>();
  /*
   * `\p{M}` is not optional. Scripts like Sinhala, Devanagari, Thai and Arabic
   * write with combining marks, so a class of letters and numbers alone truncates
   * or drops those hashtags entirely — a naive `\w+` fails even harder. Caught by
   * a test with a real Sinhala tag, which is a language this project's author
   * actually publishes in.
   */
  for (const match of description.matchAll(/#([\p{L}\p{N}\p{M}_]{2,60})/gu)) {
    const tag = match[1];
    if (tag !== undefined) found.add(`#${tag}`);
  }
  return [...found].slice(0, 40);
}

export interface WatchVideoResult {
  readonly video: VideoContext | null;
  readonly drift: DriftReport;
}

/** Extra facts the DOM has and the page global does not. */
export interface WatchDomExtras {
  readonly viewCountExact?: number;
  readonly publishedAtMs?: number | null;
  readonly subscriberText?: string;
  readonly chapters?: readonly { readonly label: string; readonly startSec: number }[];
}

/**
 * Parse the page-data payload into a `VideoContext`.
 *
 * Never throws. A missing `videoId` is fatal — a context with no id cannot be
 * matched to the surface and would show the wrong video's data.
 */
export function parseWatchPageData(raw: string, extras: WatchDomExtras = {}): WatchVideoResult {
  const drift = createDriftCollector();

  if (raw.trim() === '') {
    drift.fatal('empty page data');
    return { video: null, drift: drift.report() };
  }

  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (error) {
    drift.fatal(error instanceof Error ? error.message : 'invalid JSON');
    return { video: null, drift: drift.report() };
  }

  if (!isRecord(json)) {
    drift.fatal('page data was not an object');
    return { video: null, drift: drift.report() };
  }

  const videoId = str(json.videoId);
  if (videoId === '') {
    drift.fatal('no videoId in page data');
    return { video: null, drift: drift.report() };
  }

  const description = str(json.shortDescription);
  const tags = Array.isArray(json.keywords)
    ? json.keywords.filter((tag): tag is string => typeof tag === 'string' && tag !== '')
    : [];

  // Deliberately NOT recorded as drift when empty: plenty of videos genuinely
  // have no tags, and flagging that as a parse problem would cry wolf.
  drift.counted();

  const video: VideoContext = {
    videoId,
    title: str(json.title),
    description,
    tags,
    suggestedHashtags: [],
    descriptionHashtags: hashtagsIn(description),
    durationSec: num(json.lengthSeconds),
    publishedAtMs: extras.publishedAtMs ?? epochMs(json.publishDate) ?? epochMs(json.uploadDate),
    channelId: str(json.channelId),
    category: str(json.category),
    categoryRaw: str(json.category),
    license: '',
    privacy: json.isUnlisted === true ? 'unlisted' : 'public',
    status: 'processed',
    metadataLanguage: null,
    // NOT known from a public page. `false` here means "cannot see it", and the
    // guardrail engine deliberately does not run on public surfaces because of
    // it — a compliance decision must never rest on an absence of evidence.
    madeForKids: false,
    ageRestricted: json.isFamilySafe === false,
    allowEmbed: true,
    allowRatings: true,
    paidPromotion: false,
    alteredContent: 'unset',
    originalFilename: null,
    shareUrl: `https://youtu.be/${videoId}`,
    thumbnails: [],
    abTest: { state: 'none', result: null, arms: [] },
    // Empty strings and zeroes here mean "a public page does not report this",
    // not "reviewed and clean". Same reason `source` exists.
    monetization: { effectiveStatus: '', selfCertDecision: '' },
    copyright: { activeClaimCount: 0, hasImpact: false },
    viewCount: extras.viewCountExact ?? num(json.viewCount),
    channelTitle: str(json.author),
    subscriberText: extras.subscriberText ?? '',
    chapters: extras.chapters ?? [],
    source: 'public',
  };

  return { video, drift: drift.report() };
}
