import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  getTrustedTypesPolicy,
  isTrustedTypesAvailable,
  isTrustedTypesEnforced,
  resetTrustedTypesCacheForTests,
} from '~/lib/trusted-types';

/**
 * Google enforces Trusted Types on YouTube and states that non-compliant
 * extension DOM manipulation will be blocked. These tests cover both worlds:
 * a page without Trusted Types (our test environment) and a page that both
 * supports and refuses policies.
 */
describe('trusted types', () => {
  afterEach(() => {
    resetTrustedTypesCacheForTests();
    vi.unstubAllGlobals();
  });

  it('reports unavailable when the platform has no policy factory', () => {
    expect(isTrustedTypesAvailable()).toBe(false);
    expect(isTrustedTypesEnforced()).toBe(false);
    expect(getTrustedTypesPolicy()).toBeNull();
  });

  it('creates an identity policy when the platform allows it', () => {
    const createPolicy = vi.fn((_name: string, rules: { createHTML: (i: string) => string }) => ({
      createHTML: rules.createHTML,
    }));
    vi.stubGlobal('trustedTypes', { createPolicy, defaultPolicy: null });

    const policy = getTrustedTypesPolicy();

    expect(isTrustedTypesAvailable()).toBe(true);
    expect(createPolicy).toHaveBeenCalledWith('neuratube', expect.anything());
    expect(policy?.createHTML('<b>x</b>')).toBe('<b>x</b>');
  });

  it('memoises the policy so we never create it twice', () => {
    const createPolicy = vi.fn(() => ({ createHTML: (i: string) => i }));
    vi.stubGlobal('trustedTypes', { createPolicy, defaultPolicy: null });

    getTrustedTypesPolicy();
    getTrustedTypesPolicy();

    // A duplicate name throws on a real platform, so this must be once.
    expect(createPolicy).toHaveBeenCalledTimes(1);
  });

  it('returns null instead of throwing when the page CSP refuses our policy name', () => {
    vi.stubGlobal('trustedTypes', {
      createPolicy: () => {
        throw new TypeError('Policy "neuratube" disallowed.');
      },
      defaultPolicy: null,
    });

    expect(() => getTrustedTypesPolicy()).not.toThrow();
    expect(getTrustedTypesPolicy()).toBeNull();
  });
});
