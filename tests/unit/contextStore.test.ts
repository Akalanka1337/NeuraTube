import { readFileSync } from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  currentVideo,
  exchangeCount,
  exchangeLog,
  hasData,
  ingestExchange,
  lastDrift,
  applyCachedTranscript,
  lastTranscriptAttempt,
  resetContextStoreForTests,
  setTranscript,
  setTranscriptCapturedHandler,
  transcript,
  videosById,
} from '~/state/contextStore';
import { resetPanelStateForTests, surface } from '~/state/panelState';
import { detectSurface } from '~/types/surface';
import { createDriftCollector, isUserVisible } from '~/parsers/drift';
import type { CapturedExchange } from '~/intercept/protocol';
import type { TranscriptContext } from '~/parsers/captions';

const FIXTURE = readFileSync(
  path.join(import.meta.dirname, '../fixtures/get_creator_videos.json'),
  'utf8',
);

function exchange(overrides: Partial<CapturedExchange> = {}): CapturedExchange {
  return {
    kind: 'CREATOR_VIDEOS',
    url: 'https://studio.youtube.com/youtubei/v1/creator/get_creator_videos?alt=json',
    method: 'POST',
    status: 200,
    responseText: FIXTURE,
    requestBody: null,
    at: 100,
    skipped: null,
    ...overrides,
  };
}

describe('context store', () => {
  beforeEach(() => {
    resetContextStoreForTests();
    resetPanelStateForTests();
  });

  it('reduces a creator-videos exchange into the store', () => {
    ingestExchange(exchange());

    expect(videosById.value.size).toBe(2);
    expect(hasData.value).toBe(true);
    expect(exchangeCount.value).toBe(1);
    expect(lastDrift.value?.severity).toBe('none');
  });

  it('selects the video named in the URL, not merely the first in the batch', () => {
    // get_creator_videos returns a batch; the panel must track the video the
    // user is actually editing.
    surface.value = detectSurface('https://studio.youtube.com/video/dQw4w9WgXcQ/edit');
    ingestExchange(exchange());

    expect(currentVideo.value?.videoId).toBe('dQw4w9WgXcQ');
  });

  it('falls back to the most recent video when the URL names none', () => {
    surface.value = detectSurface('https://studio.youtube.com/channel/UCuAXFkgsw1L7xaCfnd5JJOw');
    ingestExchange(exchange());

    expect(currentVideo.value).not.toBeNull();
  });

  it('returns null when the URL names a video the batch did not contain', () => {
    surface.value = detectSurface('https://studio.youtube.com/video/zzzzzzzzzzz/edit');
    ingestExchange(exchange());

    // Showing another video's metadata would be actively misleading.
    expect(currentVideo.value).toBeNull();
  });

  it('merges later batches over earlier ones', () => {
    surface.value = detectSurface('https://studio.youtube.com/video/PPGYNmrVG58/edit');
    ingestExchange(exchange());
    expect(currentVideo.value?.title).toContain('Build an AI Agent');

    ingestExchange(
      exchange({
        responseText: JSON.stringify({
          videos: [
            {
              videoId: 'PPGYNmrVG58',
              title: 'Renamed after a Studio save',
              description: '',
              thumbnailDetails: { thumbnails: [] },
            },
          ],
        }),
      }),
    );

    expect(currentVideo.value?.title).toBe('Renamed after a Studio save');
    // The other video from the first batch survives.
    expect(videosById.value.size).toBe(2);
  });

  it('logs every exchange, including ones it does not parse', () => {
    ingestExchange(exchange({ kind: 'PUBLIC_PLAYER', responseText: '{"videoDetails":{}}' }));
    ingestExchange(exchange({ kind: 'CREATOR_ANALYTICS', responseText: '{}' }));

    expect(exchangeCount.value).toBe(2);
    expect(exchangeLog.value).toHaveLength(2);
    // Newest first.
    expect(exchangeLog.value[0]!.kind).toBe('CREATOR_ANALYTICS');
    // Not a route we parse yet, so no parse count is claimed.
    expect(exchangeLog.value[0]!.parsed).toBeNull();
    expect(videosById.value.size).toBe(0);
  });

  it('records the path only, discarding session query parameters', () => {
    ingestExchange(
      exchange({
        url: 'https://studio.youtube.com/youtubei/v1/creator/get_creator_videos?alt=json&key=SECRET',
      }),
    );
    expect(exchangeLog.value[0]!.path).toBe('/youtubei/v1/creator/get_creator_videos');
    expect(JSON.stringify(exchangeLog.value)).not.toContain('SECRET');
  });

  it('bounds the log so a long session cannot grow it without limit', () => {
    for (let i = 0; i < 60; i += 1) {
      ingestExchange(exchange({ kind: 'PUBLIC_SEARCH', at: i, responseText: '{}' }));
    }
    expect(exchangeLog.value.length).toBeLessThanOrEqual(40);
    expect(exchangeCount.value).toBe(60);
  });

  it('records a skipped body without pretending it parsed', () => {
    ingestExchange(exchange({ responseText: '', skipped: 'too-large' }));

    expect(exchangeLog.value[0]!.skipped).toBe('too-large');
    expect(videosById.value.size).toBe(0);
    // An empty body is not a drift signal — nothing was attempted.
    expect(lastDrift.value).toBeNull();
  });

  it('never throws on a malformed payload, and keeps accepting later ones', () => {
    expect(() => {
      ingestExchange(exchange({ responseText: 'not json at all' }));
    }).not.toThrow();

    expect(lastDrift.value?.severity).toBe('broken');

    // The receiver's loop must survive, so a good payload after a bad one works.
    surface.value = detectSurface('https://studio.youtube.com/video/PPGYNmrVG58/edit');
    ingestExchange(exchange());
    expect(currentVideo.value?.videoId).toBe('PPGYNmrVG58');
    expect(lastDrift.value?.severity).toBe('none');
  });
});

describe('drift reporting', () => {
  it('reports a clean parse as none', () => {
    const collector = createDriftCollector();
    collector.counted();
    const report = collector.report();
    expect(report.severity).toBe('none');
    expect(isUserVisible(report)).toBe(false);
  });

  it('treats an unmapped enum as minor and does not alarm the user', () => {
    const collector = createDriftCollector();
    collector.counted();
    collector.unmapped('category', 'CREATOR_VIDEO_CATEGORY_NEW');
    const report = collector.report();

    expect(report.severity).toBe('minor');
    expect(isUserVisible(report)).toBe(false);
    expect(report.summary).toContain('usable');
  });

  it('deduplicates a repeated unmapped value across a batch', () => {
    const collector = createDriftCollector();
    for (let i = 0; i < 50; i += 1) {
      collector.counted();
      collector.unmapped('category', 'CREATOR_VIDEO_CATEGORY_NEW');
    }
    expect(collector.report().unmappedEnums).toHaveLength(1);
  });

  it('treats a missing critical field as major and tells the user', () => {
    const collector = createDriftCollector();
    collector.counted();
    collector.missing('title');
    const report = collector.report();

    expect(report.severity).toBe('major');
    expect(isUserVisible(report)).toBe(true);
    expect(report.summary).toContain('incomplete');
  });

  it('treats nothing parsed as broken', () => {
    const collector = createDriftCollector();
    collector.missing('videos');
    const report = collector.report();

    expect(report.severity).toBe('broken');
    expect(isUserVisible(report)).toBe(true);
  });

  it('surfaces the reason when a payload could not be read at all', () => {
    const collector = createDriftCollector();
    collector.fatal('invalid JSON');
    const report = collector.report();

    expect(report.severity).toBe('broken');
    expect(report.summary).toContain('invalid JSON');
  });
});

describe('ingesting captions timings', () => {
  beforeEach(() => {
    resetContextStoreForTests();
  });

  const RESPONSE = readFileSync(
    path.join(import.meta.dirname, '../fixtures/get_captions_translation.json'),
    'utf8',
  );
  const REQUEST = readFileSync(
    path.join(import.meta.dirname, '../fixtures/get_captions_translation_request.json'),
    'utf8',
  );

  function captionsExchange(overrides: Partial<CapturedExchange> = {}): CapturedExchange {
    return {
      kind: 'CREATOR_CAPTIONS_TRANSLATION',
      method: 'POST',
      url: 'https://studio.youtube.com/youtubei/v1/globalization/get_captions_translation?alt=json',
      status: 200,
      requestBody: REQUEST,
      responseText: RESPONSE,
      skipped: null,
      at: Date.now(),
      ...overrides,
    };
  }

  it('populates the transcript signal', () => {
    ingestExchange(captionsExchange());
    expect(transcript.value?.videoId).toBe('Xo8bwzAFhSw');
    expect(transcript.value?.segments).toHaveLength(52);
  });

  /**
   * The capture happens on the subtitles page but chapters are generated on the
   * details page, so handing it to the worker is what makes the feature usable
   * at all — not an optimisation.
   */
  it('hands the transcript to the worker for cross-page caching', () => {
    const captured: string[] = [];
    setTranscriptCapturedHandler((next) => {
      captured.push(next.videoId);
    });
    ingestExchange(captionsExchange());
    expect(captured).toEqual(['Xo8bwzAFhSw']);
  });

  it('does not notify the worker when the response is unusable', () => {
    const captured: string[] = [];
    setTranscriptCapturedHandler((next) => {
      captured.push(next.videoId);
    });
    ingestExchange(captionsExchange({ responseText: '{"translation":{}}' }));
    expect(captured).toEqual([]);
    expect(transcript.value).toBeNull();
  });

  it('logs the exchange with the segment count', () => {
    ingestExchange(captionsExchange());
    const entry = exchangeLog.value[0]!;
    expect(entry.kind).toBe('CREATOR_CAPTIONS_TRANSLATION');
    expect(entry.parsed).toBe(52);
    // Path only: the real URL carries session parameters we have no use for.
    expect(entry.path).toBe('/youtubei/v1/globalization/get_captions_translation');
  });

  it('survives a handler that throws, so the panel keeps working', () => {
    setTranscriptCapturedHandler(() => {
      throw new Error('worker unreachable');
    });
    expect(() => {
      ingestExchange(captionsExchange());
    }).not.toThrow();
    // The signal is set before the handler runs, so the transcript is still usable.
    expect(transcript.value?.segments).toHaveLength(52);
  });

  it('ignores an empty response body without touching the signal', () => {
    ingestExchange(captionsExchange({ responseText: '' }));
    expect(transcript.value).toBeNull();
    // 0, not null: we recognised the endpoint and got nothing from it, which is
    // a different fact from never having looked.
    expect(exchangeLog.value[0]!.parsed).toBe(0);
  });
});

describe('applyCachedTranscript', () => {
  beforeEach(() => {
    resetContextStoreForTests();
  });

  function make(videoId: string, segments = 2): TranscriptContext {
    return {
      videoId,
      language: 'en',
      segments: Array.from({ length: segments }, (_, index) => ({
        startMs: index * 1000,
        durationMs: 1000,
        text: `line ${index}`,
      })),
      coverageMs: segments * 1000,
      capturedAtMs: 1_000,
    };
  }

  it('applies a cached transcript for the current video', () => {
    applyCachedTranscript('abc', make('abc'));
    expect(transcript.value?.videoId).toBe('abc');
  });

  /**
   * The regression that made the feature look broken on a live page. The cache
   * lookup is async, so the worker's "nothing cached" reply can land AFTER a live
   * capture — and a plain assignment then wiped a transcript we already had.
   */
  it('does not let a cache miss wipe a transcript already captured', () => {
    setTranscript(make('abc'));
    applyCachedTranscript('abc', null);
    expect(transcript.value?.videoId).toBe('abc');
  });

  it('does clear when the miss is for a different video', () => {
    setTranscript(make('abc'));
    applyCachedTranscript('other', null);
    expect(transcript.value).toBeNull();
  });

  it('keeps a transcript when no video is on screen', () => {
    setTranscript(make('abc'));
    applyCachedTranscript(null, null);
    expect(transcript.value?.videoId).toBe('abc');
  });

  it('ignores a late reply for a video that is no longer current', () => {
    setTranscript(make('abc'));
    // A slow lookup for the previously viewed video resolves after navigation.
    applyCachedTranscript('abc', make('stale-video'));
    expect(transcript.value?.videoId).toBe('abc');
  });

  /**
   * The aligner can return a fragment while the user drafts subtitles, so a
   * cached fragment must not replace a fuller transcript — that would quietly
   * shrink the range chapters cover.
   */
  it('does not replace a fuller transcript with a shorter one', () => {
    setTranscript(make('abc', 40));
    applyCachedTranscript('abc', make('abc', 3));
    expect(transcript.value?.segments).toHaveLength(40);
  });

  it('does upgrade to a longer transcript for the same video', () => {
    setTranscript(make('abc', 3));
    applyCachedTranscript('abc', make('abc', 40));
    expect(transcript.value?.segments).toHaveLength(40);
  });
});

describe('transcript diagnosis', () => {
  beforeEach(() => {
    resetContextStoreForTests();
  });

  const REQUEST = readFileSync(
    path.join(import.meta.dirname, '../fixtures/get_captions_translation_request.json'),
    'utf8',
  );

  function exchange(responseText: string, skipped: string | null = null): CapturedExchange {
    return {
      kind: 'CREATOR_CAPTIONS_TRANSLATION',
      method: 'POST',
      url: 'https://studio.youtube.com/youtubei/v1/globalization/get_captions_translation?alt=json',
      status: 200,
      requestBody: REQUEST,
      responseText,
      skipped: skipped as CapturedExchange['skipped'],
      at: Date.now(),
    };
  }

  it('names the renamed wrapper when the schema moves', () => {
    ingestExchange(exchange('{"captionTimings":{"segments":[]},"responseContext":{}}'));
    const attempt = lastTranscriptAttempt.value!;
    expect(attempt.reason).toBe('translation');
    expect(attempt.topLevelKeys).toEqual(['captionTimings', 'responseContext']);
  });

  it('distinguishes a skipped body from a schema problem', () => {
    ingestExchange(exchange('', 'too-large'));
    const attempt = lastTranscriptAttempt.value!;
    expect(attempt.reason).toBe('too-large');
    expect(attempt.bytes).toBe(0);
  });

  /**
   * Cleared, not set to 'ok'. The banner reads this to decide whether to show a
   * diagnosis, so a lingering value after a good capture would report a failure
   * the user does not have — and these endpoints fire several times per modal
   * open, in no guaranteed order.
   */
  it('clears the diagnosis on a successful capture', () => {
    const response = readFileSync(
      path.join(import.meta.dirname, '../fixtures/get_captions_translation.json'),
      'utf8',
    );
    ingestExchange(exchange('{"nope":true}'));
    expect(lastTranscriptAttempt.value).not.toBeNull();

    ingestExchange(exchange(response));
    expect(lastTranscriptAttempt.value).toBeNull();
    expect(transcript.value?.segments).toHaveLength(52);
  });

  it('does not overwrite a good capture with a later empty response', () => {
    const response = readFileSync(
      path.join(import.meta.dirname, '../fixtures/get_captions_translation.json'),
      'utf8',
    );
    ingestExchange(exchange(response));
    // A sibling endpoint fires afterwards carrying nothing.
    ingestExchange(exchange('{"responseContext":{},"nextRequestDelay":{}}'));

    expect(lastTranscriptAttempt.value).toBeNull();
    expect(transcript.value?.segments).toHaveLength(52);
  });

  /** Key NAMES only. A value here could be transcript text or a credential. */
  it('records key names but never values', () => {
    ingestExchange(exchange('{"secretField":"SENSITIVE_VALUE"}'));
    const attempt = lastTranscriptAttempt.value!;
    expect(attempt.topLevelKeys).toEqual(['secretField']);
    expect(JSON.stringify(attempt)).not.toContain('SENSITIVE_VALUE');
  });
});
