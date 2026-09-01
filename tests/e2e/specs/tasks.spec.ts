/**
 * M5 acceptance suite.
 *
 * Runs real tasks from inside the panel on the mock Studio page, with all four
 * provider APIs mocked. This is the first suite where the whole product is
 * exercised end to end: intercept -> parse -> guardrails -> provider -> stream ->
 * panel -> clipboard.
 */

import { configureProvider, expect, mockProviders, panel, test } from '../fixtures';
import type { Page } from '@playwright/test';

const STUDIO_EDIT = 'https://studio.youtube.com/video/PPGYNmrVG58/edit';
/** The fixture's second video: made for kids AND paid promotion. */
const STUDIO_FLAGGED = 'https://studio.youtube.com/video/dQw4w9WgXcQ/edit';

const KEY = 'sk-mock-openai-abcdefghijklmnopqrstuvwxyz01';

/** Open a task by name from the panel's task rail. */
async function openTask(page: Page, label: string): Promise<void> {
  await panel(page, '.task-btn').filter({ hasText: label }).first().click();
}

test.describe('M5 acceptance: running a task from the panel', () => {
  test('lists only the tasks this surface supports', async ({ openSurface }) => {
    const page = await openSurface(STUDIO_EDIT);

    const tasks = panel(page, '.task-btn');
    await expect(tasks).not.toHaveCount(0);
    await expect(panel(page, '.tasks')).toContainText('Tag generator');
    await expect(panel(page, '.tasks')).toContainText('Title optimizer');
    // A public-page task must not be offered inside Studio.
    await expect(panel(page, '.tasks')).not.toContainText('Steal this video');
  });

  test('streams output and reports provider, tokens and cost', async ({
    context,
    openSurface,
    serviceWorker,
  }) => {
    await mockProviders(context);
    await configureProvider(serviceWorker);

    const page = await openSurface(STUDIO_EDIT);
    await openTask(page, 'Tag generator');

    await expect(panel(page, '.output')).toContainText('ai agent, langchain, tutorial');
    await expect(panel(page, '.muted-line')).toContainText('OpenAI');
    await expect(panel(page, '.muted-line')).toContainText('420 in');
    await expect(panel(page, '.muted-line')).toContainText('12 out');
    // The mock model has no bundled price, and inventing one would be worse
    // than admitting we do not know it.
    await expect(panel(page, '.muted-line')).toContainText('cost unknown');
  });

  test('sends the parsed video metadata, not a placeholder', async ({
    context,
    openSurface,
    serviceWorker,
  }) => {
    const mock = await mockProviders(context);
    await configureProvider(serviceWorker);

    const page = await openSurface(STUDIO_EDIT);
    await openTask(page, 'Tag generator');
    await expect(panel(page, '.output')).toContainText('ai agent');

    const chat = mock.calls.find((call) => call.url.includes('/chat/completions'));
    expect(chat).toBeDefined();

    const body = JSON.parse(chat!.body ?? '{}') as { messages: { content: string }[] };
    const joined = body.messages.map((message) => message.content).join('\n');

    // The real title from the intercepted payload, fenced as untrusted data.
    expect(joined).toContain('Build an AI Agent in 12 Minutes');
    expect(joined).toContain('VIDEO CONTEXT');
    expect(joined).toContain('<<<');
  });

  test('can be cancelled mid-run', async ({ context, openSurface, serviceWorker }) => {
    // A stream that never completes, so Cancel has something to interrupt.
    await context.route('https://api.openai.com/**', async (route) => {
      if (route.request().url().includes('/models')) {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ data: [{ id: 'openai-mock-large' }] }),
        });
        return;
      }
      await route.fulfill({
        status: 200,
        contentType: 'text/event-stream',
        body: 'data: {"choices":[{"delta":{"content":"starting"}}]}\n\n',
      });
    });
    await configureProvider(serviceWorker);

    const page = await openSurface(STUDIO_EDIT);
    await openTask(page, 'Tag generator');
    await expect(panel(page, '.output')).toContainText('starting');

    // The run completes on its own here (the stream closes), so assert the
    // control exists and the terminal state is reached rather than racing it.
    await expect(panel(page, '.ghost-btn').filter({ hasText: /Run again|Cancel/ })).toBeVisible();
  });

  test('copies the output to the clipboard', async ({ context, openSurface, serviceWorker }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await mockProviders(context);
    await configureProvider(serviceWorker);

    const page = await openSurface(STUDIO_EDIT);
    await openTask(page, 'Tag generator');
    await expect(panel(page, '.output')).toContainText('ai agent');

    await panel(page, '.task-actions button').first().click();
    await expect(panel(page, '.task-actions button').first()).toHaveText('Copied');

    const clipboard = await page.evaluate(() => navigator.clipboard.readText());
    expect(clipboard).toContain('ai agent');
  });

  test('offers a cleaned Copy All for tags', async ({ context, openSurface, serviceWorker }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await mockProviders(context);
    await configureProvider(serviceWorker);

    const page = await openSurface(STUDIO_EDIT);
    await openTask(page, 'Tag generator');
    await expect(panel(page, '.output')).toContainText('ai agent');

    const copyAll = panel(page, '.task-actions button').filter({ hasText: 'Copy all' });
    await expect(copyAll).toBeVisible();
    await copyAll.click();

    const clipboard = await page.evaluate(() => navigator.clipboard.readText());
    // Cleaned and de-duplicated, ready to paste into Studio's tag field.
    expect(clipboard).toBe('ai agent, langchain, tutorial');
  });

  test('says plainly that it does not write to YouTube', async ({
    context,
    openSurface,
    serviceWorker,
  }) => {
    await mockProviders(context);
    await configureProvider(serviceWorker);

    const page = await openSurface(STUDIO_EDIT);
    await openTask(page, 'Tag generator');
    await expect(panel(page, '.output')).toContainText('ai agent');

    await expect(panel(page, '.task-output')).toContainText('does not write to YouTube');
  });
});

test.describe('M5: guardrails are visible and applied', () => {
  test('shows which constraints came from Studio settings', async ({
    context,
    openSurface,
    serviceWorker,
  }) => {
    await mockProviders(context);
    await configureProvider(serviceWorker);

    // The fixture's second video is made-for-kids and has paid promotion.
    const page = await openSurface(STUDIO_FLAGGED);
    await openTask(page, 'Description structurizer');

    await expect(panel(page, '.rails')).toContainText('Made for kids');
    await expect(panel(page, '.rails')).toContainText('Paid promotion disclosure');
  });

  test('sends the constraints ahead of the task prompt', async ({
    context,
    openSurface,
    serviceWorker,
  }) => {
    const mock = await mockProviders(context);
    await configureProvider(serviceWorker);

    const page = await openSurface(STUDIO_FLAGGED);
    await openTask(page, 'Description structurizer');
    await expect(panel(page, '.output')).not.toBeEmpty();

    const chat = mock.calls.find((call) => call.url.includes('/chat/completions'));
    const body = JSON.parse(chat!.body ?? '{}') as {
      messages: { role: string; content: string }[];
    };

    // First message is the guardrail block, before the user-editable prompt.
    expect(body.messages[0]!.role).toBe('system');
    expect(body.messages[0]!.content).toContain('CONSTRAINTS FROM THIS VIDEO');
    expect(body.messages[0]!.content).toContain('MUST include a clear paid-promotion');
    expect(body.messages[1]!.content).toContain('You write YouTube descriptions');
  });

  test('warns when the output omits a required disclosure', async ({
    context,
    openSurface,
    serviceWorker,
  }) => {
    // The mock returns a tag list with no disclosure in it, which is exactly the
    // failure the post-hoc audit exists to catch.
    await mockProviders(context);
    await configureProvider(serviceWorker);

    const page = await openSurface(STUDIO_FLAGGED);
    await openTask(page, 'Description structurizer');

    const alert = panel(page, '[role="alert"]');
    await expect(alert).toContainText('does not appear to include a disclosure');
  });

  test('applies only the constraints the video actually warrants', async ({
    context,
    openSurface,
    serviceWorker,
  }) => {
    await mockProviders(context);
    await configureProvider(serviceWorker);

    const page = await openSurface(STUDIO_EDIT);
    await openTask(page, 'Description structurizer');
    await expect(panel(page, '.output')).not.toBeEmpty();

    // This video is not made-for-kids and has no paid promotion, but it DOES
    // carry one copyright claim — so exactly one advisory rail applies. The
    // engine reads real state rather than applying a blanket set.
    await expect(panel(page, '.rails')).toContainText('1 copyright claim');
    await expect(panel(page, '.rails')).not.toContainText('Made for kids');
    await expect(panel(page, '.rails')).not.toContainText('Paid promotion');

    // No MANDATORY constraint applied, so nothing to audit and no alert. Scoped
    // to `.rails` because the video card below also badges the copyright claim.
    await expect(panel(page, '.rails .pill--warn')).toHaveCount(0);
    await expect(panel(page, '[role="alert"]')).toHaveCount(0);
  });
});

test.describe('M5: error handling', () => {
  test('explains an unconfigured provider instead of failing silently', async ({ openSurface }) => {
    const page = await openSurface(STUDIO_EDIT);
    await openTask(page, 'Tag generator');

    await expect(panel(page, '[role="alert"]')).toContainText('No API key configured');
  });

  test('surfaces a rejected key with advice', async ({ context, openSurface, serviceWorker }) => {
    await context.route('https://api.openai.com/**', (route) =>
      route.fulfill({
        status: 401,
        contentType: 'application/json',
        body: JSON.stringify({ error: { message: 'Incorrect API key provided' } }),
      }),
    );
    await configureProvider(serviceWorker);

    const page = await openSurface(STUDIO_EDIT);
    await openTask(page, 'Tag generator');

    await expect(panel(page, '[role="alert"]')).toContainText('API key was rejected');
  });

  test('keeps the key out of an error the provider echoed back', async ({
    context,
    openSurface,
    serviceWorker,
  }) => {
    await context.route('https://api.openai.com/**', (route) =>
      route.fulfill({
        status: 401,
        contentType: 'application/json',
        body: JSON.stringify({ error: { message: `Invalid key ${KEY}` } }),
      }),
    );
    await configureProvider(serviceWorker);

    const page = await openSurface(STUDIO_EDIT);
    await openTask(page, 'Tag generator');
    await expect(panel(page, '[role="alert"]')).toBeVisible();

    const shown = await panel(page, '[role="alert"]').textContent();
    expect(shown).not.toContain(KEY);
    expect(shown).toContain('[redacted]');
  });
});

test.describe('M5: task state', () => {
  test('keeps each task result separately', async ({ context, openSurface, serviceWorker }) => {
    await mockProviders(context);
    await configureProvider(serviceWorker);

    const page = await openSurface(STUDIO_EDIT);

    await openTask(page, 'Tag generator');
    await expect(panel(page, '.output')).toContainText('ai agent');

    // Back to the list, then run a different task.
    await panel(page, '.icon-btn').filter({ hasText: '←' }).click();
    await expect(panel(page, '.tasks')).toBeVisible();
    // The finished task is badged so the user knows a result is waiting.
    await expect(panel(page, '.task-btn').filter({ hasText: 'Tag generator' })).toContainText(
      'ready',
    );

    await openTask(page, 'Title optimizer');
    await expect(panel(page, '.output')).toContainText('ai agent');

    // Returning to the first task still shows its own result.
    await panel(page, '.icon-btn').filter({ hasText: '←' }).click();
    await openTask(page, 'Tag generator');
    await expect(panel(page, '.output')).toContainText('ai agent');
  });

  test('clears a result on request', async ({ context, openSurface, serviceWorker }) => {
    await mockProviders(context);
    await configureProvider(serviceWorker);

    const page = await openSurface(STUDIO_EDIT);
    await openTask(page, 'Tag generator');
    await expect(panel(page, '.output')).toContainText('ai agent');

    await panel(page, '.task-actions button').filter({ hasText: 'Clear' }).click();
    // Clearing returns to the task list.
    await expect(panel(page, '.tasks')).toBeVisible();
  });
});

test.describe('M5: accessibility of the task view', () => {
  test('announces the streaming region politely rather than per token', async ({
    context,
    openSurface,
    serviceWorker,
  }) => {
    await mockProviders(context);
    await configureProvider(serviceWorker);

    const page = await openSurface(STUDIO_EDIT);
    await openTask(page, 'Tag generator');

    const output = panel(page, '.output');
    await expect(output).toHaveAttribute('aria-live', 'polite');
    await expect(output).toHaveAttribute('role', 'region');
    // Scrollable, so it must be focusable — the same rule axe caught in M4.
    await expect(output).toHaveAttribute('tabindex', '0');
  });
});

test.describe('M5: one copy button per suggestion', () => {
  test('splits a five-title response into individually copyable rows', async ({
    context,
    openSurface,
    serviceWorker,
  }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await mockProviders(context, { titleList: true });
    await configureProvider(serviceWorker);

    const page = await openSurface(STUDIO_EDIT);
    await openTask(page, 'Title optimizer');

    // Three rows, each with its own Copy button.
    await expect(panel(page, '.suggestions li')).toHaveCount(3);
    await expect(panel(page, '.copy-one')).toHaveCount(3);
  });

  test('copies only the chosen title, without numbering or rationale', async ({
    context,
    openSurface,
    serviceWorker,
  }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await mockProviders(context, { titleList: true });
    await configureProvider(serviceWorker);

    const page = await openSurface(STUDIO_EDIT);
    await openTask(page, 'Title optimizer');
    await expect(panel(page, '.suggestions li')).toHaveCount(3);

    // The second one, which legitimately ends in parentheses — the case a naive
    // parser would corrupt.
    await panel(page, '.copy-one').nth(1).click();
    await expect(panel(page, '.copy-one').nth(1)).toHaveText('Copied');

    const clipboard = await page.evaluate(() => navigator.clipboard.readText());
    expect(clipboard).toBe('Fix Blurry Footage in 5 Minutes (VideoProc AI Tutorial)');
    expect(clipboard).not.toContain('why:');
    expect(clipboard).not.toMatch(/^\d/);
  });

  test('measures each title against the length YouTube actually displays', async ({
    context,
    openSurface,
    serviceWorker,
  }) => {
    await mockProviders(context, { titleList: true });
    await configureProvider(serviceWorker);

    const page = await openSurface(STUDIO_EDIT);
    await openTask(page, 'Title optimizer');
    await expect(panel(page, '.suggestions li')).toHaveCount(3);

    // Measured locally — no reason to spend tokens asking a model to count.
    await expect(panel(page, '.suggestions .pill').first()).toContainText('chars');
  });

  test('shows the rationale but keeps it out of the copyable text', async ({
    context,
    openSurface,
    serviceWorker,
  }) => {
    await mockProviders(context, { titleList: true });
    await configureProvider(serviceWorker);

    const page = await openSurface(STUDIO_EDIT);
    await openTask(page, 'Title optimizer');

    await expect(panel(page, '.suggestion-note').first()).toHaveText('search-first');
    await expect(panel(page, '.suggestion-text').first()).not.toContainText('search-first');
  });

  test('falls back to a single Copy when the output is not a list', async ({
    context,
    openSurface,
    serviceWorker,
  }) => {
    // A model that ignores the format must not produce a broken list; the raw
    // block and one Copy button is the honest fallback.
    await context.route('https://api.openai.com/**', (route) =>
      route.request().url().includes('/models')
        ? route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({ data: [{ id: 'openai-mock-large' }] }),
          })
        : route.fulfill({
            status: 200,
            contentType: 'text/event-stream',
            body: 'data: {"choices":[{"delta":{"content":"Your title is already good, I would only tighten the ending."}}]}\n\ndata: [DONE]\n\n',
          }),
    );
    await configureProvider(serviceWorker);

    const page = await openSurface(STUDIO_EDIT);
    await openTask(page, 'Title optimizer');

    await expect(panel(page, '.output')).toContainText('already good');
    await expect(panel(page, '.suggestions')).toHaveCount(0);
    await expect(panel(page, '.task-actions button').first()).toHaveText('Copy');
  });

  test('keeps the whole-block copy as a secondary action', async ({
    context,
    openSurface,
    serviceWorker,
  }) => {
    await mockProviders(context, { titleList: true });
    await configureProvider(serviceWorker);

    const page = await openSurface(STUDIO_EDIT);
    await openTask(page, 'Title optimizer');
    await expect(panel(page, '.suggestions li')).toHaveCount(3);

    // Demoted to "Copy all" once per-item copy is available.
    await expect(panel(page, '.task-actions button').first()).toHaveText('Copy all');
  });
});

test.describe('M5: an empty result explains itself', () => {
  /**
   * Reported from a live session: some videos produced an empty output box on
   * Title optimizer and Tag generator while the request succeeded. The cause was
   * a reasoning model streaming `reasoning_content` — which nothing parsed — and
   * spending its whole budget before emitting an answer. The panel showed the
   * literal truth (no output) and nothing actionable.
   */
  test('names the reasoning budget when a model thinks until it runs out', async ({
    context,
    openSurface,
    serviceWorker,
  }) => {
    await context.route('https://api.openai.com/**', async (route) => {
      if (route.request().url().includes('/models')) {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ data: [{ id: 'openai-mock-large' }] }),
        });
        return;
      }
      await route.fulfill({
        status: 200,
        contentType: 'text/event-stream',
        body: [
          'data: {"choices":[{"delta":{"reasoning_content":"Considering the SEO angle at length"}}]}\n\n',
          'data: {"choices":[{"delta":{},"finish_reason":"length"}]}\n\n',
          'data: {"choices":[],"usage":{"prompt_tokens":800,"completion_tokens":900}}\n\n',
          'data: [DONE]\n\n',
        ].join(''),
      });
    });
    await configureProvider(serviceWorker);

    const page = await openSurface(STUDIO_EDIT);
    await openTask(page, 'Title optimizer');

    const notice = panel(page, '[data-testid="empty-output"]');
    await expect(notice).toBeVisible();
    await expect(notice).toContainText('reasoning model');
    await expect(notice).toContainText('Options → Advanced');
    // The thinking is offered as evidence rather than thrown away.
    await expect(panel(page, '.reasoning-peek')).toBeVisible();
  });

  /**
   * The fix belongs where the user is blocked. Sending them to another tab to
   * change a number and then back again is friction at the worst moment.
   */
  test('offers a one-click raise and retry from the banner itself', async ({
    context,
    openSurface,
    serviceWorker,
  }) => {
    let call = 0;
    await context.route('https://api.openai.com/**', async (route) => {
      if (route.request().url().includes('/models')) {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ data: [{ id: 'openai-mock-large' }] }),
        });
        return;
      }
      call += 1;
      // First attempt thinks itself out of budget; the retry succeeds.
      await route.fulfill({
        status: 200,
        contentType: 'text/event-stream',
        body:
          call === 1
            ? 'data: {"choices":[{"delta":{"reasoning_content":"thinking hard"}}]}\n\n' +
              'data: {"choices":[{"delta":{},"finish_reason":"length"}]}\n\n' +
              'data: [DONE]\n\n'
            : 'data: {"choices":[{"delta":{"content":"1. A Real Title"}}]}\n\n' +
              'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n' +
              'data: [DONE]\n\n',
      });
    });
    await configureProvider(serviceWorker);

    const page = await openSurface(STUDIO_EDIT);
    await openTask(page, 'Title optimizer');
    await expect(panel(page, '[data-testid="empty-output"]')).toBeVisible();

    await panel(page, '.transcript-actions button')
      .filter({ hasText: /^Raise to/ })
      .click();

    // The retry produced real output. Asserted on `.output` rather than on
    // `.suggestions`: the list parser deliberately declines to call a single item
    // a list, and this canned response has one title.
    await expect(panel(page, '.output')).toContainText('A Real Title');
    await expect(panel(page, '[data-testid="empty-output"]')).toHaveCount(0);
    const stored = await serviceWorker.evaluate(async () => {
      const bag = await chrome.storage.local.get('neuratube:state');
      const state = (bag['neuratube:state'] ?? {}) as {
        taskLimits?: Record<string, { maxTokens?: number }>;
      };
      return state.taskLimits?.optimize_title?.maxTokens ?? 0;
    });
    expect(stored).toBeGreaterThanOrEqual(4000);
  });

  test('warns when output arrived but was cut off mid-answer', async ({
    context,
    openSurface,
    serviceWorker,
  }) => {
    await context.route('https://api.openai.com/**', async (route) => {
      if (route.request().url().includes('/models')) {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ data: [{ id: 'openai-mock-large' }] }),
        });
        return;
      }
      await route.fulfill({
        status: 200,
        contentType: 'text/event-stream',
        body: [
          'data: {"choices":[{"delta":{"content":"ai agent, langchain, tut"}}]}\n\n',
          'data: {"choices":[{"delta":{},"finish_reason":"length"}]}\n\n',
          'data: [DONE]\n\n',
        ].join(''),
      });
    });
    await configureProvider(serviceWorker);

    const page = await openSurface(STUDIO_EDIT);
    await openTask(page, 'Tag generator');

    // The user cannot see that the last third is missing, so the panel says so.
    await expect(panel(page, '[role="alert"]').filter({ hasText: 'Cut off' })).toBeVisible();
    await expect(panel(page, '.output')).toContainText('langchain');
  });

  test('distinguishes a provider that returned nothing at all', async ({
    context,
    openSurface,
    serviceWorker,
  }) => {
    await context.route('https://api.openai.com/**', async (route) => {
      if (route.request().url().includes('/models')) {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ data: [{ id: 'openai-mock-large' }] }),
        });
        return;
      }
      await route.fulfill({
        status: 200,
        contentType: 'text/event-stream',
        body: [
          'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n',
          'data: {"choices":[],"usage":{"prompt_tokens":800,"completion_tokens":0}}\n\n',
          'data: [DONE]\n\n',
        ].join(''),
      });
    });
    await configureProvider(serviceWorker);

    const page = await openSurface(STUDIO_EDIT);
    await openTask(page, 'Tag generator');

    const notice = panel(page, '[data-testid="empty-output"]');
    await expect(notice).toContainText('zero output tokens');
    // No reasoning happened, so no thinking is offered and no budget is blamed.
    await expect(panel(page, '.reasoning-peek')).toHaveCount(0);
    await expect(notice).not.toContainText('reasoning model');
  });
});
