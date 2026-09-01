import type { JSX } from 'preact';
import { useEffect, useRef } from 'preact/hooks';
import { IconClose, IconInfo, IconMinimise } from './Icons';
import { isDragSurface, makeDraggable, nudgeFor } from './chrome/interact';
import { readViewport, snapTargetFor, snapped, translate } from './chrome/geometry';
import { geometry, interacting } from '~/state/panelState';
import { SURFACE_LABELS } from '~/types/surface';
import type { SurfaceInfo } from '~/types/surface';

export interface HeaderProps {
  readonly surface: SurfaceInfo;
  readonly showDebug: boolean;
  readonly onCollapse: () => void;
  readonly onHide: () => void;
  readonly onToggleDebug: () => void;
}

/**
 * Panel header, and the drag handle.
 *
 * https://github.com/Akalanka1337/NeuraTube
 *
 * The actions were grouped in their own container back in M1 for exactly this
 * reason: `isDragSurface` walks the composed path and refuses to start a drag
 * that began on a button.
 *
 * Keyboard equivalent: the handle is focusable and arrow keys move the panel,
 * with Shift for a larger step. A pointer-only affordance fails WCAG 2.1 AA,
 * which the project commits to.
 */
export function Header({
  surface,
  showDebug,
  onCollapse,
  onHide,
  onToggleDebug,
}: HeaderProps): JSX.Element {
  const context = surface.videoId
    ? `${SURFACE_LABELS[surface.surface]} · ${surface.videoId}`
    : SURFACE_LABELS[surface.surface];

  const handleRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    const handle = handleRef.current;
    if (!handle) return;

    // Captured at gesture start so every move is relative to a fixed origin
    // rather than accumulating rounding error.
    let origin = geometry.value;

    const gesture = makeDraggable(
      handle,
      {
        onMove(deltaX, deltaY) {
          if (!interacting.value) {
            origin = geometry.value;
            interacting.value = true;
          }
          geometry.value = translate(origin, deltaX, deltaY, readViewport());
        },
        onEnd() {
          interacting.value = false;
          // Snap on release, per the brief. Measured from the panel's own edges,
          // so dragging until the panel touches an edge docks it.
          const viewport = readViewport();
          const edge = snapTargetFor(geometry.value, viewport);
          if (edge !== 'none') {
            geometry.value = snapped(edge, geometry.value.width, viewport);
          }
        },
        onCancel() {
          interacting.value = false;
          // Restore the pre-gesture position: a cancelled drag should look like
          // it never happened.
          geometry.value = origin;
        },
      },
      isDragSurface,
    );

    return () => {
      gesture.destroy();
    };
  }, []);

  const onKeyDown = (event: KeyboardEvent): void => {
    const nudge = nudgeFor(event);
    if (!nudge) return;
    event.preventDefault();
    event.stopPropagation();
    geometry.value = translate(geometry.value, nudge.deltaX, nudge.deltaY, readViewport());
  };

  return (
    <header
      class="header"
      part="header"
      ref={handleRef}
      tabIndex={0}
      role="toolbar"
      aria-label="NeuraTube panel — drag to move, or use arrow keys"
      aria-orientation="horizontal"
      onKeyDown={onKeyDown}
    >
      <div class="mark" aria-hidden="true">
        N
      </div>
      <div class="titles">
        <span class="title">NeuraTube</span>
        <span class="subtitle" title={context}>
          {context}
        </span>
      </div>
      <div class="header-actions">
        <button
          type="button"
          class="icon-btn"
          onClick={onToggleDebug}
          aria-pressed={showDebug}
          title="Diagnostics"
        >
          <IconInfo title="Toggle diagnostics" />
        </button>
        <button type="button" class="icon-btn" onClick={onCollapse} title="Collapse to orb">
          <IconMinimise title="Collapse panel" />
        </button>
        <button type="button" class="icon-btn" onClick={onHide} title="Hide panel (Alt+N)">
          <IconClose title="Hide panel" />
        </button>
      </div>
    </header>
  );
}
