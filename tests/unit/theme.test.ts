import { describe, expect, it } from 'vitest';
import { relativeLuminance, resolveTheme } from '~/panel/theme';

describe('relativeLuminance', () => {
  it('reports near-zero for black and near-one for white', () => {
    expect(relativeLuminance('rgb(0, 0, 0)')).toBeCloseTo(0, 3);
    expect(relativeLuminance('rgb(255, 255, 255)')).toBeCloseTo(1, 3);
  });

  it("classifies YouTube's dark backdrop as dark", () => {
    // #0f0f0f, YouTube's dark surface.
    expect(relativeLuminance('rgb(15, 15, 15)')!).toBeLessThan(0.45);
  });

  it('classifies a white page as light', () => {
    expect(relativeLuminance('rgb(255, 255, 255)')!).toBeGreaterThan(0.45);
  });

  it('parses both rgb and rgba, comma and space separated', () => {
    expect(relativeLuminance('rgba(15, 15, 15, 1)')).not.toBeNull();
    expect(relativeLuminance('rgb(15 15 15)')).not.toBeNull();
    expect(relativeLuminance('rgb(15 15 15 / 0.9)')).not.toBeNull();
  });

  it('returns null for effectively transparent colours so the caller can fall through', () => {
    expect(relativeLuminance('rgba(0, 0, 0, 0)')).toBeNull();
    expect(relativeLuminance('transparent')).toBeNull();
  });

  it('returns null rather than throwing on unparseable input', () => {
    for (const value of ['', 'inherit', '#0f0f0f', 'color(display-p3 0 0 0)']) {
      expect(relativeLuminance(value)).toBeNull();
    }
  });
});

describe('resolveTheme', () => {
  it('honours an explicit preference over page detection', () => {
    expect(resolveTheme('dark')).toBe('dark');
    expect(resolveTheme('light')).toBe('light');
  });

  it('falls back to detection for auto', () => {
    expect(['dark', 'light']).toContain(resolveTheme('auto'));
  });
});
