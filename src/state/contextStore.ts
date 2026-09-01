/**
 * Intercepted-data store.
 *
 * Sits between the receiver and the UI. Responsibilities:
 *
 *  - reduce captured exchanges into `VideoContext` objects
 *  - decide which video is "current" for the surface the user is on
 *  - keep a bounded log of what was seen, for the debug view
 *
 * Everything is in memory only, deliberately. Video metadata is the user's own
 * data and there is no reason to persist a copy of it to disk when Studio will
 * hand it to us again on the next page load. That also means no cache
 * invalidation problem and nothing to leak.
 */

import { computed, signal } from '@preact/signals';
import { createLogger } from '~/lib/logger';
import type { CapturedExchange } from '~/intercept/protocol';
import type { RouteKind } from '~/intercept/routes';
import { parseCreatorVideosResponse } from '~/parsers/creatorVideos';
import { parseCaptionsRequest, parseCaptionsResponse } from '~/parsers/captions';
import { parseTimedTextResponse } from '~/parsers/timedText';
import { parseWatchPageData } from '~/parsers/watchVideo';
import type { WatchDomExtras } from '~/parsers/watchVideo';
import { readWatchDom } from '~/panel/watchDom';
import { extractPlayerDetails } from '~/parsers/playerResponse';
import type { TranscriptContext } from '~/parsers/captions';
import type { DriftReport } from '~/parsers/drift';
import type { VideoContext } from '~/types/VideoContext';
import { surface } from './panelState';

const log = createLogger('context');

/**
 * Endpoints whose responses can contain a caption track.
 *
 * `get_captions_translation` is the one that reliably does.
 * `get_video_translations` is attempted with the same parser because it plausibly
 * shares the wrapper — if it does not, the tolerant parser simply reports drift
 * and nothing breaks.
 *
 * `CREATOR_CAPTIONS_TIMINGS` is deliberately ABSENT. Measured on a live page, its
 * body is `{responseContext, nextRequestDelay}` with no segments, so parsing it
 * only ever produced a spurious "schema mismatch" in the panel.
 */
/**
 * Read the DOM-only watch facts, guarded.
 *
 * Called from ingest, which runs inside the receiver's message loop — so a throw
 * here would stop every subsequent capture being processed. The reader is already
 * defensive; this is the second belt.
 */
function domExtras(): WatchDomExtras {
  try {
    const facts = readWatchDom();
    return {
      // `undefined`, not `null`: a missing tooltip means the parser should fall
      // back to the payload's rounded figure, and `?? null` would pin it to zero.
      ...(facts.viewCountExact !== null ? { viewCountExact: facts.viewCountExact } : {}),
      publishedAtMs: facts.publishedAtMs,
      subscriberText: facts.subscriberText,
      chapters: facts.chapters,
    };
  } catch {
    return {};
  }
}

/**
 * Endpoints whose responses can contain a caption track.
 *
 * ALL THREE, and that is a correction worth recording. `get_captions_timings`
 * was removed from this set after a capture showed its body was only
 * `{responseContext, nextRequestDelay}`. A later capture on an unlisted video
 * showed the opposite: the SAME endpoint returning a full timed track.
 *
 * It is an ALIGNER — the response mirrors what the request carried. Empty when
 * Studio is merely creating a draft, complete when Studio sends transcript text
 * to be aligned. Neither observation generalises, so demoting it on the strength
 * of one sample broke transcripts on exactly the videos where it was the only
 * source.
 *
 * Hence a SET rather than a single 'correct' endpoint: which one carries the
 * track depends on the video's caption state. Every plausible source is parsed,
 * the first success wins, and a later empty one cannot overwrite it.
 */
const TRANSCRIPT_SOURCES: ReadonlySet<RouteKind> = new Set<RouteKind>([
  'CREATOR_CAPTIONS_TRANSLATION',
  'CREATOR_CAPTIONS_TIMINGS',
  'CREATOR_VIDEO_TRANSLATIONS',
]);

/** Bound on the debug log. Enough to see a page load, small enough to ignore. */
const MAX_LOG_ENTRIES = 40;

/** One line in the debug view. */
export interface ExchangeLogEntry {
  readonly kind: RouteKind;
  readonly status: number;
  readonly method: string;
  /** Path only — the full URL carries session parameters we have no use for. */
  readonly path: string;
  readonly bytes: number;
  readonly skipped: string | null;
  /** Videos extracted from this exchange, when it was one we parse. */
  readonly parsed: number | null;
  readonly at: number;
}

/** All videos seen this session, keyed by id. */
export const videosById = signal<ReadonlyMap<string, VideoContext>>(new Map());

/** Most recent drift report from a parsed payload. */
export const lastDrift = signal<DriftReport | null>(null);

/**
 * Transcript for the video on screen, when one has been captured.
 *
 * Populated either by intercepting the subtitles editor on this page load, or by
 * asking the service worker for a cached one (the usual case, since the capture
 * happens on a different Studio page).
 */
export const transcript = signal<TranscriptContext | null>(null);

/** Set when a transcript arrives from the worker's session cache. */
export function setTranscript(next: TranscriptContext | null): void {
  transcript.value = next;
}

/**
 * Why the last caption-timings capture did not produce a usable transcript.
 *
 * Exists because the failure was otherwise invisible: the panel said "no
 * timings" whether the endpoint had never fired, or had fired and been rejected
 * for a reason only the parser knew. The user then has no way to tell a missing
 * capture from a schema change, and neither do I.
 *
 * `topLevelKeys` is key NAMES only — never values. Enough to recognise a renamed
 * wrapper, and it cannot carry transcript text or a session credential.
 */
export interface TranscriptAttempt {
  readonly kind: RouteKind;
  readonly bytes: number;
  readonly skipped: string | null;
  readonly reason: string;
  readonly topLevelKeys: readonly string[];
  readonly at: number;
}

export const lastTranscriptAttempt = signal<TranscriptAttempt | null>(null);

function topLevelKeysOf(raw: string): readonly string[] {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return [];
    return Object.keys(parsed).slice(0, 12);
  } catch {
    return [];
  }
}

/**
 * Apply a transcript that came back from the worker's cache.
 *
 * NOT a plain assignment, for two reasons that both produced a transcript
 * silently vanishing:
 *
 *  - A cache MISS must never clear a transcript we already hold. The live
 *    capture and the cache lookup race, so the worker's "nothing cached" reply
 *    can land AFTER a capture and wipe it.
 *  - A reply for a video that is no longer on screen must be ignored, or a slow
 *    lookup for the previous video overwrites the current one — chapters for the
 *    wrong video, which is the worst failure this feature has.
 */
export function applyCachedTranscript(
  videoId: string | null,
  incoming: TranscriptContext | null,
): void {
  const held = transcript.value;

  if (incoming === null) {
    // Keep what we have if it belongs to this video (or no video is on screen).
    if (held !== null && (videoId === null || held.videoId === videoId)) return;
    transcript.value = null;
    return;
  }

  // Stale reply for some other video.
  if (videoId !== null && incoming.videoId !== '' && incoming.videoId !== videoId) return;

  // A live capture beats a cached one of equal or lesser coverage: the aligner
  // can return a fragment while the user is drafting, and replacing a full
  // transcript with a fragment would quietly shrink the chapter range.
  if (
    held !== null &&
    held.videoId === incoming.videoId &&
    held.segments.length >= incoming.segments.length
  ) {
    return;
  }

  transcript.value = incoming;
}

/** Bounded record of intercepted exchanges, newest first. */
export const exchangeLog = signal<readonly ExchangeLogEntry[]>([]);

/** Total exchanges accepted from the interceptor. */
export const exchangeCount = signal<number>(0);

/**
 * The video the panel should be showing.
 *
 * Prefers the video id in the URL, so on a Studio edit page the panel tracks the
 * video the user is actually editing even though `get_creator_videos` returns a
 * batch. Falls back to the most recently parsed video when the URL names none
 * (the channel dashboard, for instance).
 */
export const currentVideo = computed<VideoContext | null>(() => {
  const map = videosById.value;
  const wanted = surface.value.videoId;

  if (wanted !== null) {
    return map.get(wanted) ?? null;
  }

  let latest: VideoContext | null = null;
  for (const video of map.values()) latest = video;
  return latest;
});

/** Whether anything has been intercepted yet. */
export const hasData = computed<boolean>(() => videosById.value.size > 0);

function pathOf(url: string): string {
  try {
    return new URL(url, location.origin).pathname;
  } catch {
    return url.slice(0, 120);
  }
}

function appendLog(entry: ExchangeLogEntry): void {
  const next = [entry, ...exchangeLog.value];
  exchangeLog.value = next.length > MAX_LOG_ENTRIES ? next.slice(0, MAX_LOG_ENTRIES) : next;
}

/**
 * Reduce one captured exchange into the store.
 *
 * Never throws: it is called from the receiver's message loop, and an exception
 * here would stop every subsequent response being processed.
 */
/** Called when a transcript is captured, so it can be persisted for other pages. */
let onTranscriptCaptured: ((next: TranscriptContext) => void) | null = null;

export function setTranscriptCapturedHandler(handler: (next: TranscriptContext) => void): void {
  onTranscriptCaptured = handler;
}

export function ingestExchange(exchange: CapturedExchange): void {
  exchangeCount.value += 1;

  let parsedCount: number | null = null;

  try {
    if (exchange.kind === 'CREATOR_VIDEOS' && exchange.responseText !== '') {
      const result = parseCreatorVideosResponse(exchange.responseText);
      parsedCount = result.videos.length;

      if (result.videos.length > 0) {
        // Copy-on-write so the signal identity changes and dependents recompute.
        const next = new Map(videosById.value);
        for (const video of result.videos) next.set(video.videoId, video);
        videosById.value = next;
      }

      lastDrift.value = result.drift;

      if (result.drift.severity !== 'none') {
        log.warn('schema drift', result.drift.severity, result.drift.summary);
      }
      log.debug('parsed videos', result.videos.length);
    }

    if (exchange.kind === 'PUBLIC_PLAYER' && exchange.responseText !== '') {
      /*
       * The authoritative watch-page source.
       *
       * `ytInitialPlayerResponse` is written once and never rewritten on
       * client-side navigation, so on a watch page the global describes whatever
       * video you first landed on — permanently. This endpoint fires on every
       * navigation, carries the same shape, and is therefore what keeps the panel
       * correct after the viewer clicks a suggested video.
       */
      let payload: string | null = null;
      try {
        payload = extractPlayerDetails(JSON.parse(exchange.responseText));
      } catch {
        payload = null;
      }

      if (payload !== null) {
        const result = parseWatchPageData(payload, domExtras());
        parsedCount = result.video === null ? 0 : 1;
        if (result.video !== null) {
          const next = new Map(videosById.value);
          next.set(result.video.videoId, result.video);
          videosById.value = next;
          log.info('parsed player response', {
            videoId: result.video.videoId,
            tags: result.video.tags.length,
          });
        }
        lastDrift.value = result.drift;
      } else {
        parsedCount = 0;
      }
    }

    if (exchange.kind === 'PUBLIC_PAGE_DATA' && exchange.responseText !== '') {
      // A public watch page. Title, description and TAGS come from YouTube's own
      // player response; the DOM supplies only what the payload lacks.
      const result = parseWatchPageData(exchange.responseText, domExtras());
      parsedCount = result.video === null ? 0 : 1;

      if (result.video !== null) {
        const next = new Map(videosById.value);
        next.set(result.video.videoId, result.video);
        videosById.value = next;
        log.info('parsed public video', {
          videoId: result.video.videoId,
          tags: result.video.tags.length,
        });
      }
      lastDrift.value = result.drift;
    }

    if (exchange.kind === 'PUBLIC_TIMEDTEXT' && exchange.responseText !== '') {
      // The public caption track. Same destination as Studio's, different wire
      // format — and available for videos the user does not own.
      const result = parseTimedTextResponse(exchange.responseText, exchange.url);
      parsedCount = result.transcript?.segments.length ?? 0;

      if (result.transcript !== null) {
        transcript.value = result.transcript;
        onTranscriptCaptured?.(result.transcript);
        lastTranscriptAttempt.value = null;
        log.info('captured public transcript', {
          videoId: result.transcript.videoId,
          segments: result.transcript.segments.length,
        });
      } else if (transcript.value === null) {
        lastTranscriptAttempt.value = {
          kind: exchange.kind,
          bytes: exchange.responseText.length,
          skipped: exchange.skipped,
          reason: result.drift.missingFields[0] ?? result.drift.summary ?? 'no usable segments',
          topLevelKeys: topLevelKeysOf(exchange.responseText),
          at: exchange.at,
        };
      }
      lastDrift.value = result.drift;
    }

    if (TRANSCRIPT_SOURCES.has(exchange.kind)) {
      // The request carries the video id and language; the response carries the
      // timings. Both halves are needed — timings with no video id could be
      // attached to the wrong video.
      const identity = parseCaptionsRequest(exchange.requestBody);
      const result =
        exchange.responseText === ''
          ? null
          : parseCaptionsResponse(exchange.responseText, identity);
      parsedCount = result?.transcript?.segments.length ?? 0;

      if (result?.transcript != null) {
        // Straight assignment, not applyCachedTranscript: a live capture for the
        // page we are on is the most authoritative source there is.
        transcript.value = result.transcript;
        onTranscriptCaptured?.(result.transcript);
        lastTranscriptAttempt.value = null;
        log.info('captured transcript', {
          kind: exchange.kind,
          videoId: result.transcript.videoId,
          segments: result.transcript.segments.length,
        });
      } else if (transcript.value === null) {
        // Only report a failure when we have nothing. Several of these endpoints
        // fire per modal open and their order is not guaranteed, so a later
        // empty one must not overwrite a good capture with an error.
        lastTranscriptAttempt.value = {
          kind: exchange.kind,
          bytes: exchange.responseText.length,
          skipped: exchange.skipped,
          reason:
            exchange.responseText === ''
              ? (exchange.skipped ?? 'empty response body')
              : (result?.drift.missingFields[0] ?? result?.drift.summary ?? 'no usable segments'),
          topLevelKeys: topLevelKeysOf(exchange.responseText),
          at: exchange.at,
        };
      }

      if (result !== null) lastDrift.value = result.drift;
    }
  } catch (error) {
    // A parser that throws is a bug, but it must not take the panel with it.
    log.error('ingest failed', error);
  }

  appendLog({
    kind: exchange.kind,
    status: exchange.status,
    method: exchange.method,
    path: pathOf(exchange.url),
    bytes: exchange.responseText.length,
    skipped: exchange.skipped,
    parsed: parsedCount,
    at: exchange.at,
  });
}

/** Reset the store. Test-only. */
export function resetContextStoreForTests(): void {
  videosById.value = new Map();
  lastDrift.value = null;
  transcript.value = null;
  lastTranscriptAttempt.value = null;
  onTranscriptCaptured = null;
  exchangeLog.value = [];
  exchangeCount.value = 0;
}
