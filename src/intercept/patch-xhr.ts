/**
 * https://github.com/Akalanka1337/NeuraTube
 *
 * XMLHttpRequest patch.
 *
 * Runs inside YouTube's own JS heap. The governing rule is that this code must
 * never, under any circumstance, throw into a YouTube call frame — an exception
 * escaping from `open` or `send` would break Studio itself, and the user would
 * blame the page, not us.
 *
 * FIXES OVER THE BRIEF'S REFERENCE IMPLEMENTATION:
 *
 * 1. `this.responseText` THROWS. The brief reads it unconditionally in the
 *    `load` handler. Per XHR spec, `responseText` raises `InvalidStateError`
 *    whenever `responseType` is anything other than `''` or `'text'`. Studio
 *    does use `'json'` and `'arraybuffer'` for some endpoints, so the brief's
 *    version throws inside YouTube's own event dispatch. We check
 *    `responseType` first and fall back to `response`.
 *
 * 2. NO ERROR PATH. The brief listens only for `load`. A request that errors,
 *    aborts or times out leaves the panel waiting forever with no signal. We
 *    listen for all four and report a skip reason.
 *
 * 3. UNBOUNDED BODIES. The brief captures any size. A multi-megabyte response
 *    gets structured-cloned across the world boundary and retained. We cap it.
 *
 * Additionally, the brief mutates `arguments` implicitly by calling
 * `_open.apply(this, arguments)` after assigning `this._nt`. That works, but
 * using a `Symbol`-keyed property instead of `_nt` avoids colliding with any
 * property YouTube's own code (or another extension's patch) might set.
 */

import type { CapturedExchange, SkipReason } from './protocol';
import { MAX_BODY_BYTES } from './protocol';
import { classifyRoute } from './routes';
import type { RouteKind } from './routes';

/**
 * Per-request state, attached under a Symbol.
 *
 * A Symbol cannot collide with a string property set by YouTube or by another
 * extension patching the same prototype.
 */
const STATE = Symbol('neuratube.xhr');

interface RequestState {
  kind: RouteKind;
  url: string;
  method: string;
  requestBody: string | null;
  reported: boolean;
}

// `RequestState | undefined` rather than an optional property: with
// `exactOptionalPropertyTypes` an optional property cannot be assigned
// `undefined`, and clearing the slot on reopen is exactly what we need.
type PatchedXhr = XMLHttpRequest & { [STATE]?: RequestState | undefined };

/**
 * Read a response body defensively.
 *
 * Returns the text plus a skip reason when the body is deliberately not
 * captured. Never throws.
 */
function readBody(xhr: XMLHttpRequest): { text: string; skipped: SkipReason | null } {
  let raw: unknown;

  try {
    // `responseText` is only legal for '' and 'text'. Anything else must go
    // through `response`, or the getter raises InvalidStateError.
    const type = xhr.responseType;
    if (type === '' || type === 'text') {
      raw = xhr.responseText;
    } else if (type === 'json') {
      // Already parsed by the platform; re-serialise so the wire format stays
      // uniformly "text that the parser will JSON.parse".
      raw = JSON.stringify(xhr.response);
    } else {
      // 'blob', 'arraybuffer', 'document' — not something we consume.
      return { text: '', skipped: 'unreadable-response-type' };
    }
  } catch {
    return { text: '', skipped: 'read-failed' };
  }

  if (typeof raw !== 'string') return { text: '', skipped: 'read-failed' };
  if (raw.length > MAX_BODY_BYTES) return { text: '', skipped: 'too-large' };
  return { text: raw, skipped: null };
}

/** Coerce a request body to a string, or null when it is not text-shaped. */
function readRequestBody(body: unknown): string | null {
  if (body == null) return null;
  if (typeof body === 'string') return body.length > MAX_BODY_BYTES ? null : body;
  if (typeof URLSearchParams !== 'undefined' && body instanceof URLSearchParams) {
    return body.toString();
  }
  // FormData, Blob, ArrayBuffer and streams are not used by the routes we
  // consume; capturing them would mean async reads on the page's hot path.
  return null;
}

/**
 * Install the patch.
 *
 * Idempotent, and safe to call again if the page (or another extension)
 * replaces the prototype methods after us — see `reassertPatches`.
 */
export function patchXhr(emit: (exchange: CapturedExchange) => void): void {
  const proto = XMLHttpRequest.prototype;
  /* eslint-disable @typescript-eslint/unbound-method -- capturing the native
     methods to delegate to is the whole point of a prototype patch; both are
     re-invoked with `.apply(this, ...)`, so `this` is never lost. */
  const originalOpen = proto.open;
  const originalSend = proto.send;
  /* eslint-enable @typescript-eslint/unbound-method */

  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- patching a native prototype requires the platform's own loose signature; the overload set is not expressible in a wrapper
  proto.open = function patchedOpen(this: PatchedXhr, ...args: any[]): void {
    try {
      const method = typeof args[0] === 'string' ? args[0] : 'GET';
      const rawUrl: unknown = args[1];
      const url = typeof rawUrl === 'string' ? rawUrl : String(rawUrl);
      const kind = classifyRoute(url);
      if (kind) {
        this[STATE] = { kind, url, method, requestBody: null, reported: false };
      } else if (this[STATE]) {
        // The same XHR object reopened for a different URL. Assigned rather
        // than deleted: `delete` on a hot object forces V8 to abandon the
        // hidden class and fall back to dictionary mode, and this runs on
        // every request the page makes.
        this[STATE] = undefined;
      }
    } catch {
      // Classification must never break the request.
    }

    originalOpen.apply(this, args as never);
  } as typeof proto.open;

  proto.send = function patchedSend(this: PatchedXhr, body?: unknown): void {
    const requestState = this[STATE];

    if (requestState) {
      try {
        requestState.requestBody = readRequestBody(body);

        const report = (skipOverride: SkipReason | null): void => {
          // Terminal events can fire in combination; only the first counts.
          if (requestState.reported) return;
          requestState.reported = true;

          const { text, skipped } =
            skipOverride === null ? readBody(this) : { text: '', skipped: skipOverride };

          emit({
            kind: requestState.kind,
            url: requestState.url,
            method: requestState.method,
            status: this.status,
            responseText: text,
            requestBody: requestState.requestBody,
            at: performance.now(),
            skipped,
          });
        };

        this.addEventListener('load', () => {
          report(null);
        });
        // Without these, a failed request leaves the panel waiting silently.
        this.addEventListener('error', () => {
          report('read-failed');
        });
        this.addEventListener('timeout', () => {
          report('read-failed');
        });
        this.addEventListener('abort', () => {
          report('aborted');
        });
      } catch {
        // Instrumentation failure must not stop the request being sent.
      }
    }

    originalSend.apply(this, [body] as never);
  };

  // Mark so `reassertPatches` can tell whether ours is still installed.
  markPatched(proto, 'open');
  markPatched(proto, 'send');
}

const PATCH_MARK = Symbol('neuratube.patched');

type Markable = Record<string | symbol, unknown>;

function markPatched(target: object, key: 'open' | 'send'): void {
  const fn = (target as Markable)[key];
  if (typeof fn === 'function') {
    (fn as unknown as Markable)[PATCH_MARK] = true;
  }
}

/** Whether a function is one of ours. */
export function isOurPatch(fn: unknown): boolean {
  return typeof fn === 'function' && (fn as unknown as Markable)[PATCH_MARK] === true;
}
