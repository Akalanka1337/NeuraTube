import { createLogger } from './logger';

const log = createLogger('download');

/**
 * Sanitize a video title or string so it is safe to use as a filename across operating systems.
 * Removes forbidden characters: / \ ? % * : | " < > and collapses multiple spaces.
 */
export function sanitizeFilename(name: string): string {
  const sanitized = name
    .replace(/[/\\?%*:|"<>]/g, '_')
    .replace(/\s+/g, ' ')
    .trim();
  const withoutUnderscores = sanitized.replace(/^_+|_+$/g, '');
  if (withoutUnderscores.length === 0) return 'subtitles';
  return sanitized.length > 0 ? sanitized.slice(0, 120) : 'subtitles';
}

/**
 * Download text content as a file directly in the browser via an Object URL blob.
 * Does not require the chrome.downloads permission.
 */
export function downloadTextFile(
  filename: string,
  content: string,
  mimeType = 'text/plain;charset=utf-8',
): boolean {
  if (!content) return false;
  try {
    const blob = new Blob([content], { type: mimeType });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    link.style.display = 'none';
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => {
      URL.revokeObjectURL(url);
    }, 1500);
    log.info('download initiated', { filename, bytes: content.length });
    return true;
  } catch (error) {
    log.error('download failed', error);
    return false;
  }
}
