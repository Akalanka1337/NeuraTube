import type { JSX } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import type { VideoContext, CaptionTrackMeta } from '~/types/VideoContext';
import { transcript, recordTranscript } from '~/state/contextStore';
import {
  renderPlainTranscript,
  renderTimedTranscript,
  renderSrtTranscript,
  renderVttTranscript,
  transcriptWordCount,
  formatTimestamp,
} from '~/parsers/captions';
import { parseTimedTextResponse } from '~/parsers/timedText';
import { copyText } from '~/lib/clipboard';
import { downloadTextFile, sanitizeFilename } from '~/lib/download';
import { createLogger } from '~/lib/logger';

const log = createLogger('captions-card');

export function CaptionsCard({ video }: { readonly video: VideoContext }): JSX.Element {
  const tracks: readonly CaptionTrackMeta[] = video.captionTracks ?? [];
  const currentTranscript = transcript.value;

  const [selectedTrackIndex, setSelectedTrackIndex] = useState<number>(0);
  const [fetching, setFetching] = useState<boolean>(false);
  const [fetchError, setFetchError] = useState<string | null>(null);
  const [copiedFormat, setCopiedFormat] = useState<'plain' | 'timed' | 'srt' | null>(null);
  const [downloadedFormat, setDownloadedFormat] = useState<'srt' | 'vtt' | 'txt' | null>(null);

  const selectedTrack: CaptionTrackMeta | undefined = tracks[selectedTrackIndex];

  // Auto-fetch captions when a track is available and not yet loaded for this video
  useEffect(() => {
    const track = selectedTrack;
    if (!track) return;

    // If transcript is already populated for this video, don't re-fetch unless track language differs
    if (
      currentTranscript !== null &&
      currentTranscript.videoId === video.videoId &&
      currentTranscript.segments.length > 0 &&
      (currentTranscript.language === track.languageCode || tracks.length <= 1)
    ) {
      return;
    }

    let cancelled = false;

    async function load(trackToLoad: CaptionTrackMeta): Promise<void> {
      setFetching(true);
      setFetchError(null);
      try {
        const url = new URL(trackToLoad.baseUrl, 'https://www.youtube.com');
        url.searchParams.set('fmt', 'json3');
        if (video.videoId && !url.searchParams.has('v')) {
          url.searchParams.set('v', video.videoId);
        }

        const res = await fetch(url.toString());
        if (!res.ok) {
          throw new Error(`HTTP ${res.status}`);
        }
        const text = await res.text();
        if (cancelled) return;

        const result = parseTimedTextResponse(text, url.toString());
        if (result.transcript !== null) {
          recordTranscript(result.transcript);
          log.info('fetched captions track', {
            videoId: video.videoId,
            language: trackToLoad.languageCode,
            segments: result.transcript.segments.length,
          });
        } else {
          setFetchError(result.drift.missingFields[0] ?? 'No usable caption segments');
        }
      } catch (err) {
        if (!cancelled) {
          const message = err instanceof Error ? err.message : 'Failed to fetch captions';
          setFetchError(message);
          log.warn('captions fetch failed', err);
        }
      } finally {
        if (!cancelled) {
          setFetching(false);
        }
      }
    }

    void load(track);

    return () => {
      cancelled = true;
    };
  }, [video.videoId, selectedTrackIndex, selectedTrack]);

  const handleCopy = async (format: 'plain' | 'timed' | 'srt'): Promise<void> => {
    if (!currentTranscript) return;
    let text = '';
    if (format === 'plain') text = renderPlainTranscript(currentTranscript);
    else if (format === 'timed') text = renderTimedTranscript(currentTranscript);
    else if (format === 'srt') text = renderSrtTranscript(currentTranscript);

    const ok = await copyText(text);
    if (ok) {
      setCopiedFormat(format);
      setTimeout(() => {
        setCopiedFormat(null);
      }, 1600);
    }
  };

  const handleDownload = (format: 'srt' | 'vtt' | 'txt'): void => {
    if (!currentTranscript) return;
    const base = sanitizeFilename(video.title || video.videoId);
    const lang = selectedTrack?.languageCode ?? currentTranscript.language ?? 'en';

    let content = '';
    let filename = '';
    let mimeType = 'text/plain;charset=utf-8';

    if (format === 'srt') {
      content = renderSrtTranscript(currentTranscript);
      filename = `${base}.${lang}.srt`;
      mimeType = 'application/x-subrip;charset=utf-8';
    } else if (format === 'vtt') {
      content = renderVttTranscript(currentTranscript);
      filename = `${base}.${lang}.vtt`;
      mimeType = 'text/vtt;charset=utf-8';
    } else {
      content = renderPlainTranscript(currentTranscript);
      filename = `${base}.${lang}.txt`;
    }

    const ok = downloadTextFile(filename, content, mimeType);
    if (ok) {
      setDownloadedFormat(format);
      setTimeout(() => {
        setDownloadedFormat(null);
      }, 1600);
    }
  };

  const hasCaptions = currentTranscript !== null && currentTranscript.segments.length > 0;
  const wordCount = hasCaptions ? transcriptWordCount(currentTranscript) : 0;

  return (
    <div class="card captions-card">
      <div class="captions-card-header">
        <h2 class="card-title">
          Captions & Subtitles
          {tracks.length > 0 ? <span class="count">{tracks.length}</span> : null}
        </h2>

        {hasCaptions ? (
          <span class="pill caption-pill--ok" title={`${wordCount} words`}>
            {currentTranscript.segments.length} segments
          </span>
        ) : fetching ? (
          <span class="pill pill--muted">Fetching…</span>
        ) : tracks.length > 0 ? (
          <span class="pill caption-pill--warn">Not loaded</span>
        ) : null}
      </div>

      {tracks.length > 1 ? (
        <div class="caption-row">
          <label class="caption-label" htmlFor="caption-track-select">
            Language:
          </label>
          <select
            id="caption-track-select"
            class="caption-select"
            value={selectedTrackIndex}
            onChange={(e) => {
              const val = Number((e.target as HTMLSelectElement).value);
              setSelectedTrackIndex(val);
            }}
          >
            {tracks.map((t, idx) => (
              <option key={`${t.languageCode}-${idx}`} value={idx}>
                {t.name} {t.kind === 'asr' ? '(auto-generated)' : ''}
              </option>
            ))}
          </select>
        </div>
      ) : tracks.length === 1 && selectedTrack ? (
        <p class="note note--sm">
          Track: <strong>{selectedTrack.name}</strong>
          {selectedTrack.kind === 'asr' ? ' (auto-generated)' : ''}
        </p>
      ) : null}

      {fetchError ? (
        <div class="banner banner--warn">
          <p class="note note--sm">Failed to load captions: {fetchError}</p>
          {selectedTrack ? (
            <button
              type="button"
              class="ghost-btn"
              onClick={() => {
                // Force re-fetch
                setSelectedTrackIndex(selectedTrackIndex);
              }}
            >
              Retry
            </button>
          ) : null}
        </div>
      ) : null}

      {!hasCaptions && !fetching && tracks.length === 0 ? (
        <p class="note">No captions available for this video.</p>
      ) : null}

      {hasCaptions ? (
        <>
          <div class="caption-section">
            <span class="caption-section-title">Copy captions</span>
            <div class="caption-btn-group" role="group" aria-label="Copy captions">
              <button
                type="button"
                class="caption-btn"
                onClick={() => {
                  void handleCopy('plain');
                }}
                title="Copy continuous transcript text"
              >
                {copiedFormat === 'plain' ? 'Copied!' : 'Plain text'}
              </button>
              <button
                type="button"
                class="caption-btn"
                onClick={() => {
                  void handleCopy('timed');
                }}
                title="Copy transcript with timestamps [M:SS]"
              >
                {copiedFormat === 'timed' ? 'Copied!' : 'With timestamps'}
              </button>
              <button
                type="button"
                class="caption-btn"
                onClick={() => {
                  void handleCopy('srt');
                }}
                title="Copy formatted SubRip subtitles (.srt)"
              >
                {copiedFormat === 'srt' ? 'Copied!' : 'As SRT'}
              </button>
            </div>
          </div>

          <div class="caption-section">
            <span class="caption-section-title">Download subtitle file</span>
            <div class="caption-btn-group" role="group" aria-label="Download subtitle file">
              <button
                type="button"
                class="caption-btn ghost-btn"
                onClick={() => {
                  handleDownload('srt');
                }}
                title="Download standard SubRip subtitle file"
              >
                {downloadedFormat === 'srt' ? 'Downloaded!' : '.SRT file'}
              </button>
              <button
                type="button"
                class="caption-btn ghost-btn"
                onClick={() => {
                  handleDownload('vtt');
                }}
                title="Download WebVTT subtitle file"
              >
                {downloadedFormat === 'vtt' ? 'Downloaded!' : '.VTT file'}
              </button>
              <button
                type="button"
                class="caption-btn ghost-btn"
                onClick={() => {
                  handleDownload('txt');
                }}
                title="Download plain text file"
              >
                {downloadedFormat === 'txt' ? 'Downloaded!' : '.TXT file'}
              </button>
            </div>
          </div>

          <p class="note note--sm">
            Covers to {formatTimestamp(currentTranscript.coverageMs)} · {wordCount} words
          </p>
        </>
      ) : null}
    </div>
  );
}
