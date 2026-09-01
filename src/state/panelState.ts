/**
 * Panel runtime state.
 *
 * Preact Signals rather than component state: the panel is driven by events
 * from three directions (the service worker's hotkey command, storage changes
 * written by the popup or another tab, and the surface watcher). Signals let
 * those write to one place without the panel needing a context provider or a
 * top-down re-render.
 */

import { computed, signal } from '@preact/signals';
import type { PanelGeometry } from '~/storage/schema';
import { defaultGeometry, readViewport } from '~/panel/chrome/geometry';
import type { PanelStatus } from '~/types/messages';
import type { SurfaceInfo } from '~/types/surface';
import { detectSurface } from '~/types/surface';

/** Whether the panel is on screen at all. */
export const visible = signal<boolean>(true);

/** Collapsed to the 48x48 orb. */
export const collapsed = signal<boolean>(false);

/**
 * Current panel position and size.
 *
 * Always a resolved, clamped geometry — never null. The stored value may be
 * null (meaning "never moved"), but by the time it reaches here it has been
 * through `resolveGeometry`.
 */
export const geometry = signal<PanelGeometry>(defaultGeometry(readViewport()));

/** True while a drag or resize is in progress, to suppress transitions. */
export const interacting = signal<boolean>(false);

/** Current surface classification. */
export const surface = signal<SurfaceInfo>(detectSurface(location.href));

/** Resolved theme actually being rendered (after `auto` resolution). */
export const theme = signal<'dark' | 'light'>('dark');

/** Measured first paint, in milliseconds. */
export const firstPaintMs = signal<number | null>(null);

/** Whether Trusted Types enforcement was detected on this page. */
export const trustedTypesEnforced = signal<boolean>(false);

/** Whether the diagnostics section is shown. */
export const showDebug = signal<boolean>(false);

/** True once the panel has mounted into the DOM. */
export const mounted = signal<boolean>(false);

/** Snapshot for the popup and the E2E suite. */
export const status = computed<PanelStatus>(() => ({
  mounted: mounted.value,
  visible: visible.value,
  collapsed: collapsed.value,
  surface: surface.value,
  firstPaintMs: firstPaintMs.value,
  trustedTypesEnforced: trustedTypesEnforced.value,
}));

/** Toggle visibility. Expanding a collapsed panel counts as showing it. */
export function togglePanel(): void {
  if (visible.value && collapsed.value) {
    collapsed.value = false;
    return;
  }
  visible.value = !visible.value;
}

/** Reset every signal to its initial value. Test-only. */
export function resetPanelStateForTests(): void {
  visible.value = true;
  collapsed.value = false;
  geometry.value = defaultGeometry(readViewport());
  interacting.value = false;
  surface.value = detectSurface(location.href);
  theme.value = 'dark';
  firstPaintMs.value = null;
  trustedTypesEnforced.value = false;
  showDebug.value = false;
  mounted.value = false;
}
