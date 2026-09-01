/**
 * Panel geometry: bounds, defaults, clamping and snapping.
 *
 * https://github.com/Akalanka1337/NeuraTube
 * 
 * Pure functions over plain numbers, deliberately — no DOM, no signals. The
 * interesting logic here is entirely about not putting the panel somewhere the
 * user cannot reach it, and that is exactly the kind of arithmetic that is
 * miserable to debug through a browser and trivial to test directly.
 *
 * THE PROBLEM THIS SOLVES. Stored geometry outlives the viewport it was created
 * in. A panel dragged to x=3100 on a 3440px monitor is entirely off-screen on a
 * 1280px laptop; a panel sized 800x1200 does not fit a 900px-tall window. So
 * every read is clamped against the CURRENT viewport rather than trusting what
 * was written, and snapping is stored as an edge rather than as coordinates so
 * "docked right" stays docked right at any width.
 */

import type { PanelGeometry, SnapEdge } from '~/storage/schema';

/** Bounds from the project brief: min 320x400, max 800x1200. */
export const MIN_WIDTH = 320;
export const MIN_HEIGHT = 400;
export const MAX_WIDTH = 800;
export const MAX_HEIGHT = 1200;

/** Gap kept between the panel and the viewport edge when snapped or defaulted. */
export const EDGE_MARGIN = 16;

/** How close to an edge a release must land to dock. */
export const SNAP_THRESHOLD = 48;

/**
 * Pixels of the panel that must remain on screen.
 *
 * A panel dragged mostly off the right edge is fine — that is a legitimate way to
 * get it out of the way — but the header has to stay grabbable, or the user has
 * no way to bring it back without clearing storage.
 */
export const MIN_VISIBLE = 80;

export interface Viewport {
  readonly width: number;
  readonly height: number;
}

/** The panel's collapsed orb size, from the brief. */
export const ORB_SIZE = 48;

export function readViewport(): Viewport {
  return {
    width: Math.max(window.innerWidth, MIN_WIDTH),
    height: Math.max(window.innerHeight, MIN_HEIGHT),
  };
}

function clamp(value: number, min: number, max: number): number {
  // Guards against max < min, which happens on a viewport smaller than our
  // minimum size: prefer the minimum and let the panel overflow rather than
  // producing a nonsensical negative size.
  if (max < min) return min;
  return Math.min(Math.max(value, min), max);
}

/**
 * Default position: top-right, matching the M1 CSS placement.
 *
 * Height is 78% of the viewport, capped, which is the `--nt-panel-max-height`
 * the stylesheet used before geometry became explicit.
 */
export function defaultGeometry(viewport: Viewport): PanelGeometry {
  const width = clamp(380, MIN_WIDTH, Math.min(MAX_WIDTH, viewport.width - EDGE_MARGIN * 2));
  const height = clamp(
    Math.round(viewport.height * 0.78),
    MIN_HEIGHT,
    Math.min(MAX_HEIGHT, viewport.height - EDGE_MARGIN * 2),
  );

  return {
    x: Math.max(EDGE_MARGIN, viewport.width - width - EDGE_MARGIN),
    y: 72,
    width,
    height,
    snap: 'none',
  };
}

/**
 * Clamp geometry into the current viewport.
 *
 * Size first, then position, because a clamped size changes what positions are
 * legal. A snapped panel has its x and height recomputed from the edge rather
 * than clamped, which is the whole point of storing the edge.
 */
export function clampGeometry(geometry: PanelGeometry, viewport: Viewport): PanelGeometry {
  const width = clamp(
    geometry.width,
    MIN_WIDTH,
    Math.min(MAX_WIDTH, Math.max(viewport.width - EDGE_MARGIN * 2, MIN_WIDTH)),
  );
  const height = clamp(
    geometry.height,
    MIN_HEIGHT,
    Math.min(MAX_HEIGHT, Math.max(viewport.height - EDGE_MARGIN * 2, MIN_HEIGHT)),
  );

  if (geometry.snap !== 'none') {
    return snapped(geometry.snap, width, viewport);
  }

  return {
    // Keep at least MIN_VISIBLE pixels reachable on every side.
    x: clamp(geometry.x, MIN_VISIBLE - width, viewport.width - MIN_VISIBLE),
    y: clamp(geometry.y, 0, Math.max(viewport.height - MIN_VISIBLE, 0)),
    width,
    height,
    snap: 'none',
  };
}

/** Geometry for a panel docked to an edge: full usable height, pinned x. */
export function snapped(edge: 'left' | 'right', width: number, viewport: Viewport): PanelGeometry {
  const usableWidth = clamp(
    width,
    MIN_WIDTH,
    Math.min(MAX_WIDTH, Math.max(viewport.width - EDGE_MARGIN * 2, MIN_WIDTH)),
  );
  const height = clamp(
    viewport.height - EDGE_MARGIN * 2,
    MIN_HEIGHT,
    Math.min(MAX_HEIGHT, Math.max(viewport.height - EDGE_MARGIN * 2, MIN_HEIGHT)),
  );

  return {
    x:
      edge === 'left'
        ? EDGE_MARGIN
        : Math.max(EDGE_MARGIN, viewport.width - usableWidth - EDGE_MARGIN),
    y: EDGE_MARGIN,
    width: usableWidth,
    height,
    snap: edge,
  };
}

/**
 * Which edge a release should dock to, if any.
 *
 * Measured from the panel's own edges rather than the pointer, so dragging a
 * wide panel until its left edge touches the viewport's left edge docks it —
 * which is what the gesture looks like it should do.
 */
export function snapTargetFor(geometry: PanelGeometry, viewport: Viewport): SnapEdge {
  if (geometry.x <= SNAP_THRESHOLD) return 'left';
  if (geometry.x + geometry.width >= viewport.width - SNAP_THRESHOLD) return 'right';
  return 'none';
}

/** Resolve stored prefs into usable geometry, applying defaults and clamping. */
export function resolveGeometry(stored: PanelGeometry | null, viewport: Viewport): PanelGeometry {
  return stored === null ? defaultGeometry(viewport) : clampGeometry(stored, viewport);
}

/** Move by a delta, then re-clamp. Used by drag and by keyboard nudging. */
export function translate(
  geometry: PanelGeometry,
  deltaX: number,
  deltaY: number,
  viewport: Viewport,
): PanelGeometry {
  return clampGeometry(
    // Dragging always un-snaps: a docked panel that moved is no longer docked.
    { ...geometry, x: geometry.x + deltaX, y: geometry.y + deltaY, snap: 'none' },
    viewport,
  );
}

/** Resize by a delta from the bottom-right corner, then re-clamp. */
export function resizeBy(
  geometry: PanelGeometry,
  deltaWidth: number,
  deltaHeight: number,
  viewport: Viewport,
): PanelGeometry {
  return clampGeometry(
    {
      ...geometry,
      width: geometry.width + deltaWidth,
      height: geometry.height + deltaHeight,
      // Resizing a docked panel keeps it docked — only its width changes.
    },
    viewport,
  );
}

/** Whether two geometries are equal, to avoid pointless writes and renders. */
export function sameGeometry(a: PanelGeometry, b: PanelGeometry): boolean {
  return (
    a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height && a.snap === b.snap
  );
}
