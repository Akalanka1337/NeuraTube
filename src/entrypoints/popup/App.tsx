import type { JSX } from 'preact';
import { useCallback, useEffect, useState } from 'preact/hooks';
import { SURFACE_LABELS } from '~/types/surface';
import { sendToTab } from '~/types/messages';
import type { PanelStatus } from '~/types/messages';
import { isSupportedUrl } from '~/types/hosts';

type State =
  | { readonly kind: 'loading' }
  | { readonly kind: 'unsupported' }
  | { readonly kind: 'needs-reload' }
  | { readonly kind: 'ready'; readonly tabId: number; readonly status: PanelStatus };

/**
 * Popup.
 *
 * Its job is diagnosis, not configuration: tell the user whether NeuraTube is
 * attached to this tab, what it detected, and let them toggle the panel. The
 * real settings surface is the options page, which arrives in M3 along with
 * anything worth configuring.
 */
export function App(): JSX.Element {
  const [state, setState] = useState<State>({ kind: 'loading' });

  const load = useCallback(async () => {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const tabId = tab?.id;
    // `tab.url` is readable without the `tabs` permission because our
    // host_permissions cover these origins.
    const tabUrl = tab?.url;
    if (tabId === undefined || tabUrl === undefined || !isSupportedUrl(tabUrl)) {
      setState({ kind: 'unsupported' });
      return;
    }

    const reply = await sendToTab(tabId, { type: 'get-panel-status' });
    if (reply?.type !== 'panel-status') {
      // The page predates this build of the extension, so no content script is
      // present. Chrome does not retroactively inject, and NeuraTube holds no
      // `scripting` permission to do it manually, so a reload is the fix.
      setState({ kind: 'needs-reload' });
      return;
    }

    setState({ kind: 'ready', tabId, status: reply.status });
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const toggle = useCallback(async () => {
    if (state.kind !== 'ready') return;
    const reply = await sendToTab(state.tabId, { type: 'toggle-panel', reason: 'action' });
    if (reply?.type === 'panel-status') {
      setState({ kind: 'ready', tabId: state.tabId, status: reply.status });
    }
  }, [state]);

  return (
    <>
      <div class="brand">
        <div class="mark" aria-hidden="true">
          N
        </div>
        <strong>NeuraTube</strong>
        <span>{__NEURATUBE_VERSION__}</span>
      </div>

      {state.kind === 'loading' ? <p class="hint">Checking this tab…</p> : null}

      {state.kind === 'unsupported' ? (
        <p class="hint">
          Open a YouTube Studio page or a YouTube watch page, then reopen this popup.
        </p>
      ) : null}

      {state.kind === 'needs-reload' ? (
        <p class="hint">
          NeuraTube is not attached to this tab yet. Reload the page to attach it — this happens
          after installing or updating the extension.
        </p>
      ) : null}

      {state.kind === 'ready' ? (
        <>
          <dl class="rows">
            <dt>Surface</dt>
            <dd>{SURFACE_LABELS[state.status.surface.surface]}</dd>
            <dt>Panel</dt>
            <dd class={state.status.visible ? 'ok' : 'warn'}>
              {state.status.visible ? (state.status.collapsed ? 'collapsed' : 'visible') : 'hidden'}
            </dd>
            {state.status.surface.videoId ? (
              <>
                <dt>Video</dt>
                <dd>{state.status.surface.videoId}</dd>
              </>
            ) : null}
            <dt>First paint</dt>
            <dd>
              {state.status.firstPaintMs === null
                ? '—'
                : `${state.status.firstPaintMs.toFixed(1)} ms`}
            </dd>
          </dl>

          <button type="button" onClick={() => void toggle()}>
            {state.status.visible ? 'Hide panel' : 'Show panel'}
          </button>
        </>
      ) : null}

      <p class="hint">
        Toggle anywhere with <kbd>Alt</kbd>+<kbd>N</kbd>. No data leaves your browser in this build.
      </p>
    </>
  );
}
