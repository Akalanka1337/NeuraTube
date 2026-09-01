import { describe, expect, it } from 'vitest';
import { NEURATUBE_ROUTES, classifyRoute, isCreatorRoute } from '~/intercept/routes';

/**
 * `classifyRoute` runs on every XHR and every fetch the page makes — hundreds
 * per Studio session, inside YouTube's own call stack. Correctness on the miss
 * path matters as much as on the hit path.
 */
describe('classifyRoute', () => {
  it('classifies the primary creator endpoint with query parameters attached', () => {
    expect(
      classifyRoute('https://studio.youtube.com/youtubei/v1/creator/get_creator_videos?alt=json'),
    ).toBe('CREATOR_VIDEOS');
  });

  it('classifies every documented route', () => {
    for (const [fragment, kind] of Object.entries(NEURATUBE_ROUTES)) {
      expect(classifyRoute(`https://studio.youtube.com${fragment}?key=abc`), fragment).toBe(kind);
    }
  });

  it('matches on a relative URL, which is how Studio issues most requests', () => {
    expect(classifyRoute('/youtubei/v1/creator/edit_video?alt=json')).toBe('CREATOR_EDIT_VIDEO');
  });

  it('does not confuse /player with the creator routes', () => {
    expect(classifyRoute('/youtubei/v1/player?key=x')).toBe('PUBLIC_PLAYER');
    expect(classifyRoute('/youtubei/v1/next')).toBe('PUBLIC_NEXT');
  });

  it('returns null for the traffic that makes up most of a YouTube page', () => {
    for (const url of [
      'https://i.ytimg.com/vi/abc/maxresdefault.jpg',
      'https://rr3---sn-x.googlevideo.com/videoplayback?expire=1',
      'https://www.youtube.com/youtubei/v1/log_event?alt=json',
      'https://www.google-analytics.com/collect',
      'https://studio.youtube.com/static/app.js',
      '/youtubei/v2/creator/get_creator_videos',
      '',
    ]) {
      expect(classifyRoute(url), url).toBeNull();
    }
  });

  it('never throws, whatever it is handed', () => {
    for (const url of ['', '///', 'not a url', '/youtubei/v1/', ' ']) {
      expect(() => classifyRoute(url)).not.toThrow();
    }
  });

  it('separates creator-owned routes from public ones', () => {
    expect(isCreatorRoute('CREATOR_VIDEOS')).toBe(true);
    expect(isCreatorRoute('CREATOR_ANALYTICS')).toBe(true);
    expect(isCreatorRoute('PUBLIC_PLAYER')).toBe(false);
    expect(isCreatorRoute('PUBLIC_SEARCH')).toBe(false);
  });
});
