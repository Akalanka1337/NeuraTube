import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { isSameSurface, watchSurface } from '~/state/surfaceWatcher';
import { detectSurface } from '~/types/surface';
import type { SurfaceInfo } from '~/types/surface';

/**
 * YouTube is a single-page app, so the panel's correctness depends entirely on
 * noticing client-side navigation. A content script in the isolated world
 * cannot see the page's own history.pushState, hence the polling fallback these
 * tests exercise.
 */
describe('watchSurface', () => {
  const setHref = (href: string): void => {
    // happy-dom allows assigning location.href without a real navigation.
    window.location.href = href;
  };

  beforeEach(() => {
    vi.useFakeTimers();
    setHref('https://studio.youtube.com/video/PPGYNmrVG58/edit');
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('reports the initial surface synchronously', () => {
    const seen: SurfaceInfo[] = [];
    const watcher = watchSurface((info) => seen.push(info));

    // No timer advance: callers must be able to render on the first frame.
    expect(seen).toHaveLength(1);
    expect(seen[0]!.surface).toBe('studio-edit');

    watcher.stop();
  });

  it('detects a pushState navigation via the polling fallback', () => {
    const seen: SurfaceInfo[] = [];
    const watcher = watchSurface((info) => seen.push(info));

    setHref('https://www.youtube.com/watch?v=dQw4w9WgXcQ');
    vi.advanceTimersByTime(600);

    expect(seen).toHaveLength(2);
    expect(seen[1]!.surface).toBe('watch');
    expect(seen[1]!.videoId).toBe('dQw4w9WgXcQ');

    watcher.stop();
  });

  it('detects a popstate navigation without waiting for the poll', () => {
    const seen: SurfaceInfo[] = [];
    const watcher = watchSurface((info) => seen.push(info));

    setHref('https://www.youtube.com/results?search_query=mv3');
    window.dispatchEvent(new Event('popstate'));

    expect(seen).toHaveLength(2);
    expect(seen[1]!.surface).toBe('search');

    watcher.stop();
  });

  it('ignores URL churn that does not change the classification', () => {
    const seen: SurfaceInfo[] = [];
    const watcher = watchSurface((info) => seen.push(info));

    // Studio rewrites the URL for analytics tab and period changes on the same
    // video. Tearing the panel down for those would be user-visible churn.
    setHref('https://studio.youtube.com/video/PPGYNmrVG58/edit?tab=details');
    vi.advanceTimersByTime(600);
    setHref('https://studio.youtube.com/video/PPGYNmrVG58/subtitles');
    vi.advanceTimersByTime(600);

    expect(seen).toHaveLength(1);

    watcher.stop();
  });

  it('reports a change when only the video id changes', () => {
    const seen: SurfaceInfo[] = [];
    const watcher = watchSurface((info) => seen.push(info));

    setHref('https://studio.youtube.com/video/dQw4w9WgXcQ/edit');
    vi.advanceTimersByTime(600);

    expect(seen).toHaveLength(2);
    expect(seen[1]!.videoId).toBe('dQw4w9WgXcQ');

    watcher.stop();
  });

  it('exposes the current surface', () => {
    const watcher = watchSurface(() => undefined);
    expect(watcher.current.surface).toBe('studio-edit');

    setHref('https://www.youtube.com/watch?v=dQw4w9WgXcQ');
    vi.advanceTimersByTime(600);
    expect(watcher.current.surface).toBe('watch');

    watcher.stop();
  });

  it('stops polling after stop()', () => {
    const seen: SurfaceInfo[] = [];
    const watcher = watchSurface((info) => seen.push(info));
    watcher.stop();

    setHref('https://www.youtube.com/watch?v=dQw4w9WgXcQ');
    vi.advanceTimersByTime(5000);

    expect(seen).toHaveLength(1);
  });
});

describe('isSameSurface', () => {
  it('compares surface, video and channel identity', () => {
    const a = detectSurface('https://studio.youtube.com/video/PPGYNmrVG58/edit');
    const b = detectSurface('https://studio.youtube.com/video/PPGYNmrVG58/subtitles');
    const c = detectSurface('https://studio.youtube.com/video/dQw4w9WgXcQ/edit');

    expect(isSameSurface(a, b)).toBe(true);
    expect(isSameSurface(a, c)).toBe(false);
  });
});
