import type { JSX } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import { PROVIDER_SPECS } from '~/providers/specs';
import { PROVIDER_IDS } from '~/providers/types';
import type { ProviderId, Usage } from '~/providers/types';
import { estimateCost, formatUsd } from '~/providers/pricing';
import { formatTokens } from '~/orchestrator/costMeter';
import { TASK_TYPES, TASKS } from '~/orchestrator/tasks';
import type { TaskType } from '~/orchestrator/tasks';
import { openTaskStream } from '~/orchestrator/stream';
import type { TaskStream } from '~/orchestrator/stream';
import type { VideoContext } from '~/types/VideoContext';
import type { Store } from './useStore';

/**
 * Run a task against sample metadata.
 *
 * This exists for two reasons, and the second matters more.
 *
 * For the user: it is the difference between "the key is valid" and "the whole
 * pipeline works". Test connection proves auth; this proves prompts, routing,
 * streaming, usage reporting and cost accounting.
 *
 * For the project: the streaming port needs a real consumer in M3. Building the
 * transport now and only exercising it in M5 would mean shipping untested
 * plumbing, and the failure modes here — a worker killed mid-stream, a dropped
 * port, usage never arriving — are exactly the sort that do not show up until
 * something real reads them.
 */
export function TryItPanel({ store }: { readonly store: Store }): JSX.Element {
  const [task, setTask] = useState<TaskType>('generate_tags');
  const [forced, setForced] = useState<ProviderId | ''>('');
  const [title, setTitle] = useState('Build an AI Agent in 12 Minutes (Full Tutorial)');
  const [description, setDescription] = useState(
    'A walkthrough of building a working AI agent from scratch, covering the tool layer, streaming responses and deployment.',
  );
  const [tags, setTags] = useState('ai agent, langchain, python tutorial');

  const [output, setOutput] = useState('');
  const [running, setRunning] = useState(false);
  const [ranOn, setRanOn] = useState<{ provider: ProviderId; model: string } | null>(null);
  const [usage, setUsage] = useState<Usage | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [firstTokenMs, setFirstTokenMs] = useState<number | null>(null);

  const streamRef = useRef<TaskStream | null>(null);
  const requestRef = useRef<string | null>(null);
  const startedRef = useRef(0);

  useEffect(() => {
    const stream = openTaskStream({
      onEvent: (event) => {
        switch (event.type) {
          case 'provider':
            setRanOn({ provider: event.provider, model: event.model });
            break;
          case 'text':
            setOutput((current) => {
              if (current === '')
                setFirstTokenMs(Math.round(performance.now() - startedRef.current));
              return current + event.text;
            });
            break;
          case 'usage':
            // Replacement, not increment: Anthropic reports cumulatively.
            setUsage(event.usage);
            break;
          case 'done':
            setRunning(false);
            requestRef.current = null;
            break;
          case 'error':
            setError(event.message);
            setRunning(false);
            requestRef.current = null;
            break;
        }
      },
      onInterrupted: (partial) => {
        setRunning(false);
        setError(
          'The connection to the extension service worker dropped mid-run. Showing what arrived.',
        );
        if (partial !== '') setOutput(partial);
      },
    });

    streamRef.current = stream;
    return () => {
      stream.disconnect();
      streamRef.current = null;
    };
  }, []);

  const ready = PROVIDER_IDS.some(
    (id) =>
      (store.credentials[id] ?? '') !== '' &&
      store.state.providers[id].enabled &&
      store.state.providers[id].model !== '',
  );

  const run = (): void => {
    const stream = streamRef.current;
    if (!stream) return;

    setOutput('');
    setError(null);
    setUsage(null);
    setRanOn(null);
    setFirstTokenMs(null);
    setRunning(true);
    startedRef.current = performance.now();

    requestRef.current = stream.run({
      task,
      video: sampleVideo(title, description, tags),
      ...(forced === '' ? {} : { forceProvider: forced }),
    });
  };

  const cancel = (): void => {
    const requestId = requestRef.current;
    if (requestId !== null) streamRef.current?.cancel(requestId);
    setRunning(false);
    requestRef.current = null;
  };

  const cost =
    usage && ranOn
      ? estimateCost(
          ranOn.provider,
          ranOn.model,
          usage.inputTokens,
          usage.outputTokens,
          store.state.pricingOverrides,
        )
      : null;

  return (
    <section class="card">
      <h3>Try a task</h3>
      <p class="muted small">
        Runs a real request against sample metadata, so you can check the whole pipeline — prompt,
        routing, streaming and cost — before going near Studio. This spends tokens on your key.
      </p>

      {!ready ? (
        <p class="banner warn small">
          No provider is ready. A provider needs a key, needs to be enabled, and needs a model
          selected.
        </p>
      ) : null}

      <div class="grid-2">
        <div class="field">
          <label for="try-task">Task</label>
          <select
            id="try-task"
            value={task}
            onChange={(event) => {
              setTask(event.currentTarget.value as TaskType);
            }}
          >
            {TASK_TYPES.map((type) => (
              <option key={type} value={type}>
                {TASKS[type].label}
              </option>
            ))}
          </select>
        </div>

        <div class="field">
          <label for="try-provider">Provider</label>
          <select
            id="try-provider"
            value={forced}
            onChange={(event) => {
              setForced(event.currentTarget.value as ProviderId | '');
            }}
          >
            <option value="">Use routing</option>
            {PROVIDER_IDS.map((id) => (
              <option key={id} value={id}>
                {PROVIDER_SPECS[id].label}
              </option>
            ))}
          </select>
        </div>
      </div>

      <div class="field">
        <label for="try-title">Sample title</label>
        <input
          id="try-title"
          type="text"
          value={title}
          onInput={(event) => {
            setTitle(event.currentTarget.value);
          }}
        />
      </div>

      <div class="field">
        <label for="try-description">Sample description</label>
        <textarea
          id="try-description"
          rows={3}
          value={description}
          onInput={(event) => {
            setDescription(event.currentTarget.value);
          }}
        />
      </div>

      <div class="field">
        <label for="try-tags">Sample tags (comma separated)</label>
        <input
          id="try-tags"
          type="text"
          value={tags}
          onInput={(event) => {
            setTags(event.currentTarget.value);
          }}
        />
      </div>

      <div class="row">
        <button type="button" onClick={run} disabled={running || !ready}>
          {running ? 'Running…' : 'Run task'}
        </button>
        {running ? (
          <button type="button" class="ghost" onClick={cancel}>
            Cancel
          </button>
        ) : null}
        {ranOn !== null ? (
          <span class="pill">
            {PROVIDER_SPECS[ranOn.provider].label} · <code>{ranOn.model}</code>
          </span>
        ) : null}
        {firstTokenMs !== null ? (
          <span class={`pill ${firstTokenMs < 800 ? 'ok' : 'warn'}`}>
            first token {firstTokenMs} ms
          </span>
        ) : null}
      </div>

      {error !== null ? <p class="small error">{error}</p> : null}

      {output !== '' || running ? (
        <pre class="output" aria-live="polite" aria-busy={running}>
          {output}
          {running ? <span class="caret" /> : null}
        </pre>
      ) : null}

      {usage !== null ? (
        <p class="muted small">
          {formatTokens(usage.inputTokens)} in · {formatTokens(usage.outputTokens)} out
          {usage.cachedInputTokens !== undefined
            ? ` · ${formatTokens(usage.cachedInputTokens)} cached`
            : ''}{' '}
          · {cost === null ? 'cost unknown for this model' : formatUsd(cost)}
        </p>
      ) : null}
    </section>
  );
}

/**
 * Build a synthetic VideoContext from the sample fields.
 *
 * Deliberately fills every field with a plausible, benign value rather than
 * leaving holes: the point is to exercise the same code path a real video takes,
 * including the compliance-flag rendering.
 */
function sampleVideo(title: string, description: string, tags: string): VideoContext {
  return {
    videoId: 'sample00000',
    title,
    description,
    tags: tags
      .split(',')
      .map((tag) => tag.trim())
      .filter((tag) => tag !== ''),
    suggestedHashtags: ['#ai', '#coding'],
    descriptionHashtags: [],
    durationSec: 742,
    publishedAtMs: Date.parse('2026-01-15T00:00:00Z'),
    channelId: 'UCsample0000000000000000',
    category: 'Science & Technology',
    categoryRaw: 'CREATOR_VIDEO_CATEGORY_TECH',
    license: 'STANDARD_YOUTUBE_LICENSE',
    privacy: 'public',
    status: 'processed',
    metadataLanguage: 'en',
    madeForKids: false,
    ageRestricted: false,
    allowEmbed: true,
    allowRatings: true,
    paidPromotion: false,
    alteredContent: 'no',
    originalFilename: null,
    shareUrl: 'https://youtu.be/sample00000',
    thumbnails: [],
    abTest: { state: 'none', result: null, arms: [] },
    monetization: { effectiveStatus: 'UNKNOWN', selfCertDecision: 'UNKNOWN' },
    copyright: { activeClaimCount: 0, hasImpact: false },
  };
}
