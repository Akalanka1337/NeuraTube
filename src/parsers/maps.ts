/**
 * InnerTube enum translation.
 *
 * Every map here is total by construction: the parser falls back to the raw
 * enum string rather than losing information, because YouTube adds categories
 * and states without warning and a silent "Unknown" is worse than an ugly
 * identifier the user can report to us.
 */

import type {
  ExperimentResult,
  ExperimentState,
  Privacy,
  ProcessingStatus,
  Tristate,
} from '~/types/VideoContext';

export const PRIVACY_MAP: Readonly<Record<string, Privacy>> = Object.freeze({
  VIDEO_PRIVACY_PUBLIC: 'public',
  VIDEO_PRIVACY_UNLISTED: 'unlisted',
  VIDEO_PRIVACY_PRIVATE: 'private',
  VIDEO_PRIVACY_SCHEDULED: 'scheduled',
});

export const STATUS_MAP: Readonly<Record<string, ProcessingStatus>> = Object.freeze({
  VIDEO_STATUS_PROCESSED: 'processed',
  VIDEO_STATUS_PROCESSING: 'processing',
  VIDEO_STATUS_UPLOADED: 'processing',
  VIDEO_STATUS_TRANSCODING: 'processing',
  VIDEO_STATUS_FAILED: 'failed',
  VIDEO_STATUS_REJECTED: 'failed',
  VIDEO_STATUS_DELETED: 'failed',
});

/**
 * Video categories.
 *
 * Covers YouTube's full public category list as it maps onto the
 * CREATOR_VIDEO_CATEGORY_* enum. An unmapped value falls through to the raw
 * string, and `detectCategoryDrift` reports it.
 */
export const CATEGORY_MAP: Readonly<Record<string, string>> = Object.freeze({
  CREATOR_VIDEO_CATEGORY_FILM_ANIMATION: 'Film & Animation',
  CREATOR_VIDEO_CATEGORY_AUTOS_VEHICLES: 'Autos & Vehicles',
  CREATOR_VIDEO_CATEGORY_MUSIC: 'Music',
  CREATOR_VIDEO_CATEGORY_PETS_ANIMALS: 'Pets & Animals',
  CREATOR_VIDEO_CATEGORY_SPORTS: 'Sports',
  CREATOR_VIDEO_CATEGORY_TRAVEL_EVENTS: 'Travel & Events',
  CREATOR_VIDEO_CATEGORY_GAMING: 'Gaming',
  CREATOR_VIDEO_CATEGORY_PEOPLE_BLOGS: 'People & Blogs',
  CREATOR_VIDEO_CATEGORY_COMEDY: 'Comedy',
  CREATOR_VIDEO_CATEGORY_ENTERTAINMENT: 'Entertainment',
  CREATOR_VIDEO_CATEGORY_NEWS_POLITICS: 'News & Politics',
  CREATOR_VIDEO_CATEGORY_HOWTO_STYLE: 'Howto & Style',
  CREATOR_VIDEO_CATEGORY_EDUCATION: 'Education',
  CREATOR_VIDEO_CATEGORY_TECH: 'Science & Technology',
  CREATOR_VIDEO_CATEGORY_SCIENCE_TECHNOLOGY: 'Science & Technology',
  CREATOR_VIDEO_CATEGORY_NONPROFITS_ACTIVISM: 'Nonprofits & Activism',
  CREATOR_VIDEO_CATEGORY_SHORT_MOVIES: 'Short Movies',
  CREATOR_VIDEO_CATEGORY_TRAILERS: 'Trailers',
});

export const EXPERIMENT_STATE_MAP: Readonly<Record<string, ExperimentState>> = Object.freeze({
  CREATOR_EXPERIMENT_STATE_RUNNING: 'running',
  CREATOR_EXPERIMENT_STATE_FINISHED: 'finished',
  CREATOR_EXPERIMENT_STATE_COMPLETE: 'finished',
  CREATOR_EXPERIMENT_STATE_UNKNOWN: 'none',
  CREATOR_EXPERIMENT_STATE_NONE: 'none',
});

export const EXPERIMENT_RESULT_MAP: Readonly<Record<string, ExperimentResult>> = Object.freeze({
  CREATOR_EXPERIMENT_RESULT_STATE_WINNER: 'winner',
  CREATOR_EXPERIMENT_RESULT_STATE_NO_WINNER: 'no_winner',
  CREATOR_EXPERIMENT_RESULT_STATE_PENDING: 'pending',
  CREATOR_EXPERIMENT_RESULT_STATE_INSUFFICIENT_DATA: 'pending',
});

export const ALTERED_CONTENT_MAP: Readonly<Record<string, Tristate>> = Object.freeze({
  VIDEO_HAS_ALTERED_CONTENT_YES: 'yes',
  VIDEO_HAS_ALTERED_CONTENT_NO: 'no',
  VIDEO_HAS_ALTERED_CONTENT_UNSET: 'unset',
});

/** Enum values that mean "this video is marked as made for kids". */
export const MADE_FOR_KIDS_TRUE: ReadonlySet<string> = new Set([
  'VIDEO_EFFECTIVE_MADE_FOR_KIDS_MFK',
  'VIDEO_MADE_FOR_KIDS_MFK',
]);

/** Age-restriction enum values that mean "restricted". */
export const AGE_RESTRICTED_VALUES: ReadonlySet<string> = new Set([
  'VIDEO_AGE_RESTRICTION_RESTRICTED',
  'VIDEO_AGE_RESTRICTED_RESTRICTED',
  'AGE_RESTRICTION_RESTRICTED',
]);

/** Copyright impact enum meaning "no monetization impact". */
export const COPYRIGHT_NO_IMPACT = 'VIDEO_COPYRIGHT_MONETIZATION_IMPACT_NOT_AFFECTED';
