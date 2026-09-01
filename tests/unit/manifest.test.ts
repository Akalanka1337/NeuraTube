import { describe, expect, it } from 'vitest';
import { MATCH_PATTERNS, PROVIDER_ORIGINS, createManifest } from '../../build/manifest.mjs';
import { SUPPORTED_HOSTNAMES } from '~/types/hosts';
import { PROVIDER_ORIGINS as RUNTIME_PROVIDER_ORIGINS, PROVIDER_SPECS } from '~/providers/specs';
import { PROVIDER_IDS } from '~/providers/types';

/**
 * The manifest is authored in plain JS (the build script consumes it before
 * TypeScript exists) so it cannot share a module with the runtime host list.
 * These tests are the joint: drift fails CI instead of shipping a content
 * script that never matches, or host permissions we never use — which Chrome
 * Web Store review flags, and which the Limited Use policy (enforced
 * 2026-08-01) expects us to justify.
 */
describe('manifest', () => {
  const manifest = createManifest({ version: '1.2.3', mode: 'production' });

  it('agrees with the runtime host list', () => {
    const fromManifest = MATCH_PATTERNS.map(
      (pattern) => new URL(pattern.replace('/*', '/')).hostname,
    );
    expect([...fromManifest].sort()).toEqual([...SUPPORTED_HOSTNAMES].sort());
  });

  it('declares MV3 with a module service worker', () => {
    expect(manifest.manifest_version).toBe(3);
    expect(manifest.background).toEqual({ service_worker: 'background.js', type: 'module' });
  });

  it('carries the version it was given', () => {
    expect(manifest.version).toBe('1.2.3');
  });

  it('requests only the storage permission at this milestone', () => {
    // Permissions are added in the milestone that first needs them. If this
    // fails, confirm the new permission is genuinely required and disclosed in
    // PRIVACY.md before updating the assertion.
    expect(manifest.permissions).toEqual(['storage']);
  });

  it('scopes host permissions to YouTube plus the four provider origins', () => {
    expect(manifest.host_permissions).toEqual([
      'https://studio.youtube.com/*',
      'https://www.youtube.com/*',
      'https://api.openai.com/*',
      'https://api.anthropic.com/*',
      'https://api.deepseek.com/*',
      'https://integrate.api.nvidia.com/*',
    ]);
  });

  it('agrees with the runtime provider origin list', () => {
    // A provider missing here fails at runtime with an opaque network error,
    // and one present but unused is penalised in store review.
    expect([...PROVIDER_ORIGINS].sort()).toEqual([...RUNTIME_PROVIDER_ORIGINS].sort());
  });

  it('holds a host permission for every provider it can call', () => {
    const granted = manifest.host_permissions as string[];
    for (const id of PROVIDER_IDS) {
      const origin = new URL(PROVIDER_SPECS[id].defaultBaseUrl).origin;
      expect(granted, id).toContain(`${origin}/*`);
    }
  });

  it('declares the options page', () => {
    expect(manifest.options_page).toBe('options/index.html');
  });

  it('declares exactly two content scripts, interceptor first', () => {
    const scripts = manifest.content_scripts as Record<string, unknown>[];
    expect(scripts).toHaveLength(2);
    // Declaration order is load-bearing: the interceptor must patch
    // XMLHttpRequest before anything else runs.
    expect(scripts[0]!.js).toEqual(['content/interceptor.js']);
    expect(scripts[1]!.js).toEqual(['content/panel.js']);
  });

  it('injects the interceptor into the MAIN world at document_start', () => {
    const scripts = manifest.content_scripts as Record<string, unknown>[];
    const interceptor = scripts[0]!;
    // MAIN world is the only way to read a response body in MV3, and
    // document_start is the only way to patch before YouTube's bundle runs.
    expect(interceptor.world).toBe('MAIN');
    expect(interceptor.run_at).toBe('document_start');
    expect(interceptor.all_frames).toBe(false);
  });

  it('injects the panel at document_idle in the isolated world', () => {
    const scripts = manifest.content_scripts as Record<string, unknown>[];
    const panel = scripts[1]!;
    // document_start would block page load and put us on YouTube's critical
    // path, which the non-functional requirements forbid. Only the interceptor
    // genuinely needs it.
    expect(panel.run_at).toBe('document_idle');
    expect(panel.world).toBe('ISOLATED');
  });

  it('does not expose any web-accessible resources', () => {
    // A manifest-declared MAIN-world content script is injected by the browser
    // and never fetched by URL. The brief listed interceptor.js under
    // web_accessible_resources; doing so would only widen the attack surface.
    expect(manifest.web_accessible_resources).toBeUndefined();
    expect(JSON.stringify(manifest)).not.toContain('web_accessible');
  });

  it('forbids remote and unsafe code in its CSP', () => {
    const csp = manifest.content_security_policy as Record<string, string>;
    expect(csp.extension_pages).toContain("script-src 'self'");
    expect(csp.extension_pages).not.toContain('unsafe-eval');
    expect(csp.extension_pages).not.toContain('unsafe-inline');
    expect(csp.extension_pages).not.toContain('http');
  });

  it('binds the toggle command to Alt+N', () => {
    const commands = manifest.commands as Record<string, { suggested_key: { default: string } }>;
    expect(commands['toggle-panel']?.suggested_key.default).toBe('Alt+N');
  });

  it('sets a minimum Chrome version that supports MAIN-world content scripts', () => {
    // world: "MAIN" needs 111; WebSocket-based service worker lifetime
    // extension needs 116. We rely on both before v1.
    expect(Number(manifest.minimum_chrome_version)).toBeGreaterThanOrEqual(116);
  });

  it('references only icons that the generator produces', () => {
    const icons = manifest.icons as Record<string, string>;
    expect(Object.keys(icons).sort()).toEqual(['128', '16', '32', '48']);
  });

  it('marks development builds so they are distinguishable when both are loaded', () => {
    expect(createManifest({ version: '0.0.0', mode: 'development' }).name).toBe('NeuraTube (dev)');
    expect(manifest.name).toBe('NeuraTube');
  });

  it('localises user-visible strings through _locales', () => {
    expect(manifest.default_locale).toBe('en');
    expect(manifest.description).toBe('__MSG_extDescription__');
  });
});
