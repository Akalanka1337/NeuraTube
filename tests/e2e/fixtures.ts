/**
 * Playwright fixtures for extension testing.
 *
 * Two constraints, both from Playwright's own documentation:
 *
 *  - Extensions require `launchPersistentContext`; they cannot be loaded into
 *    an ordinary browser context.
 *  - We must use Playwright's BUNDLED Chromium, never `channel: 'chrome'`.
 *    Google Chrome removed the flags needed to sideload an unpacked extension,
 *    so `--load-extension` there silently does nothing.
 *
 * YouTube is never contacted. Every request to a YouTube origin is fulfilled
 * from tests/e2e/mock-studio, so the suite is hermetic and safe to run in CI —
 * but it is served at the real URL, so the extension's match patterns,
 * surface detection and injection timing all exercise production code paths.
 */

import { test as base, chromium, expect } from '@playwright/test';
import type { BrowserContext, Page, Route, Worker } from '@playwright/test';
import path from 'node:path';
import fs from 'node:fs/promises';
import os from 'node:os';

const ROOT = path.resolve(import.meta.dirname, '../..');
const EXTENSION_PATH = path.join(ROOT, 'dist');
const MOCK_DIR = path.join(ROOT, 'tests/e2e/mock-studio');
const FIXTURE_DIR = path.join(ROOT, 'tests/fixtures');

/** Pages served in place of the real YouTube surfaces. */
const MOCK_ROUTES: readonly { pattern: string; file: string }[] = [
  { pattern: 'https://studio.youtube.com/**', file: 'studio-edit.html' },
  { pattern: 'https://www.youtube.com/**', file: 'watch.html' },
  // Registered AFTER the catch-all so it wins: Playwright matches route handlers
  // in reverse registration order.
  { pattern: 'https://www.youtube.com/shorts/**', file: 'shorts.html' },
];

export interface ExtensionFixtures {
  context: BrowserContext;
  serviceWorker: Worker;
  /** Navigate to a mocked YouTube URL and wait for the panel host to attach. */
  openSurface: (url: string, options?: { trustedTypes?: boolean }) => Promise<Page>;
  /** The loaded extension's id, derived from the service worker URL. */
  extensionId: string;
  /** Open an extension page (e.g. 'options/index.html'). */
  openExtensionPage: (page: string) => Promise<Page>;
}

export const test = base.extend<ExtensionFixtures>({
  // Playwright requires an object destructuring pattern here and infers a
  // fixture's dependencies from the destructured names. This fixture depends on
  // none, so the pattern is intentionally empty.
  // eslint-disable-next-line no-empty-pattern -- required by Playwright's fixture API
  context: async ({}, use) => {
    try {
      await fs.access(path.join(EXTENSION_PATH, 'manifest.json'));
    } catch {
      throw new Error(`Built extension not found at ${EXTENSION_PATH}. Run \`pnpm build\` first.`);
    }

    const userDataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'neuratube-e2e-'));

    const context = await chromium.launchPersistentContext(userDataDir, {
      // Bundled Chromium — see the note above.
      channel: 'chromium',
      args: [
        `--disable-extensions-except=${EXTENSION_PATH}`,
        `--load-extension=${EXTENSION_PATH}`,
        '--no-first-run',
      ],
    });

    await use(context);

    await context.close();
    await fs.rm(userDataDir, { recursive: true, force: true });
  },

  serviceWorker: async ({ context }, use) => {
    // The MV3 worker may already be running by the time we look.
    const existing = context.serviceWorkers()[0];
    const worker = existing ?? (await context.waitForEvent('serviceworker'));
    await use(worker);
  },

  extensionId: async ({ serviceWorker }, use) => {
    // chrome-extension://<id>/background.js
    await use(new URL(serviceWorker.url()).host);
  },

  openExtensionPage: async ({ context, extensionId }, use) => {
    await use(async (target) => {
      const page = await context.newPage();
      await page.goto(`chrome-extension://${extensionId}/${target}`);
      return page;
    });
  },

  openSurface: async ({ context }, use) => {
    await use(async (url, options) => {
      const page = await context.newPage();

      for (const { pattern, file } of MOCK_ROUTES) {
        const body = await fs.readFile(path.join(MOCK_DIR, file), 'utf8');
        await page.route(pattern, (route) => {
          void route.fulfill({
            status: 200,
            contentType: 'text/html; charset=utf-8',
            headers: options?.trustedTypes
              ? {
                  // Reproduce YouTube's Trusted Types enforcement. Under this
                  // header, any string-to-HTML assignment throws — which is
                  // exactly the failure mode we must never have.
                  'Content-Security-Policy': "require-trusted-types-for 'script'",
                }
              : {},
            body,
          });
        });
      }

      // Registered last so it takes precedence over the catch-all page routes:
      // Playwright matches route handlers in reverse registration order.
      const creatorVideos = await fs.readFile(
        path.join(FIXTURE_DIR, 'get_creator_videos.json'),
        'utf8',
      );
      await page.route('**/youtubei/v1/creator/get_creator_videos*', (route) => {
        void route.fulfill({
          status: 200,
          contentType: 'application/json; charset=utf-8',
          body: creatorVideos,
        });
      });
      // The aligner acknowledgement (no segments) and the real track, served at
      // their own paths so the suite exercises Studio's actual pair.
      const timingsAck = await fs.readFile(
        path.join(FIXTURE_DIR, 'get_captions_timings_ack.json'),
        'utf8',
      );
      const captionsTrack = await fs.readFile(
        path.join(FIXTURE_DIR, 'get_captions_translation.json'),
        'utf8',
      );
      const timingsTrack = await fs.readFile(
        path.join(FIXTURE_DIR, 'get_captions_timings_track.json'),
        'utf8',
      );
      // Two shapes per endpoint, selected by a mock header. Which endpoint
      // carries the track depends on the video's caption state, so both
      // arrangements have to be exercisable.
      await page.route('**/youtubei/v1/globalization/get_captions_timings*', (route) => {
        const wantsTrack = route.request().headers()['x-mock-track'] === '1';
        void route.fulfill({
          status: 200,
          contentType: 'application/json; charset=utf-8',
          body: wantsTrack ? timingsTrack : timingsAck,
        });
      });
      await page.route('**/youtubei/v1/globalization/get_captions_translation*', (route) => {
        const empty = route.request().headers()['x-mock-empty-track'] === '1';
        void route.fulfill({
          status: 200,
          contentType: 'application/json; charset=utf-8',
          // A `translation` wrapper with no segments — what an unlisted video
          // returned live, and what made the panel report a schema mismatch.
          body: empty
            ? JSON.stringify({ responseContext: {}, translation: { captionsTranslations: [{}] } })
            : captionsTrack,
        });
      });
      const timedText = await fs.readFile(path.join(FIXTURE_DIR, 'timedtext_json3.json'), 'utf8');
      await page.route('**/api/timedtext*', (route) => {
        void route.fulfill({
          status: 200,
          contentType: 'application/json; charset=utf-8',
          body: timedText,
        });
      });
      const playerSecond = await fs.readFile(
        path.join(FIXTURE_DIR, 'player_second_video.json'),
        'utf8',
      );
      const playerShort = await fs.readFile(path.join(FIXTURE_DIR, 'player_short.json'), 'utf8');
      await page.route('**/youtubei/v1/player*', (route) => {
        // On a Shorts page the next item is another Short; on a watch page it is
        // the second video. Selected by the page the request came from, which is
        // what the real client does.
        const onShorts = route.request().frame().url().includes('/shorts/');
        void route.fulfill({
          status: 200,
          contentType: 'application/json; charset=utf-8',
          body: onShorts ? playerShort : playerSecond,
        });
      });
      // Noise the extension must ignore.
      await page.route('**/youtubei/v1/log_event*', (route) =>
        route.fulfill({ status: 200, contentType: 'application/json', body: '{}' }),
      );
      await page.route('**/generate_204', (route) => route.fulfill({ status: 204, body: '' }));

      await page.goto(url, { waitUntil: 'domcontentloaded' });
      // document_idle injection, so wait for the host rather than assuming it.
      await page.waitForSelector('#neuratube-root', { state: 'attached', timeout: 10_000 });
      return page;
    });
  },
});

export { expect };

/**
 * Record of a provider request the extension made.
 *
 * Playwright's `context.route` DOES intercept extension service worker
 * requests, which is what makes the provider layer end-to-end testable at all —
 * verified before this suite was written, because the alternative (pointing base
 * URLs at a local server) is blocked by our own narrow host permissions.
 */
export interface ProviderCall {
  readonly url: string;
  readonly method: string;
  readonly headers: Record<string, string>;
  readonly body: string | null;
}

export interface ProviderMock {
  readonly calls: ProviderCall[];
  /** Calls to a given host. */
  forHost(host: string): ProviderCall[];
}

/**
 * A canned five-title response, in the shape the title prompt asks for.
 *
 * Used to exercise per-suggestion copy, which is the whole reason the parser
 * exists — five titles in one blob with no way to take one is a speed tool that
 * gave the time back.
 */
export const TITLE_STREAM = [
  'data: {"choices":[{"delta":{"content":"1. Upscale Any Video to 4K with VideoProc AI\\nwhy: search-first\\n"}}]}\n\n',
  'data: {"choices":[{"delta":{"content":"2. Fix Blurry Footage in 5 Minutes (VideoProc AI Tutorial)\\nwhy: outcome-first\\n"}}]}\n\n',
  'data: {"choices":[{"delta":{"content":"3. Why Your 1080p Footage Looks Bad on a 4K TV\\nwhy: problem-first\\n"}}]}\n\n',
  'data: {"choices":[],"usage":{"prompt_tokens":512,"completion_tokens":64}}\n\n',
  'data: [DONE]\n\n',
].join('');

/** SSE frames for a canned streaming chat response. */
export const OPENAI_STREAM = [
  'data: {"choices":[{"delta":{"content":"ai agent, "}}]}\n\n',
  'data: {"choices":[{"delta":{"content":"langchain, tutorial"}}]}\n\n',
  'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n',
  'data: {"choices":[],"usage":{"prompt_tokens":420,"completion_tokens":12}}\n\n',
  'data: [DONE]\n\n',
].join('');

export const ANTHROPIC_STREAM = [
  'event: message_start\ndata: {"message":{"usage":{"input_tokens":420,"output_tokens":0}}}\n\n',
  'event: content_block_delta\ndata: {"delta":{"type":"text_delta","text":"ai agent, langchain"}}\n\n',
  'event: message_delta\ndata: {"usage":{"output_tokens":12},"delta":{"stop_reason":"end_turn"}}\n\n',
  'event: message_stop\ndata: {}\n\n',
].join('');

/**
 * Mock all four provider APIs.
 *
 * Returns the recorded calls so a test can assert on headers — notably
 * Anthropic's browser-access opt-in, whose absence would break every Claude
 * request.
 */
export async function mockProviders(
  context: BrowserContext,
  options: { titleList?: boolean } = {},
): Promise<ProviderMock> {
  const calls: ProviderCall[] = [];

  const models = (ids: readonly string[]) =>
    JSON.stringify({ data: ids.map((id) => ({ id, created: 1_800_000_000 })) });

  const anthropicModels = JSON.stringify({
    data: [
      {
        id: 'claude-mock-large',
        display_name: 'Claude Mock Large',
        created_at: '2026-06-01T00:00:00Z',
      },
      {
        id: 'claude-mock-small',
        display_name: 'Claude Mock Small',
        created_at: '2026-01-01T00:00:00Z',
      },
    ],
  });

  const handler = async (route: Route): Promise<void> => {
    const request = route.request();
    const url = request.url();
    calls.push({
      url,
      method: request.method(),
      headers: request.headers(),
      body: request.postData(),
    });

    if (url.includes('/models')) {
      const body = url.includes('anthropic')
        ? anthropicModels
        : url.includes('deepseek')
          ? models(['deepseek-mock-pro', 'deepseek-mock-flash'])
          : url.includes('nvidia')
            ? models(['nvidia/mock-a', 'nvidia/mock-b'])
            : models(['openai-mock-large', 'openai-mock-small']);
      await route.fulfill({ status: 200, contentType: 'application/json', body });
      return;
    }

    await route.fulfill({
      status: 200,
      contentType: 'text/event-stream',
      body: options.titleList
        ? TITLE_STREAM
        : url.includes('anthropic')
          ? ANTHROPIC_STREAM
          : OPENAI_STREAM,
    });
  };

  for (const pattern of [
    'https://api.openai.com/**',
    'https://api.anthropic.com/**',
    'https://api.deepseek.com/**',
    'https://integrate.api.nvidia.com/**',
  ]) {
    await context.route(pattern, handler);
  }

  return {
    calls,
    forHost(host) {
      return calls.filter((call) => new URL(call.url).host === host);
    },
  };
}

/** Shadow-DOM-piercing locator for an element inside the panel. */
/**
 * Put a provider key and model into extension storage, and make it stick.
 *
 * WHY THIS RETRIES THE WRITE. Tests write with a raw `chrome.storage.local.set`,
 * which bypasses the serialised `updateState` path — so it races the service
 * worker's own install-time default write. Under full-suite load the worker cold
 * starts later, its defaults land AFTER ours, and the model reverts to empty. A
 * poll that only READS cannot converge out of that, because the losing write is
 * permanent: the earlier version of this helper timed out for exactly that
 * reason. Re-writing on each attempt does converge, whichever order they land in.
 */
export async function configureProvider(
  serviceWorker: Worker,
  options: { apiKey?: string; model?: string } = {},
): Promise<void> {
  const apiKey = options.apiKey ?? 'sk-mock-openai-abcdefghijklmnopqrstuvwxyz01';
  const model = options.model ?? 'openai-mock-large';

  await expect
    .poll(
      () =>
        serviceWorker.evaluate(
          async ([key, wanted]) => {
            await chrome.storage.local.set({ 'neuratube:credentials': { openai: key } });
            const bag = await chrome.storage.local.get('neuratube:state');
            const state = (bag['neuratube:state'] ?? {}) as Record<string, unknown>;
            await chrome.storage.local.set({
              'neuratube:state': {
                ...state,
                schemaVersion: 4,
                providers: {
                  ...((state.providers ?? {}) as Record<string, unknown>),
                  openai: { model: wanted, baseUrl: '', enabled: true },
                },
              },
            });

            const after = await chrome.storage.local.get('neuratube:state');
            const settled = (after['neuratube:state'] ?? {}) as {
              providers?: Record<string, { model?: string }>;
            };
            return settled.providers?.openai?.model ?? '';
          },
          [apiKey, model] as const,
        ),
      { timeout: 20_000 },
    )
    .toBe(model);
}

export function panel(page: Page, selector: string) {
  // Playwright's engine pierces open shadow roots for CSS selectors.
  return page.locator(`#neuratube-root ${selector}`);
}

/** Read the panel's self-reported status straight out of the page. */
export async function readPanelStatus(page: Page): Promise<{
  visible: boolean;
  collapsed: boolean;
  firstPaintMs: number | null;
  trustedTypesEnforced: boolean;
}> {
  return page.evaluate(() => {
    const host = document.getElementById('neuratube-root');
    const shadow = host?.shadowRoot ?? null;
    const footer = shadow?.querySelector('.footer-metric')?.textContent ?? '';
    const parsed = /([\d.]+) ms/.exec(footer);
    return {
      visible: !!host && !host.hasAttribute('hidden'),
      collapsed: !!shadow?.querySelector('.orb'),
      firstPaintMs: parsed ? Number(parsed[1]) : null,
      trustedTypesEnforced: !!shadow?.textContent?.includes('enforced'),
    };
  });
}
