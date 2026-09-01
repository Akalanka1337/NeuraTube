/**
 * Drag and resize gestures.
 *
 * Pointer Events throughout, not mouse events, so the same code path serves
 * mouse, touch and pen — the brief asks for mouse and touch, and Pointer Events
 * are how you get both without duplicating logic.
 *
 * FOUR THINGS THAT MATTER AND ARE EASY TO GET WRONG:
 *
 * 1. `setPointerCapture`. Without it, a fast drag that outruns the cursor loses
 *    the pointer the moment it crosses an iframe, a cross-origin embed, or a
 *    YouTube video element — and the panel sticks to the cursor with no
 *    pointerup ever arriving. Studio is full of iframes, so this is not
 *    theoretical.
 * 2. `touch-action: none` on the handle. Without it the browser claims the
 *    gesture for scrolling and the drag never starts on a touch device.
 * 3. Only the primary button. A right-click drag or a two-finger gesture must
 *    not move the panel.
 * 4. `pointercancel` must be handled, not just `pointerup`. The browser fires it
 *    when it takes the gesture away (a system gesture, a context menu), and a
 *    handler that ignores it leaves the panel permanently in drag state.
 *
 * The gesture reports deltas and lets the caller decide what they mean, so the
 * same machinery drives drag, resize, and the keyboard equivalents.
 */

export interface GestureHandlers {
  /** Called on every move, with the total delta since the gesture began. */
  onMove(deltaX: number, deltaY: number): void;
  /** Called once when the gesture ends normally. */
  onEnd?(): void;
  /** Called when the browser cancels the gesture. */
  onCancel?(): void;
}

export interface Gesture {
  /** Whether a gesture is currently in progress. */
  readonly active: boolean;
  /** Remove all listeners. */
  destroy(): void;
}

/**
 * Make an element a gesture handle.
 *
 * `shouldStart` lets the caller veto — used by the header, where clicking an
 * action button must not begin a drag.
 */
export function makeDraggable(
  handle: HTMLElement,
  handlers: GestureHandlers,
  shouldStart?: (event: PointerEvent) => boolean,
): Gesture {
  let pointerId: number | null = null;
  let startX = 0;
  let startY = 0;

  const onPointerDown = (event: PointerEvent): void => {
    // Primary button only. `event.button === 0` covers left mouse and the
    // primary contact of a touch or pen.
    if (event.button !== 0) return;
    if (pointerId !== null) return;
    if (shouldStart && !shouldStart(event)) return;

    pointerId = event.pointerId;
    startX = event.clientX;
    startY = event.clientY;

    try {
      // The critical line: routes every subsequent pointer event for this
      // pointer to this element, regardless of what it is over.
      handle.setPointerCapture(event.pointerId);
    } catch {
      // Capture can be refused if the pointer is already captured elsewhere.
      // The gesture still works for pointers that stay over the handle.
    }

    // Stop YouTube's own handlers seeing this as a click on the page.
    event.preventDefault();
    event.stopPropagation();
  };

  const onPointerMove = (event: PointerEvent): void => {
    if (pointerId === null || event.pointerId !== pointerId) return;
    handlers.onMove(event.clientX - startX, event.clientY - startY);
    event.preventDefault();
  };

  const finish = (event: PointerEvent, cancelled: boolean): void => {
    if (pointerId === null || event.pointerId !== pointerId) return;

    try {
      handle.releasePointerCapture(event.pointerId);
    } catch {
      // Already released.
    }
    pointerId = null;

    if (cancelled) handlers.onCancel?.();
    else handlers.onEnd?.();
  };

  const onPointerUp = (event: PointerEvent): void => {
    finish(event, false);
  };

  // Fired when the browser takes the gesture away. Ignoring this leaves the
  // panel stuck in drag state until the next pointerdown.
  const onPointerCancel = (event: PointerEvent): void => {
    finish(event, true);
  };

  handle.addEventListener('pointerdown', onPointerDown);
  handle.addEventListener('pointermove', onPointerMove);
  handle.addEventListener('pointerup', onPointerUp);
  handle.addEventListener('pointercancel', onPointerCancel);
  // Losing capture without a pointerup (rare, but happens on some platforms)
  // must also end the gesture.
  handle.addEventListener('lostpointercapture', onPointerCancel);

  return {
    get active() {
      return pointerId !== null;
    },
    destroy() {
      handle.removeEventListener('pointerdown', onPointerDown);
      handle.removeEventListener('pointermove', onPointerMove);
      handle.removeEventListener('pointerup', onPointerUp);
      handle.removeEventListener('pointercancel', onPointerCancel);
      handle.removeEventListener('lostpointercapture', onPointerCancel);
    },
  };
}

/**
 * Whether a pointerdown on the header should begin a drag.
 *
 * Buttons, links and form controls inside the header keep their own behaviour;
 * everything else is draggable surface. Uses `composedPath` because the header
 * lives in a shadow root and `event.target` is retargeted at the boundary.
 */
export function isDragSurface(event: PointerEvent): boolean {
  const interactive = /^(BUTTON|A|INPUT|SELECT|TEXTAREA|LABEL)$/;
  for (const node of event.composedPath()) {
    if (!(node instanceof Element)) continue;
    if (interactive.test(node.tagName)) return false;
    // Stop at the header itself: anything above it is not our concern.
    if (node.classList.contains('header')) break;
  }
  return true;
}

/** Keyboard nudge step, and the larger step when Shift is held. */
export const NUDGE_STEP = 12;
export const NUDGE_STEP_LARGE = 60;

export interface KeyboardNudge {
  readonly deltaX: number;
  readonly deltaY: number;
}

/**
 * Interpret an arrow-key press as a nudge.
 *
 * Drag and resize must have keyboard equivalents: a pointer-only affordance
 * fails WCAG 2.1 AA outright, and the brief commits to AA. Returns null for keys
 * that are not a nudge so the caller can ignore them without a second check.
 */
export function nudgeFor(event: KeyboardEvent): KeyboardNudge | null {
  const step = event.shiftKey ? NUDGE_STEP_LARGE : NUDGE_STEP;

  switch (event.key) {
    case 'ArrowLeft':
      return { deltaX: -step, deltaY: 0 };
    case 'ArrowRight':
      return { deltaX: step, deltaY: 0 };
    case 'ArrowUp':
      return { deltaX: 0, deltaY: -step };
    case 'ArrowDown':
      return { deltaX: 0, deltaY: step };
    default:
      return null;
  }
}
