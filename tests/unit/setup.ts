/**
 * Vitest setup.
 *
 * Provides a small in-memory `chrome` stub. Deliberately hand-written rather
 * than pulled from a mocking package: the surface we touch is tiny, and a stub
 * we control lets each test assert on real storage behaviour (including the
 * onChanged fan-out that the content script depends on) instead of on mock call
 * counts.
 */

import { beforeEach, vi } from 'vitest';

type ChangeListener = (
  changes: Record<string, { oldValue?: unknown; newValue?: unknown }>,
  areaName: string,
) => void;

export interface ChromeStub {
  store: Map<string, unknown>;
  /** Separate area, because `storage.session` is a different bucket in Chrome. */
  session: Map<string, unknown>;
  /**
   * Whether anything ever widened `storage.session` access to content scripts.
   * The design deliberately does NOT, so a test asserts this stays null.
   */
  sessionAccessLevel: string | null;
  changeListeners: Set<ChangeListener>;
  messageListeners: Set<
    (message: unknown, sender: unknown, respond: (value: unknown) => void) => void
  >;
  sentToBackground: unknown[];
}

const stub: ChromeStub = {
  store: new Map(),
  session: new Map(),
  sessionAccessLevel: null,
  changeListeners: new Set(),
  messageListeners: new Set(),
  sentToBackground: [],
};

export function chromeStub(): ChromeStub {
  return stub;
}

function buildChrome(): unknown {
  return {
    runtime: {
      id: 'neuratube-test',
      lastError: undefined,
      getURL: (p: string) => `chrome-extension://neuratube-test/${p}`,
      sendMessage: (message: unknown) => {
        stub.sentToBackground.push(message);
        return Promise.resolve({ type: 'ack' });
      },
      onMessage: {
        addListener: (fn: never) => stub.messageListeners.add(fn),
        removeListener: (fn: never) => stub.messageListeners.delete(fn),
      },
      onInstalled: { addListener: () => undefined },
      onStartup: { addListener: () => undefined },
    },
    tabs: {
      query: () => Promise.resolve([]),
      sendMessage: () => Promise.resolve({ type: 'ack' }),
    },
    commands: {
      onCommand: { addListener: () => undefined },
    },
    storage: {
      local: {
        get: (key: string | string[] | null) => {
          if (key === null) return Promise.resolve(Object.fromEntries(stub.store));
          const keys = Array.isArray(key) ? key : [key];
          const out: Record<string, unknown> = {};
          for (const k of keys) {
            if (stub.store.has(k)) out[k] = stub.store.get(k);
          }
          return Promise.resolve(out);
        },
        set: (items: Record<string, unknown>) => {
          const changes: Record<string, { oldValue?: unknown; newValue?: unknown }> = {};
          for (const [k, v] of Object.entries(items)) {
            changes[k] = { oldValue: stub.store.get(k), newValue: v };
            stub.store.set(k, v);
          }
          for (const listener of stub.changeListeners) listener(changes, 'local');
          return Promise.resolve();
        },
        remove: (key: string) => {
          stub.store.delete(key);
          return Promise.resolve();
        },
        clear: () => {
          stub.store.clear();
          return Promise.resolve();
        },
      },
      session: {
        // `remove` accepts an array here, unlike the single-key `local` stub
        // above — the transcript cache evicts in batches.
        get: (key: string | string[] | null) => {
          if (key === null) return Promise.resolve(Object.fromEntries(stub.session));
          const keys = Array.isArray(key) ? key : [key];
          const out: Record<string, unknown> = {};
          for (const k of keys) {
            if (stub.session.has(k)) out[k] = stub.session.get(k);
          }
          return Promise.resolve(out);
        },
        set: (items: Record<string, unknown>) => {
          for (const [k, v] of Object.entries(items)) {
            // Round-trip through JSON: `storage.session` structured-clones, and
            // serialising here keeps tests honest about what comes back out.
            stub.session.set(k, JSON.parse(JSON.stringify(v)));
          }
          return Promise.resolve();
        },
        remove: (key: string | string[]) => {
          for (const k of Array.isArray(key) ? key : [key]) stub.session.delete(k);
          return Promise.resolve();
        },
        clear: () => {
          stub.session.clear();
          return Promise.resolve();
        },
        setAccessLevel: (options: { accessLevel: string }) => {
          stub.sessionAccessLevel = options.accessLevel;
          return Promise.resolve();
        },
      },
      onChanged: {
        addListener: (fn: ChangeListener) => stub.changeListeners.add(fn),
        removeListener: (fn: ChangeListener) => stub.changeListeners.delete(fn),
      },
    },
  };
}

beforeEach(() => {
  stub.store.clear();
  stub.session.clear();
  stub.sessionAccessLevel = null;
  stub.changeListeners.clear();
  stub.messageListeners.clear();
  stub.sentToBackground.length = 0;
  vi.stubGlobal('chrome', buildChrome());
});
