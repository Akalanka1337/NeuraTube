# Security

## Reporting a vulnerability

Please do **not** open a public issue for a security problem. Use GitHub's private
vulnerability reporting ("Report a vulnerability" on the Security tab). Include what you
did, what happened, and the extension version from the panel footer.

Expect an acknowledgement within 3 working days. Anything that can exfiltrate a user's API
key is treated as critical and takes priority over all feature work.

## Threat model

NeuraTube runs on a page controlled by someone else, holds credentials that cost real
money, and is open source. That combination defines the threats we actually design against.

### 1. The page is hostile

Every YouTube page — and any other extension operating in the MAIN world — can read and
interfere with anything in the MAIN world. Therefore:

- The MAIN-world interceptor holds **no** secrets and has **no** privileged capability. It
  classifies URLs and forwards response text. That is all it can do.
- Credentials live only in the service worker's reach, read from `chrome.storage.local` per
  call. They never enter a content script, and never a page.
- The interceptor's transport to the isolated world is authenticated with a per-session
  nonce and validated on `event.source`, `event.origin` and the nonce (M2). Without this,
  any page script could post a fake message and inject arbitrary text straight into an AI
  prompt — a prompt-injection channel on a Google property. The original design used an
  unauthenticated `postMessage(payload, '*')`; that was fixed before implementation.
- The panel lives in a shadow root, and its inherited CSS properties are pinned on
  elements inside that root. The page can neither restyle nor read the panel. Both
  directions are covered by an E2E test that serves a deliberately hostile stylesheet.

### 2. Credentials

- `chrome.storage.local` only. `chrome.storage.sync` is banned by lint because it
  replicates to Google's servers.
- Never cached in a module variable — partly for correctness after the user edits a key,
  partly because the service worker is terminated after 30 seconds idle anyway.
- Redacted from every log line and error message by `src/lib/redact.ts`, unit tested
  against each provider's key format, including bearer tokens and JWTs.
- Not encrypted at rest. See [PRIVACY.md](PRIVACY.md) for what that does and does not mean.

### 3. Code integrity

- No `eval`, no `new Function`, no inline scripts, no remotely hosted code. Enforced by
  the extension CSP and by lint.
- Remote _data_ (the Stage 2 prompt library) is JSON, parsed with `JSON.parse`, never
  executed. Chrome Web Store policy permits this explicitly and MV3 forbids the
  alternative.
- Dependencies are kept deliberately few. Every addition to `dependencies` is a supply
  chain risk in a project that handles API keys; prefer writing 200 lines.

### 4. Trusted Types

Measured behaviour under `require-trusted-types-for 'script'` (Chromium 151): string-HTML
sinks are blocked in the MAIN world and permitted in an isolated-world content script.
We treat the exemption as an implementation detail and ban the sinks everywhere. This is
load-bearing for the M2 interceptor, where the exemption does not apply.

### 5. Out of scope

- A compromised operating system or Chrome profile. If an attacker can read your profile
  directory, they have your keys, and no extension design prevents that.
- Malicious _other_ extensions with host access to YouTube. Chrome provides no isolation
  between extensions operating on the same page.
- The AI provider's own handling of data you send it under your own key.

## Stage 2 (NeuraTube Cloud)

The premium gate is a server boundary. Because this repository is public, a client-side
licence check is decorative — so no premium capability is implemented client-side. Licence
verification happens on every gated request. A forked build with the local check forced on
receives 401s, and there is an explicit test for that.
