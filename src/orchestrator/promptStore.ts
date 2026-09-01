/**
 * https://github.com/Akalanka1337/NeuraTube
 * 
 * Prompt storage and versioning.
 *
 * Every task's system prompt ships as a markdown file in `src/prompts/`, bundled
 * at build time with Vite's `?raw`. That satisfies MV3's remote-code rule — the
 * prompts are code, not configuration, and must be in the package — while still
 * letting the user edit them, because an opaque prompt is one of the two things
 * the brief singles out as an incumbent weakness.
 *
 * VERSIONING MATTERS MORE THAN IT LOOKS. A user edits a prompt, we ship an
 * improved default three releases later, and their override silently shadows it
 * forever. So each default carries a content hash: when it changes, the options
 * page can tell the user their override is based on an older version and offer a
 * diff. Without that, customisation quietly becomes stagnation.
 */

import optimizeTitle from '~/prompts/optimize_title.md?raw';
import optimizeDescription from '~/prompts/optimize_description.md?raw';
import generateTags from '~/prompts/generate_tags.md?raw';
import suggestThumbnailText from '~/prompts/suggest_thumbnail_text.md?raw';
import hookWriter from '~/prompts/hook_writer.md?raw';
import chapterGenerator from '~/prompts/chapter_generator.md?raw';
import translateMetadata from '~/prompts/translate_metadata.md?raw';
import competitorTeardown from '~/prompts/competitor_teardown.md?raw';
import contentGapAnalysis from '~/prompts/content_gap_analysis.md?raw';
import betterVideoIdeas from '~/prompts/better_video_ideas.md?raw';
import abTestTitles from '~/prompts/ab_test_titles.md?raw';
import commentInsights from '~/prompts/comment_insights.md?raw';
import commentGenerator from '~/prompts/comment_generator.md?raw';

import type { TaskType } from './tasks';

/** Bundled defaults, keyed by task. */
export const DEFAULT_PROMPTS: Readonly<Record<TaskType, string>> = Object.freeze({
  optimize_title: optimizeTitle,
  optimize_description: optimizeDescription,
  generate_tags: generateTags,
  suggest_thumbnail_text: suggestThumbnailText,
  hook_writer: hookWriter,
  chapter_generator: chapterGenerator,
  translate_metadata: translateMetadata,
  competitor_teardown: competitorTeardown,
  content_gap_analysis: contentGapAnalysis,
  better_video_ideas: betterVideoIdeas,
  ab_test_titles: abTestTitles,
  comment_insights: commentInsights,
  comment_generator: commentGenerator,
});

/** A user's edited prompt, as persisted. */
export interface PromptOverride {
  readonly text: string;
  /** Hash of the DEFAULT this override was written against. */
  readonly basedOnVersion: string;
  readonly editedAt: number;
}

/**
 * Short, stable content hash.
 *
 * FNV-1a with a final avalanche step. Not cryptographic and does not need to be
 * — its only job is changing whenever the text changes.
 *
 * THE OBVIOUS IMPLEMENTATION IS WRONG, and this project shipped it briefly:
 * plain djb2 truncated with `.slice(0, 6)` takes the HIGH hex digits, which are
 * the ones a small edit barely disturbs. `promptVersion('abc')` and
 * `promptVersion('abd')` collided — meaning a one-character prompt edit produced
 * an identical version string and staleness detection silently failed, which is
 * the single thing this function exists to prevent.
 *
 * So: mix properly, and keep the full 32 bits rather than throwing away the
 * bits that carry the difference.
 */
export function promptVersion(text: string): string {
  // FNV-1a, 32-bit.
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    // 16777619, via shifts to stay in 32-bit integer arithmetic.
    hash = (hash + (hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24)) | 0;
  }

  // Avalanche, so a single-bit input change affects every output bit.
  //
  // Every XOR is followed by `>>> 0`: JavaScript's `^` yields a SIGNED 32-bit
  // integer, so without it the value can go negative and `toString(16)` emits a
  // leading minus — a 9-character "hash" that breaks the fixed-width contract.
  let mixed = hash >>> 0;
  mixed = (mixed ^ (mixed >>> 16)) >>> 0;
  mixed = Math.imul(mixed, 0x21f0aaad) >>> 0;
  mixed = (mixed ^ (mixed >>> 15)) >>> 0;
  mixed = Math.imul(mixed, 0x735a2d97) >>> 0;
  mixed = (mixed ^ (mixed >>> 15)) >>> 0;

  return mixed.toString(16).padStart(8, '0');
}

/** Current version of a task's bundled default. */
export function defaultVersion(task: TaskType): string {
  return promptVersion(DEFAULT_PROMPTS[task]);
}

export interface ResolvedPrompt {
  readonly text: string;
  readonly isOverridden: boolean;
  /** True when the bundled default changed since the override was written. */
  readonly isStale: boolean;
  readonly currentDefaultVersion: string;
  readonly overrideBasedOn: string | null;
}

/**
 * Resolve the prompt to actually send.
 *
 * An override always wins — the user's edit is not silently discarded because we
 * shipped a new default. But `isStale` lets the options page say so.
 */
export function resolvePrompt(
  task: TaskType,
  override: PromptOverride | undefined,
): ResolvedPrompt {
  const currentDefaultVersion = defaultVersion(task);

  if (!override || override.text.trim() === '') {
    return {
      text: DEFAULT_PROMPTS[task],
      isOverridden: false,
      isStale: false,
      currentDefaultVersion,
      overrideBasedOn: null,
    };
  }

  return {
    text: override.text,
    isOverridden: true,
    isStale: override.basedOnVersion !== currentDefaultVersion,
    currentDefaultVersion,
    overrideBasedOn: override.basedOnVersion,
  };
}

/** Build an override record for saving. */
export function createOverride(task: TaskType, text: string): PromptOverride {
  return {
    text,
    basedOnVersion: defaultVersion(task),
    editedAt: Date.now(),
  };
}
