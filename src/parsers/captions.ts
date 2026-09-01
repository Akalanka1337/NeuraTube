/**
 * Parser for Studio's caption tracks.
 *
 * WHICH ENDPOINT ACTUALLY CARRIES THE TRANSCRIPT — measured, not assumed. When
 * the subtitles editor opens, Studio fires four requests. Only some carry
 * segments, and the obvious-looking one carries none:
 *
 *   create_captions            — creates a draft track
 *   get_video_translations     — track list
 *   get_captions_timings       — an ACKNOWLEDGEMENT. Verified on a live capture:
 *                                the response body is
 *                                `{responseContext, nextRequestDelay}` and has no
 *                                `translation` key at all. It is the aligner's
 *                                receipt for text Studio just sent, NOT a source.
 *   get_captions_translation   — THE SOURCE. Full track:
 *                                `translation.captionsTranslations[].captionSegments.segments`
 *                                with `startTimeMs` / `durationMs` / `text`.
 *
 * An earlier version of this file targeted `get_captions_timings` and reported a
 * schema mismatch on every real page, because that endpoint never had the data.
 * The lesson is recorded here rather than in a commit message: the endpoint whose
 * NAME matches the feature was the wrong one.
 *
 * WHY TIMED SEGMENTS MATTER AT ALL. Without timings the chapter generator could
 * only invent timestamps — exactly what its prompt forbids — so the feature could
 * not have worked correctly even with plain text.
 *
 * NOTHING FROM THE REQUEST'S AUTH CONTEXT IS READ OR STORED. The request body
 * carries `eats`, `sessionInfo.token`, `clientScreenNonce` and `onBehalfOfUser` —
 * live session credentials. This parser reads `videoId` and a language code and
 * ignores the rest, deliberately, so none of it can reach a log, a prompt or
 * storage.
 */

import type { DriftReport } from './drift';
import { createDriftCollector } from './drift';

/** One timed caption segment. */
export interface TranscriptSegment {
  /** Offset from the start of the video, in milliseconds. */
  readonly startMs: number;
  readonly durationMs: number;
  readonly text: string;
}

/** A transcript with real timings, ready to place chapters from. */
export interface TranscriptContext {
  readonly videoId: string;
  /** BCP-47-ish language code the timings were produced for. */
  readonly language: string;
  readonly segments: readonly TranscriptSegment[];
  /** End of the last segment, in ms. Used to sanity-check coverage. */
  readonly coverageMs: number;
  /** Unix ms when this was captured, so the UI can say how fresh it is. */
  readonly capturedAtMs: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Coerce a numeric field that InnerTube sends as a string.
 *
 * `startTimeMs` and `durationMs` arrive as strings in this payload
 * (`"480"`, `"5760"`), which is why a plain `typeof === 'number'` check would
 * silently drop every segment.
 */
function num(value: unknown, fallback = -1): number {
  if (typeof value === 'number') return Number.isFinite(value) ? value : fallback;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
  }
  return fallback;
}

/**
 * Normalise segment text.
 *
 * The wire format hard-wraps segments with embedded newlines and pads them with
 * trailing double spaces, both of which are artefacts of caption line layout
 * rather than content. Collapsing them keeps the prompt readable and stops the
 * model treating a line break as a sentence boundary.
 */
function cleanText(value: unknown): string {
  if (typeof value !== 'string') return '';
  return value
    .replace(/\s*\n\s*/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

export interface CaptionsResult {
  readonly transcript: TranscriptContext | null;
  readonly drift: DriftReport;
}

/**
 * Read `videoId` and `language` out of the request body.
 *
 * The response does not carry them, so without the request we would not know
 * which video the timings belong to — and attaching a transcript to the wrong
 * video would produce chapters for the wrong content.
 *
 * Everything else in the request body is ignored on purpose; see the note at the
 * top of this file.
 */
export function parseCaptionsRequest(
  raw: string | null,
): { videoId: string; language: string } | null {
  if (raw === null || raw.trim() === '') return null;

  try {
    const parsed: unknown = JSON.parse(raw);
    if (!isRecord(parsed)) return null;

    const videoId = parsed.videoId;
    if (typeof videoId !== 'string' || videoId === '') return null;

    // Two shapes seen in the wild: `language` on the timings request, and
    // `ttsTrackId.lang` on the translation request. Try both.
    const direct = parsed.language;
    const track = isRecord(parsed.ttsTrackId) ? parsed.ttsTrackId.lang : undefined;
    const language = [direct, track].find(
      (candidate): candidate is string => typeof candidate === 'string' && candidate !== '',
    );

    return { videoId, language: language ?? 'unknown' };
  } catch {
    return null;
  }
}

/**
 * Parse the timed-segments response.
 *
 * Never throws: a malformed body yields a null transcript and a drift report the
 * panel can show, exactly like the creator-videos parser.
 */
export function parseCaptionsResponse(
  raw: string,
  identity: { videoId: string; language: string } | null,
): CaptionsResult {
  const drift = createDriftCollector();

  if (raw.trim() === '') {
    drift.fatal('empty response body');
    return { transcript: null, drift: drift.report() };
  }

  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (error) {
    drift.fatal(error instanceof Error ? error.message : 'invalid JSON');
    return { transcript: null, drift: drift.report() };
  }

  if (!isRecord(json)) {
    drift.fatal('response was not an object');
    return { transcript: null, drift: drift.report() };
  }

  const translation = json.translation;
  if (!isRecord(translation)) {
    // The single most likely shape change for this endpoint.
    drift.missing('translation');
    return { transcript: null, drift: drift.report() };
  }

  const translations = translation.captionsTranslations;
  if (!Array.isArray(translations)) {
    drift.missing('translation.captionsTranslations');
    return { transcript: null, drift: drift.report() };
  }

  const segments: TranscriptSegment[] = [];

  // The field is an array because Studio can return several languages. We take
  // every entry rather than only the first: a video whose primary track is
  // empty but has a secondary one should still produce chapters.
  for (const entry of translations) {
    if (!isRecord(entry)) continue;
    const captionSegments = entry.captionSegments;
    if (!isRecord(captionSegments)) continue;
    const list = captionSegments.segments;
    if (!Array.isArray(list)) continue;

    for (const candidate of list) {
      if (!isRecord(candidate)) continue;

      const startMs = num(candidate.startTimeMs);
      const durationMs = num(candidate.durationMs, 0);
      const text = cleanText(candidate.text);

      // A segment with no start offset cannot be placed on a timeline, and one
      // with no text tells the model nothing.
      if (startMs < 0 || text === '') continue;

      segments.push({ startMs, durationMs: Math.max(durationMs, 0), text });
    }

    if (segments.length > 0) break;
  }

  if (segments.length === 0) {
    drift.missing('captionSegments.segments');
    return { transcript: null, drift: drift.report() };
  }

  // Order is not guaranteed by the wire format, and out-of-order segments would
  // produce chapters that go backwards.
  segments.sort((a, b) => a.startMs - b.startMs);
  drift.counted();

  const last = segments[segments.length - 1];
  const coverageMs = last === undefined ? 0 : last.startMs + last.durationMs;

  // The response states its own language (`translation.languageCode`), which
  // beats the request's: it is what Studio actually returned a track for.
  const responseLanguage = translation.languageCode;
  const language =
    typeof responseLanguage === 'string' && responseLanguage !== ''
      ? responseLanguage
      : (identity?.language ?? 'unknown');

  return {
    transcript: {
      videoId: identity?.videoId ?? '',
      language,
      segments,
      coverageMs,
      capturedAtMs: Date.now(),
    },
    drift: drift.report(),
  };
}

/* -------------------------------------------------------------------------- */
/* Rendering                                                                   */
/* -------------------------------------------------------------------------- */

/** Format milliseconds the way YouTube chapters are written. */
export function formatTimestamp(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const pad = (value: number) => String(value).padStart(2, '0');

  // YouTube accepts M:SS under an hour and requires H:MM:SS over it.
  return hours > 0 ? `${hours}:${pad(minutes)}:${pad(seconds)}` : `${minutes}:${pad(seconds)}`;
}

/**
 * The line that guarantees a 0:00 exists.
 *
 * Labelled, not faked. It states what is true of the interval before the first
 * caption — the video is playing and nothing has been said yet — so the model can
 * anchor the first chapter without inventing a timestamp.
 */
const START_ANCHOR = '[0:00] (start of video, nothing spoken yet)';

/**
 * Render a transcript for a prompt, with a real timestamp on every line.
 *
 * This is the whole point: the model must be able to read a timestamp off the
 * transcript rather than estimate one. Merging adjacent segments would produce
 * fewer, longer lines and a smaller prompt, but it would also blur the
 * boundaries a chapter needs to land on, so segments are kept as they arrive.
 *
 * WHY A 0:00 ANCHOR IS PREPENDED. YouTube rejects a chapter set whose first entry
 * is not 0:00. The chapter prompt therefore requires one — and also requires that
 * every timestamp be copied from the transcript rather than interpolated. Those
 * two rules contradict each other whenever the first caption starts after 0:00,
 * which is most videos: a beat of music or a title card before the first word is
 * the norm.
 *
 * Observed live on a video whose first caption began at 1840 ms. The model
 * refused, correctly and unhelpfully: "the transcript does not contain a 0:00
 * timestamp, so I cannot generate valid YouTube chapters." The data was at fault,
 * not the model. So when the first line does not already read 0:00, an explicit
 * anchor line is added.
 *
 * The check is on the FORMATTED value, not on `startMs > 0`: a caption starting at
 * 480 ms already renders as `0:00` because seconds are floored, and adding a
 * second 0:00 line would give the model two candidates for one chapter.
 */
export function renderTimedTranscript(transcript: TranscriptContext): string {
  const lines = transcript.segments.map(
    (segment) => `[${formatTimestamp(segment.startMs)}] ${segment.text}`,
  );

  const first = transcript.segments[0];
  if (first !== undefined && formatTimestamp(first.startMs) !== '0:00') {
    lines.unshift(START_ANCHOR);
  }

  return lines.join('\n');
}

/** Plain text with no timings, for tasks that only need the content. */
export function renderPlainTranscript(transcript: TranscriptContext): string {
  return transcript.segments.map((segment) => segment.text).join(' ');
}

/** Rough word count, for showing the user what was captured. */
export function transcriptWordCount(transcript: TranscriptContext): number {
  return transcript.segments.reduce(
    (total, segment) => total + segment.text.split(/\s+/).filter(Boolean).length,
    0,
  );
}

/**
 * Whether the timings plausibly cover the whole video.
 *
 * A transcript that stops at 40% of the duration will produce chapters only for
 * the first part, and the user should be told rather than left to notice.
 */
export function coversVideo(transcript: TranscriptContext, durationSec: number): boolean {
  if (durationSec <= 0) return true;
  return transcript.coverageMs >= durationSec * 1000 * 0.7;
}
