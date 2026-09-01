/**
 * Advanced: per-task token ceiling and temperature.
 *
 * WHY THIS IS A REAL SETTING AND NOT A KNOB FOR ITS OWN SAKE. The shipped
 * ceilings are sized for ordinary models. A reasoning model — DeepSeek R1, QwQ,
 * several NVIDIA NIM deployments — streams its chain of thought first and its
 * answer second, so a budget that comfortably fits five titles can be consumed
 * entirely by thinking, leaving no answer at all. Without a way to raise the
 * limit that failure has no fix.
 *
 * Only deviations are stored. That matters beyond tidiness: it means a later
 * tuning pass to the shipped defaults still reaches everyone who has not
 * explicitly overridden that task.
 */

import { useState } from 'preact/hooks';
import type { JSX } from 'preact';
import { TASKS, TASK_TYPES } from '~/orchestrator/tasks';
import type { TaskType } from '~/orchestrator/tasks';
import { MAX_TASK_TOKENS, MIN_TASK_TOKENS } from '~/storage/schema';
/*
 * ONE definition of the reasoning-sized ceiling, shared with the panel's
 * empty-output diagnosis. Two copies would let the advice the user reads and the
 * value this button applies drift apart.
 */
import { reasoningCeiling } from '~/state/taskStore';
import type { Store } from './useStore';

export function AdvancedPanel({ store }: { readonly store: Store }): JSX.Element {
  const overridden = TASK_TYPES.filter((task) => store.state.taskLimits[task] !== undefined).length;

  return (
    <>
      <section class="card">
        <h2>Token limits and temperature</h2>
        <p class="small muted">
          Each task ships with a ceiling sized for its output. Raise it when a model returns nothing
          or gets cut off mid-answer — <strong>reasoning models</strong> (DeepSeek R1, QwQ, and some
          NVIDIA NIM models) stream their thinking before the answer and can spend the whole budget
          on it, which shows up as an empty result.
        </p>
        <p class="small muted">
          Temperature controls how much the model varies. Low for anything structural (chapters,
          tags); higher for ideas and hooks. Leave a field blank to use the shipped default.
        </p>
        <p class="small muted">
          {overridden === 0
            ? 'Nothing overridden — every task uses its shipped default.'
            : `${overridden} of ${TASK_TYPES.length} tasks overridden. Only your changes are stored, so the rest follow future tuning.`}
        </p>
      </section>

      <section class="card">
        <table class="limits">
          <thead>
            <tr>
              <th scope="col">Task</th>
              <th scope="col">Max tokens</th>
              <th scope="col">Temperature</th>
              <th scope="col">
                <span class="sr-only">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {TASK_TYPES.map((task) => (
              <LimitRow key={task} task={task} store={store} />
            ))}
          </tbody>
        </table>
      </section>
    </>
  );
}

function LimitRow({
  task,
  store,
}: {
  readonly task: TaskType;
  readonly store: Store;
}): JSX.Element {
  const definition = TASKS[task];
  const override = store.state.taskLimits[task];

  // Local draft state so a half-typed number is not written to storage on every
  // keystroke, which would clamp "40" to the minimum before the user typed "4000".
  const [tokens, setTokens] = useState<string>(
    override?.maxTokens !== undefined ? String(override.maxTokens) : '',
  );
  const [temp, setTemp] = useState<string>(
    override?.temperature !== undefined ? String(override.temperature) : '',
  );

  const commit = (nextTokens: string, nextTemp: string): void => {
    const parsedTokens = nextTokens.trim() === '' ? undefined : Number(nextTokens);
    const parsedTemp = nextTemp.trim() === '' ? undefined : Number(nextTemp);
    void store.setTaskLimits(task, {
      ...(parsedTokens !== undefined && Number.isFinite(parsedTokens)
        ? { maxTokens: parsedTokens }
        : {}),
      ...(parsedTemp !== undefined && Number.isFinite(parsedTemp)
        ? { temperature: parsedTemp }
        : {}),
    });
  };

  const suggestion = reasoningCeiling(task);

  return (
    <tr data-task={task}>
      <th scope="row">
        {definition.label}
        <span class="small muted block">
          default {definition.maxTokens} tokens · temp {definition.temperature}
        </span>
      </th>
      <td>
        <input
          type="number"
          min={MIN_TASK_TOKENS}
          max={MAX_TASK_TOKENS}
          step={64}
          value={tokens}
          placeholder={String(definition.maxTokens)}
          aria-label={`Max tokens for ${definition.label}`}
          onInput={(event) => {
            setTokens(event.currentTarget.value);
          }}
          onBlur={() => {
            commit(tokens, temp);
          }}
        />
      </td>
      <td>
        <input
          type="number"
          min={0}
          max={2}
          step={0.1}
          value={temp}
          placeholder={String(definition.temperature)}
          aria-label={`Temperature for ${definition.label}`}
          onInput={(event) => {
            setTemp(event.currentTarget.value);
          }}
          onBlur={() => {
            commit(tokens, temp);
          }}
        />
      </td>
      <td class="limits-actions">
        <button
          type="button"
          class="ghost"
          title={`Raise to ${suggestion} tokens, enough for a reasoning model`}
          onClick={() => {
            setTokens(String(suggestion));
            commit(String(suggestion), temp);
          }}
        >
          For reasoning
        </button>
        <button
          type="button"
          class="ghost"
          disabled={override === undefined}
          onClick={() => {
            setTokens('');
            setTemp('');
            void store.setTaskLimits(task, {});
          }}
        >
          Reset
        </button>
      </td>
    </tr>
  );
}
