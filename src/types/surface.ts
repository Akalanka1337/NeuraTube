/**
 * URL surface detection.
 *
 * NeuraTube behaves differently on each YouTube surface, and the panel must
 * react to YouTube's client-side navigation without a reload. This module is a
 * pure function over a URL string so the whole matrix is unit-testable with no
 * DOM and no browser.
 */

/** The concrete page we are on. */
export type Surface =
  | 'studio-dashboard'
  | 'studio-edit'
  | 'studio-analytics'
  | 'studio-other'
  | 'watch'
  /**
   * `/shorts/<id>`.
   *
   * Its OWN surface rather than an alias for `watch`, for two reasons. The panel
   * stores position and visibility per surface, and Shorts is a full-height
   * vertical player where a panel placed for the watch page lands on top of the
   * video. And the two pages expose different things — a Short has no chapter
   * list and its comments live in a side drawer — so code that branches on the
   * surface can be honest about that instead of guessing.
   */
  | 'shorts'
  | 'search'
  | 'unsupported';

/** The panel's behavioural mode for a surface. */
export type PanelMode = 'channel' | 'edit' | 'analytics' | 'public' | 'research' | 'none';

export interface SurfaceInfo {
  readonly surface: Surface;
  readonly mode: PanelMode;
  /** 11-character YouTube video id, when the surface identifies one. */
  readonly videoId: string | null;
  /** UC-prefixed channel id, when the surface identifies one. */
  readonly channelId: string | null;
  /** Whether NeuraTube offers anything here. */
  readonly supported: boolean;
}

const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;
const CHANNEL_ID = /^UC[A-Za-z0-9_-]{22}$/;

/** Human-readable labels for the panel header. */
export const SURFACE_LABELS: Record<Surface, string> = {
  'studio-dashboard': 'Studio · Channel',
  'studio-edit': 'Studio · Video details',
  'studio-analytics': 'Studio · Analytics',
  'studio-other': 'Studio',
  watch: 'YouTube · Watch',
  shorts: 'YouTube · Shorts',
  search: 'YouTube · Search',
  unsupported: 'Unsupported page',
};

const UNSUPPORTED: SurfaceInfo = {
  surface: 'unsupported',
  mode: 'none',
  videoId: null,
  channelId: null,
  supported: false,
};

function asVideoId(value: string | undefined): string | null {
  return value && VIDEO_ID.test(value) ? value : null;
}

function asChannelId(value: string | undefined): string | null {
  return value && CHANNEL_ID.test(value) ? value : null;
}

/**
 * Classify a URL.
 *
 * Accepts anything; returns the `unsupported` surface for input we do not
 * handle rather than throwing, because this runs on every navigation event and
 * must never be able to break the page.
 */
export function detectSurface(href: string): SurfaceInfo {
  let url: URL;
  try {
    url = new URL(href);
  } catch {
    return UNSUPPORTED;
  }

  if (url.protocol !== 'https:') return UNSUPPORTED;

  const segments = url.pathname.split('/').filter(Boolean);

  if (url.hostname === 'studio.youtube.com') {
    // /video/{videoId}/edit
    // /video/{videoId}/analytics/{tab}/{period}
    if (segments[0] === 'video') {
      const videoId = asVideoId(segments[1]);
      const section = segments[2];
      if (section === 'analytics') {
        return {
          surface: 'studio-analytics',
          mode: 'analytics',
          videoId,
          channelId: null,
          supported: true,
        };
      }
      // Studio treats /video/{id}/edit and its sub-tabs (editor, comments,
      // subtitles) as the video-details surface.
      return { surface: 'studio-edit', mode: 'edit', videoId, channelId: null, supported: true };
    }

    // /channel/{channelId}/... — dashboard, content list, analytics, etc.
    if (segments[0] === 'channel') {
      return {
        surface: 'studio-dashboard',
        mode: 'channel',
        videoId: null,
        channelId: asChannelId(segments[1]),
        supported: true,
      };
    }

    // Studio root and everything else under it: we attach, but with no
    // video-specific context.
    return {
      surface: 'studio-other',
      mode: 'channel',
      videoId: null,
      channelId: null,
      supported: true,
    };
  }

  if (url.hostname === 'www.youtube.com') {
    /*
     * `/shorts/<videoId>`. Scrolling to the next Short rewrites this path with no
     * document load, which the surface watcher's poll picks up — and because the
     * video id is in the PATH rather than a query parameter, a Short that changes
     * is a surface change, so the per-video reset fires and the previous Short's
     * results are discarded.
     */
    if (url.pathname.startsWith('/shorts/')) {
      const segments = url.pathname.split('/').filter(Boolean);
      return {
        surface: 'shorts',
        mode: 'public',
        videoId: asVideoId(segments[1]),
        channelId: null,
        supported: true,
      };
    }

    if (url.pathname === '/watch') {
      return {
        surface: 'watch',
        mode: 'public',
        videoId: asVideoId(url.searchParams.get('v') ?? undefined),
        channelId: null,
        supported: true,
      };
    }

    if (url.pathname === '/results') {
      return {
        surface: 'search',
        mode: 'research',
        videoId: null,
        channelId: null,
        supported: true,
      };
    }

    return UNSUPPORTED;
  }

  return UNSUPPORTED;
}

/** Stable key for persisting per-surface panel layout. */
export function layoutKeyFor(info: SurfaceInfo): string {
  return info.surface;
}
