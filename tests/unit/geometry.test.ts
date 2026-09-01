import { describe, expect, it } from 'vitest';
import {
  EDGE_MARGIN,
  MAX_HEIGHT,
  MAX_WIDTH,
  MIN_HEIGHT,
  MIN_VISIBLE,
  MIN_WIDTH,
  SNAP_THRESHOLD,
  clampGeometry,
  defaultGeometry,
  resizeBy,
  resolveGeometry,
  sameGeometry,
  snapTargetFor,
  snapped,
  translate,
} from '~/panel/chrome/geometry';
import type { PanelGeometry } from '~/storage/schema';
import { NUDGE_STEP, NUDGE_STEP_LARGE, nudgeFor } from '~/panel/chrome/interact';

const LAPTOP = { width: 1280, height: 800 };
const WIDE = { width: 3440, height: 1440 };
const TINY = { width: 400, height: 380 };

function geo(overrides: Partial<PanelGeometry> = {}): PanelGeometry {
  return { x: 500, y: 100, width: 380, height: 600, snap: 'none', ...overrides };
}

describe('defaultGeometry', () => {
  it('places the panel top-right, matching the original CSS placement', () => {
    const result = defaultGeometry(LAPTOP);
    expect(result.y).toBe(72);
    expect(result.x + result.width).toBe(LAPTOP.width - EDGE_MARGIN);
    expect(result.snap).toBe('none');
  });

  it('fits inside a viewport smaller than the maximum panel size', () => {
    const result = defaultGeometry(TINY);
    expect(result.width).toBeLessThanOrEqual(TINY.width);
    expect(result.x).toBeGreaterThanOrEqual(0);
  });

  it('never exceeds the maximum bounds on a huge display', () => {
    const result = defaultGeometry(WIDE);
    expect(result.width).toBeLessThanOrEqual(MAX_WIDTH);
    expect(result.height).toBeLessThanOrEqual(MAX_HEIGHT);
  });
});

describe('clampGeometry', () => {
  it('leaves valid geometry untouched', () => {
    const input = geo();
    expect(clampGeometry(input, LAPTOP)).toEqual(input);
  });

  it('pulls a panel saved on a wide monitor back onto a laptop screen', () => {
    // The core reason clamping happens on READ rather than on write: stored
    // geometry outlives the viewport it was created in.
    const fromWide = geo({ x: 3100, y: 1200 });
    const result = clampGeometry(fromWide, LAPTOP);

    expect(result.x).toBeLessThanOrEqual(LAPTOP.width - MIN_VISIBLE);
    expect(result.y).toBeLessThanOrEqual(LAPTOP.height - MIN_VISIBLE);
  });

  it('keeps the header grabbable when dragged mostly off the left edge', () => {
    // Dragging a panel mostly off-screen is legitimate; losing the header is not.
    const result = clampGeometry(geo({ x: -100_000 }), LAPTOP);
    expect(result.x + result.width).toBeGreaterThanOrEqual(MIN_VISIBLE);
  });

  it('keeps the header grabbable when dragged mostly off the right edge', () => {
    const result = clampGeometry(geo({ x: 100_000 }), LAPTOP);
    expect(result.x).toBeLessThanOrEqual(LAPTOP.width - MIN_VISIBLE);
  });

  it('never allows a negative y, so the header cannot go above the viewport', () => {
    expect(clampGeometry(geo({ y: -500 }), LAPTOP).y).toBe(0);
  });

  it('enforces the minimum and maximum size from the brief', () => {
    const tooSmall = clampGeometry(geo({ width: 10, height: 10 }), WIDE);
    expect(tooSmall.width).toBe(MIN_WIDTH);
    expect(tooSmall.height).toBe(MIN_HEIGHT);

    const tooBig = clampGeometry(geo({ width: 9999, height: 9999 }), WIDE);
    expect(tooBig.width).toBe(MAX_WIDTH);
    expect(tooBig.height).toBe(MAX_HEIGHT);
  });

  it('prefers the minimum size over a nonsensical negative on a tiny viewport', () => {
    // A viewport narrower than our minimum would otherwise produce max < min.
    const result = clampGeometry(geo({ width: 800, height: 1200 }), TINY);
    expect(result.width).toBeGreaterThanOrEqual(MIN_WIDTH);
    expect(result.height).toBeGreaterThanOrEqual(MIN_HEIGHT);
  });

  it('recomputes a snapped panel from the edge rather than clamping coordinates', () => {
    // Storing the edge instead of x is the entire point: docked-right must stay
    // docked-right at any width.
    const fromWide = { ...geo({ x: 3040, snap: 'right' as const }) };
    const result = clampGeometry(fromWide, LAPTOP);

    expect(result.snap).toBe('right');
    expect(result.x + result.width).toBe(LAPTOP.width - EDGE_MARGIN);
  });
});

describe('snapped', () => {
  it('docks left at the edge margin, full usable height', () => {
    const result = snapped('left', 380, LAPTOP);
    expect(result.x).toBe(EDGE_MARGIN);
    expect(result.y).toBe(EDGE_MARGIN);
    expect(result.height).toBe(LAPTOP.height - EDGE_MARGIN * 2);
    expect(result.snap).toBe('left');
  });

  it('docks right against the far edge', () => {
    const result = snapped('right', 380, LAPTOP);
    expect(result.x + result.width).toBe(LAPTOP.width - EDGE_MARGIN);
  });

  it('respects the maximum height on a very tall display', () => {
    expect(snapped('left', 380, { width: 2000, height: 4000 }).height).toBe(MAX_HEIGHT);
  });
});

describe('snapTargetFor', () => {
  it('docks left when the panel edge reaches the threshold', () => {
    expect(snapTargetFor(geo({ x: SNAP_THRESHOLD - 1 }), LAPTOP)).toBe('left');
  });

  it('docks right when the far edge reaches the threshold', () => {
    const x = LAPTOP.width - 380 - SNAP_THRESHOLD + 1;
    expect(snapTargetFor(geo({ x }), LAPTOP)).toBe('right');
  });

  it('does not dock from the middle of the screen', () => {
    expect(snapTargetFor(geo({ x: 500 }), LAPTOP)).toBe('none');
  });

  it('measures from the panel edges, not the pointer', () => {
    // A wide panel whose left edge touches the viewport edge should dock, even
    // though its centre is far from it.
    expect(snapTargetFor(geo({ x: 2, width: 800 }), LAPTOP)).toBe('left');
  });
});

describe('translate', () => {
  it('moves by the delta', () => {
    const result = translate(geo({ x: 500, y: 100 }), -200, 50, LAPTOP);
    expect(result.x).toBe(300);
    expect(result.y).toBe(150);
  });

  it('un-snaps: a docked panel that moved is no longer docked', () => {
    const result = translate(geo({ snap: 'left' }), 200, 0, LAPTOP);
    expect(result.snap).toBe('none');
  });

  it('clamps as it moves, so a drag cannot escape the viewport', () => {
    const result = translate(geo(), 100_000, 100_000, LAPTOP);
    expect(result.x).toBeLessThanOrEqual(LAPTOP.width - MIN_VISIBLE);
    expect(result.y).toBeLessThanOrEqual(LAPTOP.height - MIN_VISIBLE);
  });
});

describe('resizeBy', () => {
  it('grows and shrinks from the bottom-right', () => {
    const grown = resizeBy(geo({ width: 400, height: 600 }), 100, 50, WIDE);
    expect(grown.width).toBe(500);
    expect(grown.height).toBe(650);
  });

  it('respects the bounds', () => {
    expect(resizeBy(geo(), -100_000, -100_000, WIDE).width).toBe(MIN_WIDTH);
    expect(resizeBy(geo(), 100_000, 100_000, WIDE).width).toBe(MAX_WIDTH);
  });

  it('keeps a docked panel docked while its width changes', () => {
    const result = resizeBy(geo({ snap: 'right', width: 400 }), 100, 0, LAPTOP);
    expect(result.snap).toBe('right');
    expect(result.width).toBe(500);
    // Still flush against the edge after widening.
    expect(result.x + result.width).toBe(LAPTOP.width - EDGE_MARGIN);
  });
});

describe('resolveGeometry', () => {
  it('falls back to the default when nothing is stored', () => {
    expect(resolveGeometry(null, LAPTOP)).toEqual(defaultGeometry(LAPTOP));
  });

  it('clamps what is stored', () => {
    const result = resolveGeometry(geo({ x: 99_999 }), LAPTOP);
    expect(result.x).toBeLessThanOrEqual(LAPTOP.width - MIN_VISIBLE);
  });
});

describe('sameGeometry', () => {
  it('compares every field', () => {
    expect(sameGeometry(geo(), geo())).toBe(true);
    expect(sameGeometry(geo(), geo({ x: 501 }))).toBe(false);
    expect(sameGeometry(geo(), geo({ snap: 'left' }))).toBe(false);
  });
});

describe('nudgeFor', () => {
  it('maps the arrow keys', () => {
    const key = (k: string, shift = false) =>
      nudgeFor({ key: k, shiftKey: shift } as KeyboardEvent);

    expect(key('ArrowLeft')).toEqual({ deltaX: -NUDGE_STEP, deltaY: 0 });
    expect(key('ArrowRight')).toEqual({ deltaX: NUDGE_STEP, deltaY: 0 });
    expect(key('ArrowUp')).toEqual({ deltaX: 0, deltaY: -NUDGE_STEP });
    expect(key('ArrowDown')).toEqual({ deltaX: 0, deltaY: NUDGE_STEP });
  });

  it('uses a larger step with Shift', () => {
    expect(nudgeFor({ key: 'ArrowRight', shiftKey: true } as KeyboardEvent)).toEqual({
      deltaX: NUDGE_STEP_LARGE,
      deltaY: 0,
    });
  });

  it('returns null for keys that are not a nudge', () => {
    for (const k of ['Enter', 'a', 'Escape', 'Tab', ' ']) {
      expect(nudgeFor({ key: k, shiftKey: false } as KeyboardEvent), k).toBeNull();
    }
  });
});
