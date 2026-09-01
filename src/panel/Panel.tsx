import type { JSX } from 'preact';
import { useEffect, useRef } from 'preact/hooks';
import { Header } from './Header';
import { Orb } from './Orb';
import { VideoCard } from './VideoCard';
import { DebugSection } from './DebugSection';
import { TaskOutput, TaskRail } from './TaskView';
import {
  collapsed,
  firstPaintMs,
  geometry,
  interacting,
  showDebug,
  surface,
  visible,
} from '~/state/panelState';
import { makeDraggable, nudgeFor } from './chrome/interact';
import { readViewport, resizeBy } from './chrome/geometry';
import { currentVideo, exchangeCount, lastDrift } from '~/state/contextStore';
import { openTask } from '~/state/taskStore';
import { isUserVisible } from '~/parsers/drift';
import { SURFACE_LABELS } from '~/types/surface';

function formatMs(value: number | null): string {
  return value === null ? '—' : `${value.toFixed(1)} ms`;
}

/**
 * Root panel component.
 *
 * Reads directly from signals rather than props: the panel is driven by the
 * service worker, storage changes from other contexts, the surface watcher and
 * the interceptor — none of which sit above it in the tree.
 */
export function Panel(): JSX.Element | null {
  // Escape collapses rather than hides, so the panel never vanishes in a way
  // the user cannot obviously undo.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape' && visible.value && !collapsed.value) {
        collapsed.value = true;
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
    };
  }, []);

  if (!visible.value) return null;
  if (collapsed.value) {
    return (
      <Orb
        onExpand={() => {
          collapsed.value = false;
        }}
      />
    );
  }

  const info = surface.value;
  const video = currentVideo.value;
  const drift = lastDrift.value;
  const paint = firstPaintMs.value;

  return (
    <section
      class="panel"
      role="complementary"
      aria-label="NeuraTube optimisation panel"
      part="panel"
    >
      <Header
        surface={info}
        showDebug={showDebug.value}
        onCollapse={() => {
          collapsed.value = true;
        }}
        onHide={() => {
          visible.value = false;
        }}
        onToggleDebug={() => {
          showDebug.value = !showDebug.value;
        }}
      />

      {/*
        `tabIndex` and the region role are an accessibility requirement, not
        decoration: this element scrolls (`overflow-y: auto`), and axe's
        `scrollable-region-focusable` rule correctly flagged that a keyboard-only
        user had no way to scroll it. Focusable + named fixes that.
      */}
      <div class="body" tabIndex={0} role="region" aria-label="NeuraTube panel content">
        {/* Drift that affects correctness is shown unconditionally, above the
            data it affects. Silently rendering incomplete metadata as if it
            were complete is the one failure mode that could make a creator act
            on wrong information. */}
        {drift && isUserVisible(drift) ? (
          <div class="banner banner--warn" role="status">
            {drift.summary}
          </div>
        ) : null}

        {/* A task in progress or with a result takes over the body: the user
            asked for it, so it is what they want to see. */}
        {openTask.value !== null ? <TaskOutput task={openTask.value} /> : <TaskRail />}

        {video ? (
          <VideoCard video={video} />
        ) : (
          <div class="card">
            <h2 class="card-title">Waiting for Studio data</h2>
            <p class="note">
              {info.surface === 'studio-edit' || info.surface === 'studio-analytics'
                ? exchangeCount.value > 0
                  ? 'Intercepted Studio traffic, but no video metadata in it yet. Reload the page — the payload NeuraTube reads arrives during page load.'
                  : 'Reload this page so the interceptor can attach before Studio fetches its data.'
                : 'Open a video in Studio to see its metadata here. Public-page support arrives in M6.'}
            </p>
          </div>
        )}

        <div class="card">
          <h2 class="card-title">Detected context</h2>
          <dl class="rows">
            <dt>Surface</dt>
            <dd>{SURFACE_LABELS[info.surface]}</dd>
            <dt>Video</dt>
            <dd class={info.videoId ? 'mono' : undefined}>{info.videoId ?? 'none on this page'}</dd>
            <dt>Channel</dt>
            <dd class={video?.channelId ? 'mono' : undefined}>
              {video?.channelId ?? info.channelId ?? 'not exposed by this URL'}
            </dd>
          </dl>
        </div>

        <p class="note note--sm">
          Press <kbd>Alt</kbd>+<kbd>N</kbd> to hide or show, <kbd>Esc</kbd> to collapse. AI
          suggestions and provider keys arrive in M3 — nothing leaves your browser yet.
        </p>

        {showDebug.value ? <DebugSection video={video} /> : null}
      </div>

      <footer class="footer">
        <span>NeuraTube {__NEURATUBE_VERSION__}</span>
        <span class="footer-metric">{formatMs(paint)}</span>
      </footer>

      <ResizeHandle />
    </section>
  );
}

/**
 * Bottom-right resize handle.
 *
 * Focusable with an arrow-key equivalent, for the same AA reason the header has
 * one. `aria-label` says what the keys do, because a resize grip is otherwise
 * invisible to a screen reader.
 */
function ResizeHandle(): JSX.Element {
  const ref = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    const handle = ref.current;
    if (!handle) return;

    let origin = geometry.value;

    const gesture = makeDraggable(handle, {
      onMove(deltaX, deltaY) {
        if (!interacting.value) {
          origin = geometry.value;
          interacting.value = true;
        }
        geometry.value = resizeBy(origin, deltaX, deltaY, readViewport());
      },
      onEnd() {
        interacting.value = false;
      },
      onCancel() {
        interacting.value = false;
        geometry.value = origin;
      },
    });

    return () => {
      gesture.destroy();
    };
  }, []);

  const onKeyDown = (event: KeyboardEvent): void => {
    const nudge = nudgeFor(event);
    if (!nudge) return;
    event.preventDefault();
    event.stopPropagation();
    geometry.value = resizeBy(geometry.value, nudge.deltaX, nudge.deltaY, readViewport());
  };

  return (
    <button
      type="button"
      ref={ref}
      class="resize-handle"
      aria-label="Resize panel — use arrow keys, or drag"
      onKeyDown={onKeyDown}
    />
  );
}
