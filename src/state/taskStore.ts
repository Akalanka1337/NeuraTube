/**
 * https://github.com/Akalanka1337/NeuraTube
 * Panel-side task state.
 *
 * One record per task type, so a user can run the tag generator, read the
 * result, then run the title optimizer without losing the first — which is how
 * people actually work through a video's metadata.
 *
 * The port is opened lazily on first run and kept for the page's lifetime. It is
 * NOT opened at panel mount: an idle port serves no purpose, and every open port
 * is a connection the service worker has to track.
 */

import { signal } from '@preact/signals';
import { createLogger } from '~/lib/logger';
import type { Guardrail } from '~/orchestrator/guardrails';
import { auditOutput } from '~/orchestrator/guardrails';
import type { AuditFinding } from '~/orchestrator/guardrails';
import { openTaskStream } from '~/orchestrator/stream';
import type { TaskStream } from '~/orchestrator/stream';
import type { TaskEvent } from '~/orchestrator/runTask';
import type { TaskInputs } from '~/orchestrator/context';
import type { TaskType } from '~/orchestrator/tasks';
import type { TaskLimits } from '~/storage/schema';
import { MAX_TASK_TOKENS } from '~/storage/schema';
import { TASKS } from '~/orchestrator/tasks';
import { estimateCost } from '~/providers/pricing';
import type { PricingOverrides } from '~/providers/pricing';
import type { ProviderId, Usage } from '~/providers/types';
import type { VideoContext } from '~/types/VideoContext';
import { renderTimedTranscript } from '~/parsers/captions';
import { readComments, renderComments } from '~/panel/watchDom';
import type { TranscriptContext } from '~/parsers/captions';

const log = createLogger('tasks');

export type RunStatus = 'idle' | 'running' | 'done' | 'error' | 'cancelled';

export interface TaskRun {
  readonly status: RunStatus;
  /** Accumulated output so far. */
  readonly output: string;
  readonly provider: ProviderId | null;
  readonly model: string | null;
  readonly usage: Usage | null;
  readonly costUsd: number | null;
  /** Milliseconds from run start to first token. */
  readonly firstTokenMs: number | null;
  readonly error: string | null;
  /** Constraints applied from Studio state, so the UI can explain itself. */
  readonly guardrails: readonly Guardrail[];
  /** Post-hoc findings, e.g. a missing paid-promotion disclosure. */
  readonly findings: readonly AuditFinding[];
  /**
   * How the provider says the response ended: 'stop', 'length', 'max_tokens'…
   *
   * Kept because 'length' is the difference between "this is the answer" and
   * "this is the first two thirds of the answer", and the user cannot tell those
   * apart by looking.
   */
  readonly finishReason: string | null;
  /**
   * Chain-of-thought characters received, which are NOT part of the output.
   *
   * A non-zero count with an empty output is the signature of a reasoning model
   * that spent its whole budget thinking — previously indistinguishable from a
   * provider returning nothing.
   */
  readonly reasoningChars: number;
  /** A short tail of the thinking, so the diagnosis can show evidence. */
  readonly reasoningPreview: string;
  readonly requestId: string | null;
}

const IDLE: TaskRun = {
  status: 'idle',
  output: '',
  provider: null,
  model: null,
  usage: null,
  costUsd: null,
  firstTokenMs: null,
  error: null,
  guardrails: [],
  findings: [],
  finishReason: null,
  reasoningChars: 0,
  reasoningPreview: '',
  requestId: null,
};

/** Runs keyed by task type. */
export const runs = signal<Readonly<Partial<Record<TaskType, TaskRun>>>>({});

/** Which task's output the panel is showing, or null for the task list. */
export const openTask = signal<TaskType | null>(null);

export function runFor(task: TaskType): TaskRun {
  return runs.value[task] ?? IDLE;
}

function patch(task: TaskType, changes: Partial<TaskRun>): void {
  const current = runFor(task);
  runs.value = { ...runs.value, [task]: { ...current, ...changes } };
}

/* -------------------------------------------------------------------------- */
/* Transport                                                                   */
/* -------------------------------------------------------------------------- */

let stream: TaskStream | null = null;
/** Maps a request id back to the task that started it. */
const requestOwners = new Map<string, TaskType>();
const startedAt = new Map<string, number>();
/** Pricing overrides, refreshed from storage by the content script. */
let pricingOverrides: PricingOverrides = {};

export function setPricingOverrides(overrides: PricingOverrides): void {
  pricingOverrides = overrides;
}

function ensureStream(): TaskStream {
  stream ??= openTaskStream({
    onEvent: handleEvent,
    onInterrupted: (partial) => {
      // The worker died mid-run. Show what was persisted rather than hanging.
      for (const [requestId, task] of requestOwners) {
        if (runFor(task).status !== 'running') continue;
        patch(task, {
          status: 'error',
          output: partial !== '' ? partial : runFor(task).output,
          error:
            'The connection to the extension dropped mid-run. Showing what arrived — run it again to finish.',
        });
        requestOwners.delete(requestId);
      }
    },
  });
  return stream;
}

function handleEvent(event: TaskEvent): void {
  // Events carry no request id, so resolve the owner by finding the task that
  // is currently running. Only one run per task is ever in flight, and the panel
  // runs them one at a time.
  const task = [...requestOwners.values()].find(
    (candidate) => runFor(candidate).status === 'running',
  );
  if (task === undefined) {
    log.debug('event with no running task', event.type);
    return;
  }

  const current = runFor(task);

  switch (event.type) {
    case 'provider':
      patch(task, { provider: event.provider, model: event.model, guardrails: event.guardrails });
      return;

    case 'text': {
      const requestId = current.requestId;
      const started = requestId === null ? undefined : startedAt.get(requestId);
      patch(task, {
        output: current.output + event.text,
        firstTokenMs:
          current.firstTokenMs ??
          (started === undefined ? null : Math.round(performance.now() - started)),
      });
      return;
    }

    case 'reasoning': {
      // Counted and tail-sampled rather than accumulated in full: a long chain of
      // thought can dwarf the answer, and the panel needs evidence, not a
      // transcript.
      const preview = (current.reasoningPreview + event.text).slice(-400);
      patch(task, {
        reasoningChars: current.reasoningChars + event.text.length,
        reasoningPreview: preview,
      });
      return;
    }

    case 'usage': {
      // Replacement, not increment: Anthropic reports cumulatively.
      const cost =
        current.provider === null || current.model === null
          ? null
          : estimateCost(
              current.provider,
              current.model,
              event.usage.inputTokens,
              event.usage.outputTokens,
              pricingOverrides,
            );
      patch(task, { usage: event.usage, costUsd: cost });
      return;
    }

    case 'done': {
      const finished = runFor(task);
      patch(task, {
        status: 'done',
        finishReason: event.finishReason,
        // Audit only on completion: a partial description would fail a
        // disclosure check that the finished text passes.
        findings: auditOutput(finished.guardrails, finished.output),
      });
      if (finished.requestId !== null) {
        requestOwners.delete(finished.requestId);
        startedAt.delete(finished.requestId);
      }
      return;
    }

    case 'error': {
      const finished = runFor(task);
      patch(task, { status: 'error', error: event.message });
      if (finished.requestId !== null) {
        requestOwners.delete(finished.requestId);
        startedAt.delete(finished.requestId);
      }
      return;
    }
  }
}

/* -------------------------------------------------------------------------- */
/* Commands                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Tasks that are materially better with a transcript.
 *
 * Chapters REQUIRE one. Titles, descriptions, hooks and ideas are all
 * substantially better with one, because the transcript is the only source of
 * what the video actually says — the description is the creator's summary of it,
 * which is a different thing. So it is attached automatically whenever it has
 * been captured, rather than hidden behind a separate "advanced" mode.
 */
/**
 * Tasks that read the page's comments.
 *
 * Gathered at run time from the live DOM rather than stored, because comments
 * load lazily: what is on screen when the user presses Run is the best sample
 * available, and a snapshot taken at page load would usually be empty.
 */
const COMMENT_TASKS: ReadonlySet<TaskType> = new Set<TaskType>([
  'comment_insights',
  // Reads existing comments so it does not repeat one, and so it can match the
  // tone the community already uses.
  'comment_generator',
  'better_video_ideas',
  'content_gap_analysis',
]);

export function usesComments(task: TaskType): boolean {
  return COMMENT_TASKS.has(task);
}

const TRANSCRIPT_TASKS: ReadonlySet<TaskType> = new Set<TaskType>([
  'chapter_generator',
  'optimize_title',
  'optimize_description',
  'hook_writer',
  'ab_test_titles',
  'better_video_ideas',
  'generate_tags',
  // A comment that refers to something actually said in the video is the whole
  // difference between engagement and noise.
  'comment_generator',
]);

export function usesTranscript(task: TaskType): boolean {
  return TRANSCRIPT_TASKS.has(task);
}

/* -------------------------------------------------------------------------- */
/* Transcript opt-out                                                          */
/* -------------------------------------------------------------------------- */

/**
 * Tasks the user has switched the transcript off for.
 *
 * Opt-OUT rather than opt-in, so the default is to use it. Mirrors
 * `state.transcriptOptOut`; the content script owns persistence.
 */
export const transcriptOptOut = signal<Readonly<Partial<Record<TaskType, boolean>>>>({});

/** Called by the content script when storage changes, including at startup. */
export function setTranscriptOptOut(next: Partial<Record<TaskType, boolean>>): void {
  transcriptOptOut.value = { ...next };
}

/** Registered by the content script so a toggle persists. */
let persistOptOut: ((next: Partial<Record<TaskType, boolean>>) => void) | null = null;

export function setTranscriptOptOutPersister(
  handler: (next: Partial<Record<TaskType, boolean>>) => void,
): void {
  persistOptOut = handler;
}

/**
 * Whether a run of `task` should include the transcript.
 *
 * A task that REQUIRES one always gets it: chapters without timings cannot work,
 * so offering the choice there would only offer a broken run.
 */
/* -------------------------------------------------------------------------- */
/* Per-task limits                                                             */
/* -------------------------------------------------------------------------- */

/**
 * User overrides for token ceiling and temperature, mirroring `state.taskLimits`.
 *
 * Only deviations live here, so the shipped defaults remain authoritative and a
 * later tuning pass still reaches anyone who has not overridden that task.
 */
export const taskLimits = signal<Readonly<Partial<Record<TaskType, TaskLimits>>>>({});

export function setTaskLimits(next: Partial<Record<TaskType, TaskLimits>>): void {
  taskLimits.value = { ...next };
}

/**
 * The limits a run will actually use.
 *
 * Single source of truth for both the request and the panel's explanation of an
 * empty result — if these could disagree, the panel would quote a budget the run
 * never had.
 */
export function effectiveLimits(task: TaskType): { maxTokens: number; temperature: number } {
  const definition = TASKS[task];
  const override = taskLimits.value[task];
  return {
    maxTokens: override?.maxTokens ?? definition.maxTokens,
    temperature: override?.temperature ?? definition.temperature,
  };
}

/** Registered by the content script so a limit change from the panel persists. */
let persistLimits: ((next: Partial<Record<TaskType, TaskLimits>>) => void) | null = null;

export function setTaskLimitsPersister(
  handler: (next: Partial<Record<TaskType, TaskLimits>>) => void,
): void {
  persistLimits = handler;
}

/**
 * A ceiling large enough for a reasoning model.
 *
 * Four times the shipped default, floored at 4000 — thinking commonly costs
 * several times the answer, so a nudge would not help. Kept in step with the
 * options page's preset by a test, because two different "recommended" values
 * would make the panel's advice and the settings page disagree.
 */
export function reasoningCeiling(task: TaskType): number {
  return Math.min(MAX_TASK_TOKENS, Math.max(4000, TASKS[task].maxTokens * 4));
}

/**
 * Raise a task's ceiling from the panel, without a trip to the options page.
 *
 * The diagnosis that offers this appears exactly when the user is blocked, and
 * sending them to another tab to fix it is friction at the worst moment.
 */
export function raiseLimitFor(task: TaskType): number {
  const target = reasoningCeiling(task);
  const next: Partial<Record<TaskType, TaskLimits>> = { ...taskLimits.value };
  next[task] = { ...next[task], maxTokens: target };
  taskLimits.value = next;
  persistLimits?.(next);
  return target;
}

export function transcriptEnabledFor(task: TaskType): boolean {
  if (!TRANSCRIPT_TASKS.has(task)) return false;
  if (TASKS[task].needsTranscript) return true;
  return transcriptOptOut.value[task] !== true;
}

/** Flip the switch for one task and persist it. */
export function toggleTranscriptFor(task: TaskType, enabled: boolean): void {
  // Rebuilt rather than mutated with `delete`: only the opt-OUTs are stored, so
  // switching back on must remove the key rather than write `false`. Filtering
  // keeps the map to exactly the deviations.
  const next: Partial<Record<TaskType, boolean>> = {};
  for (const [key, value] of Object.entries(transcriptOptOut.value)) {
    if (value && key !== task) next[key as TaskType] = true;
  }
  if (!enabled) next[task] = true;

  transcriptOptOut.value = next;
  persistOptOut?.(next);
}

export function startTask(
  task: TaskType,
  video: VideoContext | null,
  transcript?: TranscriptContext | null,
  inputs?: TaskInputs,
): void {
  // Re-running replaces the previous result rather than appending to it.
  runs.value = { ...runs.value, [task]: { ...IDLE, status: 'running' } };
  openTask.value = task;

  // Timed, not plain: the chapter prompt must be able to read a timestamp off
  // the transcript rather than estimate one.
  //
  // transcriptEnabledFor, not usesTranscript: the user can switch it off per
  // task. Some videos have auto-captions bad enough to be worse than the
  // metadata alone, and only the creator knows which.
  const timed =
    transcript && transcriptEnabledFor(task) ? renderTimedTranscript(transcript) : undefined;

  // Read comments now, not at page load: they arrive lazily as the viewer
  // scrolls, so the sample at Run time is the only useful one.
  let commentText: string | undefined;
  if (COMMENT_TASKS.has(task)) {
    const snapshot = readComments();
    const rendered = renderComments(snapshot);
    if (rendered !== '') commentText = rendered;
  }

  const merged: TaskInputs | undefined =
    timed === undefined && commentText === undefined
      ? inputs
      : {
          ...inputs,
          ...(timed !== undefined ? { transcript: timed } : {}),
          ...(commentText !== undefined ? { comments: commentText } : {}),
        };

  // Limits travel WITH the request rather than being looked up in the worker, so
  // the budget the panel reports in an empty-output diagnosis is provably the one
  // the request was made with.
  const limits = effectiveLimits(task);

  const requestId = ensureStream().run({
    task,
    video,
    limits,
    ...(merged ? { inputs: merged } : {}),
  });

  requestOwners.set(requestId, task);
  startedAt.set(requestId, performance.now());
  patch(task, { requestId });
}

/**
 * Which video the results on screen belong to.
 *
 * Runs are keyed by TASK, not by video — one record per task so a user can read
 * a tag result, then run the title optimizer without losing it. That is right
 * within a video and wrong across videos: navigating to another video left the
 * previous one's generated titles sitting in the panel, looking like output for
 * the video now on screen. Which is the worst kind of wrong, because it is
 * plausible.
 */
let resultsVideoId: string | null = null;

/**
 * Discard results that belong to a different video.
 *
 * Called on every surface change. A no-op when the video is unchanged, so
 * Studio's tab and period rewrites do not throw away work.
 */
export function resetForVideo(videoId: string | null): void {
  if (videoId === resultsVideoId) return;

  const had = Object.keys(runs.value).length > 0;
  resultsVideoId = videoId;

  // Cancel anything in flight: its output would stream into the new video's panel.
  for (const [requestId, task] of requestOwners) {
    if (runFor(task).status === 'running') stream?.cancel(requestId);
  }
  requestOwners.clear();
  startedAt.clear();

  runs.value = {};
  openTask.value = null;

  if (had) log.debug('cleared results for a new video', { videoId });
}

export function cancelTask(task: TaskType): void {
  const current = runFor(task);
  if (current.requestId !== null) {
    stream?.cancel(current.requestId);
    requestOwners.delete(current.requestId);
    startedAt.delete(current.requestId);
  }
  patch(task, { status: 'cancelled' });
}

export function clearTask(task: TaskType): void {
  const { [task]: _discarded, ...rest } = runs.value;
  runs.value = rest;
  if (openTask.value === task) openTask.value = null;
}

/** Close the port. Called when the panel unmounts. */
export function disconnectTasks(): void {
  stream?.disconnect();
  stream = null;
  requestOwners.clear();
  startedAt.clear();
}

/** Reset for tests. */
export function resetTaskStoreForTests(): void {
  runs.value = {};
  openTask.value = null;
  requestOwners.clear();
  startedAt.clear();
  pricingOverrides = {};
  stream = null;
  resultsVideoId = null;
  transcriptOptOut.value = {};
  taskLimits.value = {};
  persistOptOut = null;
  persistLimits = null;
}
