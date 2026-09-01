import { describe, expect, it } from 'vitest';
import { SSE_DONE, parseSse, parseSseJson } from '~/providers/sse';

/**
 * Build a stream that delivers exactly these byte chunks.
 *
 * Chunk boundaries are the whole point: a parser that splits each chunk
 * independently corrupts any frame that straddles one, and that failure is
 * intermittent in production and invisible in a test that feeds whole events.
 */
function streamOf(chunks: readonly (string | Uint8Array)[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  let index = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (index >= chunks.length) {
        controller.close();
        return;
      }
      const chunk = chunks[index]!;
      index += 1;
      controller.enqueue(typeof chunk === 'string' ? encoder.encode(chunk) : chunk);
    },
  });
}

async function collect(stream: ReadableStream<Uint8Array>, signal?: AbortSignal) {
  const events: { event: string | null; data: string }[] = [];
  for await (const event of parseSse(stream, signal)) events.push(event);
  return events;
}

describe('parseSse', () => {
  it('parses simple OpenAI-shaped frames', async () => {
    const events = await collect(
      streamOf(['data: {"a":1}\n\n', 'data: {"a":2}\n\n', `data: ${SSE_DONE}\n\n`]),
    );
    expect(events).toEqual([
      { event: null, data: '{"a":1}' },
      { event: null, data: '{"a":2}' },
      { event: null, data: SSE_DONE },
    ]);
  });

  it('reassembles a frame split across chunk boundaries', async () => {
    // The failure this exists to prevent: naive per-chunk splitting yields
    // '{"conte' and 'nt":"hi"}', neither of which is valid JSON.
    const events = await collect(streamOf(['data: {"conte', 'nt":"hi"}', '\n\n']));
    expect(events).toEqual([{ event: null, data: '{"content":"hi"}' }]);
  });

  it('reassembles a frame split mid-UTF-8-sequence', async () => {
    // A single emoji spanning two chunks. Decoding each chunk independently
    // produces replacement characters, silently corrupting user-visible text.
    const encoder = new TextEncoder();
    const full = encoder.encode('data: {"t":"🎬"}\n\n');
    const split = Math.floor(full.length / 2);
    const events = await collect(streamOf([full.slice(0, split), full.slice(split)]));
    expect(events).toEqual([{ event: null, data: '{"t":"🎬"}' }]);
  });

  it('handles CRLF line endings, which proxies introduce', async () => {
    const events = await collect(streamOf(['data: {"a":1}\r\n\r\n']));
    expect(events).toEqual([{ event: null, data: '{"a":1}' }]);
  });

  it('handles bare CR', async () => {
    const events = await collect(streamOf(['data: {"a":1}\r\r']));
    expect(events).toEqual([{ event: null, data: '{"a":1}' }]);
  });

  it('reads named events, as Anthropic sends', async () => {
    const events = await collect(
      streamOf([
        'event: message_start\ndata: {"type":"message_start"}\n\n',
        'event: content_block_delta\ndata: {"delta":{"text":"hi"}}\n\n',
      ]),
    );
    expect(events).toEqual([
      { event: 'message_start', data: '{"type":"message_start"}' },
      { event: 'content_block_delta', data: '{"delta":{"text":"hi"}}' },
    ]);
  });

  it('skips comment keep-alives', async () => {
    const events = await collect(streamOf([': ping\n\n', 'data: {"a":1}\n\n', ':\n\n']));
    // Comments carry no data, so they must not produce empty frames.
    expect(events).toEqual([{ event: null, data: '{"a":1}' }]);
  });

  it('joins multiple data lines in one frame with newlines', async () => {
    const events = await collect(streamOf(['data: line one\ndata: line two\n\n']));
    expect(events).toEqual([{ event: null, data: 'line one\nline two' }]);
  });

  it('strips exactly one leading space after the colon', async () => {
    const events = await collect(streamOf(['data:  two spaces\n\n']));
    expect(events).toEqual([{ event: null, data: ' two spaces' }]);
  });

  it('emits an unterminated final frame rather than discarding it', async () => {
    // A dropped connection leaves the last frame without its blank line. Those
    // tokens were billed; throwing them away is the wrong failure.
    const events = await collect(streamOf(['data: {"a":1}\n\n', 'data: {"a":2}']));
    expect(events).toEqual([
      { event: null, data: '{"a":1}' },
      { event: null, data: '{"a":2}' },
    ]);
  });

  it('ignores id and retry fields', async () => {
    const events = await collect(streamOf(['id: 42\nretry: 1000\ndata: {"a":1}\n\n']));
    expect(events).toEqual([{ event: null, data: '{"a":1}' }]);
  });

  it('ignores unknown fields rather than failing', async () => {
    // Providers add fields; an unrecognised one must not break a live response.
    const events = await collect(streamOf(['futurefield: x\ndata: {"a":1}\n\n']));
    expect(events).toEqual([{ event: null, data: '{"a":1}' }]);
  });

  it('yields nothing for an empty stream', async () => {
    expect(await collect(streamOf([]))).toEqual([]);
  });

  it('yields nothing for a stream of only blank lines', async () => {
    expect(await collect(streamOf(['\n\n\n\n']))).toEqual([]);
  });

  it('stops when the signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    expect(await collect(streamOf(['data: {"a":1}\n\n']), controller.signal)).toEqual([]);
  });

  it('handles a single chunk containing many frames', async () => {
    const events = await collect(streamOf(['data: {"a":1}\n\ndata: {"a":2}\n\ndata: {"a":3}\n\n']));
    expect(events).toHaveLength(3);
  });

  it('handles one byte at a time', async () => {
    // Pathological but exactly what a slow connection produces.
    const payload = 'event: ping\ndata: {"n":123}\n\n';
    // Array.from rather than spread: the payload is ASCII, but the lint rule
    // guards against surrogate-pair splitting and is a reasonable default.
    const events = await collect(streamOf(Array.from(payload)));
    expect(events).toEqual([{ event: 'ping', data: '{"n":123}' }]);
  });
});

describe('parseSseJson', () => {
  it('parses an object', () => {
    expect(parseSseJson('{"a":1}')).toEqual({ a: 1 });
  });

  it('returns null for the terminator', () => {
    expect(parseSseJson(SSE_DONE)).toBeNull();
  });

  it('returns null for empty data', () => {
    expect(parseSseJson('')).toBeNull();
  });

  it('returns null rather than throwing on malformed JSON', () => {
    // One bad frame must not abort a response the user is already reading.
    for (const data of ['{', 'not json', '[1,2]', '"a string"', '42', 'null']) {
      expect(() => parseSseJson(data)).not.toThrow();
      expect(parseSseJson(data), data).toBeNull();
    }
  });
});
