import type { JSX } from 'preact';
import type { VideoContext } from '~/types/VideoContext';
import { hasExperimentData, publishedDate } from '~/types/VideoContext';

function formatDuration(seconds: number): string {
  if (seconds <= 0) return '—';
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  const pad = (n: number) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

/**
 * Format a publish date in the viewer's OWN timezone.
 *
 * NOT `toISOString().slice(0, 10)`, which is UTC. A date parsed from a local
 * midnight — which is what `Date.parse('Jul 15, 2026')` produces — renders as the
 * PREVIOUS day for every user east of UTC. Caught on a UTC+5:30 machine showing
 * a video published on the 15th as the 14th: a silent off-by-one that would have
 * looked like a parser bug and only affected some of the world.
 */
function formatDate(date: Date | null): string {
  if (!date) return '—';
  const pad2 = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
}

/** Compact view count: 1443 -> "1,443". */
function formatCount(value: number): string {
  return value.toLocaleString('en-US');
}

/**
 * The parsed video, as read from Studio's own traffic.
 *
 * Two things here are the product's whole argument: `suggestedHashtags` is
 * YouTube's own keyword recommender, which vidIQ charges for, and the A/B arm
 * watch-time split is data TubeBuddy's top tier gates. Both arrive free in the
 * same payload Studio already fetched.
 */
export function VideoCard({ video }: { readonly video: VideoContext }): JSX.Element {
  const flags: { label: string; tone: string }[] = [];
  if (video.madeForKids) flags.push({ label: 'Made for kids', tone: 'pill--warn' });
  if (video.paidPromotion) flags.push({ label: 'Paid promotion', tone: 'pill--warn' });
  if (video.alteredContent === 'yes') flags.push({ label: 'Altered content', tone: 'pill--warn' });
  if (video.ageRestricted) flags.push({ label: '18+', tone: 'pill--err' });
  if (video.copyright.activeClaimCount > 0) {
    flags.push({
      label: `${video.copyright.activeClaimCount} copyright claim${video.copyright.activeClaimCount === 1 ? '' : 's'}`,
      tone: video.copyright.hasImpact ? 'pill--err' : 'pill--warn',
    });
  }

  return (
    <>
      <div class="card">
        <h2 class="card-title">Video</h2>

        <p class="video-title">{video.title || <em>untitled</em>}</p>

        <dl class="rows">
          <dt>Duration</dt>
          <dd>{formatDuration(video.durationSec)}</dd>
          <dt>Published</dt>
          <dd>{formatDate(publishedDate(video))}</dd>
          <dt>Category</dt>
          <dd>{video.category}</dd>
          <dt>Visibility</dt>
          <dd>
            {video.privacy} · {video.status}
          </dd>
          <dt>Language</dt>
          <dd>{video.metadataLanguage ?? '—'}</dd>
          {/* Public pages only. Rendered when present rather than as a zero,
              because a Studio payload does not report them and "0 views" would
              be a claim we cannot make. */}
          {video.viewCount !== undefined && video.viewCount > 0 ? (
            <>
              <dt>Views</dt>
              <dd>{formatCount(video.viewCount)}</dd>
            </>
          ) : null}
          {video.channelTitle ? (
            <>
              <dt>Channel</dt>
              <dd>
                {video.channelTitle}
                {video.subscriberText ? ` · ${video.subscriberText}` : ''}
              </dd>
            </>
          ) : null}
        </dl>

        {flags.length > 0 ? (
          <div class="pill-row" role="list" aria-label="Content flags">
            {flags.map((flag) => (
              <span key={flag.label} class={`pill ${flag.tone}`} role="listitem">
                {flag.label}
              </span>
            ))}
          </div>
        ) : null}
      </div>

      <div class="card">
        <h2 class="card-title">
          Tags <span class="count">{video.tags.length}</span>
        </h2>
        {video.tags.length > 0 ? (
          <ul class="taglist" aria-label="Video tags">
            {video.tags.map((tag) => (
              <li key={tag}>{tag}</li>
            ))}
          </ul>
        ) : (
          <p class="note">No tags on this video.</p>
        )}
      </div>

      {video.suggestedHashtags.length > 0 ? (
        <div class="card">
          <h2 class="card-title">
            YouTube&apos;s suggested hashtags{' '}
            <span class="count">{video.suggestedHashtags.length}</span>
          </h2>
          <ul class="taglist taglist--accent" aria-label="Suggested hashtags">
            {video.suggestedHashtags.map((tag) => (
              <li key={tag}>{tag}</li>
            ))}
          </ul>
          <p class="note note--sm">
            First-party recommendations, already in the payload Studio fetched.
          </p>
        </div>
      ) : null}

      {hasExperimentData(video) ? (
        <div class="card">
          <h2 class="card-title">
            A/B test <span class="count">{video.abTest.state}</span>
          </h2>
          <ul class="arms" aria-label="A/B test arms">
            {video.abTest.arms.map((arm) => (
              <li key={arm.index}>
                <span class="arm-label">Arm {arm.index + 1}</span>
                <span class="arm-bar" aria-hidden="true">
                  <span
                    class="arm-fill"
                    style={`width: ${(arm.watchtimeFraction * 100).toFixed(1)}%`}
                  />
                </span>
                <span class="arm-value">{(arm.watchtimeFraction * 100).toFixed(1)}%</span>
              </li>
            ))}
          </ul>
          <p class="note note--sm">
            Share of watch time per arm.
            {video.abTest.result ? ` Result: ${video.abTest.result.replace('_', ' ')}.` : ''}
          </p>
        </div>
      ) : null}
    </>
  );
}
