/**
 * Chapters acceptance suite.
 *
 * The feature's hard problem is not generation, it is data: `get_captions_timings`
 * fires only when Studio's subtitles editor opens, and the request cannot be
 * replayed because it carries the transcript text as its INPUT. So the flow under
 * test here is the whole chain that works around that:
 *
 *   subtitles page fires the request
 *     -> interceptor captures the response
 *     -> worker caches it in storage.session, keyed by video
 *     -> a DIFFERENT page load on the details page reads it back
 *     -> chapters run with real timestamps
 *
 * The cross-page hop is the part that has to work. A test that captured and used
 * the transcript on one page would prove nothing, because that is not how a
 * creator uses Studio.
 */

import { configureProvider, expect, mockProviders, panel, test } from '../fixtures';
import type { Page } from '@playwright/test';
import type { Worker } from '@playwright/test';

const VIDEO_ID = 'PPGYNmrVG58';
const STUDIO_EDIT = `https://studio.youtube.com/video/${VIDEO_ID}/edit`;
const STUDIO_SUBTITLES = `https://studio.youtube.com/video/${VIDEO_ID}/translations`;

/** Trigger the caption-timings request the way Studio's subtitles editor does. */
async function fireCaptionsTimings(page: Page, videoId = VIDEO_ID): Promise<void> {
  await page.evaluate((id) => {
    const mock = (window as unknown as { __mockCaptionsTimings?: (v: string) => Promise<string> })
      .__mockCaptionsTimings;
    if (mock === undefined)
      throw new Error('mock studio page did not expose __mockCaptionsTimings');
    return mock(id);
  }, videoId);
}

/** What the worker has cached, read from the worker itself. */
async function cachedIds(serviceWorker: Worker): Promise<readonly string[]> {
  return serviceWorker.evaluate(async () => {
    const bag = await chrome.storage.session.get(null);
    return Object.keys(bag)
      .filter((key) => key.startsWith('neuratube:transcript:'))
      .map((key) => key.slice('neuratube:transcript:'.length));
  });
}

async function openTask(page: Page, label: string): Promise<void> {
  await panel(page, '.task-btn').filter({ hasText: label }).first().click();
}

/**
 * Flip the transcript switch the way a user does — by clicking the label.
 *
 * NOT `.uncheck()` on the input: the input is visually hidden under the drawn
 * track (so it stays keyboard reachable and screen-reader announced), which means
 * the track intercepts a direct click on it. Clicking the label is both what a
 * pointer user actually does and what the browser forwards to the input.
 */
async function flipTranscriptSwitch(page: Page): Promise<void> {
  await panel(page, '.switch').click();
}

/** The Run / Run again control, which lives in the task-output header. */
function runButton(page: Page) {
  return panel(page, '.task-output-head button').filter({ hasText: /^Run/ });
}

test.describe('capturing caption timings', () => {
  test('captures the transcript when the subtitles editor fires the request', async ({
    openSurface,
  }) => {
    const page = await openSurface(STUDIO_SUBTITLES);
    await openTask(page, 'Chapter');

    // Before the request there is nothing, and the panel must say so rather
    // than let the user run a task that would invent timestamps.
    await expect(panel(page, '.banner')).toContainText(
      "Open Studio's subtitles editor on this page",
    );

    await fireCaptionsTimings(page);

    await expect(panel(page, '.pill--ok')).toContainText('transcript ready');
    await expect(panel(page, '.pill--ok')).toContainText('52 segments');
  });

  test('persists it to the worker so a later page load can use it', async ({
    openSurface,
    serviceWorker,
  }) => {
    const subtitles = await openSurface(STUDIO_SUBTITLES);
    await fireCaptionsTimings(subtitles);

    await expect.poll(() => cachedIds(serviceWorker), { timeout: 5_000 }).toContain(VIDEO_ID);
  });

  /**
   * The test that actually justifies the cache. Two independent page loads, and
   * the second one never sees the network response.
   */
  test('a fresh page load on the details page reads the cached transcript', async ({
    openSurface,
    serviceWorker,
  }) => {
    const subtitles = await openSurface(STUDIO_SUBTITLES);
    await fireCaptionsTimings(subtitles);
    await expect.poll(() => cachedIds(serviceWorker), { timeout: 5_000 }).toContain(VIDEO_ID);
    await subtitles.close();

    const edit = await openSurface(STUDIO_EDIT);
    await openTask(edit, 'Chapter');

    await expect(panel(edit, '.pill--ok')).toContainText('transcript ready');
  });

  test('does not hand one video the timings of another', async ({ openSurface, serviceWorker }) => {
    const subtitles = await openSurface(STUDIO_SUBTITLES);
    // Timings arrive for a video the user is not editing.
    await fireCaptionsTimings(subtitles, 'someOtherVid');
    await expect.poll(() => cachedIds(serviceWorker), { timeout: 5_000 }).toContain('someOtherVid');
    await subtitles.close();

    const edit = await openSurface(STUDIO_EDIT);
    await openTask(edit, 'Chapter');

    // Chapters for the wrong video would be silently, confidently wrong — the
    // worst failure this feature can have — so the panel must stay empty-handed.
    await expect(panel(edit, '.banner')).toContainText(
      "Open Studio's subtitles editor on this page",
    );
    await expect(panel(edit, '.pill--ok')).toHaveCount(0);
  });
});

test.describe('the panel when no transcript exists', () => {
  test('blocks the chapters run rather than generating invented timestamps', async ({
    openSurface,
  }) => {
    const page = await openSurface(STUDIO_EDIT);
    await openTask(page, 'Chapter');

    await expect(panel(page, '.banner')).toContainText('any timestamp would be guessed');
    await expect(runButton(page)).toBeDisabled();
  });

  /**
   * The behaviour the previous version got wrong. Studio's subtitles editor is a
   * modal over the SAME page at the SAME url, so the button must open it in place
   * — an earlier build opened a new tab and told the user to come back, which was
   * friction built on a misreading of Studio.
   */
  test('opens the subtitles editor in place, without navigating or opening a tab', async ({
    openSurface,
  }) => {
    const page = await openSurface(STUDIO_EDIT);
    await openTask(page, 'Chapter');

    const before = page.url();
    const pagesBefore = page.context().pages().length;

    await panel(page, '.transcript-actions button').click();

    // The modal opened here, the endpoint fired, and the transcript arrived —
    // with no navigation and no second tab.
    await expect(panel(page, '.pill--ok')).toContainText('transcript ready');
    expect(page.url()).toBe(before);
    expect(page.context().pages()).toHaveLength(pagesBefore);
    await expect(page.locator('#subtitles-modal')).toBeVisible();
  });

  test('says so plainly when Studio offers no subtitles control', async ({ openSurface }) => {
    const page = await openSurface(STUDIO_EDIT);
    await openTask(page, 'Chapter');

    // Stand in for a Studio layout where the control is absent or renamed.
    await page.evaluate(() => {
      document.getElementById('subtitles-editor-link')?.remove();
    });

    await panel(page, '.transcript-actions button').click();
    await expect(panel(page, '.banner')).toContainText("Could not find Studio's Subtitles control");
  });
});

test.describe('using the transcript', () => {
  test('sends real timestamps to the model, and only real ones', async ({
    context,
    openSurface,
    serviceWorker,
  }) => {
    const providers = await mockProviders(context);

    await serviceWorker.evaluate(async () => {
      await chrome.storage.local.set({
        'neuratube:credentials': { openai: 'sk-mock-openai-abcdefghijklmnopqrstuvwxyz01' },
      });
      const bag = await chrome.storage.local.get('neuratube:state');
      const state = (bag['neuratube:state'] ?? {}) as Record<string, unknown>;
      await chrome.storage.local.set({
        'neuratube:state': {
          ...state,
          schemaVersion: 3,
          providers: {
            ...((state.providers ?? {}) as Record<string, unknown>),
            openai: { model: 'openai-mock-large', baseUrl: '', enabled: true },
          },
        },
      });
    });

    const page = await openSurface(STUDIO_EDIT);
    await fireCaptionsTimings(page);
    await openTask(page, 'Chapter');
    await expect(panel(page, '.pill--ok')).toContainText('transcript ready');

    await runButton(page).click();
    await expect(panel(page, '.output')).not.toBeEmpty();

    const call = providers.forHost('api.openai.com').at(-1);
    expect(call).toBeDefined();
    const body = call?.body ?? '';

    // Timestamps present, in the format the prompt tells the model to copy.
    expect(body).toContain('[0:00] Look at this blurry video.');
    expect(body).toContain('[5:06]');
    expect(body).toContain('[2:31]');
    // And the instruction that makes them authoritative.
    expect(body).toContain('never estimate one');

    // The transcript came from a request carrying live session credentials. None
    // of it may reach a provider.
    for (const secret of ['eats', 'sessionInfo', 'onBehalfOfUser', 'clientScreenNonce']) {
      expect(body).not.toContain(secret);
    }
  });
});

test.describe('how much room the transcript prompt takes', () => {
  /**
   * Regression for a real complaint: the Title optimizer showed a warning banner,
   * three sentences and a button for something that was never blocking it. The
   * output belongs above the fold, not under an obstacle.
   */
  test('an optional task gets one quiet line, no banner and no button', async ({ openSurface }) => {
    const page = await openSurface(STUDIO_EDIT);
    await openTask(page, 'Title optimizer');

    await expect(panel(page, '.transcript-hint')).toContainText('running on metadata only');
    await expect(panel(page, '.transcript-actions')).toHaveCount(0);
    await expect(panel(page, '.banner--warn')).toHaveCount(0);
    // And it must not block the run.
    await expect(runButton(page)).toBeEnabled();
  });

  test('chapters still gets the full explanation, because it is blocked', async ({
    openSurface,
  }) => {
    const page = await openSurface(STUDIO_EDIT);
    await openTask(page, 'Chapter');

    await expect(panel(page, '.banner--warn')).toHaveCount(1);
    await expect(panel(page, '.transcript-actions button')).toBeVisible();
    await expect(runButton(page)).toBeDisabled();
  });

  test('the aligner firing first does not surface as an error', async ({ openSurface }) => {
    const page = await openSurface(STUDIO_EDIT);
    await openTask(page, 'Chapter');

    // Fires get_captions_timings (empty) then get_captions_translation (full).
    await fireCaptionsTimings(page);

    await expect(panel(page, '.pill--ok')).toContainText('52 segments');
    await expect(panel(page, '[data-testid="transcript-diagnosis"]')).toHaveCount(0);
  });
});

test.describe('the transcript switch', () => {
  /**
   * The user's request, and the reason it matters: auto-captions on some videos
   * are bad enough to be worse than the metadata alone, and only the creator
   * knows which. So where the transcript is optional, it is a choice.
   */
  test('an optional task offers a switch, on by default', async ({ openSurface }) => {
    const page = await openSurface(STUDIO_EDIT);
    await fireCaptionsTimings(page);
    await openTask(page, 'Title optimizer');

    const toggle = panel(page, '.switch input');
    await expect(toggle).toBeChecked();
    await expect(panel(page, '.switch')).toContainText('Use transcript');
    await expect(panel(page, '.switch')).toContainText('52 segments');
  });

  test('switching it off changes what is sent to the model', async ({
    context,
    openSurface,
    serviceWorker,
  }) => {
    const providers = await mockProviders(context, { titleList: true });
    await configureProvider(serviceWorker);

    const page = await openSurface(STUDIO_EDIT);
    await fireCaptionsTimings(page);
    await openTask(page, 'Title optimizer');

    // On by default: the transcript goes. A title run renders as a suggestion
    // list rather than a raw <pre>, so assert on that.
    await runButton(page).click();
    await expect(panel(page, '.suggestions li')).not.toHaveCount(0);
    expect(providers.forHost('api.openai.com').at(-1)?.body ?? '').toContain('[0:00] Look at this');

    // Switched off: it does not, and the run still works.
    await flipTranscriptSwitch(page);
    await expect(panel(page, '.switch input')).not.toBeChecked();
    await expect(panel(page, '.transcript-rails')).toContainText('metadata only');
    await runButton(page).click();
    await expect(panel(page, '.suggestions li')).not.toHaveCount(0);

    const after = providers.forHost('api.openai.com').at(-1)?.body ?? '';
    expect(after).not.toContain('[0:00] Look at this');
    expect(after).not.toContain('Timed transcript');
    // The video metadata is still there — this removes the transcript, not context.
    expect(after).toContain('Title:');
  });

  test('the choice survives a reload, per task', async ({ openSurface }) => {
    const first = await openSurface(STUDIO_EDIT);
    await fireCaptionsTimings(first);
    await openTask(first, 'Title optimizer');
    await flipTranscriptSwitch(first);
    await expect(panel(first, '.switch input')).not.toBeChecked();
    await first.close();

    const second = await openSurface(STUDIO_EDIT);
    await fireCaptionsTimings(second);
    await openTask(second, 'Title optimizer');
    await expect(panel(second, '.switch input')).not.toBeChecked();

    // Per task: the tag generator was never switched off.
    await panel(second, '.icon-btn[aria-label="Back to task list"]').click();
    await openTask(second, 'Tag generator');
    await expect(panel(second, '.switch input')).toBeChecked();
  });

  test('chapters gets no switch, because it cannot run without timings', async ({
    openSurface,
  }) => {
    const page = await openSurface(STUDIO_EDIT);
    await fireCaptionsTimings(page);
    await openTask(page, 'Chapter');

    await expect(panel(page, '.switch')).toHaveCount(0);
    await expect(panel(page, '.pill--ok')).toContainText('52 segments');
  });

  test('the switch is keyboard reachable and announces its state', async ({ openSurface }) => {
    const page = await openSurface(STUDIO_EDIT);
    await fireCaptionsTimings(page);
    await openTask(page, 'Title optimizer');

    // A real checkbox, not a div pretending to be one: focusable, and toggled by
    // Space like any other.
    await panel(page, '.switch input').focus();
    await page.keyboard.press('Space');
    await expect(panel(page, '.switch input')).not.toBeChecked();
  });
});

test.describe('when only the aligner has the track', () => {
  /**
   * Reported from a live unlisted video. `get_captions_translation` came back with
   * a `translation` wrapper but no segments, and the full track was in
   * `get_captions_timings` — which had been demoted to log-only on the strength of
   * one earlier capture where it was empty. The result was a "schema mismatch"
   * message on a video that had a perfectly good transcript.
   */
  test('reads the transcript from get_captions_timings', async ({ openSurface }) => {
    const page = await openSurface(STUDIO_EDIT);
    await openTask(page, 'Chapter');

    await page.evaluate(() => {
      const mock = (
        window as unknown as { __mockUnlistedSubtitles: (v: string) => Promise<string> }
      ).__mockUnlistedSubtitles;
      return mock('PPGYNmrVG58');
    });

    await expect(panel(page, '.pill--ok')).toContainText('transcript ready');
    await expect(runButton(page)).toBeEnabled();
  });

  test('does not report a schema mismatch once a source succeeded', async ({ openSurface }) => {
    const page = await openSurface(STUDIO_EDIT);
    await openTask(page, 'Chapter');

    await page.evaluate(() => {
      const mock = (
        window as unknown as { __mockUnlistedSubtitles: (v: string) => Promise<string> }
      ).__mockUnlistedSubtitles;
      return mock('PPGYNmrVG58');
    });

    await expect(panel(page, '.pill--ok')).toContainText('transcript ready');
    // The empty translation response must not leave an error behind it.
    await expect(panel(page, '[data-testid="transcript-diagnosis"]')).toHaveCount(0);
  });
});

test.describe('changing video inside Studio', () => {
  /**
   * The other half of the live report: editing a different video left the
   * previous one's generated titles in the panel, which reads as output for the
   * video now open.
   */
  test('discards the previous video results', async ({ context, openSurface, serviceWorker }) => {
    await mockProviders(context, { titleList: true });
    await configureProvider(serviceWorker);

    const page = await openSurface(STUDIO_EDIT);
    await openTask(page, 'Title optimizer');
    await expect(panel(page, '.suggestions li')).not.toHaveCount(0);

    // Studio rewrites the URL without a document load.
    await page.evaluate(() => {
      (window as unknown as { __mockNavigate: (h: string) => void }).__mockNavigate(
        '/video/dQw4w9WgXcQ/edit',
      );
    });

    await expect(panel(page, '.tasks')).toBeVisible();
    await expect(panel(page, '.suggestions li')).toHaveCount(0);
  });

  /**
   * Studio rewrites the URL for its own tabs and analytics periods within one
   * video. Treating those as navigations would throw away work mid-read.
   */
  test('keeps results when only the tab changes within one video', async ({
    context,
    openSurface,
    serviceWorker,
  }) => {
    await mockProviders(context, { titleList: true });
    await configureProvider(serviceWorker);

    const page = await openSurface(STUDIO_EDIT);
    await openTask(page, 'Title optimizer');
    await expect(panel(page, '.suggestions li')).not.toHaveCount(0);

    await page.evaluate(() => {
      (window as unknown as { __mockNavigate: (h: string) => void }).__mockNavigate(
        '/video/PPGYNmrVG58/edit?tab=advanced',
      );
    });

    await page.waitForTimeout(1200);
    await expect(panel(page, '.suggestions li')).not.toHaveCount(0);
  });
});
