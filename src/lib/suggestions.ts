/**
 * Parse list-shaped model output into individually usable items.
 *
 * WHY THIS EXISTS. The point of this extension is speed. A task that returns
 * five titles in one blob of text and makes the user select-and-drag to get one
 * of them has given back the time it saved. Each suggestion needs its own copy
 * button, which means the output has to be split into items.
 *
 * WHY IT IS TOLERANT RATHER THAN STRICT. The shipped prompts ask for a specific
 * format, but two things make strict parsing wrong:
 *
 *  1. Prompts are user-editable — that is a headline feature — so the format is
 *     not under our control.
 *  2. Models drift from any format, especially smaller ones. NVIDIA NIM, Haiku
 *     and DeepSeek all number lists slightly differently.
 *
 * So this accepts every list shape seen in practice, and when it cannot find a
 * list at all it says so, and the UI falls back to copying the whole block. A
 * parser that silently returned one mangled item would be worse than no parser.
 */

/** One extracted suggestion. */
export interface Suggestion {
  /** The usable text — what a Copy button puts on the clipboard. */
  readonly text: string;
  /** The rationale the model attached, if any. Never copied. */
  readonly note: string | null;
}

export interface ParsedSuggestions {
  readonly items: readonly Suggestion[];
  /** False when no list could be found; the caller should show the raw output. */
  readonly parsed: boolean;
}

/**
 * A line that starts a new item.
 *
 * Covers `1.`, `1)`, `(1)`, `1:`, `-`, `*`, `•`, and `**1.**` from a model that
 * bolded its own numbering — the trailing `**` has to be allowed for too, or the
 * marker never matches and the whole list falls back to a raw blob.
 */
const MARKER = /^\s*(?:\*\*)?\s*(?:\(?\d{1,2}[.):]|[-*•–])(?:\*\*)?\s+/;

/** A dedicated rationale line, which the shipped prompts ask for. */
const WHY_LINE = /^\s*(?:\*\*)?(?:why|lever|hypothesis|rationale|reason)\s*(?:\*\*)?\s*:\s*(.+)$/i;

/** Wrapping markdown emphasis around a whole item. */
const WRAPPING_EMPHASIS = /^\s*(\*\*|__|\*|_)(.+?)\1\s*$/;

/**
 * A trailing parenthetical that is a lever label rather than part of the title.
 *
 * Deliberately conservative. A YouTube title legitimately ends in parentheses —
 * "(VideoProc AI Tutorial)", "(2026 Update)" — and stripping that would corrupt
 * the thing the user is about to paste. So a parenthetical is only treated as a
 * label when it is short, has at most two words, contains no digits, and leaves
 * a substantial title behind.
 */
const TRAILING_PAREN = /^(.*\S)\s*[([]([^()[\]]{2,24})[)\]]\s*$/;

/** Trailing ` — lever` or ` -- lever`, same conservative treatment. */
const TRAILING_DASH = /^(.*\S)\s+(?:—|--|–)\s+([^—–-]{2,24})$/;

function stripEmphasis(value: string): string {
  let text = value.trim();
  for (let i = 0; i < 3; i += 1) {
    const match = WRAPPING_EMPHASIS.exec(text);
    const inner = match?.[2];
    if (inner === undefined) break;
    text = inner.trim();
  }
  // Inline emphasis left over mid-string.
  return text.replace(/\*\*(.+?)\*\*/g, '$1').replace(/__(.+?)__/g, '$1');
}

/** Whether a trailing fragment reads like a lever label, not part of the title. */
function looksLikeLabel(fragment: string, remaining: string): boolean {
  const words = fragment.trim().split(/\s+/);
  if (words.length > 2) return false;
  if (/\d/.test(fragment)) return false;
  // Never gut a short title to extract a label.
  if (remaining.trim().length < 15) return false;
  return true;
}

/** Split a first line into its text and any attached rationale. */
function splitNote(line: string): { text: string; note: string | null } {
  for (const pattern of [TRAILING_DASH, TRAILING_PAREN]) {
    const match = pattern.exec(line);
    const body = match?.[1];
    const label = match?.[2];
    if (body === undefined || label === undefined) continue;
    if (!looksLikeLabel(label, body)) continue;
    return { text: body.trim(), note: label.trim() };
  }

  return { text: line.trim(), note: null };
}

/**
 * Extract items from list-shaped output.
 *
 * An item is a marker line plus any following non-blank, non-marker lines — so a
 * single-line title list and a multi-sentence hook block both work, and trailing
 * commentary separated by a blank line is dropped rather than glued onto the
 * last item.
 */
export function parseSuggestions(output: string): ParsedSuggestions {
  if (output.trim() === '') return { items: [], parsed: false };

  const lines = output
    // Code fences would otherwise become part of the first item.
    .replace(/^\s*```[a-z]*\s*$/gim, '')
    .split('\n');

  interface Draft {
    first: string;
    rest: string[];
    note: string | null;
  }

  const drafts: Draft[] = [];
  let current: Draft | null = null;

  for (const raw of lines) {
    const line = raw.replace(/\s+$/, '');

    if (MARKER.test(line)) {
      const body = stripEmphasis(line.replace(MARKER, ''));
      if (body === '') continue;
      current = { first: body, rest: [], note: null };
      drafts.push(current);
      continue;
    }

    if (current === null) continue;

    if (line.trim() === '') {
      // A blank line ends the current item's continuation.
      current = null;
      continue;
    }

    const why = WHY_LINE.exec(line)?.[1];
    if (why !== undefined) {
      current.note = stripEmphasis(why);
      continue;
    }

    current.rest.push(stripEmphasis(line.trim()));
  }

  const items: Suggestion[] = [];
  for (const draft of drafts) {
    const split = splitNote(draft.first);
    const body = [split.text, ...draft.rest].join('\n').trim();
    if (body === '') continue;
    items.push({ text: body, note: draft.note ?? split.note });
  }

  // One item is not a list — it is far more likely a paragraph that happened to
  // begin with a dash, so fall back to the raw block.
  return items.length >= 2 ? { items, parsed: true } : { items: [], parsed: false };
}

/** Trim a title to the length YouTube displays without truncating. */
export const TITLE_DISPLAY_LIMIT = 60;
/** YouTube's hard title limit. */
export const TITLE_MAX = 100;

export type LengthVerdict = 'good' | 'long' | 'over';

/**
 * Judge a title's length.
 *
 * YouTube truncates around 60 characters in search results and less on a mobile
 * home feed, so a title that only fits in the 100-character hard limit is a
 * title whose ending nobody reads.
 */
export function titleLengthVerdict(text: string): LengthVerdict {
  if (text.length > TITLE_MAX) return 'over';
  if (text.length > TITLE_DISPLAY_LIMIT) return 'long';
  return 'good';
}
