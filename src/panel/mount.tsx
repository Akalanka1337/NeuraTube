/**
 * Shadow-DOM mount.
 *
 * Hand-rolled rather than delegated to a framework helper, for three reasons:
 *
 *  1. Style isolation must be total in both directions. YouTube ships thousands
 *     of global rules; a shadow root with `adoptedStyleSheets` is the only
 *     construct that guarantees neither side reaches the other.
 *  2. Trusted Types. Styles go in as a constructed `CSSStyleSheet`, never as a
 *     <style> element with string content, and the tree is built by Preact's
 *     createElement path. Nothing here touches a string-to-HTML sink.
 *  3. Survivability. YouTube's SPA router replaces large subtrees on
 *     navigation. The host is appended to <html> rather than <body> and is
 *     re-attached by a MutationObserver if it is ever removed.
 */

import { render } from 'preact';
import { Panel } from './Panel';
import panelCss from './styles/panel.css?inline';
import tokensCss from './styles/tokens.css?inline';
import { createLogger } from '~/lib/logger';
import { markFirstPaint } from '~/lib/perf';
import {
  collapsed,
  firstPaintMs,
  geometry,
  interacting,
  mounted,
  theme,
  visible,
} from '~/state/panelState';
import { ORB_SIZE } from './chrome/geometry';

const log = createLogger('mount');

/** Element id on the host. Also the E2E suite's handle on the panel. */
export const HOST_ID = 'neuratube-root';

export interface PanelMount {
  readonly host: HTMLElement;
  readonly shadow: ShadowRoot;
  /** Unmount, disconnect observers, and remove the host. */
  destroy(): void;
}

/**
 * Build the stylesheet once and share it.
 *
 * A single `CSSStyleSheet` object can be adopted by any number of shadow roots
 * with no duplication, so this is cheap even if we later host multiple roots.
 */
let sharedSheet: CSSStyleSheet | null = null;

function styleText(): string {
  // Tokens first: panel.css consumes the custom properties they declare.
  return `${tokensCss}\n${panelCss}`;
}

function getSharedSheet(): CSSStyleSheet | null {
  if (sharedSheet) return sharedSheet;
  // Feature-detect rather than assume: constructable stylesheets are
  // universally available in our supported range (Chromium 73+), but the test
  // environment and any future non-Chromium target may differ.
  if (typeof CSSStyleSheet === 'undefined') return null;
  try {
    const sheet = new CSSStyleSheet();
    sheet.replaceSync(styleText());
    sharedSheet = sheet;
    return sheet;
  } catch (error) {
    log.warn('constructable stylesheet unavailable, falling back to <style>', error);
    return null;
  }
}

function applyStyles(shadow: ShadowRoot): void {
  const sheet = getSharedSheet();
  if (sheet) {
    shadow.adoptedStyleSheets = [...shadow.adoptedStyleSheets, sheet];
    return;
  }
  // Fallback path. `textContent` is a plain text sink, not a Trusted Types
  // sink, so this remains safe under enforcement.
  const style = document.createElement('style');
  style.textContent = styleText();
  shadow.append(style);
}

/**
 * Create the host element.
 *
 * Every property is set `!important` because the host lives in YouTube's tree
 * and a page rule like `div { position: static }` would otherwise reposition it.
 * `all: initial` is deliberately avoided — it resets custom properties too,
 * which would wipe the design tokens.
 *
 * Position and size are driven by the geometry signal from M4 onward rather than
 * by CSS, so a dragged panel survives a re-render.
 */
function createHost(): HTMLElement {
  const host = document.createElement('div');
  host.id = HOST_ID;
  host.setAttribute('data-neuratube', __NEURATUBE_VERSION__);
  host.style.setProperty('position', 'fixed', 'important');
  host.style.setProperty('z-index', '2147483000', 'important');
  host.style.setProperty('margin', '0', 'important');
  host.style.setProperty('padding', '0', 'important');
  // The host itself must not eat clicks outside the panel it contains.
  host.style.setProperty('pointer-events', 'auto', 'important');
  return host;
}

/**
 * Write geometry onto the host as inline styles.
 *
 * Inline rather than CSS custom properties so a page stylesheet cannot override
 * the panel's position, and `!important` for the same reason. Collapsed skips
 * geometry entirely and uses the fixed orb size, anchored at the panel's
 * top-left so expanding does not make it jump.
 */
function applyGeometry(host: HTMLElement): void {
  const current = geometry.value;
  const isCollapsed = collapsed.value;

  host.style.setProperty('left', `${current.x}px`, 'important');
  host.style.setProperty('top', `${current.y}px`, 'important');
  host.style.setProperty(
    'width',
    isCollapsed ? `${ORB_SIZE}px` : `${current.width}px`,
    'important',
  );
  host.style.setProperty(
    'height',
    isCollapsed ? `${ORB_SIZE}px` : `${current.height}px`,
    'important',
  );
  host.dataset.snap = current.snap;
  // Transitions are disabled mid-gesture: animating every pointermove produces
  // visible lag behind the cursor.
  host.dataset.interacting = String(interacting.value);
}

/** Mount the panel. Idempotent: a second call returns the existing mount. */
export function mountPanel(): PanelMount {
  const existing = document.getElementById(HOST_ID);
  if (existing?.shadowRoot) {
    log.debug('already mounted');
    return wrap(existing, existing.shadowRoot, null);
  }

  const host = createHost();
  const shadow = host.attachShadow({ mode: 'open' });
  applyStyles(shadow);

  // Appending to documentElement rather than body: Studio replaces body
  // subtrees on navigation, and <html> is stable for the document's lifetime.
  document.documentElement.append(host);

  render(<Panel />, shadow);
  mounted.value = true;

  // Keep the host present if YouTube's router prunes it.
  const observer = new MutationObserver(() => {
    if (!host.isConnected) {
      log.warn('host was detached by the page, re-attaching');
      document.documentElement.append(host);
    }
  });
  observer.observe(document.documentElement, { childList: true });

  // Mirror visibility onto the host so a hidden panel costs no layout, and
  // keep the theme attribute on the host where tokens.css selects on it.
  const stopVisibility = subscribeAttribute(host);

  // Measure first paint on the frame after the initial render commits.
  requestAnimationFrame(() => {
    const measured = markFirstPaint();
    firstPaintMs.value = measured;
    log.debug('first paint', measured);
  });

  return wrap(host, shadow, () => {
    observer.disconnect();
    stopVisibility();
  });
}

/**
 * Reflect signal state onto host attributes.
 *
 * Done with attributes rather than re-rendering so a theme flip or a hide is a
 * single attribute write with no Preact work at all.
 */
function subscribeAttribute(host: HTMLElement): () => void {
  const syncVisible = (): void => {
    host.toggleAttribute('hidden', !visible.value);
  };
  const syncTheme = (): void => {
    host.dataset.theme = theme.value;
  };
  const syncGeometry = (): void => {
    applyGeometry(host);
  };

  const unsubVisible = visible.subscribe(syncVisible);
  const unsubTheme = theme.subscribe(syncTheme);
  const unsubGeometry = geometry.subscribe(syncGeometry);
  const unsubCollapsed = collapsed.subscribe(syncGeometry);
  const unsubInteracting = interacting.subscribe(syncGeometry);

  return () => {
    unsubVisible();
    unsubTheme();
    unsubGeometry();
    unsubCollapsed();
    unsubInteracting();
  };
}

function wrap(host: HTMLElement, shadow: ShadowRoot, cleanup: (() => void) | null): PanelMount {
  return {
    host,
    shadow,
    destroy() {
      cleanup?.();
      render(null, shadow);
      host.remove();
      mounted.value = false;
    },
  };
}

/** Drop the memoised stylesheet. Test-only. */
export function resetMountCacheForTests(): void {
  sharedSheet = null;
}
