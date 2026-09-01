import type { JSX } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import { DEFAULT_PROMPTS, resolvePrompt } from '~/orchestrator/promptStore';
import { TASK_TYPES, TASKS } from '~/orchestrator/tasks';
import type { TaskType } from '~/orchestrator/tasks';
import type { Store } from './useStore';

/**
 * Prompt editor.
 *
 * A PLAIN TEXTAREA, not CodeMirror or Monaco — a deliberate change from the
 * original plan, which specified Monaco. Three reasons:
 *
 *  1. Monaco is over 2MB minified, which alone would exceed the project's entire
 *     unpacked bundle budget. CodeMirror 6 is ~100KB but still six packages.
 *  2. These are markdown prose prompts, not code. Syntax highlighting, folding,
 *     autocomplete and a language server add nothing to editing English.
 *  3. Fewer dependencies is a real security property in an extension that holds
 *     API keys.
 *
 * What actually matters here is the versioning: a user edits a prompt, we ship a
 * better default three releases later, and their override shadows it silently
 * forever. So an override records which default it was written against, and this
 * panel says so when that default has moved on.
 */
export function PromptsPanel({ store }: { readonly store: Store }): JSX.Element {
  const [selected, setSelected] = useState<TaskType>('optimize_title');
  const [draft, setDraft] = useState('');
  const [dirty, setDirty] = useState(false);

  const override = store.state.prompts[selected];
  const resolved = resolvePrompt(selected, override);

  // Reload the draft when the selected task changes, or when the stored value
  // changes underneath us — but never while the user has unsaved edits.
  useEffect(() => {
    if (dirty) return;
    setDraft(resolved.text);
  }, [selected, resolved.text, dirty]);

  const save = (): void => {
    void store.savePrompt(selected, draft).then(() => {
      setDirty(false);
    });
  };

  const reset = (): void => {
    void store.resetPrompt(selected).then(() => {
      setDraft(DEFAULT_PROMPTS[selected]);
      setDirty(false);
    });
  };

  const definition = TASKS[selected];

  return (
    <div class="split">
      <nav class="tasklist" aria-label="Tasks">
        {TASK_TYPES.map((task) => {
          const isOverridden = store.state.prompts[task] !== undefined;
          return (
            <button
              key={task}
              type="button"
              class={`tasklist-item ${task === selected ? 'is-active' : ''}`}
              aria-current={task === selected}
              onClick={() => {
                setSelected(task);
                setDirty(false);
              }}
            >
              <span>{TASKS[task].label}</span>
              {isOverridden ? (
                <span class="dot" title="Customised">
                  ●
                </span>
              ) : null}
            </button>
          );
        })}
      </nav>

      <section class="card">
        <h3>{definition.label}</h3>
        <p class="muted small">{definition.description}</p>

        <dl class="kv small">
          <dt>Temperature</dt>
          <dd>{definition.temperature}</dd>
          <dt>Max output</dt>
          <dd>{definition.maxTokens} tokens</dd>
          <dt>Default version</dt>
          <dd>
            <code>{resolved.currentDefaultVersion}</code>
          </dd>
          <dt>Status</dt>
          <dd>
            {resolved.isOverridden ? (
              <span class="pill warn">customised</span>
            ) : (
              <span class="pill">shipped default</span>
            )}
          </dd>
        </dl>

        {resolved.isStale ? (
          <p class="banner warn small">
            This prompt was customised against default version{' '}
            <code>{resolved.overrideBasedOn}</code>, but the shipped default has since changed to{' '}
            <code>{resolved.currentDefaultVersion}</code>. Your version is still being used. Reset
            to adopt the new default, or keep yours.
          </p>
        ) : null}

        <label class="sr-only" for="prompt-editor">
          System prompt for {definition.label}
        </label>
        <textarea
          id="prompt-editor"
          class="prompt-editor"
          spellcheck={false}
          value={draft}
          rows={22}
          onInput={(event) => {
            setDraft(event.currentTarget.value);
            setDirty(true);
          }}
          onKeyDown={(event) => {
            // Tab inserts two spaces rather than leaving the field: a prompt with
            // indented structure is common and tabbing out mid-edit is jarring.
            if (event.key === 'Tab') {
              event.preventDefault();
              const target = event.currentTarget;
              const { selectionStart, selectionEnd, value } = target;
              const next = `${value.slice(0, selectionStart)}  ${value.slice(selectionEnd)}`;
              setDraft(next);
              setDirty(true);
              requestAnimationFrame(() => {
                target.selectionStart = selectionStart + 2;
                target.selectionEnd = selectionStart + 2;
              });
            }
          }}
        />

        <div class="row">
          <button type="button" onClick={save} disabled={!dirty}>
            {dirty ? 'Save prompt' : 'Saved'}
          </button>
          <button
            type="button"
            class="ghost"
            disabled={!resolved.isOverridden && !dirty}
            onClick={reset}
          >
            Reset to shipped default
          </button>
          <span class="muted small">{draft.length} characters</span>
        </div>

        <p class="muted small">
          Every prompt ships in the extension package — MV3 forbids remotely hosted logic, and an
          opaque prompt is one of the things this project exists to fix. Each one ends with a
          section instructing the model to treat video metadata as data rather than instructions;
          keep it if you edit the prompt, because that text is what contains a hostile title.
        </p>
      </section>
    </div>
  );
}
