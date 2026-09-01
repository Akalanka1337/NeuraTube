/**
 * https://github.com/Akalanka1337/NeuraTube
 * 
 * NeuraTube build pipeline.
 *
 * Chrome extensions have three incompatible output shapes and no single Vite
 * config can express all of them, so we drive Vite's programmatic API once per
 * shape:
 *
 *   1. Service worker  -> single-file ESM  (manifest declares type: "module")
 *   2. Content scripts -> single-file IIFE (no ESM, no code splitting, ever)
 *   3. Extension pages -> ordinary multi-asset HTML build
 *
 * Content scripts must be exactly one self-contained file: Chrome injects the
 * file directly, so a dynamic `import()` or a shared vendor chunk would resolve
 * against the *page's* origin (youtube.com) and fail. `inlineDynamicImports`
 * plus IIFE format guarantees a single file.
 *
 * Usage:
 *   node build/build.mjs            production build
 *   node build/build.mjs --watch    rebuild on change (load dist/ unpacked)
 *   node build/build.mjs --dev      development build, no watch
 */

import { build } from 'vite';
import { transform } from 'esbuild';
import preact from '@preact/preset-vite';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs/promises';
import { createManifest } from './manifest.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = path.join(ROOT, 'dist');
const SRC = path.join(ROOT, 'src');

const argv = process.argv.slice(2);
const WATCH = argv.includes('--watch');
const MODE = WATCH || argv.includes('--dev') ? 'development' : 'production';
const IS_DEV = MODE === 'development';

const pkg = JSON.parse(await fs.readFile(path.join(ROOT, 'package.json'), 'utf8'));

/** Browser baseline. Matches `minimum_chrome_version` in the manifest. */
const TARGET = 'chrome116';

/** Content scripts, one single-file IIFE bundle each. */
const CONTENT_SCRIPTS = [
  {
    entry: 'entrypoints/interceptor.content.ts',
    out: 'content/interceptor.js',
    name: 'NeuraTubeInterceptor',
  },
  { entry: 'entrypoints/panel.content.ts', out: 'content/panel.js', name: 'NeuraTubePanel' },
];

/** Shared config every sub-build inherits. */
function baseConfig() {
  return {
    root: ROOT,
    mode: MODE,
    configFile: false,
    logLevel: 'warn',
    plugins: [preact({ devToolsEnabled: false, prefreshEnabled: false })],
    resolve: {
      alias: { '~': SRC },
    },
    define: {
      __NEURATUBE_VERSION__: JSON.stringify(pkg.version),
      __DEV__: JSON.stringify(IS_DEV),
      // Preact and its ecosystem branch on this; without it the dev bundle
      // ships extra warnings into a page we do not control.
      'process.env.NODE_ENV': JSON.stringify(MODE),
    },
    esbuild: {
      target: TARGET,
      legalComments: 'none',
    },
  };
}

/**
 * @param {{ label: string, entry: string, outDir: string, fileName: string,
 *           format: 'es' | 'iife', name?: string }} options
 */
async function buildSingleFile({ label, entry, outDir, fileName, format, name }) {
  process.stdout.write(`  building ${label} ... `);
  const result = await build({
    ...baseConfig(),
    build: {
      target: TARGET,
      outDir,
      emptyOutDir: false,
      minify: IS_DEV ? false : 'esbuild',
      sourcemap: IS_DEV ? 'inline' : false,
      cssCodeSplit: false,
      reportCompressedSize: false,
      lib: {
        entry: path.join(SRC, entry),
        formats: [format],
        fileName: () => fileName,
        ...(name ? { name } : {}),
      },
      rollupOptions: {
        output: {
          // One file, no exception.
          inlineDynamicImports: true,
          // Extension bundles have no external dependencies at runtime.
          extend: false,
        },
      },
      watch: WATCH ? {} : null,
    },
  });
  // Vite skips esbuild minification for `es`-format library output, which is
  // the right default for a published package but wrong for a service worker
  // we ship as-is. Minify that one explicitly rather than shipping commented,
  // unminified source in the store bundle.
  if (!IS_DEV && format === 'es') {
    await minifyInPlace(path.join(outDir, fileName));
  }

  process.stdout.write('ok\n');
  return result;
}

/** Minify a built file in place, preserving ESM semantics. */
async function minifyInPlace(filePath) {
  const source = await fs.readFile(filePath, 'utf8');
  const { code } = await transform(source, {
    loader: 'js',
    format: 'esm',
    target: TARGET,
    minify: true,
    legalComments: 'none',
  });
  await fs.writeFile(filePath, code, 'utf8');
}

/** Extension pages: popup and the options page. */
async function buildPages() {
  process.stdout.write('  building pages (popup) ... ');
  const result = await build({
    ...baseConfig(),
    root: path.join(SRC, 'entrypoints'),
    // Relative asset URLs so the same output works from a chrome-extension://
    // origin regardless of how deep the page lives.
    base: './',
    build: {
      target: TARGET,
      outDir: DIST,
      emptyOutDir: false,
      minify: IS_DEV ? false : 'esbuild',
      sourcemap: IS_DEV ? 'inline' : false,
      reportCompressedSize: false,
      rollupOptions: {
        input: {
          popup: path.join(SRC, 'entrypoints/popup/index.html'),
          options: path.join(SRC, 'entrypoints/options/index.html'),
        },
        output: {
          entryFileNames: 'assets/[name]-[hash].js',
          chunkFileNames: 'assets/[name]-[hash].js',
          assetFileNames: 'assets/[name]-[hash][extname]',
        },
      },
      watch: WATCH ? {} : null,
    },
  });
  process.stdout.write('ok\n');
  return result;
}

async function copyStatic() {
  process.stdout.write('  copying public/ ... ');
  await fs.cp(path.join(ROOT, 'public'), DIST, { recursive: true });
  process.stdout.write('ok\n');
}

async function writeManifest() {
  process.stdout.write('  writing manifest.json ... ');
  const manifest = createManifest({ version: pkg.version, mode: MODE });
  await fs.writeFile(
    path.join(DIST, 'manifest.json'),
    JSON.stringify(manifest, null, 2) + '\n',
    'utf8',
  );
  process.stdout.write('ok\n');
}

async function main() {
  console.log(`\nNeuraTube v${pkg.version} — ${MODE} build${WATCH ? ' (watching)' : ''}\n`);

  await fs.rm(DIST, { recursive: true, force: true });
  await fs.mkdir(DIST, { recursive: true });

  await buildSingleFile({
    label: 'service worker',
    entry: 'entrypoints/background.ts',
    outDir: DIST,
    fileName: 'background.js',
    format: 'es',
  });

  for (const script of CONTENT_SCRIPTS) {
    await buildSingleFile({
      label: `content script (${path.basename(script.out)})`,
      entry: script.entry,
      outDir: DIST,
      fileName: script.out,
      format: 'iife',
      name: script.name,
    });
  }

  await buildPages();
  await copyStatic();
  await writeManifest();

  console.log(`\n  output: ${path.relative(process.cwd(), DIST)}`);
  if (WATCH) {
    console.log('  watching for changes — reload the extension in chrome://extensions\n');
  } else {
    console.log('  load unpacked: chrome://extensions -> Load unpacked -> select dist/\n');
  }
}

main().catch((error) => {
  console.error('\nbuild failed:\n', error);
  process.exitCode = 1;
});
