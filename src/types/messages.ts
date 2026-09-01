/**
 * Typed message contracts.
 *
 * Every cross-context message is a discriminated union on `type`, and both
 * directions are declared here so a change to one side fails to compile on the
 * other. There is no `any` anywhere in this file by design — the message bus is
 * exactly where untyped payloads cause the worst bugs.
 *
 * Note this covers only extension-internal messaging (`chrome.runtime`). The
 * MAIN-world interceptor's `window.postMessage` transport is a *different*,
 * hostile channel with its own nonce-authenticated envelope, and lands in M2.
 */

import type { SurfaceInfo } from './surface';
import type { ModelInfo, ProviderId, TestResult } from '~/providers/types';
import type { TranscriptContext } from '~/parsers/captions';

/** Bumped when a message shape changes incompatibly. */
export const PROTOCOL_VERSION = 1 as const;

export type ToggleReason = 'command' | 'action' | 'programmatic';

/** Panel visibility as reported by a content script. */
export interface PanelStatus {
  readonly mounted: boolean;
  readonly visible: boolean;
  readonly collapsed: boolean;
  readonly surface: SurfaceInfo;
  /** Milliseconds from content-script entry to first painted frame. */
  readonly firstPaintMs: number | null;
  readonly trustedTypesEnforced: boolean;
}

/** Content script, options page or popup -> service worker. */
export type ToBackground =
  | { readonly type: 'ping' }
  | { readonly type: 'surface-changed'; readonly surface: SurfaceInfo }
  | { readonly type: 'panel-ready'; readonly status: PanelStatus }
  /**
   * Verify a provider's credentials.
   *
   * Provider calls are routed through the service worker even from the options
   * page, which could make them directly. One network surface means one place to
   * audit, and the panel (M5) uses the same path.
   */
  | { readonly type: 'test-provider'; readonly provider: ProviderId }
  /** Fetch the model list, from cache unless `force`. */
  | {
      readonly type: 'list-models';
      readonly provider: ProviderId;
      readonly force?: boolean;
    }
  /**
   * A transcript captured from Studio's subtitles editor.
   *
   * Sent to the worker rather than written directly because `storage.session` is
   * not content-script readable without widening its access level, and because
   * the capture happens on a different page from the one that consumes it.
   */
  | { readonly type: 'transcript-captured'; readonly transcript: TranscriptContext }
  /** Ask whether a transcript is cached for a video. */
  | { readonly type: 'get-transcript'; readonly videoId: string };

/** Service worker -> caller. */
export type FromBackground =
  | { readonly type: 'pong'; readonly version: string; readonly protocol: typeof PROTOCOL_VERSION }
  | { readonly type: 'ack' }
  | { readonly type: 'provider-test'; readonly result: TestResult }
  | {
      readonly type: 'models';
      readonly models: readonly ModelInfo[];
      readonly fetchedAt: number;
      readonly fromCache: boolean;
      readonly error: string | null;
    }
  | { readonly type: 'transcript'; readonly transcript: TranscriptContext | null };

/** Service worker or popup -> content script. */
export type ToContent =
  | { readonly type: 'toggle-panel'; readonly reason: ToggleReason }
  | { readonly type: 'set-panel-visible'; readonly visible: boolean }
  | { readonly type: 'get-panel-status' };

/** Content script -> caller. */
export type FromContent =
  { readonly type: 'panel-status'; readonly status: PanelStatus } | { readonly type: 'ack' };

/**
 * Send a message to the service worker.
 *
 * Resolves to `null` rather than rejecting when the worker is unreachable —
 * an unavailable service worker is a normal, recoverable condition (it may be
 * mid-restart), not an exception the caller should have to guard.
 */
export async function sendToBackground(message: ToBackground): Promise<FromBackground | null> {
  try {
    return await chrome.runtime.sendMessage(message);
  } catch {
    return null;
  }
}

/** Send a message to a specific tab's content script. `null` if not reachable. */
export async function sendToTab(tabId: number, message: ToContent): Promise<FromContent | null> {
  try {
    return await chrome.tabs.sendMessage(tabId, message);
  } catch {
    // No content script in that tab (wrong origin, or not yet injected).
    return null;
  }
}
