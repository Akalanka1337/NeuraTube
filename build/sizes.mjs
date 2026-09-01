/**
 * Bundle budget gate.
 *
 * The non-functional requirements commit to "total unpacked < 2MB" and a
 * sub-80ms panel first paint. First paint is dominated by how much JavaScript
 * the content script has to parse before it can attach a shadow root, so the
 * content-script budget is the one that actually protects the paint target.
 *
 * Run in CI. A budget breach fails the build rather than quietly regressing.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = path.join(ROOT, 'dist');

/** Budgets in bytes. Tightened deliberately — raise only with a reason. */
const BUDGETS = [
  { label: 'total unpacked', match: () => true, max: 2 * 1024 * 1024, metric: 'raw' },
  {
    label: 'content/panel.js (gzip)',
    match: (f) => f === 'content/panel.js',
    max: 60 * 1024,
    metric: 'gzip',
  },
  {
    // Runs at document_start in the page's own heap, ahead of YouTube's bundle.
    // Every byte here delays YouTube's own startup, so this is the tightest
    // budget in the project by an order of magnitude.
    label: 'content/interceptor.js (gzip)',
    match: (f) => f === 'content/interceptor.js',
    max: 6 * 1024,
    metric: 'gzip',
  },
  {
    label: 'background.js (gzip)',
    match: (f) => f === 'background.js',
    max: 200 * 1024,
    metric: 'gzip',
  },
];

/** @returns {Promise<Array<{ file: string, raw: number, gzip: number }>>} */
async function collect(dir, base = '') {
  /** @type {Array<{ file: string, raw: number, gzip: number }>} */
  const out = [];
  const entries = await fs.readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const abs = path.join(dir, entry.name);
    const rel = base ? `${base}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      out.push(...(await collect(abs, rel)));
    } else {
      const buf = await fs.readFile(abs);
      out.push({
        file: rel,
        raw: buf.byteLength,
        gzip: zlib.gzipSync(buf, { level: 9 }).byteLength,
      });
    }
  }
  return out;
}

const kb = (n) => `${(n / 1024).toFixed(1)} KB`;

async function main() {
  try {
    await fs.access(DIST);
  } catch {
    console.error('dist/ not found — run `pnpm build` first.');
    process.exitCode = 1;
    return;
  }

  const files = (await collect(DIST)).sort((a, b) => b.raw - a.raw);
  const totalRaw = files.reduce((sum, f) => sum + f.raw, 0);
  const totalGzip = files.reduce((sum, f) => sum + f.gzip, 0);

  console.log('\nBundle report\n');
  console.log(`  ${'file'.padEnd(44)} ${'raw'.padStart(10)} ${'gzip'.padStart(10)}`);
  console.log(`  ${'-'.repeat(44)} ${'-'.repeat(10)} ${'-'.repeat(10)}`);
  for (const f of files) {
    console.log(`  ${f.file.padEnd(44)} ${kb(f.raw).padStart(10)} ${kb(f.gzip).padStart(10)}`);
  }
  console.log(`  ${'-'.repeat(44)} ${'-'.repeat(10)} ${'-'.repeat(10)}`);
  console.log(
    `  ${`${files.length} files`.padEnd(44)} ${kb(totalRaw).padStart(10)} ${kb(totalGzip).padStart(10)}`,
  );

  console.log('\nBudgets\n');
  let failed = false;
  for (const budget of BUDGETS) {
    const matched = files.filter((f) => budget.match(f.file));
    const actual = matched.reduce((sum, f) => sum + f[budget.metric], 0);
    const ok = actual <= budget.max;
    if (!ok) failed = true;
    const pct = ((actual / budget.max) * 100).toFixed(0);
    console.log(
      `  ${ok ? 'PASS' : 'FAIL'}  ${budget.label.padEnd(30)} ${kb(actual).padStart(10)} / ${kb(budget.max).padStart(10)}  (${pct}%)`,
    );
  }
  console.log('');

  if (failed) {
    console.error('Bundle budget exceeded.\n');
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
