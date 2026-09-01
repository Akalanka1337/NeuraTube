/**
 * About & diagnostics.
 *
 * Two jobs in one tab, because they are the two things a user comes here for when
 * they are not configuring a provider: understanding what this thing is, and
 * turning the debug affordances on or off.
 *
 * The tone is deliberately plain. A product that reads a creator's private
 * analytics and holds four API keys earns trust by being specific about what it
 * does and does not do, not by asserting that it is powerful.
 */

import type { JSX } from 'preact';
import type { Store } from './useStore';

const LINKS = {
  github: 'https://github.com/Akalanka1337/NeuraTube',
  sponsor: 'https://cyberscap.com',
  author: 'https://github.com/Akalanka1337',
} as const;

/** What the panel says the extension is for, in the order a new user needs it. */
const CAPABILITIES: readonly { readonly title: string; readonly body: string }[] = [
  {
    title: 'Reads the real data, not the page',
    body:
      'Titles, descriptions, tags, duration and visibility come from YouTube’s own ' +
      'responses as Studio loads them — not from scraping the screen. So what the ' +
      'model sees is what YouTube actually holds.',
  },
  {
    title: 'Works on any video, including ones you don’t own',
    body:
      'On a public watch page it reads the video’s tags, full description and ' +
      'caption transcript. That is the same picture a competitor teardown needs.',
  },
  {
    title: 'Chapters from real timestamps',
    body:
      'Chapter generation uses YouTube’s own caption timings, and refuses to run ' +
      'without them. A guessed timestamp looks right and is wrong at every point ' +
      'in the video, which is worse than no chapters.',
  },
  {
    title: 'Your key, your provider',
    body:
      'OpenAI, Anthropic, DeepSeek or NVIDIA NIM. Requests go from your browser ' +
      'straight to the provider you picked. There is no NeuraTube server in the ' +
      'path, because there is no NeuraTube server.',
  },
  {
    title: 'Knows Studio’s rules',
    body:
      'Made-for-kids, paid promotion, age restriction and altered-content flags ' +
      'become hard constraints on the request, so suggestions stay usable instead ' +
      'of getting rejected after you paste them.',
  },
  {
    title: 'Built to be edited',
    body:
      'Every prompt ships as editable text, every provider is swappable, and the ' +
      'source is public. Nothing about how it thinks is hidden from you.',
  },
];

export function AboutPanel({ store }: { readonly store: Store }): JSX.Element {
  const { settings } = store.state;

  return (
    <>
      <section class="card about-hero">
        <div class="about-title">
          <span class="mark mark--lg" aria-hidden="true">
            N
          </span>
          <div>
            <h2>NeuraTube</h2>
            <p class="muted small">
              AI-native optimisation for YouTube creators, inside Studio.{' '}
              <span class="mono">{__NEURATUBE_VERSION__}</span>
            </p>
          </div>
        </div>
        <p class="small">
          A panel that sits beside YouTube Studio and turns what YouTube already knows about your
          video into titles, descriptions, tags, hooks and chapters — using your own AI key, with
          the prompts open for you to change.
        </p>
      </section>

      <section class="card">
        <h2>What it does</h2>
        <ul class="feature-list">
          {CAPABILITIES.map((item) => (
            <li key={item.title}>
              <strong>{item.title}</strong>
              <span class="small muted block">{item.body}</span>
            </li>
          ))}
        </ul>
      </section>

      <section class="card">
        <h2>Diagnostics</h2>
        <p class="small muted">
          The diagnostics view shows every YouTube response NeuraTube recognised, what it parsed out
          of each one, and any schema drift. It is how you tell “YouTube changed something” apart
          from “this is broken”, and it is what to screenshot in a bug report.
        </p>

        <label class="row toggle-row">
          <input
            type="checkbox"
            checked={settings.showDebugPanel}
            onChange={(event) => {
              void store.patchSettings({ showDebugPanel: event.currentTarget.checked });
            }}
          />
          <span>
            <strong>Show the diagnostics button in the panel</strong>
            <span class="small muted block">
              Adds the{' '}
              <span class="inline-icon" aria-hidden="true">
                <svg viewBox="0 0 24 24" role="img" aria-hidden="true">
                  <circle cx="12" cy="12" r="9" />
                  <path d="M12 11v5M12 8h.01" />
                </svg>
              </span>{' '}
              icon to the panel header. Off by default — it is a developer affordance, not part of
              the daily workflow.
            </span>
          </span>
        </label>

        <label class="row toggle-row">
          <input
            type="checkbox"
            checked={settings.debugLogging}
            onChange={(event) => {
              void store.patchSettings({ debugLogging: event.currentTarget.checked });
            }}
          />
          <span>
            <strong>Verbose console logging</strong>
            <span class="small muted block">
              Logs interception and task activity to the browser console. API keys are never logged
              at any level.
            </span>
          </span>
        </label>
      </section>

      <section class="card">
        <h2>Project</h2>
        <dl class="about-links">
          <dt>Source</dt>
          <dd>
            <a href={LINKS.github} target="_blank" rel="noopener noreferrer">
              github.com/Akalanka1337/NeuraTube
            </a>
            <span class="small muted block">
              Open source. Read exactly what it sends before you trust it with a key.
            </span>
          </dd>

          <dt>Sponsor</dt>
          <dd>
            <a href={LINKS.sponsor} target="_blank" rel="noopener noreferrer">
              cyberscap.com
            </a>
          </dd>

          <dt>Created by</dt>
          <dd>
            <a href={LINKS.author} target="_blank" rel="noopener noreferrer">
              @Akalanka1337
            </a>
          </dd>

          <dt>Version</dt>
          <dd class="mono">{__NEURATUBE_VERSION__}</dd>
        </dl>
      </section>
    </>
  );
}
