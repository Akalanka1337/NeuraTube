import { describe, expect, it } from 'vitest';
import { detectSurface, layoutKeyFor, SURFACE_LABELS } from '~/types/surface';
import { isSameSurface } from '~/state/surfaceWatcher';

/**
 * The surface matrix is the single input every other subsystem branches on, so
 * it is tested exhaustively including the malformed cases YouTube actually
 * produces (truncated ids, tracking parameters, trailing tab segments).
 */
describe('detectSurface', () => {
  it('classifies the Studio video edit page and extracts the video id', () => {
    const info = detectSurface('https://studio.youtube.com/video/tqygzPrAkjY/edit');
    expect(info.surface).toBe('studio-edit');
    expect(info.mode).toBe('edit');
    expect(info.videoId).toBe('tqygzPrAkjY');
    expect(info.supported).toBe(true);
  });

  it('treats Studio video sub-tabs as the edit surface', () => {
    for (const tail of ['edit', 'comments', 'subtitles', 'editor']) {
      const info = detectSurface(`https://studio.youtube.com/video/tqygzPrAkjY/${tail}`);
      expect(info.surface).toBe('studio-edit');
      expect(info.videoId).toBe('tqygzPrAkjY');
    }
  });

  it('classifies Studio video analytics, including the deep period path', () => {
    const info = detectSurface(
      'https://studio.youtube.com/video/tqygzPrAkjY/analytics/tab-overview/period-default',
    );
    expect(info.surface).toBe('studio-analytics');
    expect(info.mode).toBe('analytics');
    expect(info.videoId).toBe('tqygzPrAkjY');
  });

  it('classifies the channel dashboard and extracts a valid channel id', () => {
    const info = detectSurface(
      'https://studio.youtube.com/channel/UCuAXFkgsw1L7xaCfnd5JJOw/videos/upload',
    );
    expect(info.surface).toBe('studio-dashboard');
    expect(info.mode).toBe('channel');
    expect(info.channelId).toBe('UCuAXFkgsw1L7xaCfnd5JJOw');
  });

  it('falls back to studio-other for unrecognised Studio paths', () => {
    const info = detectSurface('https://studio.youtube.com/');
    expect(info.surface).toBe('studio-other');
    expect(info.supported).toBe(true);
    expect(info.videoId).toBeNull();
  });

  it('classifies a public watch page and ignores tracking parameters', () => {
    const info = detectSurface(
      'https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=42s&list=PLabc&feature=share',
    );
    expect(info.surface).toBe('watch');
    expect(info.mode).toBe('public');
    expect(info.videoId).toBe('dQw4w9WgXcQ');
  });

  it('classifies search results', () => {
    const info = detectSurface('https://www.youtube.com/results?search_query=mv3+extension');
    expect(info.surface).toBe('search');
    expect(info.mode).toBe('research');
  });

  it('rejects ids that are not exactly 11 valid characters', () => {
    expect(detectSurface('https://studio.youtube.com/video/short/edit').videoId).toBeNull();
    expect(detectSurface('https://www.youtube.com/watch?v=tooooooooolong').videoId).toBeNull();
    expect(detectSurface('https://www.youtube.com/watch?v=bad!chars!!').videoId).toBeNull();
    // Surface is still recognised — a malformed id must not break the panel.
    expect(detectSurface('https://studio.youtube.com/video/short/edit').surface).toBe(
      'studio-edit',
    );
  });

  it('rejects malformed channel ids without dropping the surface', () => {
    const info = detectSurface('https://studio.youtube.com/channel/notachannelid');
    expect(info.surface).toBe('studio-dashboard');
    expect(info.channelId).toBeNull();
  });

  it('does not attach to unrelated YouTube pages or other origins', () => {
    for (const href of [
      'https://www.youtube.com/',
      'https://www.youtube.com/feed/subscriptions',
      'https://m.youtube.com/watch?v=dQw4w9WgXcQ',
      'https://evil.example.com/watch?v=dQw4w9WgXcQ',
      'http://studio.youtube.com/video/tqygzPrAkjY/edit',
    ]) {
      expect(detectSurface(href).supported, href).toBe(false);
    }
  });

  it('never throws on garbage input', () => {
    for (const href of ['', 'not a url', 'javascript:alert(1)', '//studio.youtube.com']) {
      expect(() => detectSurface(href)).not.toThrow();
      expect(detectSurface(href).surface).toBe('unsupported');
    }
  });

  it('has a label for every surface it can return', () => {
    const surfaces = new Set(
      [
        'https://studio.youtube.com/video/tqygzPrAkjY/edit',
        'https://studio.youtube.com/video/tqygzPrAkjY/analytics/tab-overview',
        'https://studio.youtube.com/channel/UCuAXFkgsw1L7xaCfnd5JJOw',
        'https://studio.youtube.com/',
        'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
        'https://www.youtube.com/results?search_query=x',
        'https://example.com',
      ].map((href) => detectSurface(href).surface),
    );
    for (const surface of surfaces) {
      expect(SURFACE_LABELS[surface]).toBeTruthy();
    }
  });

  it('derives a stable layout key per surface', () => {
    const a = detectSurface('https://studio.youtube.com/video/tqygzPrAkjY/edit');
    const b = detectSurface('https://studio.youtube.com/video/dQw4w9WgXcQ/edit');
    // Layout is remembered per surface, not per video.
    expect(layoutKeyFor(a)).toBe(layoutKeyFor(b));
  });
});

describe('shorts surface', () => {
  it.each([
    ['https://www.youtube.com/shorts/TenGLiqgD50', 'TenGLiqgD50'],
    ['https://www.youtube.com/shorts/TenGLiqgD50?feature=share', 'TenGLiqgD50'],
  ])('detects %s', (href, videoId) => {
    const info = detectSurface(href);
    expect(info.surface).toBe('shorts');
    expect(info.videoId).toBe(videoId);
    expect(info.supported).toBe(true);
    expect(info.mode).toBe('public');
  });

  /**
   * The reported symptom: the panel read the video correctly but said
   * "Unsupported page / none on this page", because the id is in the PATH here
   * rather than in a `v=` query parameter.
   */
  it('no longer reports a Short as unsupported with no video', () => {
    const info = detectSurface('https://www.youtube.com/shorts/TenGLiqgD50');
    expect(info.surface).not.toBe('unsupported');
    expect(info.videoId).not.toBeNull();
  });

  it('has its own label, since it is a different page', () => {
    expect(SURFACE_LABELS.shorts).toBe('YouTube · Shorts');
    expect(SURFACE_LABELS.shorts).not.toBe(SURFACE_LABELS.watch);
  });

  it('treats a different Short as a different surface, so state resets', () => {
    const first = detectSurface('https://www.youtube.com/shorts/TenGLiqgD50');
    const second = detectSurface('https://www.youtube.com/shorts/Xo8bwzAFhSw');
    expect(isSameSurface(first, second)).toBe(false);
  });

  it('does not mistake the shorts shelf on the home page for a Short', () => {
    expect(detectSurface('https://www.youtube.com/shorts').surface).not.toBe('shorts');
  });
});
