import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseCreatorVideosResponse } from '~/parsers/creatorVideos';
import { bestThumbnail, hasExperimentData, publishedDate } from '~/types/VideoContext';

const FIXTURE = readFileSync(
  path.join(import.meta.dirname, '../fixtures/get_creator_videos.json'),
  'utf8',
);

/**
 * The fixture is synthesised from the schema documented in the project brief,
 * not from a live capture. Its `_fixture.asserts` block records the counts these
 * tests depend on, so swapping in a redacted real capture makes any mismatch
 * obvious rather than mysterious.
 */
describe('parseCreatorVideosResponse — against the documented schema', () => {
  const result = parseCreatorVideosResponse(FIXTURE);
  const video = result.videos[0]!;

  it('parses both videos in the batch', () => {
    expect(result.videos).toHaveLength(2);
  });

  it('reports no schema drift against the documented shape', () => {
    expect(result.drift.severity).toBe('none');
    expect(result.drift.missingFields).toEqual([]);
    expect(result.drift.unmappedEnums).toEqual([]);
    expect(result.drift.parsedCount).toBe(2);
  });

  it('extracts identity and text', () => {
    expect(video.videoId).toBe('tqygzPrAkjY');
    expect(video.title).toBe('Build an AI Agent in 12 Minutes (Full Tutorial)');
    expect(video.description).toContain('0:00 Intro');
    expect(video.channelId).toBe('UCuAXFkgsw1L7xaCfnd5JJOw');
    expect(video.shareUrl).toBe('https://youtu.be/tqygzPrAkjY');
    expect(video.originalFilename).toBe('FlovaAI-Tutorial.mov');
  });

  it('extracts all 11 tags from the {value} wire shape', () => {
    expect(video.tags).toHaveLength(11);
    expect(video.tags[0]).toBe('ai agent');
    expect(video.tags).toContain('software engineering');
    // No holes: a naive `.map(t => t.value)` over mixed entries yields undefined.
    expect(video.tags.every((tag) => typeof tag === 'string' && tag.length > 0)).toBe(true);
  });

  it("extracts all 5 of YouTube's suggested hashtags and normalises the leading #", () => {
    expect(video.suggestedHashtags).toHaveLength(5);
    // The fixture mixes bare and #-prefixed values, as the live wire format does.
    expect(video.suggestedHashtags).toEqual([
      '#aiagents',
      '#coding',
      '#machinelearning',
      '#programming',
      '#tutorial',
    ]);
  });

  it('extracts hashtags already inline in the description', () => {
    expect(video.descriptionHashtags).toEqual(['#aiagents', '#coding', '#tutorial']);
  });

  it('parses the A/B test arms with watch-time fractions', () => {
    expect(video.abTest.state).toBe('finished');
    expect(video.abTest.result).toBe('winner');
    expect(video.abTest.arms).toHaveLength(2);
    expect(video.abTest.arms[0]).toEqual({ index: 0, watchtimeFraction: 0.5814 });
    expect(video.abTest.arms[1]).toEqual({ index: 1, watchtimeFraction: 0.4186 });
    expect(hasExperimentData(video)).toBe(true);
  });

  it('parses duration from the string field', () => {
    expect(video.durationSec).toBe(742);
  });

  it('parses the publish timestamp as unix milliseconds, not a Date', () => {
    // A Date would not survive chrome.runtime messaging, which serialises as
    // JSON rather than structured clone.
    expect(typeof video.publishedAtMs).toBe('number');
    expect(publishedDate(video)?.toISOString().slice(0, 10)).toBe('2025-08-19');
  });

  it('maps the enums to friendly values and keeps the raw one', () => {
    expect(video.category).toBe('Education');
    expect(video.categoryRaw).toBe('CREATOR_VIDEO_CATEGORY_EDUCATION');
    expect(video.privacy).toBe('public');
    expect(video.status).toBe('processed');
    expect(video.metadataLanguage).toBe('en');
    expect(video.license).toBe('STANDARD_YOUTUBE_LICENSE');
  });

  it('parses the guardrail-relevant flags the AI layer depends on', () => {
    expect(video.madeForKids).toBe(false);
    expect(video.paidPromotion).toBe(false);
    expect(video.alteredContent).toBe('no');
    expect(video.ageRestricted).toBe(false);
    expect(video.allowEmbed).toBe(true);
    expect(video.allowRatings).toBe(true);
  });

  it('parses copyright state, treating a claim with no impact as no impact', () => {
    expect(video.copyright.activeClaimCount).toBe(1);
    expect(video.copyright.hasImpact).toBe(false);
  });

  it('parses monetization state', () => {
    expect(video.monetization.effectiveStatus).toBe('AD_MONETIZATION_STATUS_ON');
    expect(video.monetization.selfCertDecision).toBe('SELF_CERT_DECISION_APPROVED');
  });

  it('parses all 6 thumbnails and finds the largest', () => {
    expect(video.thumbnails).toHaveLength(6);
    expect(bestThumbnail(video)).toEqual({
      url: 'https://i.ytimg.com/vi/tqygzPrAkjY/maxres2.jpg',
      width: 1920,
      height: 1080,
    });
  });

  it('produces a model that survives a JSON round-trip unchanged', () => {
    // THE INVARIANT THIS PINS: VideoContext crosses `chrome.runtime` messaging,
    // which serialises as JSON — not structured clone. A `Date` field therefore
    // arrives at the service worker as a string, and any `.toISOString()` call
    // on it throws. That shipped as a real bug in M3 (publishedAt was a Date)
    // and was only caught by an end-to-end run.
    //
    // Any field type that does not survive this assertion is unusable in this
    // model, whatever it looks like locally.
    const roundTripped = JSON.parse(JSON.stringify(video)) as typeof video;
    expect(roundTripped).toEqual(video);
  });

  it('never carries videoStreamUrl into the model', () => {
    // The fixture deliberately includes it. A googlevideo URL is protected by
    // YouTube's rolling cipher, which a Feb 2026 N.D. Cal. ruling held is a DMCA
    // 1201 technological protection measure. It has no feature value here, so
    // carrying it would be pure liability. See README, "Retained risk".
    expect(FIXTURE).toContain('videoStreamUrl');
    expect(JSON.stringify(video)).not.toContain('googlevideo');
    expect(Object.keys(video)).not.toContain('videoStreamUrl');
  });

  it('parses the sparse second video without inventing data', () => {
    const sparse = result.videos[1]!;
    expect(sparse.videoId).toBe('dQw4w9WgXcQ');
    expect(sparse.tags).toEqual([]);
    expect(sparse.suggestedHashtags).toEqual([]);
    expect(sparse.thumbnails).toEqual([]);
    expect(sparse.privacy).toBe('unlisted');
    expect(sparse.status).toBe('processing');
    // Guardrails that will change AI behaviour in M5.
    expect(sparse.madeForKids).toBe(true);
    expect(sparse.paidPromotion).toBe(true);
    expect(sparse.abTest.state).toBe('none');
    expect(hasExperimentData(sparse)).toBe(false);
  });
});

/**
 * Live data is messier than any captured sample. These are the specific ways the
 * brief's reference parser breaks on it.
 */
describe('parseCreatorVideosResponse — hostile and malformed input', () => {
  it('never produces NaN from a non-numeric duration', () => {
    // The brief does `Number(v.lengthSeconds ?? 0)`, which yields NaN here and
    // renders as "NaN" in the UI.
    const body = JSON.stringify({ videos: [{ videoId: 'aaaaaaaaaaa', lengthSeconds: '12a' }] });
    const video = parseCreatorVideosResponse(body).videos[0]!;
    expect(Number.isNaN(video.durationSec)).toBe(false);
    expect(video.durationSec).toBe(0);
  });

  it('falls back to videoDurationMs when lengthSeconds is absent', () => {
    const body = JSON.stringify({ videos: [{ videoId: 'aaaaaaaaaaa', videoDurationMs: 742183 }] });
    expect(parseCreatorVideosResponse(body).videos[0]!.durationSec).toBe(742);
  });

  it('drops malformed tag entries instead of emitting undefined into a prompt', () => {
    const body = JSON.stringify({
      videos: [
        {
          videoId: 'aaaaaaaaaaa',
          // Every shape live data has actually produced.
          tags: [{ value: 'good' }, 'bare string', { value: '' }, { value: null }, null, 42, {}],
        },
      ],
    });
    const video = parseCreatorVideosResponse(body).videos[0]!;
    expect(video.tags).toEqual(['good', 'bare string']);
  });

  it('rejects an implausible publish timestamp rather than showing a 1970 date', () => {
    for (const value of [0, -1, 'not a number', 99999999999999]) {
      const body = JSON.stringify({
        videos: [{ videoId: 'aaaaaaaaaaa', timePublishedSeconds: value }],
      });
      expect(parseCreatorVideosResponse(body).videos[0]!.publishedAtMs, String(value)).toBeNull();
    }
  });

  it('clamps a watch-time fraction outside 0..1', () => {
    const body = JSON.stringify({
      videos: [
        {
          videoId: 'aaaaaaaaaaa',
          videoCreatorExperiment: {
            result: {
              experimentState: 'CREATOR_EXPERIMENT_STATE_RUNNING',
              armResults: [{ watchtimeFraction: 1.4 }, { watchtimeFraction: -0.2 }, {}],
            },
          },
        },
      ],
    });
    const arms = parseCreatorVideosResponse(body).videos[0]!.abTest.arms;
    expect(arms.map((arm) => arm.watchtimeFraction)).toEqual([1, 0, 0]);
  });

  it('skips entries with no videoId and records it as drift', () => {
    const body = JSON.stringify({ videos: [{ title: 'orphan' }, { videoId: 'aaaaaaaaaaa' }] });
    const result = parseCreatorVideosResponse(body);
    expect(result.videos).toHaveLength(1);
    expect(result.drift.missingFields).toContain('videoId');
    // One entry parsed, so this is partial rather than broken.
    expect(result.drift.severity).toBe('major');
  });

  it('reports an unmapped category but still shows the raw value', () => {
    const body = JSON.stringify({
      videos: [
        {
          videoId: 'aaaaaaaaaaa',
          // A realistic entry, so the assertion isolates the unknown enum
          // rather than also tripping the missing-field checks.
          title: 'Something',
          description: '',
          thumbnailDetails: { thumbnails: [] },
          category: 'CREATOR_VIDEO_CATEGORY_INTERPRETIVE_DANCE',
        },
      ],
    });
    const result = parseCreatorVideosResponse(body);
    expect(result.videos[0]!.category).toBe('CREATOR_VIDEO_CATEGORY_INTERPRETIVE_DANCE');
    expect(result.drift.severity).toBe('minor');
    expect(result.drift.unmappedEnums).toEqual([
      { field: 'category', value: 'CREATOR_VIDEO_CATEGORY_INTERPRETIVE_DANCE' },
    ]);
  });

  it('reports the videos key disappearing as broken, which is how going blind looks', () => {
    // If Studio moves InnerTube into a Web Worker, the MAIN-world patch stops
    // seeing responses and this is the shape of the failure.
    const result = parseCreatorVideosResponse(JSON.stringify({ responseContext: {} }));
    expect(result.videos).toEqual([]);
    expect(result.drift.severity).toBe('broken');
    expect(result.drift.missingFields).toContain('videos');
    expect(result.drift.summary).toContain('update');
  });

  it('never throws on any malformed body', () => {
    for (const body of [
      '',
      '   ',
      'not json',
      '{',
      'null',
      '[]',
      '"a string"',
      '42',
      '{"videos":null}',
      '{"videos":"nope"}',
      '{"videos":[null,42,"x",[]]}',
    ]) {
      expect(() => parseCreatorVideosResponse(body), body).not.toThrow();
      const result = parseCreatorVideosResponse(body);
      expect(result.videos, body).toEqual([]);
      expect(result.drift.severity, body).not.toBe('none');
    }
  });

  it('does not let a prototype-polluting payload through', () => {
    const body = '{"videos":[{"videoId":"aaaaaaaaaaa","__proto__":{"polluted":true}}]}';
    expect(() => parseCreatorVideosResponse(body)).not.toThrow();
    expect((Object.prototype as unknown as Record<string, unknown>).polluted).toBeUndefined();
  });
});
