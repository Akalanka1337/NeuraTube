import type { JSX } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import { copyText, normaliseTagList } from '~/lib/clipboard';
import { parseSuggestions, titleLengthVerdict } from '~/lib/suggestions';
import type { Suggestion } from '~/lib/suggestions';
import { formatTokens } from '~/orchestrator/costMeter';
import { TASKS, tasksForSurface } from '~/orchestrator/tasks';
import type { TaskType } from '~/orchestrator/tasks';
import { formatUsd } from '~/providers/pricing';
import { PROVIDER_SPECS } from '~/providers/specs';
import {
  cancelTask,
  clearTask,
  openTask,
  runFor,
  runs,
  effectiveLimits,
  raiseLimitFor,
  reasoningCeiling,
  startTask,
  toggleTranscriptFor,
  transcriptEnabledFor,
  usesTranscript,
} from '~/state/taskStore';
import type { TaskRun } from '~/state/taskStore';
import { surface } from '~/state/panelState';
import { currentVideo, lastTranscriptAttempt, transcript } from '~/state/contextStore';
import { coversVideo, formatTimestamp, transcriptWordCount } from '~/parsers/captions';
import { openSubtitlesEditor } from './studioLinks';
import { diagnoseEmpty, isTruncated } from './emptyOutput';
import type { OpenResult } from './studioLinks';

/**
 * The task list.
 *
 * Only tasks the current surface supports are offered — `tasksForSurface` has
 * done that since M3, and offering a tag generator on a public watch page would
 * be a button that cannot work.
 */
export function TaskRail(): JSX.Element {
  const info = surface.value;
  const video = currentVideo.value;
  const available = tasksForSurface(info.surface);
  const allRuns = runs.value;

  if (available.length === 0) {
    return (
      <div class="card">
        <h2 class="card-title">No tasks here</h2>
        <p class="note">NeuraTube has nothing to offer on this page.</p>
      </div>
    );
  }

  return (
    <div class="card">
      <h2 class="card-title">
        Tasks <span class="count">{available.length}</span>
      </h2>

      {video === null ? (
        <p class="note note--sm">
          Tasks run without video metadata on this page, so results will be generic. Open a video in
          Studio for context-aware output.
        </p>
      ) : null}

      <ul class="tasks" aria-label="Available tasks">
        {available.map((task) => {
          const run = allRuns[task.type];
          return (
            <li key={task.type}>
              <button
                type="button"
                class="task-btn"
                onClick={() => {
                  openTask.value = task.type;
                  if (run === undefined || run.status === 'idle') {
                    // Chapters cannot run without timings; opening the view lets
                    // the user read why and fetch them.
                    if (task.needsTranscript && transcript.value === null) return;
                    startTask(task.type, video, transcript.value);
                  }
                }}
              >
                <span class="task-label">{task.label}</span>
                <span class="task-desc">{task.description}</span>
                {run !== undefined ? <RunBadge run={run} /> : null}
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function RunBadge({ run }: { readonly run: TaskRun }): JSX.Element | null {
  switch (run.status) {
    case 'running':
      return <span class="pill pill--accent">running…</span>;
    case 'done':
      return <span class="pill pill--ok">ready</span>;
    case 'error':
      return <span class="pill pill--err">failed</span>;
    case 'cancelled':
      return <span class="pill pill--muted">cancelled</span>;
    default:
      return null;
  }
}

/**
 * One task's output.
 *
 * The streaming region is `aria-live="polite"` with `aria-busy` while running,
 * and is announced on completion rather than per token — a live region that
 * fires on every chunk makes a screen reader unusable, which is the classic way
 * streaming UI fails an accessibility audit.
 */
export function TaskOutput({ task }: { readonly task: TaskType }): JSX.Element {
  const run = runFor(task);
  const definition = TASKS[task];
  const video = currentVideo.value;

  const [copied, setCopied] = useState<'none' | 'raw' | 'tags'>('none');
  const outputRef = useRef<HTMLPreElement | null>(null);

  // Follow the stream, but only while the user is already at the bottom —
  // yanking the scroll position while they are reading earlier output is worse
  // than not following at all.
  useEffect(() => {
    const element = outputRef.current;
    if (!element || run.status !== 'running') return;
    const atBottom = element.scrollHeight - element.scrollTop - element.clientHeight < 48;
    if (atBottom) element.scrollTop = element.scrollHeight;
  }, [run.output, run.status]);

  useEffect(() => {
    if (copied === 'none') return;
    const timer = setTimeout(() => {
      setCopied('none');
    }, 1800);
    return () => {
      clearTimeout(timer);
    };
  }, [copied]);

  const isTagTask = task === 'generate_tags';
  const tagList = isTagTask ? normaliseTagList(run.output) : '';

  // List-shaped tasks get one copy button per suggestion. The whole point of
  // this extension is speed, and making the user select-and-drag one title out
  // of five gives back the time it saved.
  const showsList = LIST_TASKS.has(task) && run.status !== 'running';
  const parsed = showsList ? parseSuggestions(run.output) : { items: [], parsed: false };

  return (
    <div class="card task-output">
      <header class="task-output-head">
        <button
          type="button"
          class="icon-btn"
          onClick={() => {
            openTask.value = null;
          }}
          aria-label="Back to task list"
          title="Back to tasks"
        >
          ←
        </button>
        <h2 class="card-title task-output-title">{definition.label}</h2>
        {run.status === 'running' ? (
          <button
            type="button"
            class="ghost-btn"
            onClick={() => {
              cancelTask(task);
            }}
          >
            Cancel
          </button>
        ) : (
          <button
            type="button"
            class="ghost-btn"
            disabled={definition.needsTranscript && transcript.value === null}
            onClick={() => {
              startTask(task, video, transcript.value);
            }}
          >
            {run.status === 'idle' ? 'Run' : 'Run again'}
          </button>
        )}
      </header>

      {usesTranscript(task) ? (
        <TranscriptStatus task={task} required={definition.needsTranscript} />
      ) : null}

      {run.guardrails.length > 0 ? (
        <div class="rails" role="list" aria-label="Constraints applied from Studio settings">
          {run.guardrails.map((rail) => (
            <span
              key={rail.id}
              role="listitem"
              class={`pill ${rail.mandatory ? 'pill--warn' : 'pill--muted'}`}
              title={rail.instruction}
            >
              {rail.label}
            </span>
          ))}
        </div>
      ) : null}

      {run.findings.map((finding) => (
        <div key={finding.guardrail} class="banner banner--warn" role="alert">
          {finding.message}
        </div>
      ))}

      {run.error !== null ? (
        <div class="banner banner--err" role="alert">
          {run.error}
        </div>
      ) : null}

      {/*
        A finished run with no text gets an explanation, never a blank box. Three
        very different causes used to present identically: a reasoning model out
        of budget, a truncated response, and a provider returning nothing.
      */}
      {run.status === 'done' && run.output.trim() === '' ? (
        <EmptyOutputNotice task={task} run={run} maxTokens={effectiveLimits(task).maxTokens} />
      ) : null}

      {/* Non-empty but cut off is its own failure: the user cannot see that the
          last third of a description is missing. */}
      {run.status === 'done' && run.output.trim() !== '' && isTruncated(run.finishReason) ? (
        <div class="banner banner--warn" role="alert">
          <p class="note note--sm">
            Cut off at the token limit — this output is incomplete. Raise this task’s limit in
            Options → Advanced.
          </p>
        </div>
      ) : null}

      {parsed.parsed ? (
        <SuggestionList
          items={parsed.items}
          measureLength={MEASURED_TASKS.has(task)}
          label={definition.label}
        />
      ) : (
        <pre
          class="output"
          ref={outputRef}
          tabIndex={0}
          role="region"
          aria-label={`${definition.label} output`}
          aria-live="polite"
          aria-busy={run.status === 'running'}
        >
          {run.output}
          {run.status === 'running' ? <span class="caret" /> : null}
        </pre>
      )}

      {run.output !== '' ? (
        <div class="task-actions">
          <button
            type="button"
            class={parsed.parsed ? 'ghost-btn' : undefined}
            onClick={() => {
              void copyText(run.output).then((ok) => {
                setCopied(ok ? 'raw' : 'none');
              });
            }}
          >
            {copied === 'raw' ? 'Copied' : parsed.parsed ? 'Copy all' : 'Copy'}
          </button>

          {isTagTask && tagList !== '' ? (
            <button
              type="button"
              onClick={() => {
                void copyText(tagList).then((ok) => {
                  setCopied(ok ? 'tags' : 'none');
                });
              }}
              title="Cleaned, de-duplicated and trimmed to YouTube's 500-character tag budget"
            >
              {copied === 'tags' ? 'Copied' : `Copy all ${tagList.split(', ').length} tags`}
            </button>
          ) : null}

          <button
            type="button"
            class="ghost-btn"
            onClick={() => {
              clearTask(task);
            }}
          >
            Clear
          </button>
        </div>
      ) : null}

      {isTagTask && run.status === 'done' ? (
        <p class="note note--sm">
          Paste into Studio&apos;s tag field. NeuraTube does not write to YouTube for you — every
          change stays under your control.
        </p>
      ) : null}

      <RunFooter run={run} />
    </div>
  );
}

function RunFooter({ run }: { readonly run: TaskRun }): JSX.Element | null {
  if (run.provider === null && run.usage === null) return null;

  return (
    <p class="muted-line">
      {run.provider !== null ? (
        <span>
          {PROVIDER_SPECS[run.provider].label}
          {run.model !== null ? ` · ${run.model}` : ''}
        </span>
      ) : null}
      {run.firstTokenMs !== null ? <span> · first token {run.firstTokenMs} ms</span> : null}
      {run.usage !== null ? (
        <span>
          {' '}
          · {formatTokens(run.usage.inputTokens)} in / {formatTokens(run.usage.outputTokens)} out ·{' '}
          {run.costUsd === null ? 'cost unknown' : formatUsd(run.costUsd)}
        </span>
      ) : null}
    </p>
  );
}

/**
 * Tasks whose output is a list the user picks ONE item from.
 *
 * Descriptions and chapters are excluded deliberately: those are single blocks
 * meant to be pasted whole, and splitting them into lines would be actively
 * unhelpful.
 */
const LIST_TASKS: ReadonlySet<TaskType> = new Set<TaskType>([
  // Five comments, each copied on its own — the point is to post one.
  'comment_generator',
  'optimize_title',
  'ab_test_titles',
  'better_video_ideas',
  'suggest_thumbnail_text',
  'hook_writer',
]);

/** Tasks where the item is a title and its display length matters. */
const MEASURED_TASKS: ReadonlySet<TaskType> = new Set<TaskType>([
  'optimize_title',
  'ab_test_titles',
]);

interface SuggestionListProps {
  readonly items: readonly Suggestion[];
  readonly measureLength: boolean;
  readonly label: string;
}

/**
 * One row per suggestion, each independently copyable.
 *
 * For titles the character count is shown against YouTube's real display limit
 * rather than its hard limit: search truncates around 60 characters and mobile
 * feeds show fewer, so a 95-character title is technically legal and practically
 * cut off. That is information the creator needs before choosing, and it costs
 * nothing to measure locally — no reason to spend tokens asking a model to count.
 */
function SuggestionList({ items, measureLength, label }: SuggestionListProps): JSX.Element {
  const [copiedIndex, setCopiedIndex] = useState<number | null>(null);

  useEffect(() => {
    if (copiedIndex === null) return;
    const timer = setTimeout(() => {
      setCopiedIndex(null);
    }, 1600);
    return () => {
      clearTimeout(timer);
    };
  }, [copiedIndex]);

  return (
    <ol class="suggestions" aria-label={`${label} suggestions`}>
      {items.map((item, index) => {
        const verdict = measureLength ? titleLengthVerdict(item.text) : null;
        return (
          <li key={`${index}-${item.text.slice(0, 24)}`}>
            <p class="suggestion-text">{item.text}</p>

            <div class="suggestion-meta">
              {verdict !== null ? (
                <span
                  class={`pill ${verdict === 'good' ? 'pill--ok' : verdict === 'long' ? 'pill--warn' : 'pill--err'}`}
                  title={
                    verdict === 'good'
                      ? 'Fits YouTube search results without truncation'
                      : verdict === 'long'
                        ? 'Longer than ~60 characters, so search and mobile feeds will cut the end off'
                        : "Over YouTube's 100-character limit"
                  }
                >
                  {item.text.length} chars
                </span>
              ) : null}
              {item.note !== null ? <span class="suggestion-note">{item.note}</span> : null}
              <button
                type="button"
                class="copy-one"
                onClick={() => {
                  void copyText(item.text).then((ok) => {
                    setCopiedIndex(ok ? index : null);
                  });
                }}
              >
                {copiedIndex === index ? 'Copied' : 'Copy'}
              </button>
            </div>
          </li>
        );
      })}
    </ol>
  );
}

/**
 * Transcript state, and the one action that can obtain one.
 *
 * WHY THERE IS AN ACTION AT ALL. `get_captions_timings` fires only when Studio's
 * subtitles editor opens, and it cannot be summoned: replaying the request needs
 * the transcript text, which is the thing being requested. So the design is to
 * capture it whenever it happens and give the user one click that opens the
 * editor — IN PLACE, because it is a modal over this same page, not a separate
 * one. An earlier version opened a new tab and told the user to come back; that
 * was based on a wrong reading of Studio and was pure friction.
 *
 * When a capture was seen but rejected, this says WHY. Reporting "no timings"
 * identically for "never fired" and "fired but the shape changed" leaves the user
 * with nothing to act on.
 */
function TranscriptStatus({
  task,
  required,
}: {
  readonly task: TaskType;
  readonly required: boolean;
}): JSX.Element {
  const available = transcript.value;
  const video = currentVideo.value;
  const attempt = lastTranscriptAttempt.value;
  const [clicked, setClicked] = useState<OpenResult | null>(null);

  if (available !== null) {
    const words = transcriptWordCount(available);
    const covers = video === null || coversVideo(available, video.durationSec);
    const enabled = transcriptEnabledFor(task);

    return (
      <div class="rails transcript-rails">
        {/*
         * A switch only where there is a real choice. Chapters cannot run without
         * timings, so offering to disable them would only offer a broken run —
         * hence `required` gets a static pill instead.
         */}
        {required ? (
          <span class="pill pill--ok" title={`${words} words, language ${available.language}`}>
            transcript ready · {available.segments.length} segments
          </span>
        ) : (
          <label class="switch" title={`${words} words, language ${available.language}`}>
            <input
              type="checkbox"
              checked={enabled}
              onChange={(event) => {
                toggleTranscriptFor(task, event.currentTarget.checked);
              }}
            />
            <span class="switch-track" aria-hidden="true">
              <span class="switch-knob" />
            </span>
            <span class="switch-label">
              Use transcript
              <span class="switch-meta"> · {available.segments.length} segments</span>
            </span>
          </label>
        )}

        {enabled ? (
          <span class="pill pill--muted">covers to {formatTimestamp(available.coverageMs)}</span>
        ) : (
          <span class="pill pill--muted">metadata only</span>
        )}

        {enabled && !covers ? (
          <span
            class="pill pill--warn"
            title="The timings stop well before the video ends, so the later part is not represented."
          >
            partial coverage
          </span>
        ) : null}
      </div>
    );
  }

  /*
   * OPTIONAL TASKS GET ONE LINE. Titles, descriptions, hooks and tags all work
   * without a transcript — they are merely better with one. Showing them a
   * warning banner, three sentences of explanation and a call-to-action button
   * put a blocking-looking obstacle in front of a task that was not blocked, and
   * pushed the actual output below the fold. One muted line states the fact and
   * gets out of the way.
   */
  if (!required) {
    return (
      <p class="note note--sm transcript-hint">
        No transcript captured — running on metadata only.
      </p>
    );
  }

  return (
    <div class="banner banner--warn">
      <p class="note note--sm">
        Chapters need real caption timings — without them any timestamp would be guessed, which is
        worse than no chapters.
      </p>

      {attempt === null ? (
        <p class="note note--sm">
          Open Studio&apos;s subtitles editor on this page and NeuraTube captures them
          automatically. The panel stays where it is.
        </p>
      ) : (
        <>
          <p class="note note--sm">
            Studio sent caption data NeuraTube could not read. Send this line to the developer:
          </p>
          <p class="note note--sm mono" data-testid="transcript-diagnosis">
            {attempt.kind} · {attempt.bytes}B
            {attempt.skipped !== null ? ` · skipped=${attempt.skipped}` : ''} · {attempt.reason}
            {attempt.topLevelKeys.length > 0 ? ` · keys=[${attempt.topLevelKeys.join(', ')}]` : ''}
          </p>
        </>
      )}

      {/* Deliberately NOT `.task-actions`: that class belongs to the output's
          copy controls, and sharing it made `.task-actions button` ambiguous. */}
      <div class="transcript-actions">
        <button
          type="button"
          onClick={() => {
            setClicked(openSubtitlesEditor());
          }}
        >
          Open subtitles editor
        </button>
      </div>

      {clicked === 'opened-in-place' ? (
        <p class="note note--sm">
          Opening it here — the transcript appears in this panel with no reload.
        </p>
      ) : null}
      {clicked === 'not-found' ? (
        <p class="note note--sm">
          Could not find Studio&apos;s Subtitles control on this page. Click Subtitles yourself and
          NeuraTube will capture the timings.
        </p>
      ) : null}
    </div>
  );
}

/**
 * Why the output is empty, and what to do about it.
 *
 * Deliberately specific. A generic "no output" message is barely better than the
 * blank box it replaces; naming the token budget and the reasoning character
 * count is what lets the user act without guessing.
 */
function EmptyOutputNotice({
  task,
  run,
  maxTokens,
}: {
  readonly task: TaskType;
  readonly run: TaskRun;
  readonly maxTokens: number;
}): JSX.Element {
  const [raisedTo, setRaisedTo] = useState<number | null>(null);
  const diagnosis = diagnoseEmpty({
    finishReason: run.finishReason,
    reasoningChars: run.reasoningChars,
    outputTokens: run.usage?.outputTokens ?? null,
    maxTokens,
  });

  return (
    <div class="banner banner--warn" role="alert" data-testid="empty-output">
      <p class="note note--sm">
        <strong>No output.</strong> {diagnosis.cause}
      </p>
      {diagnosis.action !== null ? <p class="note note--sm">{diagnosis.action}</p> : null}

      {/* Fix it here rather than sending the user to another tab. This banner
          appears exactly when they are blocked. */}
      {diagnosis.suggestsMoreTokens ? (
        <div class="transcript-actions">
          <button
            type="button"
            onClick={() => {
              const target = raiseLimitFor(task);
              setRaisedTo(target);
              startTask(task, currentVideo.value, transcript.value);
            }}
          >
            Raise to {reasoningCeiling(task)} tokens and retry
          </button>
        </div>
      ) : null}
      {raisedTo !== null ? (
        <p class="note note--sm">
          Limit for this task raised to {raisedTo} tokens and saved. Change it any time in Options →
          Advanced.
        </p>
      ) : null}
      {run.reasoningPreview !== '' ? (
        <details class="reasoning-peek">
          <summary class="note note--sm">Show the model’s thinking</summary>
          <pre class="output output--peek">{run.reasoningPreview}</pre>
        </details>
      ) : null}
    </div>
  );
}
