import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { patchXhr } from '~/intercept/patch-xhr';
import { patchFetch, resolveFetchUrl } from '~/intercept/patch-fetch';
import type { CapturedExchange } from '~/intercept/protocol';
import { MAX_BODY_BYTES } from '~/intercept/protocol';

const MATCHED = 'https://studio.youtube.com/youtubei/v1/creator/get_creator_videos?alt=json';
const UNMATCHED = 'https://i.ytimg.com/vi/abc/maxresdefault.jpg';

const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

/* ========================================================================== */
/* fetch                                                                       */
/* ========================================================================== */

describe('resolveFetchUrl', () => {
  it('handles a string', () => {
    expect(resolveFetchUrl(MATCHED)).toBe(MATCHED);
  });

  it('handles a URL object', () => {
    // THE BRIEF'S BUG: `typeof input === 'string' ? input : input.url` returns
    // undefined for a URL, so the request is never classified and the capture is
    // silently lost.
    expect(resolveFetchUrl(new URL(MATCHED))).toBe(MATCHED);
  });

  it('handles a Request object', () => {
    expect(resolveFetchUrl(new Request(MATCHED))).toBe(MATCHED);
  });

  it('handles a Request-like from another realm', () => {
    expect(resolveFetchUrl({ url: MATCHED })).toBe(MATCHED);
  });

  it('returns an empty string rather than throwing on junk', () => {
    for (const input of [null, undefined, 42, {}, []]) {
      expect(() => resolveFetchUrl(input)).not.toThrow();
      expect(resolveFetchUrl(input)).toBe('');
    }
  });
});

describe('fetch patch', () => {
  let captured: CapturedExchange[];
  let originalFetch: typeof window.fetch;

  beforeEach(() => {
    captured = [];
    // eslint-disable-next-line @typescript-eslint/unbound-method -- saved verbatim to restore the global in afterEach
    originalFetch = window.fetch;
  });

  afterEach(() => {
    window.fetch = originalFetch;
  });

  function install(responder: (url: string) => Response | Promise<Response>): void {
    window.fetch = (input: RequestInfo | URL) => Promise.resolve(responder(resolveFetchUrl(input)));
    patchFetch((exchange) => captured.push(exchange));
  }

  it('captures a matched response without consuming the page’s copy', async () => {
    install(() => new Response('{"videos":[{"videoId":"aaaaaaaaaaa"}]}', { status: 200 }));

    const response = await window.fetch(MATCHED, { method: 'POST', body: '{"videoIds":[]}' });
    // The page must still be able to read its own body.
    await expect(response.text()).resolves.toContain('aaaaaaaaaaa');

    await tick();
    expect(captured).toHaveLength(1);
    expect(captured[0]!.kind).toBe('CREATOR_VIDEOS');
    expect(captured[0]!.method).toBe('POST');
    expect(captured[0]!.status).toBe(200);
    expect(captured[0]!.requestBody).toBe('{"videoIds":[]}');
    expect(captured[0]!.responseText).toContain('aaaaaaaaaaa');
    expect(captured[0]!.skipped).toBeNull();
  });

  it('captures when called with a URL object', async () => {
    install(() => new Response('{"videos":[]}', { status: 200 }));
    await window.fetch(new URL(MATCHED));
    await tick();
    expect(captured).toHaveLength(1);
  });

  it('takes the method from a Request when init omits it', async () => {
    install(() => new Response('{"videos":[]}', { status: 200 }));
    await window.fetch(new Request(MATCHED, { method: 'POST' }));
    await tick();
    expect(captured[0]!.method).toBe('POST');
  });

  it('ignores unmatched requests entirely', async () => {
    install(() => new Response('binary-ish', { status: 200 }));
    await window.fetch(UNMATCHED);
    await tick();
    expect(captured).toHaveLength(0);
  });

  it('skips an oversized body by content-length, before cloning it', async () => {
    install(
      () =>
        new Response('{}', {
          status: 200,
          headers: { 'content-length': String(MAX_BODY_BYTES + 1) },
        }),
    );
    await window.fetch(MATCHED);
    await tick();
    expect(captured).toHaveLength(1);
    expect(captured[0]!.skipped).toBe('too-large');
    expect(captured[0]!.responseText).toBe('');
  });

  it('reports a rejected fetch and re-throws it untouched', async () => {
    const failure = new TypeError('network down');
    window.fetch = () => Promise.reject(failure);
    patchFetch((exchange) => captured.push(exchange));

    // THE BRIEF'S BUG: it awaits the original fetch with no catch, so a network
    // failure produces no signal at all and the panel waits forever.
    await expect(window.fetch(MATCHED)).rejects.toBe(failure);
    expect(captured).toHaveLength(1);
    expect(captured[0]!.skipped).toBe('read-failed');
    expect(captured[0]!.status).toBe(0);
  });

  it('reports the response status, not the clone’s', async () => {
    install(() => new Response('{"error":1}', { status: 429 }));
    await window.fetch(MATCHED);
    await tick();
    expect(captured[0]!.status).toBe(429);
  });
});

/* ========================================================================== */
/* XMLHttpRequest                                                              */
/* ========================================================================== */

/**
 * Minimal XHR stand-in that reproduces the one spec behaviour that matters here:
 * `responseText` raises `InvalidStateError` unless `responseType` is `''` or
 * `'text'`.
 */
class FakeXhr {
  public responseType = '';
  public status = 200;
  public response: unknown = null;

  private readonly listeners = new Map<string, (() => void)[]>();
  private textValue = '';

  get responseText(): string {
    if (this.responseType !== '' && this.responseType !== 'text') {
      throw new DOMException('responseText is unavailable', 'InvalidStateError');
    }
    return this.textValue;
  }

  setText(value: string): void {
    this.textValue = value;
  }

  open(_method: string, _url: string): void {
    // Real implementation replaced by the patch.
  }

  send(_body?: unknown): void {
    // Real implementation replaced by the patch.
  }

  addEventListener(type: string, handler: () => void): void {
    const existing = this.listeners.get(type) ?? [];
    existing.push(handler);
    this.listeners.set(type, existing);
  }

  dispatch(type: string): void {
    for (const handler of this.listeners.get(type) ?? []) handler();
  }
}

describe('XMLHttpRequest patch', () => {
  let captured: CapturedExchange[];

  beforeEach(() => {
    captured = [];
    vi.stubGlobal('XMLHttpRequest', FakeXhr);
    patchXhr((exchange) => captured.push(exchange));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function request(url: string, responseType = ''): FakeXhr {
    const xhr = new (globalThis.XMLHttpRequest as unknown as typeof FakeXhr)();
    xhr.responseType = responseType;
    xhr.open('POST', url);
    return xhr;
  }

  it('captures a matched text response', () => {
    const xhr = request(MATCHED);
    xhr.send('{"videoIds":["aaaaaaaaaaa"]}');
    xhr.setText('{"videos":[]}');
    xhr.dispatch('load');

    expect(captured).toHaveLength(1);
    expect(captured[0]!.kind).toBe('CREATOR_VIDEOS');
    expect(captured[0]!.method).toBe('POST');
    expect(captured[0]!.responseText).toBe('{"videos":[]}');
    expect(captured[0]!.requestBody).toBe('{"videoIds":["aaaaaaaaaaa"]}');
  });

  it('does not throw when responseType makes responseText illegal', () => {
    // THE BRIEF'S BUG: it reads `this.responseText` unconditionally, which
    // raises InvalidStateError here — inside YouTube's own event dispatch.
    const xhr = request(MATCHED, 'json');
    xhr.response = { videos: [{ videoId: 'aaaaaaaaaaa' }] };
    xhr.send();

    expect(() => {
      xhr.dispatch('load');
    }).not.toThrow();

    expect(captured).toHaveLength(1);
    // A 'json' responseType is re-serialised rather than skipped, so the data is
    // still usable.
    expect(captured[0]!.responseText).toContain('aaaaaaaaaaa');
    expect(captured[0]!.skipped).toBeNull();
  });

  it('skips a response type it cannot read as text', () => {
    const xhr = request(MATCHED, 'arraybuffer');
    xhr.send();
    xhr.dispatch('load');

    expect(captured).toHaveLength(1);
    expect(captured[0]!.skipped).toBe('unreadable-response-type');
    expect(captured[0]!.responseText).toBe('');
  });

  it('reports error, timeout and abort, which the brief never listened for', () => {
    for (const [event, expected] of [
      ['error', 'read-failed'],
      ['timeout', 'read-failed'],
      ['abort', 'aborted'],
    ] as const) {
      captured = [];
      const xhr = request(MATCHED);
      xhr.send();
      xhr.dispatch(event);

      expect(captured, event).toHaveLength(1);
      expect(captured[0]!.skipped, event).toBe(expected);
    }
  });

  it('reports only once when terminal events combine', () => {
    const xhr = request(MATCHED);
    xhr.send();
    xhr.setText('{"videos":[]}');
    xhr.dispatch('load');
    xhr.dispatch('error');
    xhr.dispatch('abort');

    expect(captured).toHaveLength(1);
  });

  it('skips an oversized body', () => {
    const xhr = request(MATCHED);
    xhr.send();
    xhr.setText('x'.repeat(MAX_BODY_BYTES + 1));
    xhr.dispatch('load');

    expect(captured[0]!.skipped).toBe('too-large');
    expect(captured[0]!.responseText).toBe('');
  });

  it('ignores unmatched URLs', () => {
    const xhr = request(UNMATCHED);
    xhr.send();
    xhr.dispatch('load');
    expect(captured).toHaveLength(0);
  });

  it('clears state when the same object is reopened for a different URL', () => {
    const xhr = request(MATCHED);
    xhr.open('GET', UNMATCHED);
    xhr.send();
    xhr.dispatch('load');
    expect(captured).toHaveLength(0);
  });

  it('serialises a URLSearchParams request body', () => {
    const xhr = request(MATCHED);
    xhr.send(new URLSearchParams({ videoId: 'aaaaaaaaaaa' }));
    xhr.setText('{"videos":[]}');
    xhr.dispatch('load');
    expect(captured[0]!.requestBody).toBe('videoId=aaaaaaaaaaa');
  });

  it('does not capture a non-text request body', () => {
    const xhr = request(MATCHED);
    xhr.send(new ArrayBuffer(8));
    xhr.setText('{"videos":[]}');
    xhr.dispatch('load');
    expect(captured[0]!.requestBody).toBeNull();
  });
});
