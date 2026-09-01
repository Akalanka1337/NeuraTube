import { beforeEach, describe, expect, it } from 'vitest';
import {
  collapsed,
  firstPaintMs,
  mounted,
  resetPanelStateForTests,
  status,
  surface,
  togglePanel,
  trustedTypesEnforced,
  visible,
} from '~/state/panelState';
import { detectSurface } from '~/types/surface';

describe('panel state', () => {
  beforeEach(() => {
    resetPanelStateForTests();
  });

  it('toggles visibility', () => {
    expect(visible.value).toBe(true);
    togglePanel();
    expect(visible.value).toBe(false);
    togglePanel();
    expect(visible.value).toBe(true);
  });

  it('expands a collapsed panel rather than hiding it', () => {
    // Alt+N on a collapsed orb should restore the panel, not hide it — the
    // alternative makes the shortcut feel broken.
    collapsed.value = true;
    togglePanel();
    expect(collapsed.value).toBe(false);
    expect(visible.value).toBe(true);
  });

  it('hides a collapsed-then-expanded panel on the next toggle', () => {
    collapsed.value = true;
    togglePanel();
    togglePanel();
    expect(visible.value).toBe(false);
  });

  it('derives a status snapshot from the individual signals', () => {
    surface.value = detectSurface('https://studio.youtube.com/video/PPGYNmrVG58/edit');
    mounted.value = true;
    firstPaintMs.value = 41.5;
    trustedTypesEnforced.value = true;

    expect(status.value).toEqual({
      mounted: true,
      visible: true,
      collapsed: false,
      surface: surface.value,
      firstPaintMs: 41.5,
      trustedTypesEnforced: true,
    });
  });

  it('recomputes the snapshot when a dependency changes', () => {
    const before = status.value.visible;
    visible.value = !before;
    expect(status.value.visible).toBe(!before);
  });
});
