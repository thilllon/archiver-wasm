#!/usr/bin/env node
// PORTING.md 15.5: package.json is the one place a version is edited (by `changeset version`).
// This writes that version into the two crates, Cargo.lock and the snippets of PORTING.md.
// With --check it changes nothing and fails when any of them disagrees.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const check = process.argv.includes('--check');
const version = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version;
// No prerelease versions: release.yml publishes to the latest dist-tag only.
if (!/^\d+\.\d+\.\d+$/.test(version)) {
  console.error('sync-version: unexpected version ' + JSON.stringify(version));
  process.exit(1);
}
const CRATES = ['archiver-core', 'archiver-wasm'];

// [file, pattern, expected number of matches]; group 1 is kept, the version follows it
const targets = [
  ...CRATES.map((crate) => [`crates/${crate}/Cargo.toml`, new RegExp(`(\\[package\\]\\nname = "${crate}"\\nversion = ")[^"\\n]+`, 'g'), 1]),
  ...CRATES.map((crate) => ['Cargo.lock', new RegExp(`(\\[\\[package\\]\\]\\nname = "${crate}"\\nversion = ")[^"\\n]+`, 'g'), 1]),
  ...CRATES.map((crate) => ['PORTING.md', new RegExp(`(# crates/${crate}/Cargo\\.toml\\n\\[package\\]\\nname = "${crate}"\\nversion = ")[^"\\n]+`, 'g'), 1]),
  ['PORTING.md', /(  "name": "archiver-wasm",\n  "version": ")[^"\n]+/g, 1],
];

const texts = new Map();
const stale = [];
for (const [file, pattern, expected] of targets) {
  const before = texts.get(file) ?? fs.readFileSync(path.join(root, file), 'utf8');
  let matches = 0;
  const after = before.replace(pattern, (whole, kept) => {
    matches += 1;
    return kept + version;
  });
  if (matches !== expected) {
    console.error(`sync-version: ${file}: expected ${expected} match of ${pattern}, found ${matches}`);
    process.exit(1);
  }
  if (after !== before && !stale.includes(file)) { stale.push(file); }
  texts.set(file, after);
}

if (check) {
  if (stale.length > 0) {
    console.error(`sync-version: not at ${version}: ${stale.join(', ')} (run node scripts/sync-version.mjs)`);
    process.exit(1);
  }
  console.log(`sync-version: every copy is at ${version}`);
} else {
  for (const file of stale) { fs.writeFileSync(path.join(root, file), texts.get(file)); }
  console.log(`sync-version: ${version}` + (stale.length > 0 ? ` written to ${stale.join(', ')}` : ', nothing to change'));
}
