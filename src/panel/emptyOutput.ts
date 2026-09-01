/**
 * Explaining an empty result.
 *
 * THE BUG THIS EXISTS FOR. A run could finish with a 200 response, tokens billed,
 * and an empty output box — and the panel showed exactly that: an empty box. The
 * user has no way to tell a reasoning model that ran out of budget from a
 * provider that returned nothing from a prompt the model refused. Three very
 * different problems presenting identically, none of them actionable.
 *
 * So the panel diagnoses instead of shrugging. Every branch below names a cause
 * AND the specific thing to do about it, because "something went wrong" is not
 * meaningfully better than an empty box.
 */

/** Finish reasons that mean the model was cut off mid-answer. */
const TRUNCATED: ReadonlySet<string> = new Set([
  // OpenAI-compatible, Anthropic, and the NIM deployments respectively.
  'length',
  'max_tokens',
  'MAX_TOKENS',
  'model_length',
]);

export function isTruncated(finishReason: string | null): boolean {
  return finishReason !== null && TRUNCATED.has(finishReason);
}

export interface EmptyDiagnosis {
  /** One-line cause, stated plainly. */
  readonly cause: string;
  /** What the user can actually do, or null when there is nothing useful. */
  readonly action: string | null;
  /** Whether raising the token ceiling is the likely fix. */
  readonly suggestsMoreTokens: boolean;
}

/**
 * Work out why an output is empty.
 *
 * Order matters: the reasoning-budget case is checked first because it is both
 * the most common and the one most likely to be misread as a broken extension.
 */
export function diagnoseEmpty(params: {
  readonly finishReason: string | null;
  readonly reasoningChars: number;
  readonly outputTokens: number | null;
  readonly maxTokens: number;
}): EmptyDiagnosis {
  const { finishReason, reasoningChars, outputTokens, maxTokens } = params;
  const truncated = isTruncated(finishReason);

  if (reasoningChars > 0 && truncated) {
    return {
      cause: `This model is a reasoning model. It spent its entire ${maxTokens}-token budget thinking (${reasoningChars.toLocaleString('en-US')} characters of it) and was cut off before writing any answer.`,
      action:
        'Raise this task’s token limit in Options → Advanced — reasoning models often need three to four times the budget — or pick a non-reasoning model for it.',
      suggestsMoreTokens: true,
    };
  }

  if (reasoningChars > 0) {
    return {
      cause: `The model returned ${reasoningChars.toLocaleString('en-US')} characters of reasoning but no answer.`,
      action:
        'Run it again, or switch this task to a non-reasoning model in Options → Routing. Reasoning models sometimes end after thinking without producing output.',
      suggestsMoreTokens: false,
    };
  }

  if (truncated) {
    return {
      cause: `The response was cut off at the token limit (${maxTokens}) before any text arrived.`,
      action: 'Raise this task’s token limit in Options → Advanced.',
      suggestsMoreTokens: true,
    };
  }

  if (outputTokens === 0) {
    return {
      cause: 'The provider accepted the request and returned zero output tokens.',
      action:
        'Usually a transient provider issue — run it again. If it repeats on one model, try another; some refuse without an error.',
      suggestsMoreTokens: false,
    };
  }

  return {
    cause: 'The provider streamed a response with no text in it.',
    action:
      'Run it again. If it repeats, open Options → About, switch on verbose logging, and check the console for the raw stream.',
    suggestsMoreTokens: false,
  };
}
