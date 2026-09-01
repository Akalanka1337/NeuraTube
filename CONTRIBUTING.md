# Contributing

**Developers are wanted here, and there is real work available.**

Start at the [Issues](https://github.com/Akalanka1337/neuratube/issues) tab — features and
enhancements worth building are filed there, and
[`good first issue`](https://github.com/Akalanka1337/neuratube/labels/good%20first%20issue)
marks the self-contained ones. Comment to claim something so two people do not build it
twice, then fork, branch, build and open a PR.

Got an idea that is not filed? Open an issue and describe it before you build — a
five-minute conversation beats an afternoon spent on something that does not fit.

Bug reports about broken parsers are as valuable as code. YouTube changes its internal
payloads without notice, and the person who notices first is always a user, not us.

## Setup

Node 22+ and pnpm.

```bash
pnpm install
pnpm dev        # watch build into dist/
```

Load `dist/` via `chrome://extensions` → Developer mode → **Load unpacked**.

## Commands

| Command        | What it does                                             |
| -------------- | -------------------------------------------------------- |
| `pnpm dev`     | Watch build                                              |
| `pnpm build`   | Production build into `dist/`                            |
| `pnpm compile` | Typecheck only, fast                                     |
| `pnpm test`    | 574 unit tests (vitest)                                  |
| `pnpm e2e`     | 164 Playwright tests against a mocked YouTube            |
| `pnpm verify`  | typecheck → lint → format → tests → build → size budgets |
| `pnpm zip`     | Build the loadable artifact into `artifacts/`            |

**Run `pnpm verify` and `pnpm e2e` before opening a PR.** `verify` is exactly what CI runs.

## Layout

```
build/                  Build scripts and the manifest generator
src/
  intercept/            MAIN world: XHR/fetch patches, page globals, route table
  parsers/              Pure functions from raw payloads to typed context
  panel/                Shadow-DOM UI (Preact + signals)
  state/                Signals, stores, surface detection
  orchestrator/         Task catalogue, prompt assembly, guardrails, streaming
  providers/            One adapter per provider behind a single interface
  prompts/              Every prompt, as editable markdown
  entrypoints/          Content scripts, service worker, options, popup
tests/
  unit/                 vitest
  e2e/                  Playwright, with a mock YouTube in mock-studio/
  fixtures/             Real captures, credentials stripped
```

## Conventions the codebase holds to

These are not style preferences. Each one exists because breaking it caused a real bug.

- **TypeScript strict.** No `any` without a comment justifying it.
- **No `innerHTML`, `outerHTML` or `insertAdjacentHTML`.** YouTube enforces Trusted Types;
  a string-to-HTML assignment throws on a real Studio page. ESLint blocks these.
- **Never `chrome.storage.sync`.** API keys must not be uploaded to a Google account.
  ESLint blocks it.
- **No `eval`, no inline scripts, no remote code.** Manifest V3 policy.
- **Parsers never throw.** They return a result plus a drift report. A parser that throws
  inside the receiver's message loop stops every later capture being processed.
- **Absences are not facts.** A public page cannot see `madeForKids`, so `false` there means
  "unknown". That is why `VideoContext.source` exists, and why guardrails only run on Studio
  surfaces.
- **Comments explain _why_, not _what_.** If a line looks odd, the comment should say what
  broke without it.

## Adding a task

1. Add the type to `TaskType` and an entry to `TASKS` in `src/orchestrator/tasks.ts`
   (label, description, temperature, max tokens, surfaces).
2. Write `src/prompts/<task>.md`. It **must** include a section telling the model to treat
   supplied metadata as data — a test asserts every prompt does.
3. Import it in `src/orchestrator/promptStore.ts`.
4. If the output is a list of copyable items, add it to `LIST_TASKS` in
   `src/panel/TaskView.tsx`.
5. If it benefits from the transcript or the page's comments, add it to `TRANSCRIPT_TASKS`
   or `COMMENT_TASKS` in `src/state/taskStore.ts`.

The task-count assertions derive from the catalogue, so nothing needs renumbering.

## Adding a provider

1. Add the id to `PROVIDER_IDS` and a spec to `src/providers/specs.ts`.
2. If it speaks the OpenAI wire format, it works through the existing adapter. If not, write
   one implementing `LLMProvider`.
3. Add its origin to `PROVIDER_ORIGINS` — a unit test asserts the manifest's
   `host_permissions` and this list agree, because a missing origin fails at runtime with an
   opaque network error.
4. Add pricing to `src/providers/pricing.ts`, or leave it out and the meter will honestly
   say "cost unknown".

## Reporting a broken parser

When a payload shape changes, the panel prints a diagnosis line naming the endpoint, the
byte count and the field that moved. Paste that line into the issue — it is usually enough
to fix the problem in one pass.

**Redact your session before pasting anything.** YouTube's requests carry live credentials.
Never include:

- `eats`
- `sessionInfo.token`
- `clientScreenNonce`
- `onBehalfOfUser`
- your channel id or `serializedDelegationContext`

The fixtures in `tests/fixtures/` are real captures with all of that removed — follow the
same pattern if you add one.

## Pull requests

- One concern per PR.
- Add a test that fails before your change and passes after. If the bug was only reachable
  end to end, add the E2E test rather than a unit test that approximates it.
- Update `CHANGELOG.md`.
- If you changed behaviour a user can see, update `README.md` in the same PR.

## License

By contributing you agree your contribution is licensed under the [MIT License](LICENSE).
