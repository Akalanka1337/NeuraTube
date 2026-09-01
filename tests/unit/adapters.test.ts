import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createProvider } from '~/providers/index';
import { ANTHROPIC_VERSION, BROWSER_ACCESS_HEADER, splitSystem } from '~/providers/anthropic';
import { readModelList, readUsage } from '~/providers/openai-compatible';
import { ProviderError } from '~/providers/errors';
import type { Message, ProviderConfig, StreamEvent, Usage } from '~/providers/types';

const CONFIG: ProviderConfig = {
  apiKey: 'sk-test-abcdefghijklmnopqrstuvwxyz012345',
  model: 'test-model',
  baseUrl: '',
  enabled: true,
};

const MESSAGES: readonly Message[] = [
  { role: 'system', content: 'You are a title optimizer.' },
  { role: 'user', content: 'VIDEO CONTEXT\nTitle: something' },
];

/** Capture of one intercepted request. */
interface Captured {
  url: string;
  headers: Record<string, string>;
  body: unknown;
}

let captured: Captured[] = [];

/** Install a fetch stub that returns an SSE stream built from the given lines. */
function stubStream(lines: readonly string[], status = 200): void {
  vi.stubGlobal('fetch', (url: string, init: RequestInit) => {
    captured.push({
      url,
      headers: Object.fromEntries(new Headers(init.headers).entries()),
      body: typeof init.body === 'string' ? JSON.parse(init.body) : null,
    });

    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const line of lines) controller.enqueue(encoder.encode(line));
        controller.close();
      },
    });

    return Promise.resolve(
      new Response(stream, { status, headers: { 'content-type': 'text/event-stream' } }),
    );
  });
}

/** Install a fetch stub that returns a JSON body. */
function stubJson(payload: unknown, status = 200): void {
  vi.stubGlobal('fetch', (url: string, init: RequestInit) => {
    captured.push({
      url,
      headers: Object.fromEntries(new Headers(init.headers).entries()),
      body: typeof init.body === 'string' ? JSON.parse(init.body) : null,
    });
    return Promise.resolve(
      new Response(JSON.stringify(payload), {
        status,
        headers: { 'content-type': 'application/json' },
      }),
    );
  });
}

async function drain(stream: AsyncIterable<StreamEvent>) {
  const events: StreamEvent[] = [];
  for await (const event of stream) events.push(event);
  return events;
}

function textOf(events: readonly StreamEvent[]): string {
  return events
    .filter((event): event is Extract<StreamEvent, { type: 'text' }> => event.type === 'text')
    .map((event) => event.text)
    .join('');
}

function usagesOf(events: readonly StreamEvent[]): Usage[] {
  return events
    .filter((event): event is Extract<StreamEvent, { type: 'usage' }> => event.type === 'usage')
    .map((event) => event.usage);
}

beforeEach(() => {
  captured = [];
});

afterEach(() => {
  vi.unstubAllGlobals();
});

/* ========================================================================== */
/* OpenAI-compatible                                                           */
/* ========================================================================== */

describe('OpenAI-compatible adapter', () => {
  it('streams text deltas', async () => {
    stubStream([
      'data: {"choices":[{"delta":{"content":"Hello"}}]}\n\n',
      'data: {"choices":[{"delta":{"content":" world"}}]}\n\n',
      'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n',
      'data: [DONE]\n\n',
    ]);

    const events = await drain(
      createProvider('openai', CONFIG).chat(MESSAGES, { model: 'test-model' }),
    );

    expect(textOf(events)).toBe('Hello world');
    expect(events.at(-1)).toEqual({ type: 'done', finishReason: 'stop' });
  });

  it('requests usage explicitly, which the brief omits', async () => {
    stubStream(['data: [DONE]\n\n']);
    await drain(createProvider('openai', CONFIG).chat(MESSAGES, { model: 'test-model' }));

    // Without stream_options the stream carries no token counts at all and the
    // cost meter — a stated v1 feature — has nothing to show.
    expect(captured[0]!.body).toMatchObject({
      stream: true,
      stream_options: { include_usage: true },
    });
  });

  it('reads usage from the final chunk, which has no choices', async () => {
    stubStream([
      'data: {"choices":[{"delta":{"content":"hi"}}]}\n\n',
      // The usage-only frame. Code assuming choices[0] exists throws here —
      // precisely when the numbers arrive.
      'data: {"choices":[],"usage":{"prompt_tokens":120,"completion_tokens":8}}\n\n',
      'data: [DONE]\n\n',
    ]);

    const events = await drain(
      createProvider('openai', CONFIG).chat(MESSAGES, { model: 'test-model' }),
    );

    expect(usagesOf(events)).toEqual([{ inputTokens: 120, outputTokens: 8 }]);
    expect(textOf(events)).toBe('hi');
  });

  it('reads cached input tokens when reported', async () => {
    stubStream([
      'data: {"choices":[],"usage":{"prompt_tokens":100,"completion_tokens":5,"prompt_tokens_details":{"cached_tokens":64}}}\n\n',
      'data: [DONE]\n\n',
    ]);
    const events = await drain(
      createProvider('openai', CONFIG).chat(MESSAGES, { model: 'test-model' }),
    );
    expect(usagesOf(events)[0]).toEqual({
      inputTokens: 100,
      outputTokens: 5,
      cachedInputTokens: 64,
    });
  });

  it('sends the bearer header and the chosen model', async () => {
    stubStream(['data: [DONE]\n\n']);
    await drain(createProvider('openai', CONFIG).chat(MESSAGES, { model: 'chosen-model' }));

    expect(captured[0]!.headers.authorization).toBe(`Bearer ${CONFIG.apiKey}`);
    expect(captured[0]!.url).toBe('https://api.openai.com/v1/chat/completions');
    expect(captured[0]!.body).toMatchObject({ model: 'chosen-model' });
  });

  it('routes DeepSeek and NVIDIA NIM through the same adapter with only a base URL change', async () => {
    for (const [id, expected] of [
      ['deepseek', 'https://api.deepseek.com/chat/completions'],
      ['nvidia-nim', 'https://integrate.api.nvidia.com/v1/chat/completions'],
    ] as const) {
      captured = [];
      stubStream(['data: [DONE]\n\n']);
      await drain(createProvider(id, CONFIG).chat(MESSAGES, { model: 'm' }));
      expect(captured[0]!.url, id).toBe(expected);
      expect(captured[0]!.headers.authorization, id).toBe(`Bearer ${CONFIG.apiKey}`);
    }
  });

  it('honours a base URL override, for self-hosted NIM and gateways', async () => {
    stubStream(['data: [DONE]\n\n']);
    await drain(
      createProvider('nvidia-nim', { ...CONFIG, baseUrl: 'https://gw.example.com/nim/v1/' }).chat(
        MESSAGES,
        { model: 'm' },
      ),
    );
    // Trailing slash must not produce a double slash.
    expect(captured[0]!.url).toBe('https://gw.example.com/nim/v1/chat/completions');
  });

  it('raises an auth error for 401, with advice', async () => {
    stubJson({ error: { message: 'Incorrect API key provided' } }, 401);

    await expect(
      drain(createProvider('openai', CONFIG).chat(MESSAGES, { model: 'm' })),
    ).rejects.toBeInstanceOf(ProviderError);

    stubJson({ error: { message: 'Incorrect API key provided' } }, 401);
    try {
      await drain(createProvider('openai', CONFIG).chat(MESSAGES, { model: 'm' }));
      expect.unreachable('should have thrown');
    } catch (thrown) {
      const error = thrown as ProviderError;
      expect(error.kind).toBe('auth');
      expect(error.retryable).toBe(false);
      expect(error.userMessage).toContain('API key was rejected');
    }
  });

  it('marks a 429 retryable so routing can fall back', async () => {
    stubJson({ error: { message: 'Rate limit reached' } }, 429);
    try {
      await drain(createProvider('openai', CONFIG).chat(MESSAGES, { model: 'm' }));
      expect.unreachable('should have thrown');
    } catch (thrown) {
      expect((thrown as ProviderError).kind).toBe('rate-limit');
      expect((thrown as ProviderError).retryable).toBe(true);
    }
  });

  it('redacts the key from an error that echoes it', async () => {
    stubJson({ error: { message: `Invalid key ${CONFIG.apiKey} supplied` } }, 401);
    try {
      await drain(createProvider('openai', CONFIG).chat(MESSAGES, { model: 'm' }));
      expect.unreachable('should have thrown');
    } catch (thrown) {
      const error = thrown as ProviderError;
      expect(error.message).not.toContain(CONFIG.apiKey);
      expect(error.message).toContain('[redacted]');
    }
  });

  it('surfaces an error delivered mid-stream after a 200', async () => {
    stubStream([
      'data: {"choices":[{"delta":{"content":"partial"}}]}\n\n',
      'data: {"error":{"message":"context length exceeded"}}\n\n',
    ]);

    await expect(
      drain(createProvider('openai', CONFIG).chat(MESSAGES, { model: 'm' })),
    ).rejects.toThrow(/context length/);
  });

  it('lists models newest first', async () => {
    stubJson({
      data: [
        { id: 'old-model', created: 1_600_000_000 },
        { id: 'new-model', created: 1_800_000_000 },
      ],
    });

    const models = await createProvider('openai', CONFIG).listModels();
    expect(models.map((model) => model.id)).toEqual(['new-model', 'old-model']);
    expect(captured[0]!.url).toBe('https://api.openai.com/v1/models');
  });

  it('tests the connection over /models rather than billing a completion', async () => {
    stubJson({ data: [{ id: 'a' }, { id: 'b' }] });

    const result = await createProvider('openai', CONFIG).testConnection();

    expect(result.ok).toBe(true);
    expect(result.modelCount).toBe(2);
    expect(result.error).toBeNull();
    // Listing models is free; a chat call would charge the user every time they
    // press a button labelled "test".
    expect(captured).toHaveLength(1);
    expect(captured[0]!.url).toContain('/models');
  });

  it('reports a failed test without throwing', async () => {
    stubJson({ error: { message: 'nope' } }, 403);
    const result = await createProvider('openai', CONFIG).testConnection();
    expect(result.ok).toBe(false);
    expect(result.error).toContain('API key was rejected');
  });
});

describe('reasoning models', () => {
  /**
   * The bug this suite exists for. `reasoning_content` was parsed by nobody and
   * dropped on the floor, so a reasoning model that spent its whole budget
   * thinking produced a successful request, billed tokens, and an EMPTY output
   * box — indistinguishable from a provider returning nothing.
   */
  it('surfaces DeepSeek reasoning_content instead of discarding it', async () => {
    stubStream([
      'data: {"choices":[{"delta":{"reasoning_content":"Let me think about"}}]}\n\n',
      'data: {"choices":[{"delta":{"reasoning_content":" the SEO angle."}}]}\n\n',
      'data: {"choices":[{"delta":{"content":"Upscale Any Video to 4K"}}]}\n\n',
      'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n',
      'data: [DONE]\n\n',
    ]);

    const events = await drain(
      createProvider('deepseek', CONFIG).chat(MESSAGES, { model: 'deepseek-reasoner' }),
    );

    // Reasoning is reported separately and does NOT contaminate the answer.
    expect(textOf(events)).toBe('Upscale Any Video to 4K');
    const reasoning = events
      .filter((event) => event.type === 'reasoning')
      .map((event) => (event.type === 'reasoning' ? event.text : ''))
      .join('');
    expect(reasoning).toBe('Let me think about the SEO angle.');
  });

  it('also reads the bare `reasoning` field some NIM deployments use', async () => {
    stubStream([
      'data: {"choices":[{"delta":{"reasoning":"thinking"}}]}\n\n',
      'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n',
      'data: [DONE]\n\n',
    ]);

    const events = await drain(
      createProvider('nvidia-nim', CONFIG).chat(MESSAGES, { model: 'qwq-32b' }),
    );
    expect(events.some((event) => event.type === 'reasoning')).toBe(true);
  });

  /**
   * The exact reported symptom: a 200 response with tokens billed and nothing to
   * show. The adapter must make that state legible — reasoning present, no text,
   * finish reason 'length'.
   */
  it('reports a run that thought until it ran out of budget', async () => {
    stubStream([
      'data: {"choices":[{"delta":{"reasoning_content":"a very long chain of thought"}}]}\n\n',
      'data: {"choices":[{"delta":{},"finish_reason":"length"}]}\n\n',
      'data: {"choices":[],"usage":{"prompt_tokens":800,"completion_tokens":900}}\n\n',
      'data: [DONE]\n\n',
    ]);

    const events = await drain(
      createProvider('nvidia-nim', CONFIG).chat(MESSAGES, { model: 'deepseek-r1' }),
    );

    expect(textOf(events)).toBe('');
    expect(events.some((event) => event.type === 'reasoning')).toBe(true);
    expect(events.at(-1)).toEqual({ type: 'done', finishReason: 'length' });
  });

  it('ignores empty reasoning deltas', async () => {
    stubStream([
      'data: {"choices":[{"delta":{"reasoning_content":""}}]}\n\n',
      'data: {"choices":[{"delta":{"content":"ok"}}]}\n\n',
      'data: [DONE]\n\n',
    ]);

    const events = await drain(
      createProvider('openai', CONFIG).chat(MESSAGES, { model: 'test-model' }),
    );
    expect(events.some((event) => event.type === 'reasoning')).toBe(false);
    expect(textOf(events)).toBe('ok');
  });
});

describe('readUsage', () => {
  it('returns null when absent, which is every chunk but the last', () => {
    expect(readUsage(undefined)).toBeNull();
    expect(readUsage(null)).toBeNull();
    expect(readUsage({})).toBeNull();
  });

  it('tolerates a partial report', () => {
    expect(readUsage({ prompt_tokens: 10 })).toEqual({ inputTokens: 10, outputTokens: 0 });
  });
});

describe('readModelList', () => {
  it('accepts a bare array, as NIM has been observed returning', () => {
    expect(readModelList([{ id: 'a' }]).map((model) => model.id)).toEqual(['a']);
  });

  it('drops entries with no usable id', () => {
    expect(readModelList({ data: [{ id: '' }, {}, null, 42, { id: 'ok' }] })).toHaveLength(1);
  });

  it('falls back to alphabetical when no dates are present', () => {
    expect(readModelList({ data: [{ id: 'b' }, { id: 'a' }] }).map((m) => m.id)).toEqual([
      'a',
      'b',
    ]);
  });

  it('returns an empty list rather than throwing on junk', () => {
    for (const payload of [null, undefined, 42, 'nope', { data: 'nope' }]) {
      expect(() => readModelList(payload)).not.toThrow();
      expect(readModelList(payload)).toEqual([]);
    }
  });
});

/* ========================================================================== */
/* Anthropic                                                                   */
/* ========================================================================== */

describe('Anthropic adapter', () => {
  it('sends the browser access header the brief omits', async () => {
    stubStream(['event: message_stop\ndata: {}\n\n']);
    await drain(createProvider('anthropic', CONFIG).chat(MESSAGES, { model: 'm' }));

    // Without this header every Claude call fails CORS. Its absence from the
    // original provider matrix would have broken M3 on the first test click.
    expect(captured[0]!.headers[BROWSER_ACCESS_HEADER]).toBe('true');
  });

  it('authenticates with x-api-key and a version header, not a bearer token', async () => {
    stubStream(['event: message_stop\ndata: {}\n\n']);
    await drain(createProvider('anthropic', CONFIG).chat(MESSAGES, { model: 'm' }));

    expect(captured[0]!.headers['x-api-key']).toBe(CONFIG.apiKey);
    expect(captured[0]!.headers['anthropic-version']).toBe(ANTHROPIC_VERSION);
    expect(captured[0]!.headers.authorization).toBeUndefined();
    expect(captured[0]!.url).toBe('https://api.anthropic.com/v1/messages');
  });

  it('hoists the system message to a top-level parameter', async () => {
    stubStream(['event: message_stop\ndata: {}\n\n']);
    await drain(createProvider('anthropic', CONFIG).chat(MESSAGES, { model: 'm' }));

    const body = captured[0]!.body as Record<string, unknown>;
    // A system role left in `messages` is rejected outright by this API.
    expect(body.system).toBe('You are a title optimizer.');
    expect(body.messages).toEqual([{ role: 'user', content: 'VIDEO CONTEXT\nTitle: something' }]);
    // max_tokens is required here, unlike the OpenAI shape.
    expect(body.max_tokens).toBeTypeOf('number');
  });

  it('streams text_delta content and ignores other block types', async () => {
    stubStream([
      'event: content_block_delta\ndata: {"delta":{"type":"text_delta","text":"Hello"}}\n\n',
      'event: content_block_delta\ndata: {"delta":{"type":"thinking_delta","thinking":"hmm"}}\n\n',
      'event: content_block_delta\ndata: {"delta":{"type":"text_delta","text":" there"}}\n\n',
      'event: message_stop\ndata: {}\n\n',
    ]);

    const events = await drain(createProvider('anthropic', CONFIG).chat(MESSAGES, { model: 'm' }));
    expect(textOf(events)).toBe('Hello there');
  });

  it('treats usage as cumulative, carrying input forward', async () => {
    stubStream([
      'event: message_start\ndata: {"message":{"usage":{"input_tokens":250,"output_tokens":0}}}\n\n',
      'event: content_block_delta\ndata: {"delta":{"type":"text_delta","text":"a"}}\n\n',
      'event: message_delta\ndata: {"usage":{"output_tokens":10},"delta":{"stop_reason":"end_turn"}}\n\n',
      'event: message_delta\ndata: {"usage":{"output_tokens":25},"delta":{"stop_reason":"end_turn"}}\n\n',
      'event: message_stop\ndata: {}\n\n',
    ]);

    const events = await drain(createProvider('anthropic', CONFIG).chat(MESSAGES, { model: 'm' }));
    const usages = usagesOf(events);

    // Each report is a replacement, and input is carried forward from
    // message_start because message_delta reports output only. Treating these as
    // increments would double-count badly.
    expect(usages).toEqual([
      { inputTokens: 250, outputTokens: 0 },
      { inputTokens: 250, outputTokens: 10 },
      { inputTokens: 250, outputTokens: 25 },
    ]);
    expect(events.at(-1)).toEqual({ type: 'done', finishReason: 'end_turn' });
  });

  it('skips ping keep-alives', async () => {
    stubStream([
      'event: ping\ndata: {"type":"ping"}\n\n',
      'event: content_block_delta\ndata: {"delta":{"type":"text_delta","text":"x"}}\n\n',
      'event: ping\ndata: {"type":"ping"}\n\n',
      'event: message_stop\ndata: {}\n\n',
    ]);
    const events = await drain(createProvider('anthropic', CONFIG).chat(MESSAGES, { model: 'm' }));
    expect(textOf(events)).toBe('x');
  });

  it('raises a typed mid-stream error event', async () => {
    stubStream([
      'event: error\ndata: {"error":{"type":"overloaded_error","message":"Overloaded"}}\n\n',
    ]);
    await expect(
      drain(createProvider('anthropic', CONFIG).chat(MESSAGES, { model: 'm' })),
    ).rejects.toThrow(/Overloaded/);
  });

  it('completes when the stream ends without message_stop', async () => {
    stubStream([
      'event: content_block_delta\ndata: {"delta":{"type":"text_delta","text":"cut"}}\n\n',
    ]);
    const events = await drain(createProvider('anthropic', CONFIG).chat(MESSAGES, { model: 'm' }));
    expect(textOf(events)).toBe('cut');
    expect(events.at(-1)?.type).toBe('done');
  });

  it('reads its ISO-dated model list', async () => {
    stubJson({
      data: [
        { id: 'older', display_name: 'Older', created_at: '2025-01-01T00:00:00Z' },
        { id: 'newer', display_name: 'Newer', created_at: '2026-01-01T00:00:00Z' },
      ],
    });

    const models = await createProvider('anthropic', CONFIG).listModels();
    expect(models.map((model) => model.id)).toEqual(['newer', 'older']);
    expect(models[0]!.label).toBe('Newer');
  });
});

describe('splitSystem', () => {
  it('joins several system messages, which guardrails will produce', () => {
    const result = splitSystem([
      { role: 'system', content: 'Base prompt.' },
      { role: 'system', content: 'Guardrail: made for kids.' },
      { role: 'user', content: 'go' },
    ]);
    expect(result.system).toBe('Base prompt.\n\nGuardrail: made for kids.');
    expect(result.conversation).toEqual([{ role: 'user', content: 'go' }]);
  });

  it('returns null when there is no system message', () => {
    expect(splitSystem([{ role: 'user', content: 'hi' }]).system).toBeNull();
  });
});
