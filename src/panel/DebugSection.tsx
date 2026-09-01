import type { JSX } from 'preact';
import { exchangeCount, exchangeLog, lastDrift } from '~/state/contextStore';
import { firstPaintMs, theme, trustedTypesEnforced } from '~/state/panelState';
import { PROTOCOL_VERSION } from '~/types/messages';
import { WIRE_VERSION } from '~/intercept/protocol';
import type { VideoContext } from '~/types/VideoContext';

function formatMs(value: number | null): string {
  return value === null ? '—' : `${value.toFixed(1)} ms`;
}

function formatBytes(bytes: number): string {
  if (bytes === 0) return '—';
  if (bytes < 1024) return `${bytes} B`;
  return `${(bytes / 1024).toFixed(1)} KB`;
}

/**
 * https://github.com/Akalanka1337/NeuraTube
 *
 * Diagnostics.
 *
 * Exists because NeuraTube reads an undocumented API: when something goes wrong,
 * the difference between a useful bug report and a useless one is whether the
 * user could see what was actually intercepted. Rendered as text nodes
 * throughout — no string-HTML sink, so this stays safe under Trusted Types.
 */
export function DebugSection({ video }: { readonly video: VideoContext | null }): JSX.Element {
  const paint = firstPaintMs.value;
  const paintOk = paint !== null && paint < 80;
  const drift = lastDrift.value;
  const log = exchangeLog.value;

  return (
    <>
      <div class="card">
        <h2 class="card-title">Diagnostics</h2>
        <dl class="rows">
          <dt>Version</dt>
          <dd class="mono">{__NEURATUBE_VERSION__}</dd>
          <dt>Protocol</dt>
          <dd class="mono">
            msg v{PROTOCOL_VERSION} · wire v{WIRE_VERSION}
          </dd>
          <dt>First paint</dt>
          <dd>
            <span
              class={`pill ${paint === null ? 'pill--muted' : paintOk ? 'pill--ok' : 'pill--warn'}`}
            >
              {formatMs(paint)}
            </span>
            <span class="mono"> budget 80 ms</span>
          </dd>
          <dt>Trusted Types</dt>
          <dd>
            <span class={`pill ${trustedTypesEnforced.value ? 'pill--ok' : 'pill--muted'}`}>
              {trustedTypesEnforced.value
                ? 'enforced here — compliant'
                : 'not enforced in this world'}
            </span>
          </dd>
          <dt>Intercepted</dt>
          <dd>
            <span class={`pill ${exchangeCount.value > 0 ? 'pill--ok' : 'pill--muted'}`}>
              {exchangeCount.value} exchange{exchangeCount.value === 1 ? '' : 's'}
            </span>
          </dd>
          <dt>Schema</dt>
          <dd>
            {drift ? (
              <span
                class={`pill ${
                  drift.severity === 'none'
                    ? 'pill--ok'
                    : drift.severity === 'minor'
                      ? 'pill--warn'
                      : 'pill--err'
                }`}
              >
                {drift.severity === 'none' ? 'matches' : drift.severity}
              </span>
            ) : (
              <span class="pill pill--muted">nothing parsed yet</span>
            )}
          </dd>
          <dt>Theme</dt>
          <dd>{theme.value}</dd>
          <dt>Telemetry</dt>
          <dd>
            <span class="pill pill--ok">none</span>
          </dd>
        </dl>
      </div>

      {drift && (drift.missingFields.length > 0 || drift.unmappedEnums.length > 0) ? (
        <div class="card">
          <h2 class="card-title">Schema drift detail</h2>
          <p class="note note--sm">{drift.summary}</p>
          {drift.missingFields.length > 0 ? (
            <p class="note note--sm mono">missing: {drift.missingFields.join(', ')}</p>
          ) : null}
          {drift.unmappedEnums.length > 0 ? (
            <p class="note note--sm mono">
              unmapped: {drift.unmappedEnums.map((e) => `${e.field}=${e.value}`).join(', ')}
            </p>
          ) : null}
        </div>
      ) : null}

      <div class="card">
        <h2 class="card-title">
          Intercepted traffic <span class="count">{log.length}</span>
        </h2>
        {log.length > 0 ? (
          <ul class="log" aria-label="Intercepted InnerTube exchanges">
            {log.map((entry, index) => (
              <li key={`${entry.kind}-${entry.at}-${index}`}>
                <span class={`log-kind ${entry.status >= 400 ? 'log-kind--err' : ''}`}>
                  {entry.kind}
                </span>
                <span class="log-meta mono">
                  {entry.method} {entry.status} · {formatBytes(entry.bytes)}
                  {entry.parsed !== null ? ` · ${entry.parsed} parsed` : ''}
                  {entry.skipped ? ` · skipped: ${entry.skipped}` : ''}
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <p class="note">
            Nothing intercepted yet. Reload the page — the interceptor attaches at document start,
            and Studio fetches video data during page load.
          </p>
        )}
      </div>

      <div class="card">
        <h2 class="card-title">VideoContext (raw)</h2>
        {video ? (
          <pre class="json" tabIndex={0}>
            {JSON.stringify(video, null, 2)}
          </pre>
        ) : (
          <p class="note">No video parsed on this surface yet.</p>
        )}
      </div>
    </>
  );
}
