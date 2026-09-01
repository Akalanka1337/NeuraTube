# Changelog

All notable changes to NeuraTube are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions
follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.11.1] — 2026-08-31

**Initial public release.**

Versions before this one were private development builds and were never published, which is
why the first release is not `0.1.0`.

### Studio tasks

- **Title optimizer** — five distinct titles, each individually copyable, each with a
  one-line rationale and a character count measured against the width YouTube actually
  displays.
- **Description structurizer** — first two lines carry the search weight, structure below
  the fold.
- **Tag generator** — a tag set inside YouTube's 500-character ceiling, copyable as one
  comma-separated block.
- **Chapters** — timestamps read from YouTube's own caption timings. Refuses to run without
  them rather than estimating.
- **Hook writer** — opening lines for the first fifteen seconds.
- **Thumbnail text** — short overlay text that survives being shrunk to a sidebar thumbnail.
- **A/B title variants** — variants that differ on one axis, so a test result means
  something.
- **Translate metadata** — title, description and tags localised to chosen locales.

### Public watch page and Shorts tasks

- **Comment generator** — five comments a real viewer would leave, drawn from the transcript
  and the comments already on the page, each copyable on its own.
- **Comment insights** — what the audience asked for that the video did not answer, ranked
  by like count.
- **Steal this video** — what a competitor promises, why it works, how to beat it.
- **Content gaps** — ranked gaps a channel has the authority to claim.
- **Better video ideas** — stronger angles on this video, grounded in competitor context.

### Data sources

- Reads canonical video metadata by intercepting YouTube's own InnerTube responses rather
  than scraping the rendered page.
- Reads a public video's **tags** and **untruncated description** from YouTube's player
  payload — neither is rendered anywhere in the DOM.
- Reads caption transcripts with real timings from Studio's caption endpoints and from the
  public `timedtext` track, so chapters work on videos you do not own.
- Caches transcripts per video in `chrome.storage.session`, so a transcript captured on one
  Studio page is available on another.
- Supported surfaces: Studio video details, Studio analytics, Studio channel, `/watch`,
  `/shorts/` and search results.

### Providers

- OpenAI, Anthropic, DeepSeek and NVIDIA NIM behind one streaming interface.
- Models discovered live from each provider's `/models` endpoint — no hardcoded model IDs.
- Per-task routing with automatic fallback when a provider fails or is rate limited.
- Cost meter reporting tokens in, tokens out and cost per run. Reports "cost unknown" for a
  model it has no price for rather than inventing a figure.
- Handles `reasoning_content` / `reasoning` deltas from reasoning models and Anthropic
  `thinking_delta`, so a model that thinks before answering is reported accurately instead
  of appearing to return nothing.

### Panel

- Shadow-DOM panel, draggable and resizable, with position and visibility remembered per
  surface.
- <kbd>Alt</kbd>+<kbd>N</kbd> to show or hide, <kbd>Esc</kbd> to collapse to an orb.
- Follows client-side navigation, and discards the previous video's results when the video
  changes.
- Per-item copy for list results, so one of five titles can be taken without selecting text.
- Studio compliance guardrails: made-for-kids, paid promotion, age restriction and
  altered-content flags become hard constraints on the request.
- Per-task transcript switch where a transcript is optional.
- Diagnoses an empty result specifically — reasoning budget exhausted, response truncated,
  or provider returned nothing — and offers a one-click token-limit raise with retry.
- Warns when a response was cut off mid-answer.
- Theme follows YouTube's, with WCAG 2.1 AA contrast in both.

### Options

- Provider keys, model selection and a connection test per provider.
- Editable prompts, with a warning when an edit was written against an older shipped
  default.
- Per-task routing.
- Usage and cost history, with optional per-model price overrides.
- Advanced: per-task token ceiling and temperature, with a preset sized for reasoning
  models.
- About: version, links, and toggles for the diagnostics panel and verbose logging.
- Privacy and data controls, including clearing everything the extension has stored.

### Privacy

- API keys are stored in `chrome.storage.local` only — never `chrome.storage.sync`, so they
  are not uploaded to a Google account. They are never logged and are redacted in
  diagnostics.
- Requests go from the browser directly to the chosen provider. No intermediary server.
- Session credentials present in intercepted YouTube traffic (`eats`, `sessionInfo.token`,
  `clientScreenNonce`, `onBehalfOfUser`) are never read, and tests assert they cannot reach
  a log, a prompt or storage.
- No telemetry, no analytics, no account.

### Known limitations

- Not on the Chrome Web Store; install by loading the unpacked build.
- Depends on YouTube's undocumented internal endpoints, which can change without notice.
  When a payload shape changes, the panel reports a specific diagnosis rather than showing
  incorrect data — please open an issue with that line.
- Chapters require a caption track. On a video you own with no captions, open Studio's
  subtitles editor once so the timings can be captured.
- Comment reading sees the comments currently loaded on the page, not every comment, and
  says so in the prompt.
- The premium client is not included in this release. The extension does not contact any
  NeuraTube service, and every task listed above works with your own API key.

[0.11.1]: https://github.com/Akalanka1337/neuratube/releases/tag/v0.11.1
