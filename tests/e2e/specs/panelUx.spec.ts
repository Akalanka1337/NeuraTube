/**
 * M4 acceptance suite.
 *
 * Criteria: drag, resize, snap-to-edge and collapse all work and round-trip
 * through a reload; layout persists per surface; and the panel passes an
 * accessibility audit including keyboard-only operation.
 *
 * The keyboard tests are not padding. A pointer-only drag affordance fails
 * WCAG 2.1 AA outright, and the project commits to AA — so the arrow-key
 * equivalents are a requirement, not a nicety.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { expect, panel, test } from '../fixtures';
import type { Page } from '@playwright/test';

const STUDIO_EDIT = 'https://studio.youtube.com/video/PPGYNmrVG58/edit';
const WATCH = 'https://www.youtube.com/watch?v=dQw4w9WgXcQ';

/** axe-core, read off disk so it can be injected into the page. */
const AXE_SOURCE = readFileSync(
  path.join(path.dirname(createRequire(import.meta.url).resolve('axe-core')), 'axe.min.js'),
  'utf8',
);

/**
 * Load axe into a page.
 *
 * `addScriptTag` cannot be used on the options page: its CSP is
 * `script-src 'self'`, which blocks inline script — and that is the extension
 * behaving exactly as intended, so the test adapts rather than the CSP. Passing
 * the source to `evaluate` runs it through CDP, which is not subject to page CSP.
 */
async function injectAxe(page: Page): Promise<void> {
  await page.evaluate(AXE_SOURCE);
}

interface AxeViolation {
  id: string;
  impact: string | null;
  nodes: unknown[];
}

/** Run axe against WCAG 2.1 AA, the project's stated commitment. */
async function runAxe(page: Page, selector: string | null): Promise<AxeViolation[]> {
  const results = await page.evaluate(async (target: string | null) => {
    const axe = (
      window as unknown as {
        axe: { run: (a: unknown, b?: unknown) => Promise<{ violations: AxeViolation[] }> };
      }
    ).axe;
    const options = {
      runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'] },
    };
    const outcome =
      target === null ? await axe.run(options) : await axe.run({ include: [[target]] }, options);
    return outcome.violations;
  }, selector);
  return results;
}

function describeViolations(violations: readonly AxeViolation[]): string {
  return violations
    .map(
      (violation) =>
        `${violation.id} (${violation.impact ?? 'unknown'}) x${violation.nodes.length}`,
    )
    .join('; ');
}

interface Geometry {
  left: number;
  top: number;
  width: number;
  height: number;
  snap: string;
}

async function geometryOf(page: Page): Promise<Geometry> {
  return page.evaluate(() => {
    const host = document.getElementById('neuratube-root');
    const style = host?.style;
    return {
      left: parseFloat(style?.left ?? '0'),
      top: parseFloat(style?.top ?? '0'),
      width: parseFloat(style?.width ?? '0'),
      height: parseFloat(style?.height ?? '0'),
      snap: host?.dataset.snap ?? '',
    };
  });
}

/** Drag the header by a delta using real pointer events. */
async function dragHeader(page: Page, deltaX: number, deltaY: number): Promise<void> {
  const header = panel(page, '.header');
  const box = await header.boundingBox();
  if (!box) throw new Error('header has no bounding box');

  await page.mouse.move(box.x + 60, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + 60 + deltaX, box.y + box.height / 2 + deltaY, { steps: 10 });
  await page.mouse.up();
}

test.describe('M4: drag', () => {
  test('moves the panel and persists the new position', async ({ openSurface }) => {
    const page = await openSurface(STUDIO_EDIT);
    const before = await geometryOf(page);

    await dragHeader(page, -300, 120);

    const after = await geometryOf(page);
    expect(after.left).toBeCloseTo(before.left - 300, 0);
    expect(after.top).toBeCloseTo(before.top + 120, 0);
    // Size is unaffected by a move.
    expect(after.width).toBe(before.width);

    // Geometry is written on a debounce; wait for it to settle.
    await page.waitForTimeout(500);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#neuratube-root', { state: 'attached' });
    await expect(panel(page, '.panel')).toBeVisible();

    const restored = await geometryOf(page);
    expect(restored.left).toBeCloseTo(after.left, 0);
    expect(restored.top).toBeCloseTo(after.top, 0);
  });

  test('does not start a drag from a header button', async ({ openSurface }) => {
    const page = await openSurface(STUDIO_EDIT);
    const before = await geometryOf(page);

    // Press and drag starting on the diagnostics button. The panel must not move.
    const button = panel(page, '.icon-btn').first();
    const box = await button.boundingBox();
    if (!box) throw new Error('button has no bounding box');

    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x - 200, box.y + 100, { steps: 8 });
    await page.mouse.up();

    const after = await geometryOf(page);
    expect(after.left).toBeCloseTo(before.left, 0);
    expect(after.top).toBeCloseTo(before.top, 0);
  });

  test('cannot be dragged out of reach', async ({ openSurface }) => {
    const page = await openSurface(STUDIO_EDIT);

    // Far off the right edge. The header must remain grabbable.
    await dragHeader(page, 5000, 5000);

    const after = await geometryOf(page);
    const viewport = page.viewportSize();
    expect(after.left).toBeLessThan(viewport!.width);
    expect(after.top).toBeLessThan(viewport!.height);
  });
});

test.describe('M4: snap to edge', () => {
  test('docks to the left edge on release and goes full height', async ({ openSurface }) => {
    const page = await openSurface(STUDIO_EDIT);
    const before = await geometryOf(page);

    await dragHeader(page, -before.left, 0);
    await page.waitForTimeout(200);

    const after = await geometryOf(page);
    expect(after.snap).toBe('left');
    expect(after.left).toBe(16);
    // A docked panel uses the full usable height.
    expect(after.height).toBeGreaterThan(before.height);
  });

  test('docks to the right edge', async ({ openSurface }) => {
    const page = await openSurface(STUDIO_EDIT);
    const viewport = page.viewportSize()!;

    await dragHeader(page, viewport.width, 0);
    await page.waitForTimeout(200);

    const after = await geometryOf(page);
    expect(after.snap).toBe('right');
    expect(after.left + after.width).toBe(viewport.width - 16);
  });

  test('un-snaps when dragged away from the edge', async ({ openSurface }) => {
    const page = await openSurface(STUDIO_EDIT);

    await dragHeader(page, -2000, 0);
    await page.waitForTimeout(200);
    expect((await geometryOf(page)).snap).toBe('left');

    await dragHeader(page, 400, 0);
    await page.waitForTimeout(200);
    expect((await geometryOf(page)).snap).toBe('none');
  });

  test('survives a reload as an edge, not as coordinates', async ({ openSurface }) => {
    const page = await openSurface(STUDIO_EDIT);
    await dragHeader(page, -2000, 0);
    await page.waitForTimeout(500);

    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#neuratube-root', { state: 'attached' });
    await expect(panel(page, '.panel')).toBeVisible();

    expect((await geometryOf(page)).snap).toBe('left');
  });
});

test.describe('M4: resize', () => {
  test('resizes from the bottom-right corner', async ({ openSurface }) => {
    const page = await openSurface(STUDIO_EDIT);
    const before = await geometryOf(page);

    const handle = panel(page, '.resize-handle');
    const box = await handle.boundingBox();
    if (!box) throw new Error('resize handle has no bounding box');

    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + 120, box.y - 80, { steps: 10 });
    await page.mouse.up();

    const after = await geometryOf(page);
    expect(after.width).toBeGreaterThan(before.width);
    expect(after.height).toBeLessThan(before.height);
    // Position is unaffected by a corner resize.
    expect(after.left).toBeCloseTo(before.left, 0);
  });

  test('honours the minimum size from the brief', async ({ openSurface }) => {
    const page = await openSurface(STUDIO_EDIT);

    const handle = panel(page, '.resize-handle');
    const box = await handle.boundingBox();
    if (!box) throw new Error('resize handle has no bounding box');

    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x - 3000, box.y - 3000, { steps: 10 });
    await page.mouse.up();

    const after = await geometryOf(page);
    expect(after.width).toBe(320);
    expect(after.height).toBe(400);
  });
});

test.describe('M4: keyboard operation', () => {
  test('moves the panel with arrow keys', async ({ openSurface }) => {
    // A pointer-only drag affordance fails WCAG 2.1 AA.
    const page = await openSurface(STUDIO_EDIT);
    const before = await geometryOf(page);

    await panel(page, '.header').focus();
    await page.keyboard.press('ArrowLeft');
    await page.keyboard.press('ArrowLeft');
    await page.keyboard.press('ArrowDown');

    const after = await geometryOf(page);
    expect(after.left).toBe(before.left - 24);
    expect(after.top).toBe(before.top + 12);
  });

  test('uses a larger step with Shift', async ({ openSurface }) => {
    const page = await openSurface(STUDIO_EDIT);
    const before = await geometryOf(page);

    await panel(page, '.header').focus();
    await page.keyboard.press('Shift+ArrowLeft');

    expect((await geometryOf(page)).left).toBe(before.left - 60);
  });

  test('resizes with arrow keys on the resize handle', async ({ openSurface }) => {
    const page = await openSurface(STUDIO_EDIT);
    const before = await geometryOf(page);

    await panel(page, '.resize-handle').focus();
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('ArrowDown');

    const after = await geometryOf(page);
    expect(after.width).toBe(before.width + 12);
    expect(after.height).toBe(before.height + 12);
  });

  test('reaches every control by tabbing', async ({ openSurface }) => {
    const page = await openSurface(STUDIO_EDIT);

    // Walk forward from the header and collect what receives focus inside the
    // shadow root. Every interactive element must be reachable.
    await panel(page, '.header').focus();

    // The cap is generous and the loop exits early on success: the panel's
    // control count grows with every feature milestone, so a fixed number of
    // Tab presses would silently stop covering the last control.
    const reached = new Set<string>();
    let foundResize = false;

    for (let i = 0; i < 60 && !foundResize; i += 1) {
      const active = await page.evaluate(() => {
        const host = document.getElementById('neuratube-root');
        const inner = host?.shadowRoot?.activeElement;
        if (!inner) return null;
        return inner.getAttribute('aria-label') ?? inner.className ?? inner.tagName;
      });
      if (active !== null) {
        reached.add(active);
        if (active.includes('Resize panel')) foundResize = true;
      }
      if (!foundResize) await page.keyboard.press('Tab');
    }

    expect(reached.size).toBeGreaterThanOrEqual(4);
    // The resize handle is last in DOM order, so reaching it proves the whole
    // panel is traversable by keyboard.
    expect(foundResize, `reached: ${[...reached].join(', ')}`).toBe(true);
  });

  test('Escape collapses and the orb is keyboard reachable', async ({ openSurface }) => {
    const page = await openSurface(STUDIO_EDIT);

    await page.keyboard.press('Escape');
    await expect(panel(page, '.orb')).toBeVisible();

    await panel(page, '.orb').focus();
    await page.keyboard.press('Enter');
    await expect(panel(page, '.panel')).toBeVisible();
  });
});

test.describe('M4: collapse', () => {
  test('shrinks the host to the orb and restores the previous size', async ({ openSurface }) => {
    const page = await openSurface(STUDIO_EDIT);
    const expanded = await geometryOf(page);

    await page.keyboard.press('Escape');
    await expect(panel(page, '.orb')).toBeVisible();

    const collapsed = await geometryOf(page);
    expect(collapsed.width).toBe(48);
    expect(collapsed.height).toBe(48);
    // Anchored at the panel's own corner, so expanding does not make it jump.
    expect(collapsed.left).toBe(expanded.left);

    await panel(page, '.orb').click();
    const restored = await geometryOf(page);
    expect(restored.width).toBe(expanded.width);
    expect(restored.height).toBe(expanded.height);
  });
});

test.describe('M4: per-surface layout', () => {
  test('remembers a different position on each surface', async ({ openSurface, context }) => {
    const studio = await openSurface(STUDIO_EDIT);
    await dragHeader(studio, -400, 200);
    await studio.waitForTimeout(500);
    const studioGeometry = await geometryOf(studio);

    const watch = await context.newPage();
    await watch.route('https://www.youtube.com/**', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'text/html',
        body: '<html><body><h1>watch</h1></body></html>',
      }),
    );
    await watch.goto(WATCH);
    await watch.waitForSelector('#neuratube-root', { state: 'attached' });
    await expect(watch.locator('#neuratube-root .panel')).toBeVisible();

    // The watch surface has its own layout and must not inherit Studio's.
    const watchGeometry = await geometryOf(watch);
    expect(watchGeometry.left).not.toBeCloseTo(studioGeometry.left, 0);
  });
});

test.describe('M4: viewport changes', () => {
  test('pulls the panel back on screen when the window shrinks', async ({ openSurface }) => {
    const page = await openSurface(STUDIO_EDIT);

    // Park it against the right edge, then shrink the window well past it.
    await dragHeader(page, 2000, 0);
    await page.waitForTimeout(300);

    await page.setViewportSize({ width: 560, height: 520 });
    await page.waitForTimeout(400);

    const after = await geometryOf(page);
    // Still reachable, and resized to fit.
    expect(after.left).toBeLessThan(560);
    expect(after.width).toBeLessThanOrEqual(560);
    expect(after.height).toBeLessThanOrEqual(520);
    await expect(panel(page, '.header')).toBeVisible();
  });
});

test.describe('M4: accessibility audit', () => {
  test('the panel has no axe violations', async ({ openSurface }) => {
    const page = await openSurface(STUDIO_EDIT);
    await injectAxe(page);

    // axe handles open shadow roots natively, so auditing the host covers the
    // whole panel.
    const violations = await runAxe(page, '#neuratube-root');
    expect(violations, `axe violations: ${describeViolations(violations)}`).toEqual([]);
  });

  test('the panel with diagnostics open has no axe violations', async ({ openSurface }) => {
    // The diagnostics view adds a second scrollable region and a definition
    // list, both of which have their own rules.
    const page = await openSurface(STUDIO_EDIT);
    await panel(page, '.icon-btn').first().click();
    await expect(panel(page, '.json')).toBeVisible();
    await injectAxe(page);

    const violations = await runAxe(page, '#neuratube-root');
    expect(violations, `axe violations: ${describeViolations(violations)}`).toEqual([]);
  });

  test('the panel has no axe violations in light mode', async ({ openSurface }) => {
    // The mock Studio page is dark, so without this the light palette is never
    // audited — and the contrast failure this suite first caught was light-only.
    const page = await openSurface(STUDIO_EDIT);
    await page.evaluate(() => {
      document.documentElement.removeAttribute('dark');
      document.documentElement.setAttribute('light', '');
      document.body.style.background = '#ffffff';
    });
    await expect(page.locator('#neuratube-root')).toHaveAttribute('data-theme', 'light');
    await panel(page, '.icon-btn').first().click();
    await expect(panel(page, '.json')).toBeVisible();
    await injectAxe(page);

    const violations = await runAxe(page, '#neuratube-root');
    expect(violations, `axe violations: ${describeViolations(violations)}`).toEqual([]);
  });

  test('the collapsed orb has no axe violations either', async ({ openSurface }) => {
    const page = await openSurface(STUDIO_EDIT);
    await page.keyboard.press('Escape');
    await expect(panel(page, '.orb')).toBeVisible();
    await injectAxe(page);

    const violations = await runAxe(page, '#neuratube-root');
    expect(violations, `axe violations: ${describeViolations(violations)}`).toEqual([]);
  });

  test('the options page has no axe violations', async ({ openExtensionPage }) => {
    const page = await openExtensionPage('options/index.html');
    await expect(page.locator('.provider')).toHaveCount(4);
    await injectAxe(page);

    const violations = await runAxe(page, null);
    expect(violations, `axe violations: ${describeViolations(violations)}`).toEqual([]);
  });

  test('every options tab passes', async ({ openExtensionPage }) => {
    const page = await openExtensionPage('options/index.html');

    for (const tab of ['Prompts', 'Routing', 'Usage & cost', 'Privacy & data']) {
      await page.getByRole('tab', { name: tab }).click();
      await injectAxe(page);
      const violations = await runAxe(page, null);
      expect(violations, `${tab}: ${describeViolations(violations)}`).toEqual([]);
    }
  });
});
