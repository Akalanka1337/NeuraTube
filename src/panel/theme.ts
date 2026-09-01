/**
 * Theme synchronisation with YouTube.
 *
 * Both YouTube and YouTube Studio signal dark mode by putting a `dark`
 * attribute on <html>. That is a private implementation detail and could change,
 * so detection is layered:
 *
 *   1. `html[dark]` — how both properties actually do it today.
 *   2. The computed background colour of <html>/<body> — a structural fallback
 *      that keeps working if the attribute is renamed, because a dark page has a
 *      dark backdrop regardless.
 *   3. `prefers-color-scheme` — last resort if the page has not painted yet.
 *
 * Watched with a MutationObserver scoped to a single attribute on a single
 * element, which is about as cheap as observation gets.
 */

import { createLogger } from '~/lib/logger';
import type { ThemePreference } from '~/storage/schema';

const log = createLogger('theme');

export type ResolvedTheme = 'dark' | 'light';

/** Relative luminance threshold below which we treat a background as dark. */
const DARK_LUMINANCE_MAX = 0.45;

/** Detect the page's current theme. */
export function detectPageTheme(): ResolvedTheme {
  const root = document.documentElement;

  if (root.hasAttribute('dark')) return 'dark';
  // Studio has also been observed using an explicit light marker.
  if (root.hasAttribute('light')) return 'light';

  const fromBackground = themeFromBackground();
  if (fromBackground) return fromBackground;

  return window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

function themeFromBackground(): ResolvedTheme | null {
  for (const element of [document.body, document.documentElement]) {
    if (!element) continue;
    const colour = getComputedStyle(element).backgroundColor;
    const luminance = relativeLuminance(colour);
    if (luminance !== null) return luminance < DARK_LUMINANCE_MAX ? 'dark' : 'light';
  }
  return null;
}

/**
 * Approximate relative luminance of a CSS colour.
 *
 * Returns `null` for transparent or unparseable values so the caller can fall
 * through to the next signal rather than guessing from a colour that is not
 * actually painted.
 */
export function relativeLuminance(colour: string): number | null {
  const match = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)(?:[\s,/]+([\d.]+))?\s*\)$/i.exec(
    colour.trim(),
  );
  if (!match) return null;

  const alpha = match[4] === undefined ? 1 : Number(match[4]);
  if (!Number.isFinite(alpha) || alpha < 0.1) return null;

  const channels = [match[1], match[2], match[3]].map((raw) => {
    const value = Number(raw) / 255;
    return value <= 0.04045 ? value / 12.92 : Math.pow((value + 0.055) / 1.055, 2.4);
  });

  const [r, g, b] = channels as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** Apply an explicit preference over the detected page theme. */
export function resolveTheme(preference: ThemePreference): ResolvedTheme {
  return preference === 'auto' ? detectPageTheme() : preference;
}

export interface ThemeWatcher {
  stop(): void;
}

/**
 * Watch for theme changes. `onChange` fires only when the resolved value
 * actually flips.
 */
export function watchTheme(
  getPreference: () => ThemePreference,
  onChange: (theme: ResolvedTheme) => void,
): ThemeWatcher {
  let last: ResolvedTheme | null = null;

  const reconcile = (): void => {
    const next = resolveTheme(getPreference());
    if (next === last) return;
    log.debug('theme resolved', next);
    last = next;
    onChange(next);
  };

  const observer = new MutationObserver(reconcile);
  observer.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ['dark', 'light'],
  });

  const media = window.matchMedia?.('(prefers-color-scheme: dark)');
  media?.addEventListener('change', reconcile);

  reconcile();

  return {
    stop() {
      observer.disconnect();
      media?.removeEventListener('change', reconcile);
    },
  };
}
