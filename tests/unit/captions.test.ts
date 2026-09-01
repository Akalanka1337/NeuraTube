import { readFileSync } from 'node:fs';
import { DEFAULT_PROMPTS } from '~/orchestrator/promptStore';
import type { TranscriptContext } from '~/parsers/captions';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  coversVideo,
  formatTimestamp,
  parseCaptionsRequest,
  parseCaptionsResponse,
  renderPlainTranscript,
  renderTimedTranscript,
  transcriptWordCount,
} from '~/parsers/captions';

const FIXTURE_DIR = path.join(import.meta.dirname, '../fixtures');
const RESPONSE = readFileSync(path.join(FIXTURE_DIR, 'get_captions_translation.json'), 'utf8');
const REQUEST = readFileSync(
  path.join(FIXTURE_DIR, 'get_captions_translation_request.json'),
  'utf8',
);
/** The aligner's body when Studio sent no transcript text. */
const TIMINGS_ACK = readFileSync(path.join(FIXTURE_DIR, 'get_captions_timings_ack.json'), 'utf8');
/** The SAME endpoint on a different video, carrying a full track. */
const TIMINGS_TRACK = readFileSync(
  path.join(FIXTURE_DIR, 'get_captions_timings_track.json'),
  'utf8',
);

/**
 * Unlike the creator-videos fixture, this one is trimmed from a REAL capture, so
 * the shape quirks it exercises are facts rather than assumptions: string-typed
 * `startTimeMs`, embedded newlines, trailing double spaces, and a `translation`
 * wrapper with an array of language tracks.
 */
describe('parseCaptionsRequest', () => {
  it('reads the video id and the language from ttsTrackId', () => {
    expect(parseCaptionsRequest(REQUEST)).toEqual({
      videoId: 'Xo8bwzAFhSw',
      language: 'en',
    });
  });

  it('defaults an absent language rather than failing', () => {
    expect(parseCaptionsRequest('{"videoId":"abc"}')).toEqual({
      videoId: 'abc',
      language: 'unknown',
    });
  });

  it.each([
    ['null body', null],
    ['empty body', ''],
    ['not JSON', '<html>'],
    ['an array', '[]'],
    ['no video id', '{"language":"en"}'],
    ['an empty video id', '{"videoId":"","language":"en"}'],
  ])('returns null for %s', (_label, body) => {
    expect(parseCaptionsRequest(body)).toBeNull();
  });

  /**
   * The security property, asserted rather than assumed. The live request carries
   * session credentials; the parser's return type has no room for them, so this
   * test proves a future field addition cannot start leaking one.
   */
  it('extracts nothing beyond videoId and language, even when credentials are present', () => {
    const withCredentials = JSON.stringify({
      videoId: 'abc',
      language: 'en',
      eats: 'SECRET_EATS',
      sessionInfo: { token: 'SECRET_TOKEN' },
      clientScreenNonce: 'SECRET_NONCE',
      onBehalfOfUser: '110645834176698900495',
      externalChannelId: 'UCsomething',
    });

    const parsed = parseCaptionsRequest(withCredentials);
    expect(Object.keys(parsed ?? {}).sort()).toEqual(['language', 'videoId']);
    expect(JSON.stringify(parsed)).not.toContain('SECRET');
  });
});

describe('parseCaptionsResponse — against a real capture', () => {
  const identity = parseCaptionsRequest(REQUEST);
  const result = parseCaptionsResponse(RESPONSE, identity);
  const transcript = result.transcript!;

  it('parses every segment', () => {
    expect(transcript.segments).toHaveLength(52);
    expect(result.drift.severity).toBe('none');
  });

  it('coerces the string-typed millisecond fields to numbers', () => {
    const first = transcript.segments[0]!;
    expect(first.startMs).toBe(480);
    expect(first.durationMs).toBe(5760);
    expect(typeof first.startMs).toBe('number');
  });

  it('collapses the caption line wrapping out of the text', () => {
    const first = transcript.segments[0]!;
    expect(first.text).toBe('Look at this blurry video. And now look at it after AI enhancement.');
    expect(first.text).not.toContain('\n');
    expect(first.text).not.toMatch(/ {2}/);
  });

  it('carries the identity from the request, since the response has none', () => {
    expect(transcript.videoId).toBe('Xo8bwzAFhSw');
    expect(transcript.language).toBe('en');
  });

  it('computes coverage from the end of the last segment', () => {
    // Last fixture segment starts at 306040 and runs 6040ms.
    expect(transcript.coverageMs).toBe(312080);
  });

  it('sorts out-of-order segments so chapters cannot go backwards', () => {
    const shuffled = JSON.stringify({
      translation: {
        captionsTranslations: [
          {
            captionSegments: {
              segments: [
                { startTimeMs: '9000', durationMs: '1000', text: 'third' },
                { startTimeMs: '0', durationMs: '1000', text: 'first' },
                { startTimeMs: '4000', durationMs: '1000', text: 'second' },
              ],
            },
          },
        ],
      },
    });

    const parsed = parseCaptionsResponse(shuffled, identity).transcript!;
    expect(parsed.segments.map((segment) => segment.text)).toEqual(['first', 'second', 'third']);
  });

  it('drops segments that cannot be placed or say nothing', () => {
    const messy = JSON.stringify({
      translation: {
        captionsTranslations: [
          {
            captionSegments: {
              segments: [
                { startTimeMs: '0', durationMs: '1000', text: 'kept' },
                { durationMs: '1000', text: 'no start offset' },
                { startTimeMs: '2000', durationMs: '1000', text: '   ' },
                { startTimeMs: 'not a number', durationMs: '1000', text: 'unparseable' },
                null,
              ],
            },
          },
        ],
      },
    });

    const parsed = parseCaptionsResponse(messy, identity).transcript!;
    expect(parsed.segments).toHaveLength(1);
    expect(parsed.segments[0]!.text).toBe('kept');
  });

  it('falls through to a later language track when the first is empty', () => {
    const twoTracks = JSON.stringify({
      translation: {
        captionsTranslations: [
          { captionSegments: { segments: [] } },
          {
            captionSegments: {
              segments: [{ startTimeMs: '0', durationMs: '1000', text: 'secondary track' }],
            },
          },
        ],
      },
    });

    const parsed = parseCaptionsResponse(twoTracks, identity).transcript!;
    expect(parsed.segments[0]!.text).toBe('secondary track');
  });

  it.each([
    ['an empty body', ''],
    ['invalid JSON', '<html>'],
  ])('reports %s as fatal drift without throwing', (_label, body) => {
    const parsed = parseCaptionsResponse(body, identity);
    expect(parsed.transcript).toBeNull();
    expect(parsed.drift.severity).toBe('broken');
  });

  it('reports a renamed wrapper as missing rather than crashing', () => {
    const renamed = parseCaptionsResponse('{"captionTimings":{}}', identity);
    expect(renamed.transcript).toBeNull();
    expect(renamed.drift.missingFields).toContain('translation');
  });

  it('yields an empty video id when the request was never seen', () => {
    // The store refuses to cache this, which is the behaviour that matters:
    // timings with no video id could be attached to the wrong video.
    const orphan = parseCaptionsResponse(RESPONSE, null).transcript!;
    expect(orphan.videoId).toBe('');
  });
});

describe('formatTimestamp', () => {
  it.each([
    [0, '0:00'],
    [480, '0:00'],
    [26720, '0:26'],
    [60_000, '1:00'],
    [306_040, '5:06'],
    [3_600_000, '1:00:00'],
    [3_725_000, '1:02:05'],
    [-5, '0:00'],
  ])('formats %ims as %s', (ms, expected) => {
    expect(formatTimestamp(ms)).toBe(expected);
  });

  it('always starts a chapter set at 0:00, which YouTube requires', () => {
    // The first real segment starts at 480ms, not 0. Flooring to seconds is what
    // makes the first chapter valid; rounding would emit 0:01 and YouTube would
    // silently ignore the entire set.
    expect(formatTimestamp(480)).toBe('0:00');
  });
});

describe('rendering for the prompt', () => {
  const transcript = parseCaptionsResponse(RESPONSE, parseCaptionsRequest(REQUEST)).transcript!;

  it('prefixes every line with a real timestamp', () => {
    const lines = renderTimedTranscript(transcript).split('\n');
    expect(lines).toHaveLength(52);
    expect(lines[0]).toBe(
      '[0:00] Look at this blurry video. And now look at it after AI enhancement.',
    );
    for (const line of lines) expect(line).toMatch(/^\[\d+:\d{2}(?::\d{2})?] \S/);
  });

  it('renders plain text with no timings for tasks that only need content', () => {
    const plain = renderPlainTranscript(transcript);
    // Not `not.toContain('[')` — `[music]` is real caption content, so the
    // invariant is specifically that no *timestamp* markers are emitted.
    expect(plain).not.toMatch(/\[\d+:\d{2}/);
    expect(plain.startsWith('Look at this blurry video.')).toBe(true);
  });

  it('counts words', () => {
    expect(transcriptWordCount(transcript)).toBeGreaterThan(700);
  });
});

describe('coversVideo', () => {
  const transcript = parseCaptionsResponse(RESPONSE, parseCaptionsRequest(REQUEST)).transcript!;

  it('accepts timings that reach most of the way through', () => {
    // 312s of coverage against the real video's 5:17 (317s) — 98%.
    expect(coversVideo(transcript, 317)).toBe(true);
  });

  it('rejects timings that stop well short, so the UI can warn', () => {
    expect(coversVideo(transcript, 1800)).toBe(false);
  });

  it('assumes coverage when the duration is unknown', () => {
    expect(coversVideo(transcript, 0)).toBe(true);
  });
});

/**
 * The finding that cost a release. `get_captions_timings` is named as if it were
 * the source and is not; targeting it made the panel report a schema mismatch on
 * every real page. Pinned so it cannot be re-adopted by mistake.
 */
/**
 * The correction, pinned as two fixtures from the SAME endpoint.
 *
 * `get_captions_timings` was first captured returning only
 * `{responseContext, nextRequestDelay}`, and was demoted to log-only on the
 * strength of that one sample. A later capture on an unlisted video showed it
 * returning the full timed track. It is an ALIGNER: the response mirrors what the
 * request carried. Removing it as a source therefore broke transcripts on exactly
 * the videos where it was the only source.
 *
 * Both shapes are asserted here so neither observation can be generalised into a
 * rule again.
 */
describe('get_captions_timings returns whatever the request carried', () => {
  it('carries no track when Studio only created a draft', () => {
    const result = parseCaptionsResponse(TIMINGS_ACK, { videoId: 'abc', language: 'en' });
    expect(result.transcript).toBeNull();
    expect(result.drift.missingFields).toContain('translation');
  });

  it('carries the full track when the request included transcript text', () => {
    const result = parseCaptionsResponse(TIMINGS_TRACK, {
      videoId: 'Gl56GOSwkGo',
      language: 'en',
    });
    expect(result.transcript?.segments).toHaveLength(7);
    expect(result.transcript?.videoId).toBe('Gl56GOSwkGo');
    expect(result.drift.severity).toBe('none');
  });

  it('takes the language from the request, since this response states none', () => {
    // Unlike get_captions_translation, there is no `languageCode` here.
    const result = parseCaptionsResponse(TIMINGS_TRACK, {
      videoId: 'Gl56GOSwkGo',
      language: 'en',
    });
    expect(result.transcript?.language).toBe('en');
  });

  it('reads a top-level `language` on the timings request', () => {
    const request = readFileSync(
      path.join(FIXTURE_DIR, 'get_captions_timings_request_track.json'),
      'utf8',
    );
    expect(parseCaptionsRequest(request)).toEqual({ videoId: 'Gl56GOSwkGo', language: 'en' });
  });

  it('starts the first segment at exactly 0, which chapters require', () => {
    const result = parseCaptionsResponse(TIMINGS_TRACK, { videoId: 'a', language: 'en' });
    expect(result.transcript?.segments[0]?.startMs).toBe(0);
  });
});

describe('language resolution', () => {
  it("prefers the response's own languageCode over the request's", () => {
    const response = JSON.stringify({
      translation: {
        languageCode: 'si',
        captionsTranslations: [
          { captionSegments: { segments: [{ startTimeMs: '0', durationMs: '1', text: 'hi' }] } },
        ],
      },
    });
    const parsed = parseCaptionsResponse(response, { videoId: 'abc', language: 'en' });
    expect(parsed.transcript?.language).toBe('si');
  });

  it('falls back to the request when the response states none', () => {
    const response = JSON.stringify({
      translation: {
        captionsTranslations: [
          { captionSegments: { segments: [{ startTimeMs: '0', durationMs: '1', text: 'hi' }] } },
        ],
      },
    });
    const parsed = parseCaptionsResponse(response, { videoId: 'abc', language: 'en' });
    expect(parsed.transcript?.language).toBe('en');
  });
});

/**
 * Reported live: a video whose first caption began at 1840 ms produced
 * "the transcript does not contain a 0:00 timestamp, so I cannot generate valid
 * YouTube chapters."
 *
 * The model was right and the data was wrong. The chapter prompt requires a 0:00
 * first entry (YouTube rejects the set otherwise) AND requires every timestamp to
 * be copied rather than interpolated. Those contradict each other whenever the
 * first caption starts late — which is most videos, because a beat of music or a
 * title card before the first word is the norm.
 */
describe('0:00 anchor', () => {
  function withFirstStart(startMs: number): TranscriptContext {
    return {
      videoId: 'j2Nj0Yc9B6E',
      language: 'en',
      segments: [
        { startMs, durationMs: 5920, text: 'Welcome back to AI Made Simple.' },
        { startMs: startMs + 5920, durationMs: 4480, text: 'diving into AI for gaming' },
      ],
      coverageMs: startMs + 10_400,
      capturedAtMs: 1_000,
    };
  }

  it('adds a labelled 0:00 line when the first caption starts later', () => {
    // 1840 ms is the exact value from the reported video.
    const lines = renderTimedTranscript(withFirstStart(1840)).split('\n');
    expect(lines[0]).toBe('[0:00] (start of video, nothing spoken yet)');
    expect(lines[1]).toBe('[0:01] Welcome back to AI Made Simple.');
  });

  /**
   * The check is on the FORMATTED value, not `startMs > 0`. A caption at 480 ms
   * already renders as 0:00 because seconds are floored, and a second 0:00 line
   * would give the model two candidates for one chapter.
   */
  it('does not add a duplicate when the first line already reads 0:00', () => {
    for (const startMs of [0, 480, 999]) {
      const lines = renderTimedTranscript(withFirstStart(startMs)).split('\n');
      expect(lines.filter((line) => line.startsWith('[0:00]'))).toHaveLength(1);
      expect(lines[0]).not.toContain('nothing spoken yet');
    }
  });

  it('anchors even a very late first caption rather than shifting it', () => {
    // 30 seconds of intro music. The anchor must not relabel the real line as
    // 0:00 — that would be a thirty-second lie.
    const lines = renderTimedTranscript(withFirstStart(30_000)).split('\n');
    expect(lines[0]).toBe('[0:00] (start of video, nothing spoken yet)');
    expect(lines[1]).toContain('[0:30]');
  });

  it('leaves the segment data untouched, so coverage stays honest', () => {
    const transcript = withFirstStart(1840);
    renderTimedTranscript(transcript);
    expect(transcript.segments[0]?.startMs).toBe(1840);
  });

  it('anchors the real reported capture', () => {
    const transcript = parseCaptionsResponse(RESPONSE, {
      videoId: 'Xo8bwzAFhSw',
      language: 'en',
    }).transcript!;
    // This fixture's first caption is at 480 ms, which already reads 0:00.
    expect(renderTimedTranscript(transcript).split('\n')[0]).toMatch(/^\[0:00] Look at this/);
  });
});

describe('the chapter prompt no longer contradicts itself', () => {
  it('permits 0:00 without it appearing in the transcript', () => {
    const prompt = DEFAULT_PROMPTS.chapter_generator;
    expect(prompt).toMatch(/`0:00` is always\s+a valid first chapter/);
    // And the copy-verbatim rule now scopes itself to the OTHER timestamps.
    expect(prompt).toMatch(/Every OTHER timestamp must appear in the transcript/);
  });

  it('tells the model a late first caption is not a refusal case', () => {
    expect(DEFAULT_PROMPTS.chapter_generator).toMatch(
      /A first caption that starts after 0:00 is \*\*not\*\* one of those cases/,
    );
  });
});
