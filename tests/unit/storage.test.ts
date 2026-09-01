import { describe, expect, it } from 'vitest';
import {
  STATE_KEY,
  onStateChanged,
  patchPanelPrefs,
  patchSettings,
  readPanelPrefs,
  readState,
  updateState,
  writeState,
} from '~/storage/local';
import {
  DEFAULT_PANEL_PREFS,
  MAX_TASK_TOKENS,
  MIN_TASK_TOKENS,
  SCHEMA_VERSION,
  defaultState,
  migrate,
} from '~/storage/schema';
import { chromeStub } from './setup';

describe('migrate', () => {
  it('returns defaults for anything that is not an object', () => {
    for (const input of [undefined, null, 42, 'nope', [], true]) {
      expect(migrate(input)).toEqual(defaultState());
    }
  });

  it('returns defaults for a version from the future', () => {
    // A user who downgrades the extension must still get a working panel.
    expect(migrate({ schemaVersion: SCHEMA_VERSION + 5, panel: {} })).toEqual(defaultState());
  });

  it('returns defaults when no migration path exists from an older version', () => {
    expect(migrate({ schemaVersion: 0 })).toEqual(defaultState());
  });

  it('normalises a valid current-version blob', () => {
    const result = migrate({
      schemaVersion: SCHEMA_VERSION,
      settings: { debugLogging: true, theme: 'light', showDebugPanel: true },
      panel: { 'studio-edit': { visible: false, collapsed: true } },
    });
    expect(result.settings.theme).toBe('light');
    expect(result.settings.debugLogging).toBe(true);
    expect(result.panel['studio-edit']).toEqual({
      visible: false,
      collapsed: true,
      geometry: null,
    });
  });

  it('repairs wrong types field by field instead of discarding the blob', () => {
    const result = migrate({
      schemaVersion: SCHEMA_VERSION,
      settings: { debugLogging: 'yes', theme: 'chartreuse' },
      panel: { 'studio-edit': { visible: 'maybe', collapsed: true }, watch: 'garbage' },
    });
    expect(result.settings.debugLogging).toBe(false);
    expect(result.settings.theme).toBe('auto');
    // The salvageable half of the entry survives; the unsalvageable one is dropped.
    expect(result.panel['studio-edit']).toEqual({
      visible: true,
      collapsed: true,
      geometry: null,
    });
    expect(result.panel.watch).toBeUndefined();
  });

  it('migrates a v2 blob by seeding geometry on every surface', () => {
    const result = migrate({
      schemaVersion: 2,
      settings: { theme: 'dark' },
      panel: { 'studio-edit': { visible: false, collapsed: false } },
    });

    expect(result.schemaVersion).toBe(SCHEMA_VERSION);
    expect(result.panel['studio-edit']).toEqual({
      visible: false,
      collapsed: false,
      geometry: null,
    });
    // Pre-existing settings survive the migration.
    expect(result.settings.theme).toBe('dark');
  });

  it('keeps valid stored geometry through a migration', () => {
    const geometry = { x: 100, y: 200, width: 400, height: 600, snap: 'right' };
    const result = migrate({
      schemaVersion: SCHEMA_VERSION,
      panel: { watch: { visible: true, collapsed: false, geometry } },
    });
    expect(result.panel.watch?.geometry).toEqual(geometry);
  });

  it('discards malformed geometry rather than keeping half of it', () => {
    // Half a geometry would place the panel somewhere arbitrary; the default
    // position is always a safe answer.
    for (const bad of [
      { x: 1, y: 2, width: 3 },
      { x: 'a', y: 2, width: 3, height: 4 },
      { x: 1, y: 2, width: 0, height: 4 },
      { x: 1, y: 2, width: -5, height: 4 },
      { x: Number.NaN, y: 2, width: 3, height: 4 },
      'nope',
      null,
    ]) {
      const result = migrate({
        schemaVersion: SCHEMA_VERSION,
        panel: { watch: { visible: true, collapsed: false, geometry: bad } },
      });
      expect(result.panel.watch?.geometry, JSON.stringify(bad)).toBeNull();
    }
  });

  it('defaults an unrecognised snap edge to none', () => {
    const result = migrate({
      schemaVersion: SCHEMA_VERSION,
      panel: {
        watch: {
          visible: true,
          collapsed: false,
          geometry: { x: 1, y: 2, width: 400, height: 500, snap: 'diagonal' },
        },
      },
    });
    expect(result.panel.watch?.geometry?.snap).toBe('none');
  });

  it('always reports the current schema version', () => {
    expect(migrate({}).schemaVersion).toBe(SCHEMA_VERSION);
  });
});

describe('storage accessors', () => {
  it('round-trips state through chrome.storage.local', async () => {
    const state = defaultState();
    state.settings.debugLogging = true;
    expect(await writeState(state)).toBe(true);
    expect((await readState()).settings.debugLogging).toBe(true);
  });

  it('stores everything under a single key', async () => {
    await writeState(defaultState());
    expect([...chromeStub().store.keys()]).toEqual([STATE_KEY]);
  });

  it('returns defaults when storage is empty', async () => {
    expect(await readState()).toEqual(defaultState());
  });

  it('patches settings without clobbering unrelated fields', async () => {
    await patchSettings({ theme: 'light' });
    const settings = await patchSettings({ debugLogging: true });
    expect(settings.theme).toBe('light');
    expect(settings.debugLogging).toBe(true);
  });

  it('patches panel prefs per surface independently', async () => {
    await patchPanelPrefs('studio-edit', { visible: false });
    await patchPanelPrefs('watch', { collapsed: true });

    expect(await readPanelPrefs('studio-edit')).toEqual({
      visible: false,
      collapsed: false,
      geometry: null,
    });
    expect(await readPanelPrefs('watch')).toEqual({
      visible: true,
      collapsed: true,
      geometry: null,
    });
    // An untouched surface falls back to defaults.
    expect(await readPanelPrefs('search')).toEqual(DEFAULT_PANEL_PREFS);
  });

  it('no longer loses a change when two patch helpers run concurrently', async () => {
    // This test previously asserted the OPPOSITE, documenting a real hazard:
    // chrome.storage has no transaction, so each patch helper did its own
    // read-modify-write, and run together both read the same snapshot and the
    // later write discarded the earlier one's change.
    //
    // It shipped as a visible bug in M2 — hiding the panel wrote panel prefs and
    // settings in parallel, the settings write clobbered the visibility write,
    // and the panel reappeared 250ms after the user dismissed it. The workaround
    // was a rule ("always make one updateState call") that every new persisted
    // control had to remember. `updateState` now serialises writes within a
    // context, so the rule is enforced by the code instead of by discipline.
    await Promise.all([
      patchPanelPrefs('studio-edit', { visible: false }),
      patchSettings({ debugLogging: true }),
    ]);

    const state = await readState();
    expect(state.panel['studio-edit']?.visible).toBe(false);
    expect(state.settings.debugLogging).toBe(true);
  });

  it('applies changes to several subtrees atomically via a single updateState', async () => {
    // The correct way to do the above.
    await updateState((current) => ({
      ...current,
      settings: { ...current.settings, debugLogging: true },
      panel: {
        ...current.panel,
        'studio-edit': { visible: false, collapsed: true, geometry: null },
      },
    }));

    const state = await readState();
    expect(state.settings.debugLogging).toBe(true);
    expect(state.panel['studio-edit']).toEqual({
      visible: false,
      collapsed: true,
      geometry: null,
    });
  });

  it('notifies subscribers when another context writes', async () => {
    const seen: boolean[] = [];
    const unsubscribe = onStateChanged((state) => {
      seen.push(state.settings.debugLogging);
    });

    await patchSettings({ debugLogging: true });
    expect(seen).toEqual([true]);

    unsubscribe();
    await patchSettings({ debugLogging: false });
    // No further notifications after unsubscribe.
    expect(seen).toEqual([true]);
  });

  it('never rejects when the storage area throws', async () => {
    // Quota exhaustion and a revoked storage permission both surface as a
    // rejected promise. The panel must degrade to defaults, not fail to mount.
    const scope = globalThis as unknown as { chrome: unknown };
    const original = scope.chrome;
    scope.chrome = {
      ...(original as Record<string, unknown>),
      storage: {
        local: {
          get: () => Promise.reject(new Error('quota exceeded')),
          set: () => Promise.reject(new Error('quota exceeded')),
        },
        onChanged: { addListener: () => undefined, removeListener: () => undefined },
      },
    };

    try {
      await expect(readState()).resolves.toEqual(defaultState());
      await expect(writeState(defaultState())).resolves.toBe(false);
    } finally {
      scope.chrome = original;
    }
  });
});

describe('updateState serialisation', () => {
  /**
   * Regression for a whole class of bug. Each updateState is a read-modify-write
   * with an await in the middle, so overlapping calls used to both read the same
   * snapshot and the later write discarded the earlier one's change. That already
   * produced a visible bug once (a settings write clobbering a visibility write),
   * and every new persisted control adds another chance of it.
   */
  it('does not lose a concurrent write to a different subtree', async () => {
    await writeState(defaultState());

    await Promise.all([
      updateState((current) => ({
        ...current,
        settings: { ...current.settings, debugLogging: true },
      })),
      updateState((current) => ({
        ...current,
        transcriptOptOut: { optimize_title: true },
      })),
    ]);

    const final = await readState();
    expect(final.settings.debugLogging).toBe(true);
    expect(final.transcriptOptOut.optimize_title).toBe(true);
  });

  it('keeps processing after a mutation throws', async () => {
    await writeState(defaultState());

    await expect(
      updateState(() => {
        throw new Error('bad mutation');
      }),
    ).rejects.toThrow('bad mutation');

    // A rejection must not wedge the queue for every later write.
    await updateState((current) => ({
      ...current,
      settings: { ...current.settings, debugLogging: true },
    }));
    expect((await readState()).settings.debugLogging).toBe(true);
  });
});

describe('transcriptOptOut', () => {
  it('defaults to empty, meaning the transcript is used', () => {
    expect(defaultState().transcriptOptOut).toEqual({});
  });

  it('migrates a v3 blob additively', () => {
    const migrated = migrate({ schemaVersion: 3, settings: {}, panel: {} });
    expect(migrated.schemaVersion).toBe(SCHEMA_VERSION);
    expect(migrated.transcriptOptOut).toEqual({});
  });

  it('keeps only real task types set to true', () => {
    const migrated = migrate({
      schemaVersion: SCHEMA_VERSION,
      transcriptOptOut: {
        optimize_title: true,
        generate_tags: false,
        not_a_task: true,
        hook_writer: 'yes',
      },
    });
    expect(migrated.transcriptOptOut).toEqual({ optimize_title: true });
  });
});

describe('taskLimits', () => {
  it('defaults to empty, so shipped values stay authoritative', () => {
    expect(defaultState().taskLimits).toEqual({});
  });

  it('migrates a v4 blob additively', () => {
    const migrated = migrate({ schemaVersion: 4, settings: {}, panel: {} });
    expect(migrated.schemaVersion).toBe(SCHEMA_VERSION);
    expect(migrated.taskLimits).toEqual({});
  });

  /**
   * Clamped, not rejected. A user who types 100000 means "as much as possible",
   * and silently dropping their input would be worse than honouring the nearest
   * legal value.
   */
  it('clamps an over-large token ceiling instead of discarding it', () => {
    const migrated = migrate({
      schemaVersion: SCHEMA_VERSION,
      taskLimits: { optimize_title: { maxTokens: 100_000 } },
    });
    expect(migrated.taskLimits.optimize_title?.maxTokens).toBe(MAX_TASK_TOKENS);
  });

  it('clamps a too-small ceiling up to the floor', () => {
    const migrated = migrate({
      schemaVersion: SCHEMA_VERSION,
      taskLimits: { generate_tags: { maxTokens: 1 } },
    });
    expect(migrated.taskLimits.generate_tags?.maxTokens).toBe(MIN_TASK_TOKENS);
  });

  it('clamps temperature into range', () => {
    const migrated = migrate({
      schemaVersion: SCHEMA_VERSION,
      taskLimits: { hook_writer: { temperature: 9 }, ab_test_titles: { temperature: -1 } },
    });
    expect(migrated.taskLimits.hook_writer?.temperature).toBe(2);
    expect(migrated.taskLimits.ab_test_titles?.temperature).toBe(0);
  });

  it('drops unknown tasks and non-numeric values', () => {
    const migrated = migrate({
      schemaVersion: SCHEMA_VERSION,
      taskLimits: {
        not_a_task: { maxTokens: 500 },
        optimize_title: { maxTokens: 'lots' },
        generate_tags: {},
      },
    });
    expect(migrated.taskLimits).toEqual({});
  });
});
