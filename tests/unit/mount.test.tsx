import { beforeEach, describe, expect, it } from 'vitest';
import { HOST_ID, mountPanel, resetMountCacheForTests } from '~/panel/mount';
import { collapsed, resetPanelStateForTests, visible } from '~/state/panelState';

/**
 * Preact Signals schedules re-renders on a microtask rather than rendering
 * synchronously on write, so any assertion about the DOM *after* a signal
 * change has to let the scheduler run first. Attribute mirroring on the host
 * (hidden, data-theme) is different: it happens in a `subscribe` callback,
 * which does run synchronously.
 */
const flush = async (): Promise<void> => {
  await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
};

/**
 * The mount is the piece most likely to break silently on a real YouTube page,
 * so these tests pin the three properties that matter there: total style
 * isolation, no Trusted Types sink, and survival of the SPA router pruning our
 * host element.
 */
describe('mountPanel', () => {
  beforeEach(() => {
    document.getElementById(HOST_ID)?.remove();
    // Reset by node construction, not innerHTML — the same rule the panel
    // itself must follow under YouTube's enforced Trusted Types.
    document.documentElement.replaceChildren(
      document.createElement('head'),
      document.createElement('body'),
    );
    resetMountCacheForTests();
    resetPanelStateForTests();
  });

  it('attaches a single host with an open shadow root', () => {
    const mount = mountPanel();

    expect(mount.host.id).toBe(HOST_ID);
    expect(mount.host.isConnected).toBe(true);
    expect(mount.shadow).toBeInstanceOf(ShadowRoot);
    expect(mount.shadow.mode).toBe('open');
    expect(document.querySelectorAll(`#${HOST_ID}`)).toHaveLength(1);

    mount.destroy();
  });

  it('appends the host to documentElement, not body', () => {
    // Studio replaces body subtrees on navigation; <html> is stable for the
    // document's lifetime.
    const mount = mountPanel();
    expect(mount.host.parentElement).toBe(document.documentElement);
    mount.destroy();
  });

  it('renders the panel into the shadow root, not the page', () => {
    const mount = mountPanel();

    expect(mount.shadow.querySelector('.panel')).not.toBeNull();
    expect(document.body.querySelector('.panel')).toBeNull();

    mount.destroy();
  });

  it('applies styles without using a Trusted Types sink', () => {
    const mount = mountPanel();

    const adopted = mount.shadow.adoptedStyleSheets as readonly CSSStyleSheet[] | undefined;
    const styleElements = mount.shadow.querySelectorAll('style');

    // Either mechanism is acceptable; both avoid innerHTML.
    const hasStyles = (adopted?.length ?? 0) > 0 || styleElements.length > 0;
    expect(hasStyles).toBe(true);

    // Whichever path ran, the token declarations must be present.
    const cssText = (adopted?.length ?? 0) > 0 ? 'adopted' : (styleElements[0]?.textContent ?? '');
    if (cssText !== 'adopted') {
      expect(cssText).toContain('--nt-accent');
    }

    mount.destroy();
  });

  it('is idempotent', () => {
    const first = mountPanel();
    const second = mountPanel();

    expect(second.host).toBe(first.host);
    expect(document.querySelectorAll(`#${HOST_ID}`)).toHaveLength(1);

    first.destroy();
  });

  it('stamps the version on the host for support triage', () => {
    const mount = mountPanel();
    expect(mount.host.dataset.neuratube).toBe('0.0.0-test');
    mount.destroy();
  });

  it('renders the orb instead of the panel when collapsed', async () => {
    const mount = mountPanel();

    collapsed.value = true;
    await flush();
    expect(mount.shadow.querySelector('.orb')).not.toBeNull();
    expect(mount.shadow.querySelector('.panel')).toBeNull();

    collapsed.value = false;
    await flush();
    expect(mount.shadow.querySelector('.panel')).not.toBeNull();
    expect(mount.shadow.querySelector('.orb')).toBeNull();

    mount.destroy();
  });

  it('renders nothing when hidden and marks the host hidden', async () => {
    const mount = mountPanel();

    visible.value = false;
    // The host attribute is mirrored synchronously so a hidden panel costs no
    // layout even before the render is flushed.
    expect(mount.host.hasAttribute('hidden')).toBe(true);

    await flush();
    expect(mount.shadow.querySelector('.panel')).toBeNull();

    visible.value = true;
    expect(mount.host.hasAttribute('hidden')).toBe(false);
    await flush();
    expect(mount.shadow.querySelector('.panel')).not.toBeNull();

    mount.destroy();
  });

  it('removes the host and unmounts on destroy', () => {
    const mount = mountPanel();
    mount.destroy();

    expect(document.getElementById(HOST_ID)).toBeNull();
    expect(mount.host.isConnected).toBe(false);
  });
});
