/**
 * Parser for `GET /api/timedtext?...&fmt=json3` — the PUBLIC caption track.
 *
 * WHY THIS MATTERS MORE THAN THE STUDIO PATH. Studio's caption track only exists
 * for videos you own, and only arrives when you open the subtitles editor. This
 * endpoint serves any public video with captions, fires when the player loads or
 * the viewer opens the transcript, and carries the same thing NeuraTube needs:
 * text with real start offsets. So on a watch page the transcript is available
 * without Studio, without a modal, and for videos that are not yours — which is
 * what makes competitor analysis possible at all.
 *
 * SHAPE (measured from a live capture):
 *
 *   { wireMagic: "pb3",
 *     events: [ { tStartMs: 480, dDurationMs: 5760,
 *                 segs: [ { utf8: "Look at this blurry video. ..." } ] }, ... ] }
 *
 * Note the differences from Studio's `get_captions_translation`:
 *   - offsets are NUMBERS here, strings there
 *   - the field names differ (`tStartMs` / `dDurationMs` vs `startTimeMs` / `durationMs`)
 *   - text is split across a `segs` array that has to be joined
 * Which is why this is a separate parser rather than a shared one with an
 * if-statement: two wire formats that happen to describe the same idea.
 *
 * THE URL IS FULL OF CREDENTIALS AND NONE ARE READ. The query string carries
 * `signature`, `pot`, `key`, `ei` and an `expire` deadline — a signed, expiring
 * grant. This parser reads `v` and `lang` and nothing else, and the extension
 * never replays the request, so none of it is stored or logged.
 */

import type { DriftReport } from './drift';
import { createDriftCollector } from './drift';
import type { TranscriptContext, TranscriptSegment } from './captions';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Read the video id and language out of the request URL.
 *
 * The response body has neither, so without this the timings could not be
 * attributed to a video — and attaching a transcript to the wrong video produces
 * confidently wrong chapters, the worst failure this feature has.
 */
export function parseTimedTextUrl(url: string): { videoId: string; language: string } | null {
  let parsed: URL;
  try {
    parsed = new URL(url, 'https://www.youtube.com');
  } catch {
    return null;
  }

  const videoId = parsed.searchParams.get('v');
  if (videoId === null || videoId === '') return null;

  const language = parsed.searchParams.get('lang');
  return { videoId, language: language !== null && language !== '' ? language : 'unknown' };
}

/**
 * Collapse caption line wrapping.
 *
 * The wire format hard-wraps with embedded newlines and pads with trailing double
 * spaces; both are line-layout artefacts, not content. Left in, a model reads a
 * line break as a sentence boundary.
 */
function cleanText(value: string): string {
  return value
    .replace(/\s*\n\s*/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

export interface TimedTextResult {
  readonly transcript: TranscriptContext | null;
  readonly drift: DriftReport;
}

/**
 * Parse a json3 caption track.
 *
 * Never throws: a malformed body yields a null transcript and a drift report the
 * panel can show, exactly like the other parsers.
 */
export function parseTimedTextResponse(raw: string, url: string): TimedTextResult {
  const drift = createDriftCollector();

  if (raw.trim() === '') {
    drift.fatal('empty response body');
    return { transcript: null, drift: drift.report() };
  }

  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (error) {
    // `fmt=json3` is requested by the player, but a track can come back as XML
    // (`fmt` absent or `srv3`), and that is a format mismatch rather than a bug.
    drift.fatal(error instanceof Error ? error.message : 'invalid JSON');
    return { transcript: null, drift: drift.report() };
  }

  if (!isRecord(json)) {
    drift.fatal('response was not an object');
    return { transcript: null, drift: drift.report() };
  }

  const events = json.events;
  if (!Array.isArray(events)) {
    drift.missing('events');
    return { transcript: null, drift: drift.report() };
  }

  const segments: TranscriptSegment[] = [];

  for (const event of events) {
    if (!isRecord(event)) continue;

    // Not every event is a caption. The track opens with window/pen definitions
    // and can contain formatting-only events with no `segs` at all.
    const segs = event.segs;
    if (!Array.isArray(segs)) continue;

    const startMs = event.tStartMs;
    if (typeof startMs !== 'number' || !Number.isFinite(startMs) || startMs < 0) continue;

    const durationMs = event.dDurationMs;

    // A `segs` array is one caption split into pieces — join, do not treat each
    // piece as its own segment, or a sentence becomes several chapters' worth of
    // fragments.
    const joined = segs
      .map((seg) => (isRecord(seg) && typeof seg.utf8 === 'string' ? seg.utf8 : ''))
      .join('');

    const text = cleanText(joined);
    // Newline-only events are used as spacers and carry no content.
    if (text === '') continue;

    segments.push({
      startMs,
      durationMs:
        typeof durationMs === 'number' && Number.isFinite(durationMs) && durationMs > 0
          ? durationMs
          : 0,
      text,
    });
  }

  if (segments.length === 0) {
    drift.missing('events[].segs');
    return { transcript: null, drift: drift.report() };
  }

  // Order is not guaranteed by the format, and out-of-order segments produce
  // chapters that go backwards.
  segments.sort((a, b) => a.startMs - b.startMs);
  drift.counted();

  const identity = parseTimedTextUrl(url);
  const last = segments[segments.length - 1];
  const coverageMs = last === undefined ? 0 : last.startMs + last.durationMs;

  return {
    transcript: {
      videoId: identity?.videoId ?? '',
      language: identity?.language ?? 'unknown',
      segments,
      coverageMs,
      capturedAtMs: Date.now(),
    },
    drift: drift.report(),
  };
}
