/**
 * Options page state.
 *
 * The options page runs on the extension origin, so it reads and writes
 * `chrome.storage.local` directly. Provider *network* calls still go through the
 * service worker — one network surface is one thing to audit, and the panel
 * (M5) uses the same path.
 *
 * Writes go through a single `updateState` call rather than the `patch*`
 * helpers. Two concurrent patch helpers each read-modify-write and the later
 * write discards the earlier one's change; this project has already shipped that
 * bug once (see the M2 changelog), so the options page — which changes several
 * subtrees at once — must not use them.
 */

import { useCallback, useEffect, useState } from 'preact/hooks';
import type { ModelInfo, ProviderId, TestResult } from '~/providers/types';
import { PROVIDER_IDS } from '~/providers/types';
import type { PromptOverride } from '~/orchestrator/promptStore';
import { createOverride } from '~/orchestrator/promptStore';
import type { TaskRouting, TaskType } from '~/orchestrator/tasks';
import { readCredentials, writeCredential } from '~/storage/credentials';
import type { Credentials } from '~/storage/credentials';
import { onStateChanged, readState, updateState } from '~/storage/local';
import type { TaskLimits } from '~/storage/schema';
import type { NeuraTubeState, ProviderSettings } from '~/storage/schema';
import { defaultState } from '~/storage/schema';
import { sendToBackground } from '~/types/messages';

export interface ModelsState {
  readonly models: readonly ModelInfo[];
  readonly fetchedAt: number;
  readonly fromCache: boolean;
  readonly loading: boolean;
  readonly error: string | null;
}

const EMPTY_MODELS: ModelsState = {
  models: [],
  fetchedAt: 0,
  fromCache: false,
  loading: false,
  error: null,
};

export interface Store {
  readonly state: NeuraTubeState;
  /** Which providers have a key stored. Never the values. */
  readonly credentials: Credentials;
  readonly ready: boolean;
  readonly models: Readonly<Record<ProviderId, ModelsState>>;
  readonly tests: Readonly<Partial<Record<ProviderId, TestResult | 'running'>>>;

  saveKey(id: ProviderId, apiKey: string): Promise<void>;
  patchProvider(id: ProviderId, patch: Partial<ProviderSettings>): Promise<void>;
  loadModels(id: ProviderId, force?: boolean): Promise<void>;
  testProvider(id: ProviderId): Promise<void>;
  savePrompt(task: TaskType, text: string): Promise<void>;
  resetPrompt(task: TaskType): Promise<void>;
  setRouting(task: TaskType, routing: TaskRouting): Promise<void>;
  setPricingOverride(model: string, input: number, output: number): Promise<void>;
  clearPricingOverride(model: string): Promise<void>;
  resetUsage(): Promise<void>;
  /** Settings the About panel owns: diagnostics visibility and verbose logging. */
  patchSettings(patch: Partial<NeuraTubeState['settings']>): Promise<void>;
  /** Per-task token ceiling and temperature. An empty patch clears the override. */
  setTaskLimits(task: TaskType, limits: TaskLimits): Promise<void>;
}

function emptyModelsRecord(): Record<ProviderId, ModelsState> {
  const out = {} as Record<ProviderId, ModelsState>;
  for (const id of PROVIDER_IDS) out[id] = EMPTY_MODELS;
  return out;
}

export function useStore(): Store {
  const [state, setState] = useState<NeuraTubeState>(defaultState);
  const [credentials, setCredentials] = useState<Credentials>({});
  const [ready, setReady] = useState(false);
  const [models, setModels] = useState<Record<ProviderId, ModelsState>>(emptyModelsRecord);
  const [tests, setTests] = useState<Partial<Record<ProviderId, TestResult | 'running'>>>({});

  // Initial load, plus adoption of writes from other contexts (a panel toggling
  // its own visibility, for instance).
  useEffect(() => {
    let cancelled = false;

    void (async () => {
      const [loadedState, loadedCredentials] = await Promise.all([readState(), readCredentials()]);
      if (cancelled) return;
      setState(loadedState);
      setCredentials(loadedCredentials);
      setReady(true);
    })();

    const unsubscribe = onStateChanged((next) => {
      setState(next);
    });

    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, []);

  /** Apply a state mutation and adopt the result. */
  const mutate = useCallback(
    async (mutator: (current: NeuraTubeState) => NeuraTubeState): Promise<void> => {
      const next = await updateState(mutator);
      setState(next);
    },
    [],
  );

  const saveKey = useCallback(async (id: ProviderId, apiKey: string): Promise<void> => {
    await writeCredential(id, apiKey);
    setCredentials(await readCredentials());
    // A new key invalidates any previous test result and the cached model list.
    // Destructuring-omit rather than `delete`: `delete` on a hot object forces
    // V8 into dictionary mode, and the lint rule is right to flag it.
    setTests((current) => {
      const { [id]: _discarded, ...rest } = current;
      return rest;
    });
    setModels((current) => ({ ...current, [id]: EMPTY_MODELS }));
  }, []);

  const patchProvider = useCallback(
    async (id: ProviderId, patch: Partial<ProviderSettings>): Promise<void> => {
      await mutate((current) => ({
        ...current,
        providers: { ...current.providers, [id]: { ...current.providers[id], ...patch } },
      }));
    },
    [mutate],
  );

  const loadModels = useCallback(async (id: ProviderId, force = false): Promise<void> => {
    setModels((current) => ({ ...current, [id]: { ...current[id], loading: true, error: null } }));

    const reply = await sendToBackground({ type: 'list-models', provider: id, force });

    setModels((current) => {
      if (reply?.type !== 'models') {
        return {
          ...current,
          [id]: {
            ...current[id],
            loading: false,
            error: 'The extension service worker did not respond. Try again.',
          },
        };
      }
      return {
        ...current,
        [id]: {
          models: reply.models,
          fetchedAt: reply.fetchedAt,
          fromCache: reply.fromCache,
          loading: false,
          error: reply.error,
        },
      };
    });
  }, []);

  const testProvider = useCallback(async (id: ProviderId): Promise<void> => {
    setTests((current) => ({ ...current, [id]: 'running' }));
    const reply = await sendToBackground({ type: 'test-provider', provider: id });

    setTests((current) => ({
      ...current,
      [id]:
        reply?.type === 'provider-test'
          ? reply.result
          : {
              ok: false,
              latencyMs: 0,
              modelCount: null,
              error: 'The extension service worker did not respond. Try again.',
            },
    }));
  }, []);

  const savePrompt = useCallback(
    async (task: TaskType, text: string): Promise<void> => {
      const override: PromptOverride = createOverride(task, text);
      await mutate((current) => ({
        ...current,
        prompts: { ...current.prompts, [task]: override },
      }));
    },
    [mutate],
  );

  const resetPrompt = useCallback(
    async (task: TaskType): Promise<void> => {
      await mutate((current) => {
        const { [task]: _discarded, ...prompts } = current.prompts;
        return { ...current, prompts };
      });
    },
    [mutate],
  );

  const setRouting = useCallback(
    async (task: TaskType, routing: TaskRouting): Promise<void> => {
      await mutate((current) => ({
        ...current,
        routing: { ...current.routing, [task]: routing },
      }));
    },
    [mutate],
  );

  const setPricingOverride = useCallback(
    async (model: string, input: number, output: number): Promise<void> => {
      await mutate((current) => ({
        ...current,
        pricingOverrides: {
          ...current.pricingOverrides,
          [model]: { inputPerMillion: input, outputPerMillion: output },
        },
      }));
    },
    [mutate],
  );

  const clearPricingOverride = useCallback(
    async (model: string): Promise<void> => {
      await mutate((current) => {
        const { [model]: _discarded, ...pricingOverrides } = current.pricingOverrides;
        return { ...current, pricingOverrides };
      });
    },
    [mutate],
  );

  const patchSettings = useCallback(
    async (patch: Partial<NeuraTubeState['settings']>): Promise<void> => {
      // Through the shared `mutate`, which is one updateState call — and
      // updateState now serialises writes, so this cannot race the panel's own
      // persistence and silently lose either change.
      await mutate((current) => ({
        ...current,
        settings: { ...current.settings, ...patch },
      }));
    },
    [mutate],
  );

  const setTaskLimits = useCallback(
    async (task: TaskType, limits: TaskLimits): Promise<void> => {
      await mutate((current) => {
        /*
         * An empty patch means "use the shipped default", represented by ABSENCE
         * rather than by a stored copy of the default — otherwise a later tuning
         * pass could never reach this user.
         *
         * Rebuilt by filtering rather than mutated with `delete`, which keeps the
         * absence explicit and avoids a dynamic key deletion.
         */
        const cleared = limits.maxTokens === undefined && limits.temperature === undefined;
        const next = Object.fromEntries(
          Object.entries(current.taskLimits).filter(([key]) => key !== task),
        ) as typeof current.taskLimits;
        if (!cleared) next[task] = limits;
        return { ...current, taskLimits: next };
      });
    },
    [mutate],
  );

  const resetUsage = useCallback(async (): Promise<void> => {
    await mutate((current) => ({
      ...current,
      usage: { month: current.usage.month, byProvider: {} },
    }));
  }, [mutate]);

  return {
    state,
    credentials,
    ready,
    models,
    tests,
    saveKey,
    patchProvider,
    loadModels,
    testProvider,
    savePrompt,
    resetPrompt,
    setRouting,
    setPricingOverride,
    clearPricingOverride,
    resetUsage,
    patchSettings,
    setTaskLimits,
  };
}
