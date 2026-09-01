# Installing NeuraTube

## Which file do I need?

There are two kinds of archive in this project and they are **not** interchangeable.

| File                               | What it is                                                                                             | Can Chrome load it? |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------ | ------------------- |
| `neuratube-<version>-unpacked.zip` | The **built extension**. `manifest.json` sits at the root.                                             | **Yes**             |
| `neuratube-<milestone>.tar.gz`     | The **source repository**. No `manifest.json` at the root — it is generated into `dist/` by the build. | No                  |

If Chrome says **"Manifest file is missing or unreadable"**, you pointed it at the source
repository (or at a folder one level above the real one). You need the `-unpacked.zip`, or you
need to build the source first.

## Load the built extension

1. Unzip `neuratube-<version>-unpacked.zip`. You should get a folder containing
   `manifest.json`, `background.js`, `content/`, `options/`, `popup/`, `icons/`, `assets/`
   and `_locales/`.
2. Open `chrome://extensions`.
3. Turn on **Developer mode** (top right).
4. Click **Load unpacked**.
5. Select the folder **that directly contains `manifest.json`** — not its parent.

Two things that trip people up:

- Some unzip tools create a wrapper folder, so you end up with
  `neuratube-0.5.0-unpacked/neuratube-0.5.0-unpacked/manifest.json`. Select the **inner**
  folder.
- On macOS, do not select the `.zip` itself or a `__MACOSX` folder.

## Build from source instead

Requires Node 22+ and pnpm.

```bash
tar -xzf neuratube-<milestone>.tar.gz
cd neuratube
pnpm install
pnpm build          # writes dist/
```

Then **Load unpacked** and select the `dist/` folder.

To produce the distributable zip yourself:

```bash
pnpm zip            # writes artifacts/neuratube-<version>.zip
```

## First run

1. Click the NeuraTube icon, or open the extension's **Details → Extension options**.
2. Add an API key for at least one provider (OpenAI, Anthropic, DeepSeek or NVIDIA NIM).
3. Click **Load models**, then pick a model. **Tasks cannot run until a model is selected** —
   NeuraTube ships no default model because provider catalogues change faster than
   extension releases.
4. Click **Test connection** to confirm the key works. This calls the provider's `/models`
   endpoint, which is free — it does not spend tokens.
5. Optionally use **Try a task** on the same page to check the whole pipeline before going
   near Studio.

## Using it on YouTube

Open any video in YouTube Studio — for example
`https://studio.youtube.com/video/<VIDEO_ID>/edit`.

**Reload the page after installing.** Chrome does not inject content scripts into tabs that
were already open, and NeuraTube deliberately holds no `scripting` permission to force it.
If the panel does not appear, a reload is almost always the fix.

- `Alt`+`N` hides and shows the panel. Reassign it at `chrome://extensions/shortcuts`.
- `Esc` collapses it to an orb.
- Drag the header to move it; drag to a side edge to dock it. Arrow keys work too.
- Drag the bottom-right corner to resize.

## If something looks wrong

Open the panel's **diagnostics** view (the ⓘ button in the header). It shows the extension
version, first-paint time, whether Trusted Types are enforced, how many InnerTube exchanges
were intercepted, whether the payload matched the expected schema, and the raw parsed
`VideoContext`.

That last part matters: NeuraTube reads an **undocumented** API. If YouTube changes a field,
the panel says the schema drifted rather than showing you confidently wrong data. If you see
a drift warning, the diagnostics JSON is exactly what is needed to fix it.
