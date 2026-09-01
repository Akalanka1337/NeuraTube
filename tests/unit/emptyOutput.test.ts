import { describe, expect, it } from 'vitest';
import { diagnoseEmpty, isTruncated } from '~/panel/emptyOutput';

/**
 * The failure these guard against was reported from a live session: some videos
 * produced an empty output box on Title optimizer and Tag generator while the API
 * call succeeded. Three different causes present identically, so the panel has to
 * tell them apart or the user is left guessing.
 */
describe('isTruncated', () => {
  it.each(['length', 'max_tokens', 'MAX_TOKENS', 'model_length'])(
    'recognises %s across provider vocabularies',
    (reason) => {
      expect(isTruncated(reason)).toBe(true);
    },
  );

  it.each([null, 'stop', 'end_turn', 'tool_use', ''])('does not flag %s', (reason) => {
    expect(isTruncated(reason)).toBe(false);
  });
});

describe('diagnoseEmpty', () => {
  /** The most common cause, and the one most likely to look like a broken tool. */
  it('names the reasoning budget when thinking consumed the whole limit', () => {
    const result = diagnoseEmpty({
      finishReason: 'length',
      reasoningChars: 3600,
      outputTokens: 900,
      maxTokens: 900,
    });

    expect(result.cause).toContain('reasoning model');
    expect(result.cause).toContain('900');
    expect(result.cause).toContain('3,600');
    expect(result.suggestsMoreTokens).toBe(true);
    // The action has to name where to go, not just what went wrong.
    expect(result.action).toContain('Advanced');
  });

  it('handles reasoning with a clean stop, which is a different fix', () => {
    const result = diagnoseEmpty({
      finishReason: 'stop',
      reasoningChars: 500,
      outputTokens: 120,
      maxTokens: 900,
    });

    expect(result.cause).toContain('no answer');
    // Not a budget problem, so raising the ceiling is not offered as the fix.
    expect(result.suggestsMoreTokens).toBe(false);
    expect(result.action).toContain('Routing');
  });

  it('reports plain truncation when no reasoning was seen', () => {
    const result = diagnoseEmpty({
      finishReason: 'length',
      reasoningChars: 0,
      outputTokens: 400,
      maxTokens: 400,
    });

    expect(result.cause).toContain('cut off');
    expect(result.cause).toContain('400');
    expect(result.suggestsMoreTokens).toBe(true);
  });

  it('distinguishes zero output tokens from a stream with no text', () => {
    const zero = diagnoseEmpty({
      finishReason: 'stop',
      reasoningChars: 0,
      outputTokens: 0,
      maxTokens: 900,
    });
    expect(zero.cause).toContain('zero output tokens');

    const noText = diagnoseEmpty({
      finishReason: 'stop',
      reasoningChars: 0,
      outputTokens: 42,
      maxTokens: 900,
    });
    expect(noText.cause).toContain('no text in it');
  });

  it('always offers an action, so no branch is a dead end', () => {
    for (const finishReason of [null, 'stop', 'length']) {
      for (const reasoningChars of [0, 1200]) {
        for (const outputTokens of [null, 0, 50]) {
          const result = diagnoseEmpty({
            finishReason,
            reasoningChars,
            outputTokens,
            maxTokens: 900,
          });
          expect(
            result.cause.length,
            JSON.stringify({ finishReason, reasoningChars }),
          ).toBeGreaterThan(20);
          expect(result.action, JSON.stringify({ finishReason, reasoningChars })).not.toBeNull();
        }
      }
    }
  });
});
