/**
 * First-paint instrumentation.
 *
 * The panel commits to a sub-80ms first paint. An unmeasured budget is a wish,
 * so the content script marks its own entry, the panel marks its first
 * committed frame, and the number is surfaced in the panel footer and asserted
 * in the E2E suite.
 *
 * Uses `performance.mark`/`measure` so the timings also show up on a DevTools
 * performance trace alongside YouTube's own marks.
 */

const MARK_START = 'neuratube:content-start';
const MARK_PAINT = 'neuratube:first-paint';
const MEASURE = 'neuratube:first-paint-duration';

/**
 * Captured at module evaluation.
 *
 * This module is imported by the content script's first import, and a bundled
 * IIFE evaluates module bodies in dependency order before any top-level
 * statement runs. Taking the timestamp here therefore includes the cost of
 * parsing and evaluating our own bundle, which is the number that actually
 * matters for first paint. Taking it in an exported function called from the
 * entrypoint would silently exclude it and flatter the measurement.
 */
let startedAt: number | null = initialMark();
let firstPaintMs: number | null = null;

function initialMark(): number {
  try {
    performance.mark(MARK_START);
  } catch {
    // performance.mark is best-effort; never let instrumentation break startup.
  }
  return performance.now();
}

/**
 * Explicitly (re)start the measurement window.
 *
 * A no-op in normal operation because module evaluation already marked the
 * start. Exists so tests can control the window after `resetPerfForTests()`.
 */
export function markContentStart(): void {
  startedAt ??= initialMark();
}

/**
 * Call from a `requestAnimationFrame` callback after the first render commits.
 * Idempotent — only the first call is recorded.
 */
export function markFirstPaint(): number | null {
  if (firstPaintMs !== null || startedAt === null) return firstPaintMs;

  firstPaintMs = performance.now() - startedAt;
  try {
    performance.mark(MARK_PAINT);
    performance.measure(MEASURE, MARK_START, MARK_PAINT);
  } catch {
    // Ignore: the numeric measurement above is the source of truth.
  }
  return firstPaintMs;
}

export function getFirstPaintMs(): number | null {
  return firstPaintMs;
}

/** Reset instrumentation state. Test-only. */
export function resetPerfForTests(): void {
  startedAt = null;
  firstPaintMs = null;
}

/** Milliseconds elapsed since the measurement window opened. */
export function elapsedMs(): number | null {
  return startedAt === null ? null : performance.now() - startedAt;
}
