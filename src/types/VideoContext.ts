/**
 * https://github.com/Akalanka1337/NeuraTube
 * 
 * The canonical video model.
 *
 * Everything downstream — the panel, the AI orchestrator, the guardrail engine
 * — reads this shape and never the raw InnerTube payload. One translation layer,
 * one place to fix when YouTube changes the wire format.
 *
 * Deliberately omitted from the brief's specification: `videoStreamUrl`. It is a
 * googlevideo.com URL protected by YouTube's rolling cipher, and a February 2026
 * N.D. Cal. ruling held that defeating that cipher is DMCA §1201 circumvention
 * even where the underlying use would be fair. It has no feature value for
 * metadata optimisation, so carrying it in our data model would be pure
 * liability. See README, "Retained risk".
 */

export type Privacy = 'public' | 'unlisted' | 'private' | 'scheduled';
export type ProcessingStatus = 'processed' | 'processing' | 'failed';
export type Tristate = 'yes' | 'no' | 'unset';
export type ExperimentState = 'none' | 'running' | 'finished';
export type ExperimentResult = 'winner' | 'no_winner' | 'pending' | null;

export interface Thumbnail {
  readonly url: string;
  readonly width: number;
  readonly height: number;
}

/** One arm of YouTube's native title/thumbnail A/B test. */
export interface ExperimentArm {
  readonly index: number;
  /** Share of total watch time this arm won, 0..1. */
  readonly watchtimeFraction: number;
}

export interface VideoContext {
  readonly videoId: string;
  readonly title: string;
  readonly description: string;
  readonly tags: readonly string[];
  /**
   * YouTube's own hashtag recommendations, straight from Studio.
   *
   * Notable because this is a free, first-party keyword signal that vidIQ
   * charges for — it arrives in the same payload as everything else.
   */
  readonly suggestedHashtags: readonly string[];
  /** Hashtags already present inline in the description. */
  readonly descriptionHashtags: readonly string[];
  readonly durationSec: number;
  /**
   * Publish time as unix MILLISECONDS, not a `Date`.
   *
   * This model crosses two serialisation boundaries: `window.postMessage` from
   * the MAIN world (structured clone, which preserves Date) and
   * `chrome.runtime` messaging to the service worker (JSON, which does NOT).
   * A `Date` therefore arrives at the worker as an ISO *string*, and any
   * `.toISOString()` on it throws — which is exactly the bug this shape
   * prevents. The brief's parser returned a Date; that only worked while the
   * value never left the content script.
   *
   * Every field in this interface must be JSON-safe for the same reason.
   */
  readonly publishedAtMs: number | null;
  readonly channelId: string;
  /** Human-readable category, mapped from the InnerTube enum. */
  readonly category: string;
  /** Raw category enum, retained so an unmapped value is still usable. */
  readonly categoryRaw: string;
  readonly license: string;
  readonly privacy: Privacy;
  readonly status: ProcessingStatus;
  readonly metadataLanguage: string | null;
  readonly madeForKids: boolean;
  readonly ageRestricted: boolean;
  readonly allowEmbed: boolean;
  readonly allowRatings: boolean;
  readonly paidPromotion: boolean;
  readonly alteredContent: Tristate;
  readonly originalFilename: string | null;
  readonly shareUrl: string;
  readonly thumbnails: readonly Thumbnail[];
  /* ---- public watch pages only ----------------------------------------- *
   * Optional because a Studio payload does not carry them and a public page
   * does not carry most of what Studio does. Optional rather than defaulted, so
   * a consumer has to decide what an absence means instead of reading a zero as
   * a measurement.
   */
  /** Lifetime views, when known. */
  readonly viewCount?: number;
  readonly channelTitle?: string;
  /** As rendered, e.g. "1.92M subscribers" — a label, not a number. */
  readonly subscriberText?: string;
  /** Chapters YouTube itself shows, read from the watch page. */
  readonly chapters?: readonly { readonly label: string; readonly startSec: number }[];
  /**
   * Which surface this came from.
   *
   * Matters for correctness, not bookkeeping: a public context cannot see
   * `madeForKids` or `paidPromotion`, so its `false` means "unknown". Anything
   * making a compliance decision must check this first.
   */
  readonly source?: 'studio' | 'public';
  readonly abTest: {
    readonly state: ExperimentState;
    readonly result: ExperimentResult;
    readonly arms: readonly ExperimentArm[];
  };
  readonly monetization: {
    readonly effectiveStatus: string;
    readonly selfCertDecision: string;
  };
  readonly copyright: {
    readonly activeClaimCount: number;
    readonly hasImpact: boolean;
  };
}

/** Publish time as a Date, for display. Null when unpublished or unparseable. */
export function publishedDate(context: VideoContext): Date | null {
  return context.publishedAtMs === null ? null : new Date(context.publishedAtMs);
}

/** Highest-resolution thumbnail available, or null. */
export function bestThumbnail(context: VideoContext): Thumbnail | null {
  let best: Thumbnail | null = null;
  for (const thumbnail of context.thumbnails) {
    if (!best || thumbnail.width * thumbnail.height > best.width * best.height) {
      best = thumbnail;
    }
  }
  return best;
}

/** Whether YouTube's native A/B test has arms worth showing. */
export function hasExperimentData(context: VideoContext): boolean {
  return context.abTest.state !== 'none' && context.abTest.arms.length > 0;
}
