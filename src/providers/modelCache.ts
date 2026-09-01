/**
 * Model list cache.
 *
 * NeuraTube hardcodes no model IDs, so the options page has to fetch a list
 * before the user can choose one. Doing that on every options-page open is a
 * needless round trip against a catalogue that changes weekly at most, so
 * results are cached for 24 hours with an explicit refresh control.
 *
 * Stored in `storage.local` alongside everything else. Model IDs are not
 * sensitive; the key that fetched them is never stored here.
 */

import { createLogger } from '~/lib/logger';
import type { ModelInfo, ProviderId } from './types';

const log = createLogger('models');

/** How long a fetched list stays fresh. */
export const MODEL_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

export interface CachedModels {
  readonly models: readonly ModelInfo[];
  readonly fetchedAt: number;
}

export type ModelCache = Partial<Record<ProviderId, CachedModels>>;

export function isFresh(entry: CachedModels | undefined, now = Date.now()): boolean {
  if (!entry) return false;
  const age = now - entry.fetchedAt;
  // A negative age means the clock moved backwards; treat as stale rather than
  // trusting an entry from the future.
  return age >= 0 && age < MODEL_CACHE_TTL_MS;
}

/** Normalise a cache blob read from storage, discarding anything malformed. */
export function normaliseModelCache(raw: unknown): ModelCache {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return {};

  const out: ModelCache = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof value !== 'object' || value === null) continue;
    const entry = value as Record<string, unknown>;
    const fetchedAt = entry.fetchedAt;
    if (typeof fetchedAt !== 'number' || !Number.isFinite(fetchedAt)) continue;
    if (!Array.isArray(entry.models)) continue;

    const models: ModelInfo[] = [];
    for (const candidate of entry.models) {
      if (typeof candidate !== 'object' || candidate === null) continue;
      const record = candidate as Record<string, unknown>;
      if (typeof record.id !== 'string' || record.id === '') continue;
      models.push({
        id: record.id,
        label: typeof record.label === 'string' && record.label !== '' ? record.label : record.id,
        created: typeof record.created === 'number' ? record.created : null,
      });
    }

    out[key as ProviderId] = { models, fetchedAt };
  }

  log.debug('model cache loaded', Object.keys(out));
  return out;
}
