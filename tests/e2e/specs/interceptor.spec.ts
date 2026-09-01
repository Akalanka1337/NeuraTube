/**
 * M2 acceptance suite.
 *
 * The milestone's stated acceptance criterion is: open the Studio edit page for
 * PPGYNmrVG58 and confirm the panel shows the title, description, 11 tags,
 * 5 suggested hashtags and the A/B test arms.
 *
 * These specs run in real Chromium against a mock Studio served at the real
 * Studio URL, so the MAIN-world injection, `document_start` ordering, the
 * cross-world handshake and `event.source === window` all exercise production
 * behaviour rather than a test double. The InnerTube response is served from
 * tests/fixtures; YouTube is never contacted.
 */

import { expect, panel, test } from '../fixtures';

const STUDIO_EDIT = 'https://studio.youtube.com/video/PPGYNmrVG58/edit';
const STUDIO_OTHER_VIDEO = 'https://studio.youtube.com/video/dQw4w9WgXcQ/edit';
const WATCH = 'https://www.youtube.com/watch?v=Xo8bwzAFhSw';

/**
 * Open the diagnostics view (the first header action) and wait for it to render.
 *
 * The wait matters: signal-driven re-renders commit on a microtask, so a bare
 * `.count()` immediately after the click reads the pre-render DOM and silently
 * measures zero.
 */
async function openDiagnostics(page: Parameters<typeof panel>[0]): Promise<void> {
  await panel(page, '.icon-btn').first().click();
  await expect(panel(page, '.json')).toBeVisible();
}

test.describe('M2 acceptance: parsed video metadata', () => {
  test('shows the title and description from the intercepted payload', async ({ openSurface }) => {
    const page = await openSurface(STUDIO_EDIT);

    await expect(panel(page, '.video-title')).toHaveText(
      'Build an AI Agent in 12 Minutes (Full Tutorial)',
    );
  });

  test('shows all 11 tags', async ({ openSurface }) => {
    const page = await openSurface(STUDIO_EDIT);

    const tags = panel(page, '.taglist:not(.taglist--accent) li');
    await expect(tags).toHaveCount(11);
    await expect(tags.first()).toHaveText('ai agent');
    await expect(tags.last()).toHaveText('software engineering');
    // The count badge must agree with the rendered list. Targeted by a
    // case-sensitive anchored regex: since M5 there is also a "Tasks" card, and
    // Playwright's `hasText` string matching is case-insensitive so plain 'Tags'
    // would also match "suggested hashtags".
    await expect(
      panel(page, '.card-title').filter({ hasText: /^Tags/ }).locator('.count'),
    ).toHaveText('11');
  });

  test("shows all 5 of YouTube's suggested hashtags", async ({ openSurface }) => {
    const page = await openSurface(STUDIO_EDIT);

    const hashtags = panel(page, '.taglist--accent li');
    await expect(hashtags).toHaveCount(5);
    // Normalised: the fixture mixes bare and #-prefixed values.
    await expect(hashtags.first()).toHaveText('#aiagents');
    await expect(hashtags.nth(2)).toHaveText('#machinelearning');
  });

  test('shows the A/B test arms with watch-time fractions', async ({ openSurface }) => {
    const page = await openSurface(STUDIO_EDIT);

    const arms = panel(page, '.arms li');
    await expect(arms).toHaveCount(2);
    await expect(panel(page, '.arm-value').first()).toHaveText('58.1%');
    await expect(panel(page, '.arm-value').last()).toHaveText('41.9%');
  });

  test('shows the parsed metadata rows', async ({ openSurface }) => {
    const page = await openSurface(STUDIO_EDIT);

    const rows = panel(page, '.rows').first();
    await expect(rows).toContainText('12:22'); // 742 seconds
    await expect(rows).toContainText('2025-08-19');
    await expect(rows).toContainText('Education');
    await expect(rows).toContainText('public');
  });

  test('surfaces the copyright claim as a flag', async ({ openSurface }) => {
    const page = await openSurface(STUDIO_EDIT);
    await expect(panel(page, '.pill-row')).toContainText('1 copyright claim');
  });

  test('exposes the full VideoContext as JSON in diagnostics', async ({ openSurface }) => {
    const page = await openSurface(STUDIO_EDIT);
    await openDiagnostics(page);

    const json = panel(page, '.json');
    await expect(json).toBeVisible();

    const text = (await json.textContent()) ?? '';
    const parsed = JSON.parse(text) as Record<string, unknown>;
    expect(parsed.videoId).toBe('PPGYNmrVG58');
    expect(parsed.tags).toHaveLength(11);
    expect(parsed.suggestedHashtags).toHaveLength(5);
    // The stream URL is in the fixture and must never reach our model.
    expect(text).not.toContain('googlevideo');
  });

  test('reports no schema drift against the documented shape', async ({ openSurface }) => {
    const page = await openSurface(STUDIO_EDIT);
    await openDiagnostics(page);

    await expect(panel(page, '.pill').filter({ hasText: 'matches' })).toBeVisible();
    // A clean parse must not show the user a warning banner.
    await expect(panel(page, '.banner')).toHaveCount(0);
  });
});

test.describe('M2: the buffering requirement', () => {
  test('captures the payload requested before the panel existed', async ({ openSurface }) => {
    // The mock issues the XHR from <head>, i.e. before document_idle when the
    // panel's content script runs. Without the transport's pre-handshake buffer
    // this payload is lost and the panel shows nothing.
    const page = await openSurface(STUDIO_EDIT);

    const status = await page.evaluate(
      () => (window as unknown as { __mockXhrDone: Promise<number> }).__mockXhrDone,
    );
    expect(status).toBe(200);

    // Rendered anyway, from the flushed buffer.
    await expect(panel(page, '.video-title')).toContainText('Build an AI Agent');
  });

  test('counts the intercepted exchange', async ({ openSurface }) => {
    const page = await openSurface(STUDIO_EDIT);
    await openDiagnostics(page);

    await expect(panel(page, '.pill').filter({ hasText: 'exchange' })).toBeVisible();
    await expect(panel(page, '.log-kind').first()).toHaveText('CREATOR_VIDEOS');
  });
});

test.describe('M2: both transports', () => {
  test('captures a fetch-issued request', async ({ openSurface }) => {
    const page = await openSurface(STUDIO_EDIT);
    await openDiagnostics(page);

    const before = await panel(page, '.log li').count();

    await page.evaluate(() =>
      (window as unknown as { __mockFetchVideos: () => Promise<string> }).__mockFetchVideos(),
    );

    await expect(panel(page, '.log li')).toHaveCount(before + 1);
  });

  test('captures a fetch called with a URL object', async ({ openSurface }) => {
    // The brief's `typeof input === 'string' ? input : input.url` yields
    // undefined for a URL, so this request went uncaptured entirely.
    const page = await openSurface(STUDIO_EDIT);
    await openDiagnostics(page);

    const before = await panel(page, '.log li').count();

    await page.evaluate(() =>
      (
        window as unknown as { __mockFetchWithUrlObject: () => Promise<string> }
      ).__mockFetchWithUrlObject(),
    );

    await expect(panel(page, '.log li')).toHaveCount(before + 1);
  });

  test('ignores traffic that is not an InnerTube route we consume', async ({ openSurface }) => {
    const page = await openSurface(STUDIO_EDIT);
    await openDiagnostics(page);

    const before = await panel(page, '.log li').count();

    await page.evaluate(() =>
      (window as unknown as { __mockNoise: () => Promise<unknown> }).__mockNoise(),
    );
    await page.waitForTimeout(300);

    // log_event and generate_204 must not be captured.
    await expect(panel(page, '.log li')).toHaveCount(before);
  });
});

test.describe('M2: the cross-world boundary', () => {
  test('rejects a forged message using the shape the brief would have accepted', async ({
    openSurface,
  }) => {
    const page = await openSurface(STUDIO_EDIT);
    await openDiagnostics(page);

    const before = await panel(page, '.log li').count();

    // The original design keyed only on `__neuratube: true`, so any page script
    // could inject arbitrary text straight into an AI prompt.
    await page.evaluate(() => {
      window.postMessage(
        {
          __neuratube: true,
          kind: 'CREATOR_VIDEOS',
          responseText: JSON.stringify({
            videos: [{ videoId: 'PPGYNmrVG58', title: 'INJECTED BY THE PAGE' }],
          }),
        },
        '*',
      );
    });
    await page.waitForTimeout(300);

    await expect(panel(page, '.log li')).toHaveCount(before);
    await expect(panel(page, '.video-title')).not.toContainText('INJECTED');
  });

  test('rejects a wire-shaped forgery with a guessed nonce', async ({ openSurface }) => {
    const page = await openSurface(STUDIO_EDIT);
    await openDiagnostics(page);

    const before = await panel(page, '.log li').count();

    await page.evaluate(() => {
      window.postMessage(
        {
          __neuratube_wire: 1,
          nonce: 'guessed-nonce-000000000000',
          seq: 1,
          exchange: {
            kind: 'CREATOR_VIDEOS',
            url: '/youtubei/v1/creator/get_creator_videos',
            method: 'POST',
            status: 200,
            responseText: JSON.stringify({
              videos: [{ videoId: 'PPGYNmrVG58', title: 'FORGED' }],
            }),
            requestBody: null,
            at: 1,
            skipped: null,
          },
        },
        '*',
      );
    });
    await page.waitForTimeout(300);

    await expect(panel(page, '.log li')).toHaveCount(before);
    await expect(panel(page, '.video-title')).not.toContainText('FORGED');
  });

  test('the interceptor exposes no extension API to the page', async ({ openSurface }) => {
    const page = await openSurface(STUDIO_EDIT);

    // The MAIN-world script must hold nothing worth stealing.
    const exposure = await page.evaluate(() => ({
      chrome: typeof (window as unknown as { chrome?: unknown }).chrome,
      runtime: typeof (window as unknown as { chrome?: { runtime?: unknown } }).chrome?.runtime,
    }));

    expect(exposure.runtime).toBe('undefined');
  });

  test('does not break the page when Studio issues a non-text response type', async ({
    openSurface,
  }) => {
    const page = await openSurface(STUDIO_EDIT);

    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));

    // The brief reads `this.responseText` unconditionally, which throws
    // InvalidStateError for responseType 'json' — inside YouTube's own dispatch.
    const status = await page.evaluate(
      () =>
        new Promise<number>((resolve) => {
          const xhr = new XMLHttpRequest();
          xhr.open('POST', '/youtubei/v1/creator/get_creator_videos?alt=json');
          xhr.responseType = 'json';
          xhr.addEventListener('load', () => {
            resolve(xhr.status);
          });
          xhr.addEventListener('error', () => {
            resolve(0);
          });
          xhr.send('{}');
        }),
    );

    expect(status).toBe(200);
    expect(errors).toEqual([]);
  });
});

test.describe('M2: surface awareness', () => {
  test('shows the video the URL names, not merely the first in the batch', async ({
    openSurface,
  }) => {
    // get_creator_videos returns a batch of two; the panel must track the one
    // being edited.
    const page = await openSurface(STUDIO_OTHER_VIDEO);
    await expect(panel(page, '.video-title')).toHaveText('Shorts test upload');
  });

  test('applies guardrail flags from the parsed data', async ({ openSurface }) => {
    const page = await openSurface(STUDIO_OTHER_VIDEO);

    // These drive AI behaviour in M5, so they must be visible and correct now.
    await expect(panel(page, '.pill-row')).toContainText('Made for kids');
    await expect(panel(page, '.pill-row')).toContainText('Paid promotion');
  });

  /**
   * Replaces an assertion that the panel shows nothing here. Public parsing
   * landed, so the correct expectation inverted: it must now show the video AND
   * mark it as a public source, because a public page cannot see made-for-kids
   * or paid promotion and a false there means "unknown", not "clean".
   */
  test('reads a public watch page and does not claim Studio-only facts', async ({
    openSurface,
  }) => {
    const page = await openSurface(WATCH);

    await expect(panel(page, '.panel')).toBeVisible();
    await expect(
      panel(page, '.card-title').filter({ hasText: 'Waiting for Studio data' }),
    ).toHaveCount(0);
    // Guardrail pills are a Studio-only affordance and must not appear here,
    // since their inputs are unobservable on a public page.
    await expect(panel(page, '.pill-row').filter({ hasText: 'Made for kids' })).toHaveCount(0);
  });
});

test.describe('M2: privacy is unchanged', () => {
  test('still makes no network requests of its own', async ({ openSurface, context }) => {
    const unexpected: string[] = [];
    context.on('request', (request) => {
      const url = request.url();
      if (url.startsWith('chrome-extension://')) return;
      if (url.startsWith('https://studio.youtube.com')) return;
      if (url.startsWith('https://www.youtube.com')) return;
      unexpected.push(url);
    });

    await openSurface(STUDIO_EDIT);

    expect(unexpected, `unexpected requests: ${unexpected.join(', ')}`).toEqual([]);
  });
});
