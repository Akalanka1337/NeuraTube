/**
 * Task streaming over a long-lived port.
 *
 * THE SERVICE WORKER LIFECYCLE IS THE WHOLE DESIGN CONSTRAINT.
 *
 * Chrome terminates an extension service worker after 30 seconds of inactivity.
 * The detail that catches people out — and which the brief's architecture does
 * not mention — is that *opening* a port no longer resets that timer. Only
 * sending a message on it does. So a task whose provider goes quiet for 30
 * seconds mid-generation gets its worker killed, and the user watches a
 * half-finished response stop forever with no error.
 *
 * Three mitigations, all necessary:
 *
 *  1. HEARTBEAT. The worker posts a keep-alive every 20 seconds while a task is
 *    running. Each message resets the idle timer. 20s against a 30s budget
 *    leaves room for a slow message to land.
 *  2. PARTIAL PERSISTENCE. Output so far is written to `storage.session` keyed by
 *    request id, so if the worker dies anyway the consumer can show what it got
 *    instead of losing it.
 *  3. RECONNECT ON BFCACHE RESTORE. Chrome 123+ closes ports when a page enters
 *    the back/forward cache. The consumer side reconnects on `pageshow` when
 *    `event.persisted` is true, and resumes display from the persisted partial.
 *
 * There is still a hard 5-minute ceiling on a single task; nothing can extend
 * that, so `MAX_TASK_MS` fails cleanly just inside it rather than being killed.
 */

import { createLogger } from '~/lib/logger';
import { readState } from '~/storage/local';
import type { ProviderId, Usage } from '~/providers/types';
import { computeRequestCost, recordRequest } from './costMeter';
import type { TaskInputs } from './context';
import { runTask } from './runTask';
import type { TaskEvent } from './runTask';
import type { TaskType } from './tasks';
import type { VideoContext } from '~/types/VideoContext';

const log = createLogger('stream');

/** Port name. Must match on both sides. */
export const TASK_PORT = 'neuratube:task';

/** Interval between keep-alives. Comfortably inside the 30s idle timeout. */
export const HEARTBEAT_MS = 20_000;

/** Hard ceiling, just inside Chrome's 5-minute single-task limit. */
export const MAX_TASK_MS = 4 * 60 * 1000 + 30_000;

/** Prefix for partial output in `storage.session`. */
const PARTIAL_PREFIX = 'neuratube:partial:';

/* -------------------------------------------------------------------------- */
/* Wire messages                                                               */
/* -------------------------------------------------------------------------- */

export interface RunMessage {
  readonly type: 'run';
  readonly requestId: string;
  readonly task: TaskType;
  readonly video: VideoContext | null;
  readonly inputs?: TaskInputs;
  readonly forceProvider?: ProviderId;
  /** Per-task overrides resolved in the panel; see RunTaskRequest.limits. */
  readonly limits?: { readonly maxTokens?: number; readonly temperature?: number };
}

export interface CancelMessage {
  readonly type: 'cancel';
  readonly requestId: string;
}

export type PortRequest = RunMessage | CancelMessage;

export type PortResponse =
  | { readonly type: 'event'; readonly requestId: string; readonly event: TaskEvent }
  | { readonly type: 'heartbeat' };

/* -------------------------------------------------------------------------- */
/* Partial output persistence                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Persist output so far.
 *
 * `storage.session` is deliberate: partial AI output is not worth writing to
 * disk, and it should not survive a browser restart. It is cleared when the run
 * completes.
 */
async function savePartial(requestId: string, text: string): Promise<void> {
  try {
    await chrome.storage.session.set({ [`${PARTIAL_PREFIX}${requestId}`]: text });
  } catch {
    // Best effort. Losing the resume buffer is not worth failing the run over.
  }
}

async function clearPartial(requestId: string): Promise<void> {
  try {
    await chrome.storage.session.remove(`${PARTIAL_PREFIX}${requestId}`);
  } catch {
    // Ditto.
  }
}

/** Read whatever a killed worker managed to persist. */
export async function readPartial(requestId: string): Promise<string> {
  try {
    const key = `${PARTIAL_PREFIX}${requestId}`;
    const bag = await chrome.storage.session.get(key);
    const value = bag[key];
    return typeof value === 'string' ? value : '';
  } catch {
    return '';
  }
}

/* -------------------------------------------------------------------------- */
/* Service worker side                                                         */
/* -------------------------------------------------------------------------- */

/**
 * Serve one connected port.
 *
 * Registered from `chrome.runtime.onConnect`. Handles any number of sequential
 * runs on the same port; a second `run` for a request already in flight is
 * ignored rather than starting a duplicate.
 */
export function serveTaskPort(port: chrome.runtime.Port): void {
  const inFlight = new Map<string, AbortController>();
  let heartbeat: ReturnType<typeof setInterval> | null = null;

  const post = (message: PortResponse): boolean => {
    try {
      port.postMessage(message);
      return true;
    } catch {
      // Consumer disconnected mid-run.
      return false;
    }
  };

  const startHeartbeat = (): void => {
    if (heartbeat !== null) return;
    heartbeat = setInterval(() => {
      // Each message resets the worker's idle timer. Without this a provider
      // that pauses for 30 seconds gets the worker killed mid-generation.
      if (!post({ type: 'heartbeat' })) stopHeartbeat();
    }, HEARTBEAT_MS);
  };

  const stopHeartbeat = (): void => {
    if (heartbeat === null) return;
    clearInterval(heartbeat);
    heartbeat = null;
  };

  const execute = async (message: RunMessage): Promise<void> => {
    if (inFlight.has(message.requestId)) {
      log.warn('duplicate run ignored', message.requestId);
      return;
    }

    const controller = new AbortController();
    inFlight.set(message.requestId, controller);
    startHeartbeat();

    // Nothing can extend the 5-minute single-task ceiling, so fail cleanly just
    // inside it rather than being killed without an error.
    const ceiling = setTimeout(() => {
      controller.abort(new DOMException('Task exceeded its time limit', 'TimeoutError'));
    }, MAX_TASK_MS);

    let accumulated = '';
    let lastPersistedLength = 0;
    // Usage arrives cumulatively (Anthropic) or once at the end (OpenAI-shaped),
    // so the last report is always the complete one.
    let latestUsage: Usage | null = null;
    let ranOn: { provider: ProviderId; model: string } | null = null;

    try {
      for await (const event of runTask({
        task: message.task,
        video: message.video,
        ...(message.inputs ? { inputs: message.inputs } : {}),
        ...(message.forceProvider ? { forceProvider: message.forceProvider } : {}),
        ...(message.limits ? { limits: message.limits } : {}),
        signal: controller.signal,
      })) {
        if (event.type === 'provider') {
          ranOn = { provider: event.provider, model: event.model };
        }

        if (event.type === 'usage') {
          latestUsage = event.usage;
        }

        if (event.type === 'text') {
          accumulated += event.text;
          // Persist in chunks rather than per token: a storage write per token
          // would dominate the cost of streaming.
          if (accumulated.length - lastPersistedLength >= 512) {
            lastPersistedLength = accumulated.length;
            void savePartial(message.requestId, accumulated);
          }
        }

        if (!post({ type: 'event', requestId: message.requestId, event })) break;
      }
    } catch (thrown) {
      // runTask yields errors rather than throwing, so this is a genuine defect
      // — but it must still reach the consumer instead of hanging it.
      log.error('task threw', thrown);
      post({
        type: 'event',
        requestId: message.requestId,
        event: {
          type: 'error',
          kind: 'unknown',
          message: 'The task failed unexpectedly.',
          provider: null,
          retryable: false,
        },
      });
    } finally {
      clearTimeout(ceiling);
      inFlight.delete(message.requestId);
      if (inFlight.size === 0) stopHeartbeat();
      void clearPartial(message.requestId);

      // Book the spend here rather than in the consumer: the worker sees every
      // task, and a panel reporting its own usage could not be relied on.
      if (latestUsage !== null && ranOn !== null) {
        const { pricingOverrides } = await readState();
        await recordRequest(
          computeRequestCost(ranOn.provider, ranOn.model, latestUsage, pricingOverrides),
        );
      }
    }
  };

  port.onMessage.addListener((raw: unknown) => {
    const message = raw as PortRequest;
    if (message.type === 'run') {
      void execute(message);
    } else if (message.type === 'cancel') {
      inFlight.get(message.requestId)?.abort(new DOMException('Cancelled', 'AbortError'));
    }
  });

  port.onDisconnect.addListener(() => {
    // Abandon everything: there is no one left to receive it, and a still-running
    // fetch would keep the worker alive for nothing.
    for (const controller of inFlight.values()) {
      controller.abort(new DOMException('Port disconnected', 'AbortError'));
    }
    inFlight.clear();
    stopHeartbeat();
  });
}

/* -------------------------------------------------------------------------- */
/* Consumer side                                                               */
/* -------------------------------------------------------------------------- */

export interface TaskStreamHandlers {
  onEvent(event: TaskEvent): void;
  /** Called when the port drops mid-run, with whatever was persisted. */
  onInterrupted?(partial: string): void;
}

export interface TaskStream {
  /** Start a run. Resolves with the request id. */
  run(request: Omit<RunMessage, 'type' | 'requestId'>): string;
  cancel(requestId: string): void;
  disconnect(): void;
}

/**
 * Open a task stream.
 *
 * Reconnects automatically if the port drops, including on BFCache restore
 * (Chrome 123+ closes ports when a page is cached), and reports any partial
 * output the worker managed to persist so the consumer can show it rather than
 * losing it.
 */
export function openTaskStream(handlers: TaskStreamHandlers): TaskStream {
  let port: chrome.runtime.Port | null = null;
  let closed = false;
  const active = new Set<string>();

  const connect = (): chrome.runtime.Port => {
    const connected = chrome.runtime.connect({ name: TASK_PORT });

    connected.onMessage.addListener((raw: unknown) => {
      const message = raw as PortResponse;
      // Heartbeats exist only to keep the worker alive; they carry no data.
      if (message.type === 'heartbeat') return;
      if (message.type !== 'event') return;

      if (message.event.type === 'done' || message.event.type === 'error') {
        active.delete(message.requestId);
      }
      handlers.onEvent(message.event);
    });

    connected.onDisconnect.addListener(() => {
      port = null;
      if (closed) return;

      // Any run still marked active was cut off. Surface the partial rather than
      // letting the UI hang on a stream that will never resume.
      for (const requestId of active) {
        void readPartial(requestId).then((partial) => {
          handlers.onInterrupted?.(partial);
        });
      }
      active.clear();
    });

    return connected;
  };

  const ensure = (): chrome.runtime.Port => {
    port ??= connect();
    return port;
  };

  // Chrome 123+ closes ports on BFCache entry, so a restored page must reconnect
  // before its next run rather than posting into a dead port.
  const onPageShow = (event: PageTransitionEvent): void => {
    if (event.persisted && !closed) {
      port = null;
    }
  };
  // Guarded: the options page has a window, but this module is also imported by
  // the worker, which does not.
  if (typeof window !== 'undefined') {
    window.addEventListener('pageshow', onPageShow);
  }

  return {
    run(request) {
      const requestId = crypto.randomUUID();
      active.add(requestId);
      ensure().postMessage({ type: 'run', requestId, ...request } satisfies RunMessage);
      return requestId;
    },
    cancel(requestId) {
      active.delete(requestId);
      try {
        port?.postMessage({ type: 'cancel', requestId } satisfies CancelMessage);
      } catch {
        // Already gone.
      }
    },
    disconnect() {
      closed = true;
      active.clear();
      if (typeof window !== 'undefined') {
        window.removeEventListener('pageshow', onPageShow);
      }
      try {
        port?.disconnect();
      } catch {
        // Already gone.
      }
      port = null;
    },
  };
}
