/**
 * M3 acceptance suite.
 *
 * The milestone's stated criteria: Test connection returns ok plus latency for
 * all four providers, the model list populates live, and keys never appear in any
 * log or error.
 *
 * All four provider APIs are mocked with `context.route`, which does intercept
 * extension service worker requests — the thing that makes this layer testable
 * at all. Pointing base URLs at a local server would be blocked by our own
 * deliberately narrow host permissions.
 */

import { configureProvider, expect, mockProviders, panel, test } from '../fixtures';
import type { Page } from '@playwright/test';
/*
 * Derived, not hardcoded. These counts were written as literal 12s and broke on
 * every task added — which is noise that trains people to update numbers without
 * reading what the test claims.
 */
import { TASK_TYPES } from '~/orchestrator/tasks';

const KEYS = {
  openai: 'sk-mock-openai-abcdefghijklmnopqrstuvwxyz01',
  anthropic: 'sk-ant-mock-abcdefghijklmnopqrstuvwxyz01',
  deepseek: 'sk-mock-deepseek-abcdefghijklmnopqrstuvw',
  'nvidia-nim': 'nvapi-mock-abcdefghijklmnopqrstuvwxyz01',
} as const;

/** Provider cards render in a fixed order: OpenAI, Anthropic, DeepSeek, NIM. */
const CARD_INDEX = { openai: 0, anthropic: 1, deepseek: 2, 'nvidia-nim': 3 } as const;

function card(page: Page, provider: keyof typeof CARD_INDEX) {
  return page.locator('.provider').nth(CARD_INDEX[provider]);
}

/** Store a key, wait for the model list, and select the first model. */
async function configure(page: Page, provider: keyof typeof CARD_INDEX): Promise<void> {
  const target = card(page, provider);
  await target.locator('input[type="password"]').fill(KEYS[provider]);
  await target.getByRole('button', { name: 'Save', exact: true }).click();

  // Saving fetches the catalogue immediately, because without a model selected
  // the provider cannot run a task.
  await expect(target.locator('select').first()).toBeEnabled();
  const options = target.locator('select').first().locator('option');
  await expect(options).not.toHaveCount(1);

  const value = await options.nth(1).getAttribute('value');
  await target.locator('select').first().selectOption(value);
}

test.describe('M3 acceptance: all four providers', () => {
  test('tests the connection successfully for every provider', async ({
    context,
    openExtensionPage,
  }) => {
    const mock = await mockProviders(context);
    const page = await openExtensionPage('options/index.html');
    await expect(page.locator('.provider')).toHaveCount(4);

    for (const provider of ['openai', 'anthropic', 'deepseek', 'nvidia-nim'] as const) {
      await configure(page, provider);

      const target = card(page, provider);
      await target.getByRole('button', { name: 'Test connection' }).click();

      // ok + latency + model count, which is the milestone's criterion.
      const outcome = target.locator('.pill.ok');
      await expect(outcome).toBeVisible();
      await expect(outcome).toContainText('Connected');
      await expect(outcome).toContainText('ms');
      await expect(outcome).toContainText('models');
    }

    // Every test went to /models rather than a chat completion: listing models
    // is free, and a button labelled "test" must not bill the user.
    expect(mock.calls.length).toBeGreaterThanOrEqual(4);
    expect(mock.calls.every((call) => call.url.includes('/models'))).toBe(true);
  });

  test('populates each model list live, with no hardcoded IDs', async ({
    context,
    openExtensionPage,
  }) => {
    await mockProviders(context);
    const page = await openExtensionPage('options/index.html');

    await configure(page, 'openai');
    await expect(card(page, 'openai').locator('select').first()).toContainText('openai-mock-large');

    await configure(page, 'anthropic');
    // Anthropic's list uses display_name and ISO dates, sorted newest first.
    await expect(card(page, 'anthropic').locator('select').first()).toContainText(
      'Claude Mock Large',
    );

    await configure(page, 'deepseek');
    await expect(card(page, 'deepseek').locator('select').first()).toContainText(
      'deepseek-mock-pro',
    );
  });

  test('sends the Anthropic browser-access header the brief omits', async ({
    context,
    openExtensionPage,
  }) => {
    const mock = await mockProviders(context);
    const page = await openExtensionPage('options/index.html');

    await configure(page, 'anthropic');

    const calls = mock.forHost('api.anthropic.com');
    expect(calls.length).toBeGreaterThan(0);
    // Without this header every Claude request fails CORS.
    expect(calls[0]!.headers['anthropic-dangerous-direct-browser-access']).toBe('true');
    expect(calls[0]!.headers['anthropic-version']).toBe('2023-06-01');
    expect(calls[0]!.headers['x-api-key']).toBe(KEYS.anthropic);
    // And it authenticates with x-api-key, not a bearer token.
    expect(calls[0]!.headers.authorization).toBeUndefined();
  });

  test('reports a rejected key with actionable advice', async ({ context, openExtensionPage }) => {
    await context.route('https://api.openai.com/**', (route) =>
      route.fulfill({
        status: 401,
        contentType: 'application/json',
        body: JSON.stringify({ error: { message: 'Incorrect API key provided' } }),
      }),
    );

    const page = await openExtensionPage('options/index.html');
    const target = card(page, 'openai');

    await target.locator('input[type="password"]').fill('sk-not-a-real-key-000000000000000000');
    await target.getByRole('button', { name: 'Save', exact: true }).click();
    await target.getByRole('button', { name: 'Test connection' }).click();

    await expect(target.locator('.pill.err')).toBeVisible();
    // Both the model-load failure and the test failure render an error; the
    // connection-test one is last.
    await expect(target.locator('.error').last()).toContainText('API key was rejected');
  });
});

test.describe('M3: keys never leak', () => {
  test('never renders a stored key back into the page', async ({ context, openExtensionPage }) => {
    await mockProviders(context);
    const page = await openExtensionPage('options/index.html');
    await configure(page, 'openai');

    // Reload so the key is loaded from storage rather than sitting in a field
    // the user just typed into.
    await page.reload();
    await expect(page.locator('.provider')).toHaveCount(4);

    const html = await page.content();
    expect(html).not.toContain(KEYS.openai);

    // A masked preview is shown instead — enough to recognise, useless to steal.
    await expect(card(page, 'openai')).toContainText('sk-moc');
    await expect(card(page, 'openai')).toContainText('…');

    // And the input itself starts empty.
    await expect(card(page, 'openai').locator('input[type="password"]')).toHaveValue('');
  });

  test('keeps keys out of console output and page errors', async ({
    context,
    openExtensionPage,
  }) => {
    await context.route('https://api.openai.com/**', (route) =>
      route.fulfill({
        status: 401,
        contentType: 'application/json',
        // A provider echoing the key back is exactly how these leak.
        body: JSON.stringify({ error: { message: `Invalid key ${KEYS.openai}` } }),
      }),
    );

    const page = await openExtensionPage('options/index.html');
    const logged: string[] = [];
    page.on('console', (message) => logged.push(message.text()));
    page.on('pageerror', (error) => logged.push(error.message));

    const target = card(page, 'openai');
    await target.locator('input[type="password"]').fill(KEYS.openai);
    await target.getByRole('button', { name: 'Save', exact: true }).click();
    await target.getByRole('button', { name: 'Test connection' }).click();
    await expect(target.locator('.pill.err')).toBeVisible();

    const transcript = logged.join('\n');
    expect(transcript).not.toContain(KEYS.openai);

    // The visible error must be redacted too, not merely the console.
    const shown = (await target.locator('.error').last().textContent()) ?? '';
    expect(shown).not.toContain(KEYS.openai);
    expect(shown).toContain('[redacted]');
  });

  test('does not store keys in the same blob the panel reads', async ({
    context,
    openExtensionPage,
    serviceWorker,
  }) => {
    await mockProviders(context);
    const page = await openExtensionPage('options/index.html');
    await configure(page, 'openai');

    const stored = await serviceWorker.evaluate(() =>
      chrome.storage.local.get(['neuratube:state', 'neuratube:credentials']),
    );

    // The panel content script reads `neuratube:state` on every page load and
    // dumps it in the diagnostics view. Keys must not be in it.
    expect(JSON.stringify(stored['neuratube:state'])).not.toContain('sk-mock');
    expect(JSON.stringify(stored['neuratube:credentials'])).toContain('sk-mock');
  });
});

test.describe('M3: end-to-end task run', () => {
  test('streams a task, reports tokens, and books the spend', async ({
    context,
    openExtensionPage,
  }) => {
    await mockProviders(context);
    const page = await openExtensionPage('options/index.html');
    await configure(page, 'openai');

    await page.getByRole('button', { name: 'Run task' }).click();

    // Streamed text arrived over the long-lived port.
    await expect(page.locator('.output')).toContainText('ai agent, langchain, tutorial');
    // Provider-reported usage, never estimated locally.
    await expect(page.locator('.card', { hasText: 'Try a task' })).toContainText('420 in');
    await expect(page.locator('.card', { hasText: 'Try a task' })).toContainText('12 out');

    // The worker books the spend; the usage tab reflects it.
    await page.getByRole('tab', { name: 'Usage & cost' }).click();
    await expect(page.locator('.totals')).toContainText('1');
    await expect(page.locator('.totals')).toContainText('420');
  });

  test('reports cost as unknown for a model with no known price', async ({
    context,
    openExtensionPage,
  }) => {
    // The mock model IDs are invented, so none has a bundled price. Inventing a
    // number here would be worse than admitting we do not know it.
    await mockProviders(context);
    const page = await openExtensionPage('options/index.html');
    await configure(page, 'openai');

    await page.getByRole('button', { name: 'Run task' }).click();
    await expect(page.locator('.output')).toContainText('ai agent');
    await expect(page.locator('.card', { hasText: 'Try a task' })).toContainText(
      'cost unknown for this model',
    );
  });

  test('refuses to run with no provider configured, and says why', async ({
    openExtensionPage,
  }) => {
    const page = await openExtensionPage('options/index.html');
    // The button is disabled, and the reason is stated rather than implied.
    await expect(page.getByRole('button', { name: 'Run task' })).toBeDisabled();
    await expect(page.locator('.banner.warn').first()).toContainText('No provider is ready');
  });
});

test.describe('M3: prompt editing', () => {
  test('shows the shipped default and saves an override', async ({ openExtensionPage }) => {
    const page = await openExtensionPage('options/index.html');
    await page.getByRole('tab', { name: 'Prompts' }).click();

    const editor = page.locator('#prompt-editor');
    await expect(editor).toHaveValue(/You rewrite YouTube titles/);
    await expect(page.locator('.pill', { hasText: 'shipped default' })).toBeVisible();

    await editor.fill('My own title prompt.');
    await page.getByRole('button', { name: 'Save prompt' }).click();

    await expect(page.locator('.pill', { hasText: 'customised' })).toBeVisible();

    // Survives a reload, which is the point of persisting it.
    await page.reload();
    await page.getByRole('tab', { name: 'Prompts' }).click();
    await expect(page.locator('#prompt-editor')).toHaveValue('My own title prompt.');
  });

  test('resets an override back to the shipped default', async ({ openExtensionPage }) => {
    const page = await openExtensionPage('options/index.html');
    await page.getByRole('tab', { name: 'Prompts' }).click();

    await page.locator('#prompt-editor').fill('Temporary.');
    await page.getByRole('button', { name: 'Save prompt' }).click();
    await expect(page.locator('.pill', { hasText: 'customised' })).toBeVisible();

    await page.getByRole('button', { name: 'Reset to shipped default' }).click();
    await expect(page.locator('#prompt-editor')).toHaveValue(/You rewrite YouTube titles/);
  });

  test('offers a prompt for every task', async ({ openExtensionPage }) => {
    const page = await openExtensionPage('options/index.html');
    await page.getByRole('tab', { name: 'Prompts' }).click();
    await expect(page.locator('.tasklist-item')).toHaveCount(TASK_TYPES.length);
  });
});

test.describe('M3: routing', () => {
  test('defaults every task to automatic and explains why nothing is pinned', async ({
    openExtensionPage,
  }) => {
    const page = await openExtensionPage('options/index.html');
    await page.getByRole('tab', { name: 'Routing' }).click();

    await expect(page.locator('.routing tbody tr')).toHaveCount(TASK_TYPES.length);
    // Automatic, because a fresh install has at most one key and pinning a
    // provider would produce a task that cannot run.
    await expect(page.locator('.routing select').first()).toHaveValue('');
    await expect(page.locator('.banner.warn')).toContainText('No provider is ready yet');
  });

  test('pins a provider once one is configured', async ({ context, openExtensionPage }) => {
    await mockProviders(context);
    const page = await openExtensionPage('options/index.html');
    await configure(page, 'openai');

    await page.getByRole('tab', { name: 'Routing' }).click();
    const select = page.locator('.routing select').first();
    await select.selectOption('openai');

    await page.reload();
    await page.getByRole('tab', { name: 'Routing' }).click();
    await expect(page.locator('.routing select').first()).toHaveValue('openai');
  });
});

test.describe('M3: privacy disclosure', () => {
  test('states what is stored, where it goes, and the limitation', async ({
    openExtensionPage,
  }) => {
    const page = await openExtensionPage('options/index.html');
    await page.getByRole('tab', { name: 'Privacy & data' }).click();

    await expect(page.locator('.shell')).toContainText('neuratube:credentials');
    await expect(page.locator('.shell')).toContainText(
      'does not pass through any server we operate',
    );
    await expect(page.locator('.shell')).toContainText('Zero telemetry');
    // The unflattering part, stated plainly rather than omitted.
    await expect(page.locator('.shell')).toContainText('not encrypted at rest');
  });

  test('removes stored keys on request', async ({ context, openExtensionPage }) => {
    await mockProviders(context);
    const page = await openExtensionPage('options/index.html');
    await configure(page, 'openai');

    await page.getByRole('tab', { name: 'Privacy & data' }).click();
    await page.getByRole('button', { name: 'Remove all API keys' }).click();
    await page.getByRole('button', { name: 'Yes, do it' }).click();

    // The page reloads itself after a wholesale delete.
    await page.waitForLoadState('load');
    await page.getByRole('tab', { name: 'Providers' }).click();
    await expect(card(page, 'openai')).toContainText('No key');
  });
});

test.describe('About & diagnostics', () => {
  async function openAbout(openExtensionPage: (p: string) => Promise<Page>): Promise<Page> {
    const page = await openExtensionPage('options/index.html');
    await page.getByRole('tab', { name: 'About' }).click();
    return page;
  }

  test('names the project and credits, with working outbound links', async ({
    openExtensionPage,
  }) => {
    const page = await openAbout(openExtensionPage);

    await expect(page.locator('.about-hero')).toContainText('NeuraTube');
    await expect(page.locator('.about-hero')).toContainText('AI-native optimisation');

    // Every outbound link must open in a new tab AND carry noopener — an
    // extension page handing window.opener to a third party is a real hazard.
    for (const [label, href] of [
      ['github.com/Akalanka1337', 'https://github.com/Akalanka1337'],
      ['cyberscap.com', 'https://cyberscap.com'],
      ['@Akalanka1337', 'https://github.com/Akalanka1337'],
    ] as const) {
      const link = page.getByRole('link', { name: label });
      await expect(link).toHaveAttribute('href', href);
      await expect(link).toHaveAttribute('target', '_blank');
      await expect(link).toHaveAttribute('rel', /noopener/);
    }
  });

  test('explains what the extension does without overclaiming', async ({ openExtensionPage }) => {
    const page = await openAbout(openExtensionPage);
    const features = page.locator('.feature-list li');
    await expect(features).not.toHaveCount(0);
    // The two claims that matter most for trust.
    await expect(page.locator('.feature-list')).toContainText('there is no NeuraTube server');
    await expect(page.locator('.feature-list')).toContainText('refuses to run');
  });

  /**
   * The diagnostics icon is off by default — it is a developer affordance, not
   * part of the daily workflow — and the toggle has to survive a reload, since a
   * setting that silently reverts is worse than no setting.
   */
  test('toggles the diagnostics icon and persists the choice', async ({
    openExtensionPage,
    openSurface,
  }) => {
    const options = await openAbout(openExtensionPage);
    const toggle = options.locator('.toggle-row input').first();
    await expect(toggle).not.toBeChecked();

    await toggle.check();
    await expect(toggle).toBeChecked();

    // The panel picks it up from storage, on a surface opened afterwards.
    const studio = await openSurface('https://studio.youtube.com/video/PPGYNmrVG58/edit');
    await expect(
      panel(studio, 'button[title="Diagnostics"], .icon-btn[title="Diagnostics"]'),
    ).toBeVisible();

    await options.reload();
    await options.getByRole('tab', { name: 'About' }).click();
    await expect(options.locator('.toggle-row input').first()).toBeChecked();
  });

  test('toggles verbose logging independently', async ({ openExtensionPage }) => {
    const page = await openAbout(openExtensionPage);
    const logging = page.locator('.toggle-row input').nth(1);

    await expect(logging).not.toBeChecked();
    await logging.check();
    await page.reload();
    await page.getByRole('tab', { name: 'About' }).click();
    await expect(page.locator('.toggle-row input').nth(1)).toBeChecked();
    // And the diagnostics icon setting is untouched by it.
    await expect(page.locator('.toggle-row input').first()).not.toBeChecked();
  });
});

test.describe('Advanced: per-task limits', () => {
  async function openAdvanced(openExtensionPage: (p: string) => Promise<Page>): Promise<Page> {
    const page = await openExtensionPage('options/index.html');
    await page.getByRole('tab', { name: 'Advanced' }).click();
    return page;
  }

  test('lists every task with its shipped defaults', async ({ openExtensionPage }) => {
    const page = await openAdvanced(openExtensionPage);
    await expect(page.locator('.limits tbody tr')).toHaveCount(TASK_TYPES.length);
    // Defaults are shown, not pre-filled: an empty field means "use the default",
    // so that a later tuning pass still reaches this user.
    await expect(page.locator('.limits tbody tr').first()).toContainText('default');
    await expect(page.locator('.limits tbody tr').first().locator('input').first()).toHaveValue('');
  });

  test('explains why the setting exists', async ({ openExtensionPage }) => {
    const page = await openAdvanced(openExtensionPage);
    await expect(page.locator('.card').first()).toContainText('reasoning models');
    await expect(page.locator('.card').first()).toContainText('empty result');
  });

  test('saves an override and reports how many are set', async ({ openExtensionPage }) => {
    const page = await openAdvanced(openExtensionPage);
    const row = page.locator('.limits tr[data-task="optimize_title"]');

    await row.locator('input').first().fill('4000');
    await row.locator('input').first().blur();

    await expect(page.locator('.card').first()).toContainText(
      `1 of ${TASK_TYPES.length} tasks overridden`,
    );

    await page.reload();
    await page.getByRole('tab', { name: 'Advanced' }).click();
    await expect(
      page.locator('.limits tr[data-task="optimize_title"]').locator('input').first(),
    ).toHaveValue('4000');
  });

  test('the one-click reasoning preset raises the ceiling substantially', async ({
    openExtensionPage,
  }) => {
    const page = await openAdvanced(openExtensionPage);
    const row = page.locator('.limits tr[data-task="generate_tags"]');

    await row.getByRole('button', { name: 'For reasoning' }).click();

    // A nudge would not help; thinking commonly costs several times the answer.
    const value = Number(await row.locator('input').first().inputValue());
    expect(value).toBeGreaterThanOrEqual(4000);
  });

  test('reset returns a task to its shipped default', async ({ openExtensionPage }) => {
    const page = await openAdvanced(openExtensionPage);
    const row = page.locator('.limits tr[data-task="hook_writer"]');

    await row.locator('input').first().fill('5000');
    await row.locator('input').first().blur();
    await expect(page.locator('.card').first()).toContainText(`1 of ${TASK_TYPES.length}`);

    await row.getByRole('button', { name: 'Reset' }).click();
    await expect(page.locator('.card').first()).toContainText('Nothing overridden');
    await expect(row.locator('input').first()).toHaveValue('');
  });

  test('clamps an over-large value rather than dropping it', async ({ openExtensionPage }) => {
    const page = await openAdvanced(openExtensionPage);
    const row = page.locator('.limits tr[data-task="optimize_description"]');

    await row.locator('input').first().fill('999999');
    await row.locator('input').first().blur();

    await page.reload();
    await page.getByRole('tab', { name: 'Advanced' }).click();
    const stored = Number(
      await page
        .locator('.limits tr[data-task="optimize_description"]')
        .locator('input')
        .first()
        .inputValue(),
    );
    // Honoured as "as much as possible", not silently discarded.
    expect(stored).toBe(32_000);
  });

  /**
   * The setting is only worth having if it reaches the request. This drives the
   * options page and then asserts the outgoing provider body.
   */
  test('a raised ceiling reaches the provider request', async ({
    context,
    openExtensionPage,
    openSurface,
    serviceWorker,
  }) => {
    const providers = await mockProviders(context);
    await configureProvider(serviceWorker);

    const options = await openAdvanced(openExtensionPage);
    const row = options.locator('.limits tr[data-task="generate_tags"]');
    await row.locator('input').first().fill('7777');
    await row.locator('input').first().blur();
    await expect(options.locator('.card').first()).toContainText(`1 of ${TASK_TYPES.length}`);

    const page = await openSurface('https://studio.youtube.com/video/PPGYNmrVG58/edit');
    await panel(page, '.task-btn').filter({ hasText: 'Tag generator' }).first().click();
    await expect(panel(page, '.output')).not.toBeEmpty();

    const body = providers.forHost('api.openai.com').at(-1)?.body ?? '';
    expect(JSON.parse(body)).toMatchObject({ max_tokens: 7777 });
  });
});
