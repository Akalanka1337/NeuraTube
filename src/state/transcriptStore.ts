/**
 * Transcript cache, keyed by video.
 *
 * THE PROBLEM THIS SOLVES. `get_captions_timings` fires on Studio's **subtitles**
 * page, but chapters are generated on the **video details** page. Those are two
 * different page loads, so two different content-script instances — the panel
 * that needs the transcript is not the panel that captured it.
 *
 * So the capture has to outlive a navigation. `chrome.storage.session` is the
 * right home: it survives page loads and service-worker restarts, but not a
 * browser restart, and never touches disk. A transcript is the user's own
 * content and there is no reason to persist a copy of it.
 *
 * WHY THE SERVICE WORKER OWNS THE WRITE. `storage.session` is not readable from a
 * content script unless the worker first calls `setAccessLevel`. Rather than
 * widen that access, the content script sends captures to the worker and asks it
 * for them back. One writer, no permission widening, and the worker is already
 * the component that owns cross-page state.
 *
 * NOTHING FROM THE REQUEST'S AUTH CONTEXT IS STORED. The parser reads only
 * `videoId`, `language` and the timed segments; `eats`, `sessionInfo.token` and
 * `onBehalfOfUser` are never extracted, so they cannot land here.
 */

import { createLogger } from '~/lib/logger';
import type { TranscriptContext } from '~/parsers/captions';

const log = createLogger('transcript');

/** One key per video, so several videos can be cached in a session. */
const KEY_PREFIX = 'neuratube:transcript:';

/**
 * How many videos to keep.
 *
 * A transcript is a few KB, and `storage.session` has a 10MB budget shared with
 * everything else, so the cap is about tidiness rather than pressure.
 */
const MAX_CACHED = 12;

function keyFor(videoId: string): string {
  return `${KEY_PREFIX}${videoId}`;
}

/** Discard anything that is not a well-formed transcript. */
function normalise(raw: unknown): TranscriptContext | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const record = raw as Record<string, unknown>;

  if (typeof record.videoId !== 'string') return null;
  if (!Array.isArray(record.segments) || record.segments.length === 0) return null;

  const segments: TranscriptContext['segments'] = record.segments.flatMap((candidate) => {
    if (typeof candidate !== 'object' || candidate === null) return [];
    const entry = candidate as Record<string, unknown>;
    if (typeof entry.startMs !== 'number' || typeof entry.text !== 'string') return [];
    if (entry.text === '') return [];
    return [
      {
        startMs: entry.startMs,
        durationMs: typeof entry.durationMs === 'number' ? entry.durationMs : 0,
        text: entry.text,
      },
    ];
  });

  if (segments.length === 0) return null;

  return {
    videoId: record.videoId,
    language: typeof record.language === 'string' ? record.language : 'unknown',
    segments,
    coverageMs: typeof record.coverageMs === 'number' ? record.coverageMs : 0,
    capturedAtMs: typeof record.capturedAtMs === 'number' ? record.capturedAtMs : 0,
  };
}

/* -------------------------------------------------------------------------- */
/* Service-worker side                                                         */
/* -------------------------------------------------------------------------- */

/** Store a captured transcript. Called only by the service worker. */
export async function saveTranscript(transcript: TranscriptContext): Promise<boolean> {
  if (transcript.videoId === '') {
    // Without a video id we cannot say which video these timings belong to, and
    // attaching them to the wrong video would generate chapters for the wrong
    // content.
    log.warn('refusing to cache a transcript with no video id');
    return false;
  }

  try {
    await chrome.storage.session.set({ [keyFor(transcript.videoId)]: transcript });
    await evictOldest();
    log.debug('cached transcript', {
      videoId: transcript.videoId,
      segments: transcript.segments.length,
    });
    return true;
  } catch (error) {
    log.warn('transcript cache write failed', error instanceof Error ? error.name : 'unknown');
    return false;
  }
}

/** Read a cached transcript, or null. */
export async function loadTranscript(videoId: string): Promise<TranscriptContext | null> {
  if (videoId === '') return null;
  try {
    const key = keyFor(videoId);
    const bag = await chrome.storage.session.get(key);
    return normalise(bag[key]);
  } catch {
    return null;
  }
}

/** Which videos currently have a cached transcript. */
export async function cachedVideoIds(): Promise<readonly string[]> {
  try {
    const bag = await chrome.storage.session.get(null);
    return Object.keys(bag)
      .filter((key) => key.startsWith(KEY_PREFIX))
      .map((key) => key.slice(KEY_PREFIX.length));
  } catch {
    return [];
  }
}

/** Drop the least recently captured entries once the cap is exceeded. */
async function evictOldest(): Promise<void> {
  try {
    const bag = await chrome.storage.session.get(null);
    const entries = Object.entries(bag)
      .filter(([key]) => key.startsWith(KEY_PREFIX))
      .map(([key, value]) => ({ key, at: normalise(value)?.capturedAtMs ?? 0 }));

    if (entries.length <= MAX_CACHED) return;

    entries.sort((a, b) => a.at - b.at);
    const stale = entries.slice(0, entries.length - MAX_CACHED).map((entry) => entry.key);
    await chrome.storage.session.remove(stale);
  } catch {
    // Eviction is housekeeping; failing it is not worth surfacing.
  }
}

/** Remove every cached transcript. Wired to the options page reset. */
export async function clearTranscripts(): Promise<void> {
  try {
    const bag = await chrome.storage.session.get(null);
    const keys = Object.keys(bag).filter((key) => key.startsWith(KEY_PREFIX));
    if (keys.length > 0) await chrome.storage.session.remove(keys);
  } catch {
    // Nothing useful to do.
  }
}
