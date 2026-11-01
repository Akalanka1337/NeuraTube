import { describe, expect, it, vi } from 'vitest';
import { downloadTextFile, sanitizeFilename } from '~/lib/download';

describe('sanitizeFilename', () => {
  it('strips illegal characters from filenames', () => {
    expect(sanitizeFilename('How to code: C++ / Python? <Awesome> *Tutorial* | 2026')).toBe(
      'How to code_ C++ _ Python_ _Awesome_ _Tutorial_ _ 2026',
    );
  });

  it('collapses multiple whitespace characters', () => {
    expect(sanitizeFilename('Video    Title   Here')).toBe('Video Title Here');
  });

  it('falls back to "subtitles" when input is empty or only invalid characters', () => {
    expect(sanitizeFilename('')).toBe('subtitles');
    expect(sanitizeFilename('   ')).toBe('subtitles');
    expect(sanitizeFilename('???///:::***')).toBe('subtitles');
  });

  it('truncates excessively long titles to 120 characters', () => {
    const long = 'a'.repeat(200);
    expect(sanitizeFilename(long)).toHaveLength(120);
  });
});

describe('downloadTextFile', () => {
  it('returns false for empty content', () => {
    expect(downloadTextFile('test.srt', '')).toBe(false);
  });

  it('creates an ObjectURL and triggers anchor click in DOM', () => {
    const createObjectURLMock = vi.fn().mockReturnValue('blob:test-url');
    const revokeObjectURLMock = vi.fn();
    globalThis.URL.createObjectURL = createObjectURLMock;
    globalThis.URL.revokeObjectURL = revokeObjectURLMock;

    const clickMock = vi.fn();
    // eslint-disable-next-line @typescript-eslint/no-deprecated
    const originalCreateElement = document.createElement.bind(document);
    vi.spyOn(document, 'createElement').mockImplementation((tag: string) => {
      const el = originalCreateElement(tag);
      if (tag === 'a') {
        el.click = clickMock;
      }
      return el;
    });

    const result = downloadTextFile('test.srt', '1\n00:00:00,000 --> 00:00:01,000\nHello');
    expect(result).toBe(true);
    expect(createObjectURLMock).toHaveBeenCalled();
    expect(clickMock).toHaveBeenCalled();
  });
});
