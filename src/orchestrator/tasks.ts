/**
 * Task catalogue.
 *
 * The eleven task types from the brief, each with its default sampling
 * temperature, output cap, and the surfaces it is offered on.
 *
 * Provider preference is expressed as an ORDER, not a fixed choice: users will
 * not have all four keys configured, so every task needs a fallback chain that
 * degrades to whatever is available. The defaults below prefer a cheap model for
 * mechanical work (tags, chapters) and a stronger one where judgement matters
 * (ideas, teardowns) — but since NeuraTube hardcodes no model IDs, "cheap" and
 * "strong" mean whichever model the user selected for that provider.
 */

import type { ProviderId } from '~/providers/types';
import type { Surface } from '~/types/surface';

export type TaskType =
  | 'optimize_title'
  | 'optimize_description'
  | 'generate_tags'
  | 'suggest_thumbnail_text'
  | 'hook_writer'
  | 'chapter_generator'
  | 'translate_metadata'
  | 'competitor_teardown'
  | 'content_gap_analysis'
  | 'better_video_ideas'
  | 'ab_test_titles'
  | 'comment_insights'
  | 'comment_generator';

export const TASK_TYPES: readonly TaskType[] = [
  'optimize_title',
  'optimize_description',
  'generate_tags',
  'suggest_thumbnail_text',
  'hook_writer',
  'chapter_generator',
  'translate_metadata',
  'competitor_teardown',
  'content_gap_analysis',
  'better_video_ideas',
  'ab_test_titles',
  'comment_insights',
  'comment_generator',
];

export interface TaskDefinition {
  readonly type: TaskType;
  readonly label: string;
  /** One line, shown in the options page routing table. */
  readonly description: string;
  /** Sampling temperature. Low for structured output, high for ideation. */
  readonly temperature: number;
  readonly maxTokens: number;
  /** Surfaces where this task is offered. */
  readonly surfaces: readonly Surface[];
  /** Whether the task needs a transcript, which not every video has. */
  readonly needsTranscript: boolean;
}

const STUDIO_VIDEO: readonly Surface[] = ['studio-edit', 'studio-analytics'];
/*
 * Shorts is a public page like any other for task purposes: it has a title, a
 * description, a transcript and comments. It gets its own Surface so the panel
 * can be positioned differently, not so it can be treated as a lesser page.
 */
const PUBLIC_PAGES: readonly Surface[] = ['watch', 'shorts', 'search'];
const EVERYWHERE: readonly Surface[] = [
  'studio-edit',
  'studio-analytics',
  'studio-dashboard',
  'studio-other',
  'watch',
  'search',
];

export const TASKS: Readonly<Record<TaskType, TaskDefinition>> = Object.freeze({
  optimize_title: {
    type: 'optimize_title',
    label: 'Title optimizer',
    description: 'Rewrites the title as five candidates, each naming the lever it pulls.',
    temperature: 0.8,
    maxTokens: 700,
    surfaces: STUDIO_VIDEO,
    needsTranscript: false,
  },
  optimize_description: {
    type: 'optimize_description',
    label: 'Description structurizer',
    description: 'Hook, context, timestamps, one CTA, hashtags. Inserts paid-promotion disclosure.',
    temperature: 0.7,
    maxTokens: 1400,
    surfaces: STUDIO_VIDEO,
    needsTranscript: false,
  },
  generate_tags: {
    type: 'generate_tags',
    label: 'Tag generator',
    description: 'Fifteen tags, comma-separated, ready to paste into Studio.',
    temperature: 0.6,
    maxTokens: 400,
    surfaces: STUDIO_VIDEO,
    needsTranscript: false,
  },
  suggest_thumbnail_text: {
    type: 'suggest_thumbnail_text',
    label: 'Thumbnail text',
    description: 'Four short overlays with colour and composition notes.',
    temperature: 0.85,
    maxTokens: 700,
    surfaces: STUDIO_VIDEO,
    needsTranscript: false,
  },
  hook_writer: {
    type: 'hook_writer',
    label: 'Hook writer',
    description: 'Three opening hooks written to be read aloud.',
    temperature: 0.85,
    maxTokens: 700,
    surfaces: STUDIO_VIDEO,
    needsTranscript: false,
  },
  chapter_generator: {
    type: 'chapter_generator',
    label: 'Chapters',
    description: 'Chapters from the transcript. Refuses rather than inventing timestamps.',
    temperature: 0.4,
    maxTokens: 900,
    surfaces: STUDIO_VIDEO,
    needsTranscript: true,
  },
  translate_metadata: {
    type: 'translate_metadata',
    label: 'Translate metadata',
    description: 'Localises title, description and tags to chosen locales.',
    temperature: 0.5,
    maxTokens: 2000,
    surfaces: STUDIO_VIDEO,
    needsTranscript: false,
  },
  competitor_teardown: {
    type: 'competitor_teardown',
    label: 'Steal this video',
    description: 'What a competitor promises, why it works, and how to beat it.',
    temperature: 0.7,
    maxTokens: 900,
    surfaces: PUBLIC_PAGES,
    needsTranscript: false,
  },
  content_gap_analysis: {
    type: 'content_gap_analysis',
    label: 'Content gaps',
    description: 'Five ranked gaps this channel has authority to claim.',
    temperature: 0.7,
    maxTokens: 1200,
    surfaces: EVERYWHERE,
    needsTranscript: false,
  },
  better_video_ideas: {
    type: 'better_video_ideas',
    label: 'Better video ideas',
    description: 'Five stronger angles on this video, grounded in competitor context.',
    temperature: 0.9,
    maxTokens: 1200,
    surfaces: EVERYWHERE,
    needsTranscript: false,
  },
  comment_insights: {
    type: 'comment_insights',
    label: 'Comment insights',
    description: "What the audience asked for, and what to do about it. Reads the page's comments.",
    // Low: this reports what people said. Invention is the failure mode.
    temperature: 0.3,
    maxTokens: 1200,
    surfaces: PUBLIC_PAGES,
    needsTranscript: false,
  },
  comment_generator: {
    type: 'comment_generator',
    label: 'Comment generator',
    description: 'Five comments a real viewer would leave, drawn from the transcript.',
    /*
     * Higher than any other task, deliberately. Five comments that all sound the
     * same are one comment; the whole value is that they differ in kind and in
     * voice, and low temperature collapses them toward a single register.
     */
    temperature: 0.9,
    maxTokens: 700,
    // Watch and Shorts only. On a Studio page the user is the creator, and
    // drafting comments for your own video is a different thing entirely.
    surfaces: ['watch', 'shorts'],
    needsTranscript: false,
  },
  ab_test_titles: {
    type: 'ab_test_titles',
    label: 'A/B title variants',
    description: "Three variants for YouTube's native test, each testing one hypothesis.",
    temperature: 0.85,
    maxTokens: 600,
    surfaces: STUDIO_VIDEO,
    needsTranscript: false,
  },
});

/** Per-task provider routing, as persisted. */
export interface TaskRouting {
  /** Preferred provider. Null means "use whichever is available". */
  readonly primary: ProviderId | null;
  /** Tried in order when the primary fails with a retryable error. */
  readonly fallbacks: readonly ProviderId[];
}

/**
 * Default routing.
 *
 * `primary: null` throughout, deliberately. On first run the user has at most
 * one key configured, so pinning a provider would produce a task that cannot
 * run. The resolver picks the first enabled provider instead, and the options
 * page lets the user pin one once they have a choice to make.
 */
export function defaultRouting(): TaskRouting {
  return { primary: null, fallbacks: [] };
}

export function taskDefinition(type: TaskType): TaskDefinition {
  return TASKS[type];
}

/** Tasks offered on a given surface. */
export function tasksForSurface(surface: Surface): readonly TaskDefinition[] {
  return TASK_TYPES.map((type) => TASKS[type]).filter((task) => task.surfaces.includes(surface));
}

export function isTaskType(value: unknown): value is TaskType {
  return typeof value === 'string' && (TASK_TYPES as readonly string[]).includes(value);
}
