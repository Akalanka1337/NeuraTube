import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseTimedTextResponse, parseTimedTextUrl } from '~/parsers/timedText';
import { hashtagsIn, parseWatchPageData } from '~/parsers/watchVideo';
import { renderTimedTranscript } from '~/parsers/captions';
import { parseCount, timestampToSeconds } from '~/panel/watchDom';

const DIR = path.join(import.meta.dirname, '../fixtures');
const TIMEDTEXT = readFileSync(path.join(DIR, 'timedtext_json3.json'), 'utf8');
const PAGE_DATA = readFileSync(path.join(DIR, 'watch_page_data.json'), 'utf8');

/** A real signed URL, with the credential values replaced by placeholders. */
const URL_WITH_GRANT =
  'https://www.youtube.com/api/timedtext?v=Xo8bwzAFhSw&caps=asr&lang=en' +
  '&signature=SIGVALUE.SIGVALUE2&pot=POTVALUE&key=yt8&expire=1788047716&fmt=json3';

describe('parseTimedTextUrl', () => {
  it('reads the video id and language', () => {
    expect(parseTimedTextUrl(URL_WITH_GRANT)).toEqual({ videoId: 'Xo8bwzAFhSw', language: 'en' });
  });

  it('accepts a path-only URL, since that is what a relative fetch reports', () => {
    expect(parseTimedTextUrl('/api/timedtext?v=abc&lang=si')?.videoId).toBe('abc');
  });

  it('defaults an absent language', () => {
    expect(parseTimedTextUrl('/api/timedtext?v=abc')?.language).toBe('unknown');
  });

  it.each([
    ['no video id', '/api/timedtext?lang=en'],
    ['an empty video id', '/api/timedtext?v=&lang=en'],
    ['not a URL', '::::'],
  ])('returns null for %s', (_label, url) => {
    expect(parseTimedTextUrl(url)).toBeNull();
  });

  /** The URL is a signed, expiring grant. None of it may be extracted. */
  it('extracts nothing but the video id and language', () => {
    const parsed = parseTimedTextUrl(URL_WITH_GRANT);
    expect(Object.keys(parsed ?? {}).sort()).toEqual(['language', 'videoId']);
    const serialised = JSON.stringify(parsed);
    expect(serialised).not.toContain('SIGVALUE');
    expect(serialised).not.toContain('POTVALUE');
  });
});

describe('parseTimedTextResponse', () => {
  const result = parseTimedTextResponse(TIMEDTEXT, URL_WITH_GRANT);
  const transcript = result.transcript!;

  it('parses the caption events', () => {
    expect(transcript.segments).toHaveLength(5);
    expect(result.drift.severity).toBe('none');
  });

  it('skips the preamble event that has no segs', () => {
    // The first event in the fixture has tStartMs 0 and no segs at all.
    expect(transcript.segments[0]!.startMs).toBe(480);
  });

  it('skips newline-only spacer events', () => {
    expect(transcript.segments.some((segment) => segment.startMs === 313_000)).toBe(false);
  });

  it('reads numeric offsets, which differ from Studio strings', () => {
    const first = transcript.segments[0]!;
    expect(first.startMs).toBe(480);
    expect(first.durationMs).toBe(5760);
  });

  it('collapses caption line wrapping', () => {
    expect(transcript.segments[0]!.text).toBe(
      'Look at this blurry video. And now look at it after AI enhancement.',
    );
  });

  it('joins a multi-part segs array into one segment', () => {
    const split = JSON.stringify({
      events: [{ tStartMs: 0, dDurationMs: 1000, segs: [{ utf8: 'one ' }, { utf8: 'two' }] }],
    });
    const parsed = parseTimedTextResponse(split, '/api/timedtext?v=a').transcript!;
    expect(parsed.segments).toHaveLength(1);
    expect(parsed.segments[0]!.text).toBe('one two');
  });

  it('attributes the transcript to the video in the URL', () => {
    expect(transcript.videoId).toBe('Xo8bwzAFhSw');
    expect(transcript.language).toBe('en');
  });

  it('computes coverage from the last real segment', () => {
    expect(transcript.coverageMs).toBe(312_080);
  });

  it('sorts out-of-order events', () => {
    const shuffled = JSON.stringify({
      events: [
        { tStartMs: 9000, dDurationMs: 1, segs: [{ utf8: 'third' }] },
        { tStartMs: 0, dDurationMs: 1, segs: [{ utf8: 'first' }] },
      ],
    });
    const parsed = parseTimedTextResponse(shuffled, '/api/timedtext?v=a').transcript!;
    expect(parsed.segments.map((s) => s.text)).toEqual(['first', 'third']);
  });

  it('renders with real timestamps for the prompt', () => {
    const lines = renderTimedTranscript(transcript).split('\n');
    expect(lines[0]).toBe(
      '[0:00] Look at this blurry video. And now look at it after AI enhancement.',
    );
    expect(lines.at(-1)).toContain('[5:06]');
  });

  it.each([
    ['an empty body', ''],
    ['XML instead of json3', '<?xml version="1.0"?><transcript></transcript>'],
  ])('reports %s as drift without throwing', (_label, body) => {
    const parsed = parseTimedTextResponse(body, URL_WITH_GRANT);
    expect(parsed.transcript).toBeNull();
    expect(parsed.drift.severity).toBe('broken');
  });

  it('reports a renamed events array as missing', () => {
    const parsed = parseTimedTextResponse('{"captions":[]}', URL_WITH_GRANT);
    expect(parsed.transcript).toBeNull();
    expect(parsed.drift.missingFields).toContain('events');
  });
});

describe('parseWatchPageData', () => {
  const result = parseWatchPageData(PAGE_DATA);
  const video = result.video!;

  /** The whole reason this reads a page global instead of the DOM. */
  it('exposes the tags, which are rendered nowhere in the page', () => {
    expect(video.tags).toEqual([
      'videoproc converter ai',
      'upscale video to 4k',
      'ai video enhancer',
      'frame interpolation',
    ]);
  });

  it('reads the untruncated description', () => {
    // The DOM shows this cut off with an ellipsis; the page global has it whole.
    expect(video.description).toContain('#UpscaleVideo');
    expect(video.description).not.toContain('…');
  });

  it('coerces the string-typed duration and view count', () => {
    expect(video.durationSec).toBe(317);
    expect(video.viewCount).toBe(1443);
  });

  it('reads the channel and its title', () => {
    expect(video.channelTitle).toBe('Akalanka Ekanayake');
    expect(video.channelId).toBe('UC_REDACTED_CHANNEL_ID_0000');
  });

  it('parses the publish date', () => {
    expect(video.publishedAtMs).toBe(Date.parse('2026-07-15'));
  });

  it('extracts description hashtags', () => {
    expect(video.descriptionHashtags).toContain('#UpscaleVideo');
  });

  /**
   * The correctness property that protects the guardrail engine. A public page
   * cannot see made-for-kids or paid promotion, so `false` means "unknown" — and
   * `source` is how a consumer tells the difference.
   */
  it('marks itself as a public source, so absences are not read as facts', () => {
    expect(video.source).toBe('public');
    expect(video.madeForKids).toBe(false);
    expect(video.paidPromotion).toBe(false);
  });

  it('prefers DOM extras when supplied', () => {
    const withExtras = parseWatchPageData(PAGE_DATA, {
      viewCountExact: 1_443_999,
      subscriberText: '1.92M subscribers',
      chapters: [{ label: 'Intro', startSec: 0 }],
    }).video!;
    expect(withExtras.viewCount).toBe(1_443_999);
    expect(withExtras.subscriberText).toBe('1.92M subscribers');
    expect(withExtras.chapters).toHaveLength(1);
  });

  it('survives a video with no keywords', () => {
    const parsed = parseWatchPageData(JSON.stringify({ videoId: 'abc', keywords: [] })).video!;
    expect(parsed.tags).toEqual([]);
    // NOT drift: plenty of videos have no tags, and flagging it would cry wolf.
    expect(parseWatchPageData(JSON.stringify({ videoId: 'abc' })).drift.severity).toBe('none');
  });

  it.each([
    ['an empty payload', ''],
    ['invalid JSON', '<html>'],
    ['no video id', '{"title":"x"}'],
  ])('reports %s as fatal without throwing', (_label, body) => {
    const parsed = parseWatchPageData(body);
    expect(parsed.video).toBeNull();
    expect(parsed.drift.severity).toBe('broken');
  });
});

describe('hashtagsIn', () => {
  it('finds tags and dedupes', () => {
    expect(hashtagsIn('#AI and #ai and #tutorial')).toEqual(['#AI', '#ai', '#tutorial']);
  });

  it('handles non-ASCII tags', () => {
    expect(hashtagsIn('#තාක්ෂණය')).toEqual(['#තාක්ෂණය']);
  });

  it('ignores a bare hash and single characters', () => {
    expect(hashtagsIn('# and #a')).toEqual([]);
  });
});

describe('parseCount', () => {
  it.each([
    ['1,443', 1443],
    ['1.4K', 1400],
    ['1.92M', 1_920_000],
    ['2', 2],
    ['13 likes', 13],
    ['1 reply', 1],
    ['3.5B', 3_500_000_000],
  ])('parses %s', (label, expected) => {
    expect(parseCount(label)).toBe(expected);
  });

  /**
   * The distinction that matters. Without a suffix the separators are thousands
   * groupings, so treating the dot as a decimal point turns 1,443 into 1.4.
   */
  it('does not read a thousands separator as a decimal point', () => {
    expect(parseCount('1,443')).toBe(1443);
    expect(parseCount('1.443')).toBe(1443);
  });

  it('returns null rather than guessing at an unfamiliar shape', () => {
    expect(parseCount('no numbers here')).toBeNull();
    expect(parseCount('')).toBeNull();
  });
});

describe('timestampToSeconds', () => {
  it.each([
    ['0:00', 0],
    ['0:26', 26],
    ['1:06', 66],
    ['2:31', 151],
    ['1:02:05', 3725],
  ])('parses %s', (label, expected) => {
    expect(timestampToSeconds(label)).toBe(expected);
  });

  it.each(['', '12', 'abc', '1:2:3:4', '-1:00'])('rejects %s', (label) => {
    expect(timestampToSeconds(label)).toBeNull();
  });
});
