import type { JSX } from 'preact';
import { useState } from 'preact/hooks';
import { PROVIDER_SPECS } from '~/providers/specs';
import { PROVIDER_IDS } from '~/providers/types';
import { CREDENTIALS_KEY, clearCredentials } from '~/storage/credentials';
import { STATE_KEY } from '~/storage/local';
import type { Store } from './useStore';

/**
 * Privacy and data controls.
 *
 * Says plainly what is stored and where, including the part that is not
 * flattering: `chrome.storage.local` is not encrypted at rest. Every
 * bring-your-own-key extension has this property and most do not mention it.
 */
export function DataPanel({ store }: { readonly store: Store }): JSX.Element {
  const [confirming, setConfirming] = useState<'keys' | 'all' | null>(null);
  const configured = PROVIDER_IDS.filter((id) => (store.credentials[id] ?? '') !== '');

  return (
    <>
      <section class="card">
        <h3>What NeuraTube stores</h3>
        <dl class="kv small">
          <dt>
            <code>{CREDENTIALS_KEY}</code>
          </dt>
          <dd>
            Your API keys.{' '}
            {configured.length === 0
              ? 'None stored.'
              : `${configured.length} stored (${configured.map((id) => PROVIDER_SPECS[id].label).join(', ')}).`}
          </dd>
          <dt>
            <code>{STATE_KEY}</code>
          </dt>
          <dd>
            Panel layout, theme, selected models, task routing, prompt edits, the cached model
            lists, and this month&apos;s token counts. No keys.
          </dd>
        </dl>
        <p class="muted small">
          Both live in <code>chrome.storage.local</code>, in this browser profile only. Never{' '}
          <code>chrome.storage.sync</code>, which would replicate them to Google.
        </p>
      </section>

      <section class="card">
        <h3>Where your data goes</h3>
        <ul class="bullets small">
          <li>
            Video metadata is read from YouTube Studio&apos;s own responses, in your browser.
            NeuraTube makes no extra request to YouTube to obtain it.
          </li>
          <li>
            When you run a task, the relevant metadata is sent directly from your browser to the
            provider you configured, using your key. It does not pass through any server we operate
            — we operate none.
          </li>
          <li>
            That provider then holds your metadata under <em>their</em> privacy policy and retention
            terms, not ours.
          </li>
          <li>Zero telemetry. No analytics, no crash reporting, no pixels.</li>
        </ul>
      </section>

      <section class="card">
        <h3>Honest limitation</h3>
        <p class="small">
          <code>chrome.storage.local</code> is not encrypted at rest. Any process that can read your
          Chrome profile directory can read your API keys. This is equally true of every
          bring-your-own-key extension. Use keys scoped and spend-capped to what NeuraTube needs,
          and rotate them if the machine is shared.
        </p>
      </section>

      <section class="card danger-zone">
        <h3>Delete data</h3>

        <div class="row">
          <button
            type="button"
            class="danger"
            disabled={configured.length === 0}
            onClick={() => {
              setConfirming('keys');
            }}
          >
            Remove all API keys
          </button>
          <button
            type="button"
            class="danger ghost"
            onClick={() => {
              setConfirming('all');
            }}
          >
            Reset everything
          </button>
        </div>

        {confirming !== null ? (
          <p class="banner warn small">
            {confirming === 'keys'
              ? `Remove ${configured.length} stored key(s)? You will need to paste them again.`
              : 'Delete every NeuraTube setting, including keys, prompt edits and usage counts?'}
            <span class="row">
              <button
                type="button"
                class="danger"
                onClick={() => {
                  void (async () => {
                    if (confirming === 'keys') {
                      await clearCredentials();
                    } else {
                      await chrome.storage.local.remove([CREDENTIALS_KEY, STATE_KEY]);
                    }
                    setConfirming(null);
                    // Reload rather than patching state back into place: after a
                    // wholesale delete, re-reading from storage is the only way
                    // to be sure the UI reflects what is actually there.
                    location.reload();
                  })();
                }}
              >
                Yes, do it
              </button>
              <button
                type="button"
                class="ghost"
                onClick={() => {
                  setConfirming(null);
                }}
              >
                Cancel
              </button>
            </span>
          </p>
        ) : null}
      </section>
    </>
  );
}
