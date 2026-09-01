/**
 * Parser for `POST /youtubei/v1/creator/get_creator_videos`.
 *
 * This is the primary payload: one response carries everything NeuraTube needs
 * about a video, including two signals the incumbents charge for — YouTube's own
 * hashtag suggestions, and the per-arm watch-time split of its native A/B test.
 *
 * The shape follows the schema captured in the project brief. Two deliberate
 * departures from the brief's reference implementation:
 *
 * 1. NOTHING IS ASSUMED TO EXIST OR TO HAVE A TYPE. The brief's parser does
 *    `Number(v.lengthSeconds ?? 0)` and `v.tags.map(t => t.value)`. Both are
 *    reasonable against a known-good capture and both break on live data:
 *    `Number('')` is 0 but `Number('12a')` is NaN, and a `tags` array containing
 *    a bare string rather than `{value}` yields `undefined` entries that flow
 *    into an AI prompt. Every field goes through a coercion helper that cannot
 *    produce NaN, undefined, or a hole in an array.
 * 2. IT REPORTS WHAT IT DID NOT UNDERSTAND. Missing fields and unmapped enums
 *    are collected (see `drift.ts`) so the panel can tell the user the data is
 *    incomplete rather than silently showing an empty tag list.
 *
 * `any` appears exactly once, at the JSON boundary, which is the only place the
 * project's lint policy allows it: `JSON.parse` genuinely returns unknown shape
 * and every access below is guarded.
 */

import type { DriftCollector, DriftReport } from './drift';
import { createDriftCollector } from './drift';
import {
  AGE_RESTRICTED_VALUES,
  ALTERED_CONTENT_MAP,
  CATEGORY_MAP,
  COPYRIGHT_NO_IMPACT,
  EXPERIMENT_RESULT_MAP,
  EXPERIMENT_STATE_MAP,
  MADE_FOR_KIDS_TRUE,
  PRIVACY_MAP,
  STATUS_MAP,
} from './maps';
import type { ExperimentArm, Thumbnail, Tristate, VideoContext } from '~/types/VideoContext';

/* -------------------------------------------------------------------------- */
/* Coercion helpers                                                            */
/*                                                                             */
/* Each one is total: it returns a valid value of its type for ANY input.      */
/* This is what lets the parser below read like the brief's version while       */
/* being safe against live data.                                               */
/* -------------------------------------------------------------------------- */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function str(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

/** Optional string: empty and whitespace-only both become null. */
function strOrNull(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * Number coercion that cannot yield NaN.
 *
 * InnerTube sends numerics as both strings and numbers, inconsistently and
 * sometimes for the same field across responses.
 */
function num(value: unknown, fallback = 0): number {
  if (typeof value === 'number') return Number.isFinite(value) ? value : fallback;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
  }
  return fallback;
}

function bool(value: unknown): boolean {
  return value === true;
}

function arr(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? value : [];
}

/** Walk a dot-path, returning undefined rather than throwing on any gap. */
function at(source: unknown, path: readonly string[]): unknown {
  let cursor: unknown = source;
  for (const key of path) {
    if (!isRecord(cursor)) return undefined;
    cursor = cursor[key];
  }
  return cursor;
}

/**
 * Map an enum through a table, recording anything unrecognised.
 *
 * Returns the fallback for absent values without reporting drift (absence is
 * normal), and reports only when a value is PRESENT but unknown — which is the
 * signal that YouTube added something.
 */
function mapEnum<T>(
  raw: unknown,
  table: Readonly<Record<string, T>>,
  fallback: T,
  field: string,
  drift: DriftCollector,
): T {
  if (typeof raw !== 'string' || raw === '') return fallback;
  const mapped = table[raw];
  if (mapped === undefined) {
    drift.unmapped(field, raw);
    return fallback;
  }
  return mapped;
}

/* -------------------------------------------------------------------------- */
/* Field extractors                                                            */
/* -------------------------------------------------------------------------- */

/**
 * Tags.
 *
 * The wire shape is `tags: [{ value: string }]`. We also accept bare strings,
 * because a sibling Studio endpoint uses that shape and defending against it
 * costs one line.
 */
function parseTags(video: unknown): string[] {
  const out: string[] = [];
  for (const entry of arr(at(video, ['tags']))) {
    if (typeof entry === 'string') {
      const trimmed = entry.trim();
      if (trimmed) out.push(trimmed);
      continue;
    }
    if (isRecord(entry)) {
      const value = strOrNull(entry.value);
      if (value) out.push(value);
    }
  }
  return out;
}

/**
 * YouTube's own hashtag suggestions.
 *
 * Normalised to always carry a leading `#`, because the wire format is
 * inconsistent about it and a mixed list looks broken in the UI.
 */
function parseSuggestedHashtags(video: unknown): string[] {
  const out: string[] = [];
  for (const entry of arr(at(video, ['suggestions', 'hashtagSuggestions', 'hashtags']))) {
    if (!isRecord(entry)) continue;
    const raw = strOrNull(entry.hashtagId) ?? strOrNull(entry.hashtag);
    if (!raw) continue;
    out.push(raw.startsWith('#') ? raw : `#${raw}`);
  }
  return out;
}

/** Hashtags YouTube parsed out of the description itself. */
function parseDescriptionHashtags(video: unknown): string[] {
  const out: string[] = [];
  for (const segment of arr(at(video, ['descriptionDetails', 'segments', 'textSegments']))) {
    if (!isRecord(segment)) continue;
    const text = strOrNull(segment.text);
    if (text?.startsWith('#')) out.push(text);
  }
  return out;
}

function parseThumbnails(video: unknown): Thumbnail[] {
  const out: Thumbnail[] = [];
  for (const entry of arr(at(video, ['thumbnailDetails', 'thumbnails']))) {
    if (!isRecord(entry)) continue;
    const url = strOrNull(entry.url);
    if (!url) continue;
    out.push({ url, width: num(entry.width), height: num(entry.height) });
  }
  return out;
}

/**
 * A/B test arms.
 *
 * `watchtimeFraction` is clamped to 0..1: it is displayed as a percentage, and a
 * value outside that range would render as nonsense rather than fail loudly.
 */
function parseArms(video: unknown): ExperimentArm[] {
  const out: ExperimentArm[] = [];
  const arms = arr(at(video, ['videoCreatorExperiment', 'result', 'armResults']));
  arms.forEach((entry, index) => {
    if (!isRecord(entry)) return;
    const fraction = num(entry.watchtimeFraction);
    out.push({ index, watchtimeFraction: Math.min(Math.max(fraction, 0), 1) });
  });
  return out;
}

/**
 * Unix seconds to unix milliseconds, rejecting implausible values.
 *
 * Returns a number rather than a Date: the model crosses `chrome.runtime`
 * messaging, which serialises as JSON and would turn a Date into a string.
 */
function parsePublishedAtMs(value: unknown): number | null {
  const seconds = num(value, -1);
  // YouTube launched in 2005; anything before 2000 or more than a decade out is
  // a parse artefact, not a real timestamp.
  if (seconds < 946_684_800 || seconds > 2_524_608_000) return null;
  const ms = seconds * 1000;
  return Number.isFinite(ms) ? ms : null;
}

function parseAlteredContent(video: unknown, drift: DriftCollector): Tristate {
  return mapEnum(
    at(video, ['alteredContentSettings', 'alteredContent']),
    ALTERED_CONTENT_MAP,
    'unset',
    'alteredContent',
    drift,
  );
}

/* -------------------------------------------------------------------------- */
/* Public API                                                                  */
/* -------------------------------------------------------------------------- */

export interface CreatorVideosResult {
  readonly videos: readonly VideoContext[];
  readonly drift: DriftReport;
}

/** Parse one `videos[i]` entry. Exported for reuse by sibling creator parsers. */
export function parseVideoEntry(video: unknown, drift: DriftCollector): VideoContext | null {
  if (!isRecord(video)) {
    // A non-object entry in the videos array. Recorded rather than skipped
    // silently: an array of four unusable entries must not look like a clean
    // parse of an empty batch.
    drift.missing('videos[]');
    return null;
  }

  const videoId = strOrNull(video.videoId);
  if (!videoId) {
    // Without an id the entry cannot be addressed, cached or acted on.
    drift.missing('videoId');
    return null;
  }

  if (video.title === undefined) drift.missing('title');
  if (video.description === undefined) drift.missing('description');
  if (video.thumbnailDetails === undefined) drift.missing('thumbnailDetails');

  const categoryRaw = str(video.category);
  const category = mapEnum(categoryRaw, CATEGORY_MAP, categoryRaw || 'Unknown', 'category', drift);

  const ageRestrictionRaw = str(video.ageRestriction);

  const context: VideoContext = {
    videoId,
    title: str(video.title),
    description: str(video.description),
    tags: parseTags(video),
    suggestedHashtags: parseSuggestedHashtags(video),
    descriptionHashtags: parseDescriptionHashtags(video),
    // `lengthSeconds` is a string; `videoDurationMs` is a number. Prefer the
    // former and fall back, since either may be absent.
    durationSec:
      num(video.lengthSeconds, -1) >= 0
        ? num(video.lengthSeconds)
        : Math.round(num(video.videoDurationMs) / 1000),
    publishedAtMs: parsePublishedAtMs(video.timePublishedSeconds),
    channelId: str(video.channelId),
    category,
    categoryRaw,
    license: str(video.license, 'STANDARD_YOUTUBE_LICENSE'),
    privacy: mapEnum(video.privacy, PRIVACY_MAP, 'private', 'privacy', drift),
    status: mapEnum(video.status, STATUS_MAP, 'processing', 'status', drift),
    metadataLanguage: strOrNull(at(video, ['metadataLanguage', 'languageCode'])),
    madeForKids: MADE_FOR_KIDS_TRUE.has(str(at(video, ['mfkSettings', 'effectiveMadeForKids']))),
    ageRestricted: AGE_RESTRICTED_VALUES.has(ageRestrictionRaw),
    allowEmbed: bool(video.allowEmbed),
    allowRatings: bool(video.allowRatings),
    paidPromotion: bool(video.paidProductPlacement),
    alteredContent: parseAlteredContent(video, drift),
    originalFilename: strOrNull(video.originalFilename),
    shareUrl: str(video.shareUrl),
    thumbnails: parseThumbnails(video),
    abTest: {
      state: mapEnum(
        at(video, ['videoCreatorExperiment', 'result', 'experimentState']),
        EXPERIMENT_STATE_MAP,
        'none',
        'experimentState',
        drift,
      ),
      result: mapEnum(
        at(video, ['videoCreatorExperiment', 'result', 'resultState']),
        EXPERIMENT_RESULT_MAP,
        null,
        'resultState',
        drift,
      ),
      arms: parseArms(video),
    },
    monetization: {
      effectiveStatus: str(
        at(video, ['monetization', 'adMonetization', 'effectiveStatus']),
        'UNKNOWN',
      ),
      selfCertDecision: str(at(video, ['selfCertification', 'monetizationDecision']), 'UNKNOWN'),
    },
    copyright: {
      activeClaimCount: num(at(video, ['copyrightSummary', 'activeThirdPartyClaimCount'])),
      hasImpact: (() => {
        const impact = at(video, ['copyrightSummary', 'videoMonetizationImpact']);
        // Absent means no claim at all, which is not an impact.
        if (typeof impact !== 'string' || impact === '') return false;
        return impact !== COPYRIGHT_NO_IMPACT;
      })(),
    },
  };

  drift.counted();
  return context;
}

/**
 * Parse a full `get_creator_videos` response body.
 *
 * Never throws: a malformed body produces an empty result with a `broken` drift
 * report, which the panel shows to the user. Throwing here would take down the
 * receiver's message loop for every subsequent response.
 */
export function parseCreatorVideosResponse(raw: string): CreatorVideosResult {
  const drift = createDriftCollector();

  if (raw.trim() === '') {
    drift.fatal('empty response body');
    return { videos: [], drift: drift.report() };
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- the JSON boundary: shape is genuinely unknown and every access below is guarded
  let json: any;
  try {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- ditto; narrowed by isRecord immediately below
    json = JSON.parse(raw);
  } catch (error) {
    drift.fatal(error instanceof Error ? error.message : 'invalid JSON');
    return { videos: [], drift: drift.report() };
  }

  if (!isRecord(json)) {
    drift.fatal('response was not an object');
    return { videos: [], drift: drift.report() };
  }

  const entries = json.videos;
  if (entries === undefined) {
    // The single most likely shape change, and the signal that the MAIN-world
    // patch has gone blind (see drift.ts).
    drift.missing('videos');
    return { videos: [], drift: drift.report() };
  }

  // An empty ARRAY is legitimate — Studio returns one when no video matched the
  // request. A non-array is corruption, and must not be reported as a clean
  // parse just because the generic array coercion turns it into [].
  if (!Array.isArray(entries)) {
    drift.fatal(`"videos" was ${entries === null ? 'null' : typeof entries}, not an array`);
    return { videos: [], drift: drift.report() };
  }

  const videos: VideoContext[] = [];
  for (const entry of entries) {
    const parsed = parseVideoEntry(entry, drift);
    if (parsed) videos.push(parsed);
  }

  return { videos, drift: drift.report() };
}
