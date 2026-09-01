/**
 * Server-sent events parser.
 *
 * Shared by every adapter. This is the highest-risk code in the provider layer,
 * because streaming failures are intermittent and look like model problems
 * rather than parsing problems. The cases that actually bite:
 *
 *  - A chunk boundary lands mid-line, or mid-UTF-8-sequence. `TextDecoder` with
 *    `{ stream: true }` handles the second; an explicit line buffer handles the
 *    first. Splitting each chunk independently silently corrupts JSON.
 *  - Providers disagree on line endings. Anthropic emits `\n\n` between events;
 *    some proxies normalise to `\r\n`. Both are handled.
 *  - Comment lines (`:` prefix) are keep-alives, not data. Anthropic also sends
 *    an explicit `event: ping`.
 *  - One event may carry several `data:` lines, which the spec says to join with
 *    newlines.
 *  - The stream can end without a terminator when a connection drops. That must
 *    surface as a normal end-of-stream, not a hang, and must not discard tokens
 *    the user has already been billed for.
 *
 * Implemented as a generator over the raw byte stream so no adapter has to
 * reimplement any of the above.
 */

/** One parsed SSE event. */
export interface SseEvent {
  /** `event:` field, or null when the provider does not send one (OpenAI). */
  readonly event: string | null;
  /** Joined `data:` payload. Empty events are never yielded. */
  readonly data: string;
}

/** Terminator OpenAI-shaped providers send before closing. */
export const SSE_DONE = '[DONE]';

/**
 * Parse a byte stream into SSE events.
 *
 * Yields in order and completes when the stream ends. Never throws for
 * malformed content: a line it cannot interpret is skipped, because one bad
 * frame must not abort a response the user is already reading.
 */
export async function* parseSse(
  body: ReadableStream<Uint8Array>,
  signal?: AbortSignal,
): AsyncGenerator<SseEvent, void, undefined> {
  const reader = body.getReader();
  const decoder = new TextDecoder('utf-8');

  /** Bytes decoded but not yet forming a complete line. */
  let pending = '';
  /** Current frame being assembled. */
  let eventName: string | null = null;
  let dataLines: string[] = [];

  /** Complete the current frame, or return null if it carried no data. */
  const takeFrame = (): SseEvent | null => {
    const name = eventName;
    const lines = dataLines;
    eventName = null;
    dataLines = [];
    return lines.length > 0 ? { event: name, data: lines.join('\n') } : null;
  };

  /** Apply one complete line. Returns a finished frame when the line ends one. */
  const applyLine = (line: string): SseEvent | null => {
    // Blank line terminates the current event.
    if (line === '') return takeFrame();

    // Leading colon marks a comment; providers use these as keep-alives.
    if (line.startsWith(':')) return null;

    const colon = line.indexOf(':');
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? '' : line.slice(colon + 1);
    // The spec strips exactly one leading space after the colon.
    if (value.startsWith(' ')) value = value.slice(1);

    if (field === 'event') {
      eventName = value;
    } else if (field === 'data') {
      dataLines.push(value);
    }
    // `id` and `retry` are meaningless here — we never resume a stream. Unknown
    // fields are ignored per spec, and deliberately not an error: providers add
    // fields without warning.
    return null;
  };

  try {
    for (;;) {
      if (signal?.aborted) return;

      const { done, value } = await reader.read();

      if (done) {
        // Flush the decoder, then any buffered text as a final line.
        pending += decoder.decode();
        if (pending !== '') {
          const frame = applyLine(pending);
          pending = '';
          if (frame) yield frame;
        }
        // A dropped connection leaves the last frame unterminated by a blank
        // line. Emit it rather than throwing away billed output.
        const trailing = takeFrame();
        if (trailing) yield trailing;
        return;
      }

      pending += decoder.decode(value, { stream: true });

      // Normalise line endings, then peel off every complete line. The final
      // segment is either empty (input ended on a newline) or an incomplete
      // line that must wait for more bytes.
      pending = pending.replace(/\r\n?/g, '\n');
      const segments = pending.split('\n');
      pending = segments.pop() ?? '';

      for (const line of segments) {
        const frame = applyLine(line);
        if (frame) yield frame;
      }
    }
  } finally {
    // Cancel rather than merely release: on abort we do not want the body
    // draining in the background, and cancelling frees the connection promptly.
    try {
      await reader.cancel();
    } catch {
      // Already closed.
    }
  }
}

/**
 * Parse an SSE `data` payload as JSON.
 *
 * Returns null for the terminator, for empty payloads, and for anything
 * unparseable — a single malformed frame must not abort a response mid-flight.
 */
export function parseSseJson(data: string): Record<string, unknown> | null {
  if (data === '' || data === SSE_DONE) return null;
  try {
    const parsed: unknown = JSON.parse(data);
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}
