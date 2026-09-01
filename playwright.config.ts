import { defineConfig } from '@playwright/test';
import path from 'node:path';

/**
 * Extension E2E configuration.
 *
 * Two constraints worth writing down, both verified against Playwright docs:
 *
 *  - We must use Playwright's BUNDLED Chromium, never `channel: 'chrome'`.
 *    Google Chrome removed the flags required to sideload an unpacked
 *    extension, so `--load-extension` silently does nothing there.
 *  - MV3 service-worker suspend/restart handling was broken until the fix
 *    landed 2026-03-11 (playwright#39476): after Chrome suspended a worker,
 *    the `serviceworker` event was never re-emitted and tests kept a stale
 *    handle. Pin a post-March-2026 Playwright — hence ^1.56 in package.json.
 *
 * Extensions require a persistent context, which cannot be shared safely
 * across parallel workers, so we run fully serially with one worker.
 */
export default defineConfig({
  testDir: path.join(import.meta.dirname, 'tests/e2e/specs'),
  outputDir: path.join(import.meta.dirname, 'test-results'),
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  timeout: 45_000,
  /*
   * 20s, not 7s.
   *
   * Not a claim about product latency — assertions resolve as soon as the
   * condition holds, so a passing run is no slower. It is about the floor a
   * first-token assertion actually has to clear: a cold MV3 service worker wake,
   * a provider model-list round-trip, then the stream. Under full-suite load that
   * exceeded 7s often enough that whichever test happened to land there failed,
   * while passing in isolation — the signature of a threshold set too close to
   * the real cost, and the kind of flake that teaches people to re-run rather
   * than read failures.
   */
  expect: { timeout: 20_000 },
  reporter: process.env.CI ? [['github'], ['html', { open: 'never' }]] : [['list']],
  use: {
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
});
