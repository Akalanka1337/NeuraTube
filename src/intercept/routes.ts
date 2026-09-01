/**
 * https://github.com/Akalanka1337/NeuraTube
 * 
 * InnerTube route classification.
 *
 * YouTube and YouTube Studio talk to `/youtubei/v1/*`. This module decides which
 * of those responses NeuraTube cares about, and it is the only place that
 * knowledge lives.
 *
 * Two properties matter for a module that runs in the page's own JS heap on
 * every single request:
 *
 *  - It must be fast. `classify` runs on every XHR and every fetch the page
 *    makes, which on Studio is hundreds per session. It is a substring scan
 *    over a short table, no regex, no allocation on the miss path.
 *  - It must be dependency-free. Nothing here may touch `chrome.*` — the MAIN
 *    world has no extension APIs at all.
 */

/** Response kinds NeuraTube consumes. */
export type RouteKind =
  | 'CREATOR_VIDEOS'
  | 'CREATOR_LIST'
  | 'CREATOR_EDIT_VIDEO'
  | 'CREATOR_CHANNEL'
  | 'CREATOR_ANALYTICS'
  | 'CREATOR_CAPTIONS_TIMINGS'
  | 'CREATOR_VIDEO_TRANSLATIONS'
  | 'CREATOR_CAPTIONS_TRANSLATION'
  | 'CREATOR_CREATE_CAPTIONS'
  | 'PUBLIC_TIMEDTEXT'
  /**
   * Synthetic. Not a network route — YouTube's own `ytInitialPlayerResponse`
   * global, read from the MAIN world and emitted through the same pipeline. It is
   * the only source of a public video's TAGS and of its untruncated description.
   * See intercept/pageData.ts.
   */
  | 'PUBLIC_PAGE_DATA'
  | 'PUBLIC_PLAYER'
  | 'PUBLIC_NEXT'
  | 'PUBLIC_TRANSCRIPT'
  | 'PUBLIC_SEARCH';

/**
 * Path fragment to route kind.
 *
 * Matched as a substring of the request URL, because Studio appends query
 * parameters (`?alt=json&key=…`) and occasionally prefixes locale segments.
 */
export const NEURATUBE_ROUTES: Readonly<Record<string, RouteKind>> = Object.freeze({
  '/youtubei/v1/creator/get_creator_videos': 'CREATOR_VIDEOS',
  '/youtubei/v1/creator/list_creator_videos': 'CREATOR_LIST',
  '/youtubei/v1/creator/edit_video': 'CREATOR_EDIT_VIDEO',
  '/youtubei/v1/creator/get_creator_channel': 'CREATOR_CHANNEL',
  '/youtubei/v1/creator/get_creator_video_analytics': 'CREATOR_ANALYTICS',
  /*
   * The four requests Studio's subtitles editor fires, in observed order.
   *
   * get_captions_translation is THE transcript source — full track with real
   * timings. get_captions_timings, despite its name, returns only
   * `{responseContext, nextRequestDelay}`: an acknowledgement, no segments. It is
   * still classified so it shows up in diagnostics, but it is NOT parsed, because
   * treating it as a source made the panel report a schema mismatch on every
   * real page. See parsers/captions.ts for the measurement.
   */
  '/youtubei/v1/globalization/create_captions': 'CREATOR_CREATE_CAPTIONS',
  '/youtubei/v1/globalization/get_video_translations': 'CREATOR_VIDEO_TRANSLATIONS',
  '/youtubei/v1/globalization/get_captions_timings': 'CREATOR_CAPTIONS_TIMINGS',
  '/youtubei/v1/globalization/get_captions_translation': 'CREATOR_CAPTIONS_TRANSLATION',
  /**
   * The PUBLIC caption track. Unlike Studio's, this one exists for any public
   * video with captions and needs no editor open — which is what makes a
   * transcript available for videos the user does not own.
   */
  '/api/timedtext': 'PUBLIC_TIMEDTEXT',
  '/youtubei/v1/player': 'PUBLIC_PLAYER',
  '/youtubei/v1/next': 'PUBLIC_NEXT',
  '/youtubei/v1/get_transcript': 'PUBLIC_TRANSCRIPT',
  '/youtubei/v1/search': 'PUBLIC_SEARCH',
});

/**
 * Entries pre-extracted to an array.
 *
 * `Object.entries` allocates on every call; hoisting it out keeps `classify`
 * allocation-free on the hot path.
 */
const ROUTE_ENTRIES: readonly (readonly [string, RouteKind])[] = Object.entries(NEURATUBE_ROUTES);

/**
 * Cheap pre-filter.
 *
 * Every route we care about contains this fragment, so one `includes` rejects
 * the overwhelming majority of the page's requests (thumbnails, video segments,
 * logging beacons) before we scan the table.
 */
const INNERTUBE_PREFIX = '/youtubei/v1/';

/**
 * Classify a request URL, or `null` if NeuraTube does not want it.
 *
 * Ordering caveat: `/youtubei/v1/player` is a substring-safe match because no
 * other route in the table contains it. If a future route does (say
 * `/youtubei/v1/player_params`), the more specific entry must be listed first
 * and `classifyRoute` must keep its first-match-wins behaviour.
 */
/** The one route NeuraTube consumes that is not an InnerTube endpoint. */
const TIMEDTEXT_PREFIX = '/api/timedtext';

export function classifyRoute(url: string): RouteKind | null {
  // Two substring scans on the miss path instead of one, because the public
  // caption track does NOT live under /youtubei/. Still allocation-free, still
  // rejects the overwhelming majority of a page's requests on the first check.
  if (!url.includes(INNERTUBE_PREFIX) && !url.includes(TIMEDTEXT_PREFIX)) return null;

  for (const [fragment, kind] of ROUTE_ENTRIES) {
    if (url.includes(fragment)) return kind;
  }
  return null;
}

/** Kinds that carry creator-owned data, i.e. require an authenticated Studio session. */
const CREATOR_KINDS: ReadonlySet<RouteKind> = new Set<RouteKind>([
  'CREATOR_VIDEOS',
  'CREATOR_LIST',
  'CREATOR_EDIT_VIDEO',
  'CREATOR_CHANNEL',
  'CREATOR_ANALYTICS',
  'CREATOR_CAPTIONS_TIMINGS',
  'CREATOR_VIDEO_TRANSLATIONS',
  'CREATOR_CAPTIONS_TRANSLATION',
  'CREATOR_CREATE_CAPTIONS',
]);

export function isCreatorRoute(kind: RouteKind): boolean {
  return CREATOR_KINDS.has(kind);
}
