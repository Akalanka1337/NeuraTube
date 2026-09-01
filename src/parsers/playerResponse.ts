/**
 * Extracting the descriptive subset of a YouTube player response.
 *
 * PURE, and in `parsers/` rather than `intercept/` on purpose. The same payload
 * reaches NeuraTube two ways — as the `ytInitialPlayerResponse` page global read
 * from the MAIN world, and as an intercepted `/youtubei/v1/player` response read
 * in the isolated world — so this module must be importable by both without
 * dragging the MAIN-world transport into the panel bundle.
 *
 * WHY BOTH PATHS EXIST. The page global is written once by an inline script and
 * YouTube does NOT rewrite it on client-side navigation: click a suggested video
 * and the global still describes the video you arrived on, permanently. So the
 * global is a fast path for first paint, and the network response — which fires
 * on every navigation — is the authoritative one.
 *
 * WHAT IS EXTRACTED, AND WHAT DELIBERATELY IS NOT. Only the descriptive fields
 * below, by explicit allowlist. A player response also contains `streamingData`
 * (signed, expiring media URLs), playback tracking and ad configuration. A spread
 * would quietly start carrying whatever YouTube adds next; an allowlist cannot.
 */

interface PageGlobals {
  ytInitialPlayerResponse?: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/**
 * Pull the descriptive subset out of the player response.
 *
 * Returns null when the global is absent or does not look like a video — a
 * channel page or the home feed has no `videoDetails`, and emitting an empty
 * capture there would only add noise to the diagnostics log.
 */
export function extractWatchPageData(globals: unknown): string | null {
  if (!isRecord(globals)) return null;
  return extractPlayerDetails((globals as PageGlobals).ytInitialPlayerResponse);
}

/**
 * Extract the descriptive subset from a player response.
 *
 * Shared by the page global and by intercepted `/youtubei/v1/player` responses,
 * because they are the SAME payload delivered two ways — and the network one is
 * the only one that stays correct.
 *
 * WHY THE NETWORK PATH IS NOT OPTIONAL. `ytInitialPlayerResponse` is written once
 * by an inline script and YouTube does NOT rewrite it on client-side navigation.
 * Click a suggested video and the global still describes the video you arrived
 * on, forever. Polling it therefore cannot detect the change — the panel kept
 * showing the first video, which is exactly the bug this fixes. `/youtubei/v1/player`
 * fires on every navigation to a new video, so it is the authoritative source
 * and the global is just a fast path for first paint.
 */
export function extractPlayerDetails(playerResponse: unknown): string | null {
  const response = playerResponse;
  if (!isRecord(response)) return null;

  const details = response.videoDetails;
  if (!isRecord(details)) return null;

  const videoId = str(details.videoId);
  if (videoId === '') return null;

  const microformat = isRecord(response.microformat) ? response.microformat : {};
  const renderer = isRecord(microformat.playerMicroformatRenderer)
    ? microformat.playerMicroformatRenderer
    : {};

  // An explicit allowlist, not a spread. `videoDetails` sits beside
  // `streamingData` and playback-tracking blobs, and a spread would quietly
  // start carrying whatever YouTube adds next.
  const payload = {
    videoId,
    title: str(details.title),
    shortDescription: str(details.shortDescription),
    keywords: Array.isArray(details.keywords)
      ? details.keywords.filter((k): k is string => typeof k === 'string')
      : [],
    lengthSeconds: str(details.lengthSeconds),
    viewCount: str(details.viewCount),
    author: str(details.author),
    channelId: str(details.channelId),
    isLiveContent: details.isLiveContent === true,
    // Microformat carries the things videoDetails omits.
    publishDate: str(renderer.publishDate),
    uploadDate: str(renderer.uploadDate),
    category: str(renderer.category),
    isFamilySafe: renderer.isFamilySafe === true,
    isUnlisted: renderer.isUnlisted === true,
  };

  return JSON.stringify(payload);
}
