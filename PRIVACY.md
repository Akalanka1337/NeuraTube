# Privacy

This document is the source of truth for NeuraTube's data handling. It doubles as the
basis for the Chrome Web Store data-use disclosure, which the Limited Use policy
(enforced 2026-08-01) requires to be prominent, accurate, and proactively updated when
behaviour changes.

## Single purpose

NeuraTube helps a YouTube creator optimise their own videos' metadata. Every capability
must serve that purpose or it does not ship.

## What NeuraTube does today (v0.1.0, M1)

Nothing leaves your browser. There is no network code in this build at all — asserted by
an automated test that fails if the extension issues any request beyond the page you are
already viewing.

Stored locally in `chrome.storage.local`, never synced:

| Data                                              | Purpose                                           |
| ------------------------------------------------- | ------------------------------------------------- |
| Panel visibility and collapsed state, per surface | Remember your layout between visits               |
| Theme preference                                  | Match YouTube's dark/light mode, or your override |
| Debug logging flag                                | Verbose local console output when you opt in      |

## What NeuraTube will do (M2 onwards)

**Reading video data (M2).** NeuraTube reads the responses to requests YouTube Studio
already makes on your behalf, in your browser, for your own channel. It does not make
additional requests to YouTube to obtain them, and it does not send them anywhere. Parsed
metadata lives in memory for the lifetime of the page.

**AI provider calls (M3+).** When you ask for a suggestion, NeuraTube sends the relevant
video metadata — typically title, description, tags, duration, category and transcript
excerpts — to the AI provider **you** configured, authenticated with **your** API key.
Consequences you should understand before enabling it:

- That provider receives your video metadata and is governed by _their_ privacy policy and
  data-retention terms, not ours.
- The request goes directly from your browser to the provider. It does not pass through
  any server we operate.
- You choose the provider and the model. You can read and edit every prompt.
- NeuraTube will disclose this prominently before the first request, not only here.

**API keys.** Stored in `chrome.storage.local` only. Never `chrome.storage.sync`, which
replicates to Google's servers — this is enforced by a repo-wide lint rule, not just
convention. Keys are read from storage per request and never cached in a variable. They
are redacted from every log line and error message by `src/lib/redact.ts`, which is unit
tested against each provider's key format.

Honest limitation: `chrome.storage.local` is not encrypted at rest. Any process that can
read your Chrome profile directory can read your keys — this is equally true of every
BYO-key extension. An optional passphrase-based AES-GCM wrapper via `SubtleCrypto` is
planned but not shipped, and would still be decryptable in memory while in use. Use
provider keys scoped and rate-limited to what NeuraTube needs, and rotate them if your
machine is shared.

**NeuraTube Cloud (optional).** If you buy a licence, the extension additionally
talks to our API for keyword estimates, the prompt library, and managed inference. That
sends the video metadata relevant to your request plus your licence identifier. It is
entirely optional; the extension is fully functional without it. Details will be published
here before that code ships.

## What NeuraTube never does

- No analytics, telemetry, tracking pixels, or third-party SDKs of any kind.
- No collection of browsing history, watch history, or activity on non-YouTube sites.
- No account, no sign-up, no server contact in the open-source build.
- No selling, sharing, or transferring of user data to anyone.
- No use of your data to train models. We operate no models.
- No remote code. All logic is bundled; MV3 forbids otherwise and we do not want to.

## Permissions, and why each exists

| Permission                                                  | Why                                                       |
| ----------------------------------------------------------- | --------------------------------------------------------- |
| `storage`                                                   | Panel preferences; later, your API keys. Local area only. |
| `https://studio.youtube.com/*`, `https://www.youtube.com/*` | The pages the panel attaches to.                          |

Permissions are requested in the milestone that first needs them. `activeTab` and
`scripting` are not requested at all, because the content scripts are statically declared.
Provider hostnames are added in M3, when there is something to call.

## Data deletion

Everything is local. Removing the extension removes all of it. To clear it while keeping
the extension installed, use the reset control on the options page (M3), or clear the
extension's storage from `chrome://extensions`.

## Contact

Open an issue, or see [SECURITY.md](SECURITY.md) for anything sensitive.
