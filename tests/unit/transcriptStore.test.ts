import { describe, expect, it } from 'vitest';
import {
  cachedVideoIds,
  clearTranscripts,
  loadTranscript,
  saveTranscript,
} from '~/state/transcriptStore';
import type { TranscriptContext } from '~/parsers/captions';
import { chromeStub } from './setup';

function transcript(videoId: string, capturedAtMs = 1_000): TranscriptContext {
  return {
    videoId,
    language: 'en',
    segments: [
      { startMs: 0, durationMs: 2000, text: 'first line' },
      { startMs: 2000, durationMs: 2000, text: 'second line' },
    ],
    coverageMs: 4000,
    capturedAtMs,
  };
}

describe('transcript cache', () => {
  it('round-trips a transcript through storage.session', async () => {
    expect(await saveTranscript(transcript('abc'))).toBe(true);
    const loaded = await loadTranscript('abc');
    expect(loaded?.videoId).toBe('abc');
    expect(loaded?.segments).toHaveLength(2);
    expect(loaded?.coverageMs).toBe(4000);
  });

  it('keeps transcripts for several videos apart', async () => {
    await saveTranscript(transcript('one'));
    await saveTranscript(transcript('two'));

    expect((await loadTranscript('one'))?.segments[0]!.text).toBe('first line');
    expect(await loadTranscript('three')).toBeNull();
    expect([...(await cachedVideoIds())].sort()).toEqual(['one', 'two']);
  });

  /**
   * The correctness property that matters most. A transcript with no video id
   * cannot be attributed, and caching it under a blank key would let the next
   * video pick up someone else's timings and generate chapters for the wrong
   * content.
   */
  it('refuses to cache a transcript with no video id', async () => {
    expect(await saveTranscript(transcript(''))).toBe(false);
    expect(await cachedVideoIds()).toEqual([]);
  });

  it('returns null for an empty lookup rather than reading a blank key', async () => {
    expect(await loadTranscript('')).toBeNull();
  });

  it('evicts the oldest entries past the cap', async () => {
    // 14 videos against a cap of 12.
    for (let index = 0; index < 14; index += 1) {
      await saveTranscript(transcript(`video-${index}`, 1_000 + index));
    }

    const ids = await cachedVideoIds();
    expect(ids).toHaveLength(12);
    // The two oldest captures go.
    expect(ids).not.toContain('video-0');
    expect(ids).not.toContain('video-1');
    expect(ids).toContain('video-13');
  });

  it('clears everything on request', async () => {
    await saveTranscript(transcript('abc'));
    await clearTranscripts();
    expect(await cachedVideoIds()).toEqual([]);
  });

  it('leaves unrelated session keys alone when clearing', async () => {
    chromeStub().session.set('someone-elses-key', 'keep me');
    await saveTranscript(transcript('abc'));
    await clearTranscripts();
    expect(chromeStub().session.get('someone-elses-key')).toBe('keep me');
  });

  it.each([
    ['a non-object', 42],
    ['null', null],
    ['an array', []],
    ['no video id', { segments: [{ startMs: 0, text: 'x' }] }],
    ['no segments', { videoId: 'abc' }],
    ['empty segments', { videoId: 'abc', segments: [] }],
    ['segments that are all unusable', { videoId: 'abc', segments: [{ text: 'no start' }] }],
  ])('rejects %s found in storage', async (_label, value) => {
    chromeStub().session.set('neuratube:transcript:abc', value);
    expect(await loadTranscript('abc')).toBeNull();
  });

  it('never widens storage.session access to content scripts', async () => {
    // The content script goes through the worker on purpose. If this ever fails,
    // someone called setAccessLevel and broadened the trust boundary.
    await saveTranscript(transcript('abc'));
    await loadTranscript('abc');
    expect(chromeStub().sessionAccessLevel).toBeNull();
  });
});
