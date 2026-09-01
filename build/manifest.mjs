/**
 * Single source of truth for `dist/manifest.json`.
 *
 * Deliberate deviations from the original project brief, all documented in
 * PRIVACY.md / README.md:
 *
 *  - `interceptor.js` is NOT listed under `web_accessible_resources`. A
 *    MAIN-world content script declared in the manifest is injected by the
 *    browser and never fetched by URL, so WAR would only widen the attack
 *    surface for no benefit.
 *  - The MAIN-world interceptor runs at document_start because it must patch
 *    XMLHttpRequest before YouTube's application bundle issues its first
 *    request. The panel does NOT, because document_start blocks page load.
 *  - Permissions are added in the milestone that first needs them, not up
 *    front. `activeTab` / `scripting` remain unnecessary because our content
 *    scripts are statically declared. M3 adds the four AI provider origins,
 *    which is the first time the extension makes a request of its own. Chrome
 *    Web Store review penalises unused permissions, and the Limited Use policy
 *    (enforced 2026-08-01) expects the narrowest set that satisfies the
 *    disclosed single purpose.
 *  - `minimum_chrome_version` is 116: `world: "MAIN"` declarative content
 *    scripts need 111, and WebSocket-based service-worker lifetime extension
 *    needs 116. We rely on both before v1 ships.
 */

/** Surfaces NeuraTube attaches to. Kept in one place so the manifest and the
 *  runtime surface detector cannot drift apart. */
export const MATCH_PATTERNS = ['https://studio.youtube.com/*', 'https://www.youtube.com/*'];

/**
 * AI provider origins.
 *
 * Needed from M3, when the service worker starts calling providers with the
 * user's own key. Mirrors `PROVIDER_ORIGINS` in src/providers/specs.ts; a unit
 * test asserts the two agree, because a provider missing here fails at runtime
 * with an opaque network error.
 *
 * A user who overrides a provider's base URL to a host outside this list will
 * have the request blocked by Chrome. The options page explains that rather than
 * requesting broad host access we do not need.
 */
export const PROVIDER_ORIGINS = [
  'https://api.openai.com/*',
  'https://api.anthropic.com/*',
  'https://api.deepseek.com/*',
  'https://integrate.api.nvidia.com/*',
];

/**
 * @param {{ version: string, mode: 'development' | 'production' }} options
 * @returns {Record<string, unknown>}
 */
export function createManifest({ version, mode }) {
  const isDev = mode === 'development';

  return {
    manifest_version: 3,
    name: isDev ? 'NeuraTube (dev)' : 'NeuraTube',
    version,
    // Localised via public/_locales/<locale>/messages.json. `default_locale`
    // is set, so Chrome refuses to load the extension without that directory.
    description: '__MSG_extDescription__',
    minimum_chrome_version: '116',

    default_locale: 'en',

    icons: {
      16: 'icons/icon-16.png',
      32: 'icons/icon-32.png',
      48: 'icons/icon-48.png',
      128: 'icons/icon-128.png',
    },

    // `storage` is the only permission M1 needs: panel visibility and layout
    // are persisted in chrome.storage.local. API keys land here in M3 —
    // local only, never `sync`, because sync uploads to Google's servers and
    // caps items at 8KB.
    permissions: ['storage'],

    host_permissions: [...MATCH_PATTERNS, ...PROVIDER_ORIGINS],

    background: {
      service_worker: 'background.js',
      type: 'module',
    },

    content_scripts: [
      {
        // MAIN world, document_start. This is the only NeuraTube code that runs
        // in YouTube's own JS heap. It must be first: statically-declared
        // manifest content scripts are injected ahead of any other injection
        // mechanism at the same lifecycle stage, which is the only reason
        // patching XMLHttpRequest before YouTube's bundle is reliable.
        //
        // Deliberately NOT in web_accessible_resources: the browser injects it
        // directly and it is never fetched by URL, so listing it would only
        // widen the attack surface.
        matches: MATCH_PATTERNS,
        js: ['content/interceptor.js'],
        run_at: 'document_start',
        world: 'MAIN',
        all_frames: false,
      },
      {
        // Isolated world, document_idle. The brief specified document_start
        // for this script, but document_start blocks page load and puts us on
        // YouTube's critical path — which the non-functional requirements
        // explicitly forbid. Only the M2 interceptor genuinely needs
        // document_start; the panel does not.
        matches: MATCH_PATTERNS,
        js: ['content/panel.js'],
        run_at: 'document_idle',
        world: 'ISOLATED',
        all_frames: false,
      },
    ],

    options_page: 'options/index.html',

    action: {
      default_title: 'NeuraTube',
      default_popup: 'popup/index.html',
      default_icon: {
        16: 'icons/icon-16.png',
        32: 'icons/icon-32.png',
        48: 'icons/icon-48.png',
      },
    },

    commands: {
      'toggle-panel': {
        suggested_key: { default: 'Alt+N' },
        description: '__MSG_commandTogglePanel__',
      },
    },

    // No 'unsafe-eval', no 'wasm-unsafe-eval', no remote script origins.
    // MV3 forbids remote code; we never load any.
    content_security_policy: {
      extension_pages: "script-src 'self'; object-src 'self';",
    },
  };
}
