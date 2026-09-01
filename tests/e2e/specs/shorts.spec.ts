/**
 * YouTube Shorts acceptance suite.
 *
 * The reported bug: the panel read a Short's title, duration, views and channel
 * perfectly, then reported "Unsupported page / none on this page". The video id
 * on a Short lives in the PATH (`/shorts/<id>`) rather than in a `v=` query
 * parameter, so surface detection returned unsupported while the page-data
 * pipeline carried on working — the two disagreed.
 */

import { configureProvider, expect, mockProviders, panel, test } from '../fixtures';
import type { Page } from '@playwright/test';

const SHORT_ID = 'TenGLiqgD50';
const SHORT = `https://www.youtube.com/shorts/${SHORT_ID}`;

async function openTask(page: Page, label: string): Promise<void> {
  await panel(page, '.task-btn').filter({ hasText: label }).first().click();
}

test.describe('Shorts is a supported surface', () => {
  test('names the surface and the video instead of reporting unsupported', async ({
    openSurface,
  }) => {
    const page = await openSurface(SHORT);

    await expect(panel(page, '.panel')).toContainText('YouTube · Shorts');
    await expect(panel(page, '.panel')).toContainText(SHORT_ID);
    // The exact strings from the bug report.
    await expect(panel(page, '.panel')).not.toContainText('Unsupported page');
    await expect(panel(page, '.panel')).not.toContainText('none on this page');
  });

  test('reads the Short like any other video', async ({ openSurface }) => {
    const page = await openSurface(SHORT);

    await expect(panel(page, '.panel')).toContainText('Melissa McCarthy effect');
    await expect(panel(page, '.panel')).toContainText('1:12');
    await expect(panel(page, '.panel')).toContainText('32,208');
    await expect(panel(page, '.panel')).toContainText('DJ NOTUN GAN');
  });

  test('offers the public task set, including the comment generator', async ({ openSurface }) => {
    const page = await openSurface(SHORT);

    await expect(panel(page, '.tasks')).toContainText('Comment generator');
    await expect(panel(page, '.tasks')).toContainText('Comment insights');
    // A Short has no chapter list and is not the user's to edit.
    await expect(panel(page, '.tasks')).not.toContainText('Chapters');
    await expect(panel(page, '.tasks')).not.toContainText('Title optimizer');
  });

  /**
   * Scrolling through Shorts rewrites the path with no document load. Because the
   * id is part of the path, each Short is a genuine surface change — so the
   * per-video reset fires and the previous Short's drafts do not linger.
   */
  test('follows a scroll to the next Short and discards the previous results', async ({
    context,
    openSurface,
    serviceWorker,
  }) => {
    await mockProviders(context, { titleList: true });
    await configureProvider(serviceWorker);

    const page = await openSurface(SHORT);
    await openTask(page, 'Comment generator');
    await expect(panel(page, '.suggestions li')).not.toHaveCount(0);

    await page.evaluate(() => {
      const scroll = (window as unknown as { __mockShortsScroll: (v: string) => Promise<string> })
        .__mockShortsScroll;
      return scroll('Xo8bwzAFhSw');
    });

    await expect(panel(page, '.tasks')).toBeVisible();
    await expect(panel(page, '.suggestions li')).toHaveCount(0);
  });

  test('keeps its own panel position, separate from the watch page', async ({ openSurface }) => {
    // A Short is a full-height vertical player; a panel placed for the watch page
    // would land on top of it, so geometry is stored per surface.
    const short = await openSurface(SHORT);
    await expect(panel(short, '.panel')).toBeVisible();
    await short.close();

    const watch = await openSurface('https://www.youtube.com/watch?v=Xo8bwzAFhSw');
    await expect(panel(watch, '.panel')).toContainText('YouTube · Watch');
  });
});

test.describe('Comment generator', () => {
  test('produces individually copyable comments', async ({
    context,
    openSurface,
    serviceWorker,
  }) => {
    await mockProviders(context, { titleList: true });
    await configureProvider(serviceWorker);

    const page = await openSurface(SHORT);
    await openTask(page, 'Comment generator');

    // The whole point is posting ONE, so each needs its own copy button.
    const items = panel(page, '.suggestions li');
    await expect(items).not.toHaveCount(0);
    await expect(items.first().getByRole('button', { name: /copy/i })).toBeVisible();
  });

  test('sends the existing comments so it does not repeat one', async ({
    context,
    openSurface,
    serviceWorker,
  }) => {
    const providers = await mockProviders(context, { titleList: true });
    await configureProvider(serviceWorker);

    const page = await openSurface(SHORT);
    await openTask(page, 'Comment generator');
    await expect(panel(page, '.suggestions li')).not.toHaveCount(0);

    const body = providers.forHost('api.openai.com').at(-1)?.body ?? '';
    expect(body).toContain('Statham never stood a chance here');
    expect(body).toContain('What movie is this from?');
    // And the video itself, so the comments can be specific.
    expect(body).toContain('Melissa McCarthy effect');
  });

  test('uses the transcript when the Short has captions', async ({
    context,
    openSurface,
    serviceWorker,
  }) => {
    const providers = await mockProviders(context, { titleList: true });
    await configureProvider(serviceWorker);

    const page = await openSurface(SHORT);
    await page.evaluate(() => {
      const mock = (window as unknown as { __mockTimedText: (v: string) => Promise<string> })
        .__mockTimedText;
      return mock('TenGLiqgD50');
    });

    await openTask(page, 'Comment generator');
    await expect(panel(page, '.switch')).toContainText('Use transcript');

    await panel(page, '.task-output-head button').filter({ hasText: /^Run/ }).click();
    await expect(panel(page, '.suggestions li')).not.toHaveCount(0);

    const body = providers.forHost('api.openai.com').at(-1)?.body ?? '';
    // A comment referring to something actually said is the difference between
    // engagement and noise.
    expect(body).toContain('[0:00]');
  });

  test('is not offered inside Studio, where the user is the creator', async ({ openSurface }) => {
    const page = await openSurface('https://studio.youtube.com/video/PPGYNmrVG58/edit');
    await expect(panel(page, '.tasks')).not.toContainText('Comment generator');
  });
});
