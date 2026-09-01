/**
 * `chrome.storage.local` schema and migrations.
 *
 * Everything NeuraTube persists is described here, in one versioned shape.
 * Extensions get upgraded silently under users, so an unversioned storage blob
 * turns every future release into a guessing game about what shape is on disk.
 *
 * `local` only, never `sync`: sync replicates to Google's servers and caps
 * items at 8KB. From M3 this store also holds provider API keys, which must
 * never leave the device except in a request to the provider the user chose.
 * ESLint bans `chrome.storage.sync` repo-wide to keep that true.
 */

import type { Surface } from '~/types/surface';
import type { ProviderId } from '~/providers/types';
import { PROVIDER_IDS } from '~/providers/types';
import type { ModelCache } from '~/providers/modelCache';
import { normaliseModelCache } from '~/providers/modelCache';
import type { PricingOverrides, TokenPrice } from '~/providers/pricing';
import type { TaskRouting, TaskType } from '~/orchestrator/tasks';
import { TASK_TYPES, defaultRouting } from '~/orchestrator/tasks';
import type { PromptOverride } from '~/orchestrator/promptStore';

/**
 * Current schema version.
 *
 * v2 (M3) added providers, routing, prompt overrides, the model cache, pricing
 * overrides and the usage ledger.
 *
 * v3 (M4) added panel geometry to the per-surface prefs.
 *
 * NOTE: API keys are NOT in this blob. They live under a separate storage key —
 * see storage/credentials.ts for why.
 */
export const SCHEMA_VERSION = 5;

/** Which edge the panel is docked to, if any. */
export type SnapEdge = 'none' | 'left' | 'right';

/**
 * Panel position and size, in CSS pixels relative to the viewport.
 *
 * `snap` is stored as an edge rather than as coordinates, deliberately: a panel
 * docked to the right edge on a 3440px monitor must still be docked to the right
 * edge on a 1280px laptop, and storing x=3100 would put it off-screen. When
 * snapped, `x` is ignored on read.
 */
export interface PanelGeometry {
  x: number;
  y: number;
  width: number;
  height: number;
  snap: SnapEdge;
}

/** Per-surface panel state. */
export interface PanelPrefs {
  visible: boolean;
  collapsed: boolean;
  /** Null until the user first moves or resizes the panel on this surface. */
  geometry: PanelGeometry | null;
}

export type ThemePreference = 'auto' | 'dark' | 'light';

export interface Settings {
  /** Verbose console logging. Off by default; no telemetry either way. */
  debugLogging: boolean;
  /** `auto` follows YouTube's own dark/light state. */
  theme: ThemePreference;
  /** Show the diagnostics section in the panel. */
  showDebugPanel: boolean;
}

/** Non-secret per-provider configuration. The key lives elsewhere. */
export interface ProviderSettings {
  /** Chosen from the live model list. Empty until the user picks one. */
  model: string;
  /** Overrides the provider's default base URL. Empty means use the default. */
  baseUrl: string;
  enabled: boolean;
}

/** Rolling spend accounting for the cost meter. */
export interface UsageRecord {
  requests: number;
  inputTokens: number;
  outputTokens: number;
  /** Null when no model in the period had a known price. */
  costUsd: number | null;
}

export interface UsageLedger {
  /** `YYYY-MM`. Reset when the month rolls over. */
  month: string;
  byProvider: Partial<Record<ProviderId, UsageRecord>>;
}

export interface NeuraTubeState {
  schemaVersion: number;
  settings: Settings;
  /** Keyed by `Surface` so each surface remembers its own panel state. */
  panel: Partial<Record<Surface, PanelPrefs>>;
  providers: Record<ProviderId, ProviderSettings>;
  routing: Partial<Record<TaskType, TaskRouting>>;
  prompts: Partial<Record<TaskType, PromptOverride>>;
  modelCache: ModelCache;
  /**
   * Tasks the user has switched the transcript OFF for.
   *
   * Stored as opt-OUT so absent means "use it", which is the right default: the
   * transcript is the only record of what the video actually says, and a title
   * written from it beats one written from the creator's own description. Only
   * deviations are persisted, so the map stays empty for most users.
   *
   * Ignored for tasks that REQUIRE a transcript (chapters) — there is no
   * meaningful choice there, only a broken run.
   */
  transcriptOptOut: Partial<Record<TaskType, boolean>>;
  /**
   * Per-task limit overrides.
   *
   * Only deviations are stored, so the shipped defaults stay authoritative and a
   * later tuning pass reaches everyone who has not opted out of it.
   *
   * These exist because the shipped ceilings are sized for ordinary models, and a
   * reasoning model can spend the entire budget thinking and emit no answer at
   * all. That failure is invisible without a way to raise the limit.
   */
  taskLimits: Partial<Record<TaskType, TaskLimits>>;
  /** User-supplied token prices, keyed by model id. */
  pricingOverrides: PricingOverrides;
  usage: UsageLedger;
}

export const DEFAULT_PANEL_PREFS: Readonly<PanelPrefs> = Object.freeze({
  visible: true,
  collapsed: false,
  geometry: null,
});

export const DEFAULT_SETTINGS: Readonly<Settings> = Object.freeze({
  debugLogging: false,
  theme: 'auto',
  showDebugPanel: __DEV__,
});

export function defaultProviderSettings(): ProviderSettings {
  return { model: '', baseUrl: '', enabled: true };
}

export function currentMonth(now = new Date()): string {
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
}

export function defaultUsageLedger(): UsageLedger {
  return { month: currentMonth(), byProvider: {} };
}

function defaultProviders(): Record<ProviderId, ProviderSettings> {
  const out = {} as Record<ProviderId, ProviderSettings>;
  for (const id of PROVIDER_IDS) out[id] = defaultProviderSettings();
  return out;
}

export function defaultState(): NeuraTubeState {
  return {
    schemaVersion: SCHEMA_VERSION,
    settings: { ...DEFAULT_SETTINGS },
    panel: {},
    providers: defaultProviders(),
    routing: {},
    prompts: {},
    modelCache: {},
    transcriptOptOut: {},
    taskLimits: {},
    pricingOverrides: {},
    usage: defaultUsageLedger(),
  };
}

/**
 * A single storage migration.
 *
 * `from` is the version the migration upgrades *from*; it produces version
 * `from + 1`. Migrations must be pure and total — they receive whatever is on
 * disk, which may be partial or corrupt.
 */
export interface Migration {
  readonly from: number;
  migrate(input: Record<string, unknown>): Record<string, unknown>;
}

/**
 * Registered migrations, ascending.
 *
 * v1 -> v2 (M3) is additive: it introduces providers, routing, prompt
 * overrides, the model cache, pricing overrides and the usage ledger. Nothing
 * from v1 changes shape, so the migration only has to seed the new fields —
 * `normalise` would supply them anyway, but running them through an explicit
 * migration keeps the version history honest and gives the next, less
 * fortunate migration a pattern to follow.
 */
export const MIGRATIONS: readonly Migration[] = [
  {
    from: 1,
    migrate(input) {
      return {
        ...input,
        schemaVersion: 2,
        providers: defaultProviders(),
        routing: {},
        prompts: {},
        modelCache: {},
        pricingOverrides: {},
        usage: defaultUsageLedger(),
      };
    },
  },
  {
    from: 2,
    migrate(input) {
      // Additive: geometry starts null on every surface, meaning "use the
      // default position". `normalise` would supply it anyway, but running it
      // through an explicit migration keeps the version history honest.
      const panel = isRecord(input.panel) ? input.panel : {};
      const migrated: Record<string, unknown> = {};
      for (const [surface, prefs] of Object.entries(panel)) {
        migrated[surface] = isRecord(prefs) ? { ...prefs, geometry: null } : prefs;
      }
      return { ...input, schemaVersion: 3, panel: migrated };
    },
  },
  {
    from: 4,
    migrate(input) {
      // Additive: nobody has overridden a limit yet.
      return { ...input, schemaVersion: 5, taskLimits: {} };
    },
  },
  {
    from: 3,
    migrate(input) {
      // Additive: nobody has opted out of anything yet.
      return { ...input, schemaVersion: 4, transcriptOptOut: {} };
    },
  },
];

/**
 * Bring any on-disk value up to `SCHEMA_VERSION`.
 *
 * Unknown-shaped or future-versioned input is replaced with defaults rather
 * than trusted: a user who downgrades the extension should get a working panel,
 * not a crash loop.
 */
export function migrate(raw: unknown): NeuraTubeState {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return defaultState();
  }

  let working = { ...(raw as Record<string, unknown>) };
  const rawVersion = working.schemaVersion;
  let version = typeof rawVersion === 'number' && Number.isInteger(rawVersion) ? rawVersion : 0;

  if (version > SCHEMA_VERSION) return defaultState();

  while (version < SCHEMA_VERSION) {
    const step = MIGRATIONS.find((m) => m.from === version);
    if (!step) {
      // No path from this version: start clean rather than run on a shape we
      // cannot reason about.
      return defaultState();
    }
    working = step.migrate(working);
    version += 1;
  }

  return normalise(working);
}

/** Coerce a migrated blob into a fully-populated, correctly-typed state. */
function normalise(input: Record<string, unknown>): NeuraTubeState {
  const settingsInput = isRecord(input.settings) ? input.settings : {};
  const panelInput = isRecord(input.panel) ? input.panel : {};

  const panel: Partial<Record<Surface, PanelPrefs>> = {};
  for (const [key, value] of Object.entries(panelInput)) {
    if (!isRecord(value)) continue;
    panel[key as Surface] = {
      visible: asBoolean(value.visible, DEFAULT_PANEL_PREFS.visible),
      collapsed: asBoolean(value.collapsed, DEFAULT_PANEL_PREFS.collapsed),
      geometry: normaliseGeometry(value.geometry),
    };
  }

  return {
    schemaVersion: SCHEMA_VERSION,
    settings: {
      debugLogging: asBoolean(settingsInput.debugLogging, DEFAULT_SETTINGS.debugLogging),
      theme: asTheme(settingsInput.theme),
      showDebugPanel: asBoolean(settingsInput.showDebugPanel, DEFAULT_SETTINGS.showDebugPanel),
    },
    panel,
    providers: normaliseProviders(input.providers),
    routing: normaliseRouting(input.routing),
    prompts: normalisePrompts(input.prompts),
    modelCache: normaliseModelCache(input.modelCache),
    transcriptOptOut: normaliseTranscriptOptOut(input.transcriptOptOut),
    taskLimits: normaliseTaskLimits(input.taskLimits),
    pricingOverrides: normalisePricing(input.pricingOverrides),
    usage: normaliseUsage(input.usage),
  };
}

/** Bounds on a user-supplied token ceiling. */
export const MIN_TASK_TOKENS = 64;
/**
 * 32k.
 *
 * High enough for a reasoning model on a long transcript, low enough that a
 * fat-fingered extra zero cannot turn one click into a very large bill.
 */
export const MAX_TASK_TOKENS = 32_000;

export interface TaskLimits {
  readonly maxTokens?: number;
  readonly temperature?: number;
}

/**
 * Keep only sane overrides.
 *
 * Clamped rather than rejected: a user who types 100000 means "as much as
 * possible", and silently dropping their input would be worse than honouring the
 * nearest legal value.
 */
function normaliseTaskLimits(raw: unknown): Partial<Record<TaskType, TaskLimits>> {
  const source = isRecord(raw) ? raw : {};
  const out: Partial<Record<TaskType, TaskLimits>> = {};

  for (const task of TASK_TYPES) {
    const entry = source[task];
    if (!isRecord(entry)) continue;

    const limits: { maxTokens?: number; temperature?: number } = {};

    const tokens = entry.maxTokens;
    if (typeof tokens === 'number' && Number.isFinite(tokens)) {
      limits.maxTokens = Math.round(Math.min(MAX_TASK_TOKENS, Math.max(MIN_TASK_TOKENS, tokens)));
    }

    const temperature = entry.temperature;
    if (typeof temperature === 'number' && Number.isFinite(temperature)) {
      limits.temperature = Math.min(2, Math.max(0, temperature));
    }

    if (limits.maxTokens !== undefined || limits.temperature !== undefined) {
      out[task] = limits;
    }
  }
  return out;
}

/** Keep only real task types with a real boolean, and only the `true` entries. */
function normaliseTranscriptOptOut(raw: unknown): Partial<Record<TaskType, boolean>> {
  const source = isRecord(raw) ? raw : {};
  const out: Partial<Record<TaskType, boolean>> = {};
  for (const task of TASK_TYPES) {
    if (source[task] === true) out[task] = true;
  }
  return out;
}

function normaliseProviders(raw: unknown): Record<ProviderId, ProviderSettings> {
  const source = isRecord(raw) ? raw : {};
  const out = {} as Record<ProviderId, ProviderSettings>;

  for (const id of PROVIDER_IDS) {
    const entry = isRecord(source[id]) ? source[id] : {};
    const defaults = defaultProviderSettings();
    out[id] = {
      model: asString(entry.model, defaults.model),
      baseUrl: asString(entry.baseUrl, defaults.baseUrl),
      enabled: asBoolean(entry.enabled, defaults.enabled),
    };
  }
  return out;
}

function normaliseRouting(raw: unknown): Partial<Record<TaskType, TaskRouting>> {
  const source = isRecord(raw) ? raw : {};
  const out: Partial<Record<TaskType, TaskRouting>> = {};

  for (const task of TASK_TYPES) {
    const entry = source[task];
    if (!isRecord(entry)) continue;

    const primary = entry.primary;
    const fallbacks = Array.isArray(entry.fallbacks) ? entry.fallbacks : [];

    out[task] = {
      primary: isProviderId(primary) ? primary : defaultRouting().primary,
      // Filter rather than trust: a provider id removed in a future release
      // must not survive in a user's stored routing.
      fallbacks: fallbacks.filter(isProviderId),
    };
  }
  return out;
}

function normalisePrompts(raw: unknown): Partial<Record<TaskType, PromptOverride>> {
  const source = isRecord(raw) ? raw : {};
  const out: Partial<Record<TaskType, PromptOverride>> = {};

  for (const task of TASK_TYPES) {
    const entry = source[task];
    if (!isRecord(entry)) continue;
    const text = entry.text;
    if (typeof text !== 'string' || text.trim() === '') continue;

    out[task] = {
      text,
      basedOnVersion: asString(entry.basedOnVersion, ''),
      editedAt: asNumber(entry.editedAt, 0),
    };
  }
  return out;
}

function normalisePricing(raw: unknown): PricingOverrides {
  const source = isRecord(raw) ? raw : {};
  const out: PricingOverrides = {};

  for (const [model, value] of Object.entries(source)) {
    if (!isRecord(value)) continue;
    const input = value.inputPerMillion;
    const output = value.outputPerMillion;
    // A partially-entered override is worse than none: it would produce a
    // confidently wrong cost.
    if (typeof input !== 'number' || !Number.isFinite(input) || input < 0) continue;
    if (typeof output !== 'number' || !Number.isFinite(output) || output < 0) continue;
    out[model] = { inputPerMillion: input, outputPerMillion: output } satisfies TokenPrice;
  }
  return out;
}

function normaliseUsage(raw: unknown): UsageLedger {
  const source = isRecord(raw) ? raw : {};
  const month = asString(source.month, currentMonth());

  // A ledger from a previous month starts fresh rather than accumulating
  // forever — the meter reports monthly spend.
  if (month !== currentMonth()) return defaultUsageLedger();

  const byProviderInput = isRecord(source.byProvider) ? source.byProvider : {};
  const byProvider: Partial<Record<ProviderId, UsageRecord>> = {};

  for (const id of PROVIDER_IDS) {
    const entry = byProviderInput[id];
    if (!isRecord(entry)) continue;
    const cost = entry.costUsd;
    byProvider[id] = {
      requests: asNumber(entry.requests, 0),
      inputTokens: asNumber(entry.inputTokens, 0),
      outputTokens: asNumber(entry.outputTokens, 0),
      costUsd: typeof cost === 'number' && Number.isFinite(cost) ? cost : null,
    };
  }

  return { month, byProvider };
}

function asString(value: unknown, fallback: string): string {
  return typeof value === 'string' ? value : fallback;
}

function asNumber(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function isProviderId(value: unknown): value is ProviderId {
  return typeof value === 'string' && (PROVIDER_IDS as readonly string[]).includes(value);
}

/**
 * Read stored geometry.
 *
 * Returns null for anything malformed rather than a partially-populated shape:
 * half a geometry would place the panel somewhere arbitrary, and the default
 * position is always a safe answer. Values are NOT clamped here — clamping needs
 * the current viewport, which storage knows nothing about, so it happens on read
 * in the panel (see panel/chrome/geometry.ts).
 */
function normaliseGeometry(raw: unknown): PanelGeometry | null {
  if (!isRecord(raw)) return null;

  const isFiniteNumber = (value: unknown): value is number =>
    typeof value === 'number' && Number.isFinite(value);

  const { x, y, width, height, snap } = raw;
  if (!isFiniteNumber(x) || !isFiniteNumber(y)) return null;
  if (!isFiniteNumber(width) || !isFiniteNumber(height)) return null;
  if (width <= 0 || height <= 0) return null;

  return { x, y, width, height, snap: snap === 'left' || snap === 'right' ? snap : 'none' };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function asBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

function asTheme(value: unknown): ThemePreference {
  return value === 'dark' || value === 'light' || value === 'auto' ? value : DEFAULT_SETTINGS.theme;
}
