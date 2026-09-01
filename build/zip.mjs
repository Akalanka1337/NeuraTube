/**
 * https://github.com/Akalanka1337/NeuraTube
 * 
 * Produce a Chrome Web Store upload archive from dist/.
 *
 * Uses the system `zip` binary rather than a JS zip dependency: one fewer
 * package in a security-sensitive repo, and reproducible flags (`-X` strips
 * extra file attributes so two builds of identical bytes produce identical
 * archives, which matters for the CWS "reviewable build" expectation).
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const run = promisify(execFile);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = path.join(ROOT, 'dist');
const OUT_DIR = path.join(ROOT, 'artifacts');

async function main() {
  const pkg = JSON.parse(await fs.readFile(path.join(ROOT, 'package.json'), 'utf8'));

  try {
    await fs.access(path.join(DIST, 'manifest.json'));
  } catch {
    console.error('dist/manifest.json not found — run `pnpm build` first.');
    process.exitCode = 1;
    return;
  }

  await fs.mkdir(OUT_DIR, { recursive: true });
  // "-unpacked" is deliberate: this archive's ROOT contains manifest.json, so it
  // is what Chrome's "Load unpacked" needs after extraction. A source tarball
  // looks superficially similar and cannot be loaded, and that confusion has
  // already cost one round trip.
  const zipPath = path.join(OUT_DIR, `neuratube-${pkg.version}-unpacked.zip`);
  await fs.rm(zipPath, { force: true });

  try {
    await run('zip', ['-r', '-X', '-9', zipPath, '.'], { cwd: DIST });
  } catch (error) {
    console.error('`zip` is not available on this machine. Install it, or archive dist/ manually.');
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
    return;
  }

  const { size } = await fs.stat(zipPath);
  console.log(`\n  ${path.relative(process.cwd(), zipPath)}  (${(size / 1024).toFixed(1)} KB)`);
  console.log('  Extract it, then chrome://extensions -> Load unpacked -> select the folder');
  console.log('  containing manifest.json. See INSTALL.md.\n');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
