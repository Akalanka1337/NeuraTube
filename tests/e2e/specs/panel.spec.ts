/**
 * M1 acceptance suite.
 *
 * These specs encode the milestone's stated acceptance criteria:
 *   - the panel renders on every supported surface
 *   - it renders with ZERO Trusted Types violations under enforced CSP
 *   - first paint is inside the 80ms budget
 *   - the Alt+N hotkey and the collapse/hide controls work
 *   - style isolation holds in both directions
 */

import type { Worker } from '@playwright/test';
import { expect, panel, readPanelStatus, test } from '../fixtures';

const STUDIO_EDIT = 'https://studio.youtube.com/video/PPGYNmrVG58/edit';
const STUDIO_ANALYTICS =
  'https://studio.youtube.com/video/PPGYNmrVG58/analytics/tab-overview/period-default';
const STUDIO_CHANNEL = 'https://studio.youtube.com/channel/UCuAXFkgsw1L7xaCfnd5JJOw/videos/upload';
const WATCH = 'https://www.youtube.com/watch?v=dQw4w9WgXcQ';
const SEARCH = 'https://www.youtube.com/results?search_query=mv3+extension';

test.describe('panel mounting', () => {
  test('the service worker starts', ({ serviceWorker }) => {
    expect(serviceWorker.url()).toContain('background.js');
  });

  for (const [label, url, expectedSurface] of [
    ['Studio video edit', STUDIO_EDIT, 'Studio · Video details'],
    ['Studio analytics', STUDIO_ANALYTICS, 'Studio · Analytics'],
    ['Studio channel', STUDIO_CHANNEL, 'Studio · Channel'],
    ['public watch', WATCH, 'YouTube · Watch'],
    ['search results', SEARCH, 'YouTube · Search'],
  ] as const) {
    test(`mounts and identifies the ${label} surface`, async ({ openSurface }) => {
      const page = await openSurface(url);

      await expect(panel(page, '.panel')).toBeVisible();
      await expect(panel(page, '.title')).toHaveText('NeuraTube');
      await expect(panel(page, '.subtitle')).toContainText(expectedSurface);
    });
  }

  test('extracts the video id on the Studio edit surface', async ({ openSurface }) => {
    const page = await openSurface(STUDIO_EDIT);
    await expect(panel(page, '.subtitle')).toContainText('PPGYNmrVG58');
    // Since M2 the panel renders a Video card above the detected-context card,
    // so there is more than one .rows; the surface detection lives in the last.
    await expect(panel(page, '.rows').last()).toContainText('PPGYNmrVG58');
  });

  test('does not attach to unsupported YouTube pages', async ({ context }) => {
    const page = await context.newPage();
    await page.route('https://www.youtube.com/**', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'text/html',
        body: '<html><body>feed</body></html>',
      }),
    );
    await page.goto('https://www.youtube.com/feed/subscriptions');

    // The content script matches the origin, but the panel must not claim a
    // surface it does not support.
    await expect(page.locator('#neuratube-root .panel')).toHaveCount(0);
  });

  test('mounts exactly one host', async ({ openSurface }) => {
    const page = await openSurface(STUDIO_EDIT);
    await expect(page.locator('#neuratube-root')).toHaveCount(1);
  });
});

test.describe('Trusted Types compliance', () => {
  test('renders with no violations under enforced Trusted Types', async ({ openSurface }) => {
    const violations: string[] = [];

    const page = await openSurface(STUDIO_EDIT, { trustedTypes: true });

    page.on('pageerror', (error) => violations.push(error.message));
    page.on('console', (message) => {
      if (message.type() === 'error') violations.push(message.text());
    });

    // The panel must be fully functional, not merely present.
    await expect(panel(page, '.panel')).toBeVisible();
    await panel(page, '.icon-btn').first().click();
    // Since M2 the diagnostics view ends with the raw VideoContext dump, which
    // is the most demanding thing to render without a string-HTML sink.
    await expect(panel(page, '.card-title').last()).toHaveText('VideoContext (raw)');
    await expect(panel(page, '.json')).toBeVisible();

    const trustedTypesErrors = violations.filter((message) =>
      /trusted|TrustedHTML|require-trusted-types/i.test(message),
    );
    expect(
      trustedTypesErrors,
      `Trusted Types violations: ${trustedTypesErrors.join(' | ')}`,
    ).toEqual([]);
  });

  test('blocks string HTML in the MAIN world but not in our isolated world', async ({
    openSurface,
  }) => {
    const page = await openSurface(STUDIO_EDIT, { trustedTypes: true });

    // page.evaluate runs in the MAIN world — the same world the M2 interceptor
    // will occupy.
    const mainWorld = await page.evaluate(() => {
      try {
        // eslint-disable-next-line no-restricted-properties -- this IS the probe: a detached element, asserting the sink is blocked
        document.createElement('div').innerHTML = '';
        return 'allowed';
      } catch {
        return 'blocked';
      }
    });

    // This is the constraint that makes the repo-wide ESLint ban load-bearing
    // for M2. If it ever flips to 'allowed', the page stopped enforcing and this
    // test should tell us rather than letting us quietly relax.
    expect(mainWorld).toBe('blocked');

    // Isolated-world content scripts run under the extension's CSP, not the
    // page's, so our panel is exempt today. Pinned deliberately: if a future
    // Chromium starts enforcing here, this fails loudly and we will already be
    // compliant.
    await panel(page, '.icon-btn').first().click();
    await expect(panel(page, '.rows').last()).toContainText('Trusted Types');
    await expect(
      panel(page, '.pill').filter({ hasText: 'not enforced in this world' }),
    ).toBeVisible();
  });
});

test.describe('performance budget', () => {
  test('first paint is inside the 80ms budget', async ({ openSurface }) => {
    const page = await openSurface(STUDIO_EDIT);

    const status = await readPanelStatus(page);
    expect(status.firstPaintMs).not.toBeNull();
    // The budget the project committed to. A CI runner is slower than a real
    // machine, so a breach here is a genuine signal.
    expect(status.firstPaintMs!).toBeLessThan(80);
  });

  test('exposes a first-paint measurement on the performance timeline', async ({ openSurface }) => {
    const page = await openSurface(STUDIO_EDIT);

    const measures = await page.evaluate(() =>
      performance.getEntriesByType('measure').map((entry) => entry.name),
    );
    // Present alongside YouTube's own marks on a DevTools trace.
    expect(measures).toContain('neuratube:first-paint-duration');
  });
});

test.describe('panel controls', () => {
  /**
   * Fire the same message `chrome.commands.onCommand` sends for Alt+N.
   *
   * The keystroke itself cannot be simulated: extension commands are dispatched
   * by the browser UI layer, and CDP-synthesized key events are delivered to the
   * page, so `page.keyboard.press('Alt+n')` never reaches the command handler.
   * The binding itself is asserted in tests/unit/manifest.test.ts, and the
   * browser half is on the manual QA checklist in README.md; what these specs
   * cover is the code we actually wrote — the content-script toggle.
   */
  async function pressToggleCommand(serviceWorker: Worker) {
    await serviceWorker.evaluate(async () => {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (tab?.id !== undefined) {
        await chrome.tabs.sendMessage(tab.id, { type: 'toggle-panel', reason: 'command' });
      }
    });
  }

  test('the toggle command hides and shows the panel', async ({ openSurface, serviceWorker }) => {
    const page = await openSurface(STUDIO_EDIT);
    await expect(panel(page, '.panel')).toBeVisible();

    await pressToggleCommand(serviceWorker);
    await expect(page.locator('#neuratube-root')).toHaveAttribute('hidden', '');

    await pressToggleCommand(serviceWorker);
    await expect(panel(page, '.panel')).toBeVisible();
  });

  test('Escape collapses to the orb, and the orb restores the panel', async ({ openSurface }) => {
    const page = await openSurface(STUDIO_EDIT);

    await page.keyboard.press('Escape');
    await expect(panel(page, '.orb')).toBeVisible();
    await expect(panel(page, '.panel')).toHaveCount(0);

    await panel(page, '.orb').click();
    await expect(panel(page, '.panel')).toBeVisible();
  });

  test('the toggle command expands a collapsed orb rather than hiding it', async ({
    openSurface,
    serviceWorker,
  }) => {
    const page = await openSurface(STUDIO_EDIT);

    await page.keyboard.press('Escape');
    await expect(panel(page, '.orb')).toBeVisible();

    await pressToggleCommand(serviceWorker);
    // Hiding here would make the shortcut feel broken.
    await expect(panel(page, '.panel')).toBeVisible();
  });

  test('the hide button hides the panel', async ({ openSurface }) => {
    const page = await openSurface(STUDIO_EDIT);

    await panel(page, '.icon-btn').last().click();
    await expect(page.locator('#neuratube-root')).toHaveAttribute('hidden', '');
  });

  test('visibility persists across a reload, per surface', async ({ openSurface, context }) => {
    const page = await openSurface(STUDIO_EDIT);
    await panel(page, '.icon-btn').last().click();
    await expect(page.locator('#neuratube-root')).toHaveAttribute('hidden', '');

    // Panel preferences are written on a 250ms debounce so rapid Alt+N presses
    // do not each hit storage. Wait for it to settle rather than racing it.
    await page.waitForTimeout(500);

    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#neuratube-root', { state: 'attached' });
    await expect(page.locator('#neuratube-root')).toHaveAttribute('hidden', '');

    // A different surface keeps its own state.
    const other = await context.newPage();
    await other.route('https://www.youtube.com/**', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'text/html',
        body: '<html><body><h1>watch</h1></body></html>',
      }),
    );
    await other.goto(WATCH);
    await other.waitForSelector('#neuratube-root', { state: 'attached' });
    await expect(other.locator('#neuratube-root .panel')).toBeVisible();
  });
});

test.describe('resilience', () => {
  test('survives the page pruning its own DOM subtree', async ({ openSurface }) => {
    const page = await openSurface(STUDIO_EDIT);
    await expect(panel(page, '.panel')).toBeVisible();

    // Studio's SPA router replaces large subtrees on navigation.
    await page.evaluate(() => {
      (window as unknown as { __mockPrune: () => void }).__mockPrune();
    });

    await expect(panel(page, '.panel')).toBeVisible();
  });

  test('follows a client-side navigation with no document load', async ({ openSurface }) => {
    const page = await openSurface(STUDIO_EDIT);
    await expect(panel(page, '.subtitle')).toContainText('Video details');

    await page.evaluate(() => {
      (window as unknown as { __mockNavigate: (href: string) => void }).__mockNavigate(
        '/video/PPGYNmrVG58/analytics/tab-overview/period-default',
      );
    });

    // Detected by the polling fallback: an isolated-world content script cannot
    // observe the page's own history.pushState.
    await expect(panel(page, '.subtitle')).toContainText('Analytics', { timeout: 5_000 });
  });

  test('style isolation holds against a hostile page stylesheet', async ({ openSurface }) => {
    // The mock page sets `display: none !important` on .panel, .card, button and
    // section, plus Comic Sans and magenta text on everything. None of it may
    // cross the shadow boundary.
    const page = await openSurface(STUDIO_EDIT);

    await expect(panel(page, '.panel')).toBeVisible();

    const styles = await page.evaluate(() => {
      const element = document
        .getElementById('neuratube-root')
        ?.shadowRoot?.querySelector('.panel');
      if (!element) return null;
      const computed = getComputedStyle(element);
      return {
        display: computed.display,
        fontFamily: computed.fontFamily,
        color: computed.color,
      };
    });

    expect(styles?.display).toBe('flex');
    expect(styles?.fontFamily).not.toContain('Comic Sans');
    expect(styles?.color).not.toBe('rgb(255, 0, 255)');
  });

  test('the panel does not leak styles into the page', async ({ openSurface }) => {
    const page = await openSurface(STUDIO_EDIT);

    const marker = await page.evaluate(() => {
      const element = document.getElementById('marker');
      return element ? getComputedStyle(element).fontFamily : null;
    });

    // Still the page's own font, not ours.
    expect(marker).toContain('Comic Sans');
  });
});

test.describe('theme sync', () => {
  test('adopts dark on a dark Studio page', async ({ openSurface }) => {
    const page = await openSurface(STUDIO_EDIT);
    await expect(page.locator('#neuratube-root')).toHaveAttribute('data-theme', 'dark');
  });

  test('follows the page flipping to light', async ({ openSurface }) => {
    const page = await openSurface(STUDIO_EDIT);
    await expect(page.locator('#neuratube-root')).toHaveAttribute('data-theme', 'dark');

    await page.evaluate(() => {
      document.documentElement.removeAttribute('dark');
      document.documentElement.setAttribute('light', '');
      document.body.style.background = '#ffffff';
    });

    await expect(page.locator('#neuratube-root')).toHaveAttribute('data-theme', 'light');
  });
});

test.describe('privacy', () => {
  test('makes no network requests of its own', async ({ openSurface, context }) => {
    const unexpected: string[] = [];
    context.on('request', (request) => {
      const url = request.url();
      if (url.startsWith('chrome-extension://')) return;
      if (url.startsWith('https://studio.youtube.com')) return;
      if (url.startsWith('https://www.youtube.com')) return;
      unexpected.push(url);
    });

    await openSurface(STUDIO_EDIT);

    // Zero telemetry is a product promise, so it gets a test.
    expect(unexpected, `unexpected requests: ${unexpected.join(', ')}`).toEqual([]);
  });
});
