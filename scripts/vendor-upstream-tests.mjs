#!/usr/bin/env node
// PORTING.md 14.1: copies the two upstream test trees and the two upstream license files
// byte for byte from .upstream/ into tests/upstream/ and writes tests/upstream/SHA256SUMS.
// It writes nothing else: the shims and LEDGER.tsv are hand-written (14.1, 14.5).
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const upstream = path.join(root, '.upstream');
const vendored = path.join(root, 'tests', 'upstream');

// PORTMAP.tsv: 2 spec files, 1 helper and 8 fixtures; 6 spec files and 3 resources.
const trees = [
  { tree: 'node-archiver/test', files: 11 },
  { tree: 'archiver-zip-encrypted/test', files: 9 },
];
const licenses = [
  { from: 'node-archiver/LICENSE', to: 'LICENSE.node-archiver' },
  { from: 'archiver-zip-encrypted/LICENSE', to: 'LICENSE.archiver-zip-encrypted' },
];
// node-archiver/test/archiver.js:34-48, node-archiver/test/plugins.js:27-38 (links the suites
// create and remove; a crashed run leaves them behind, TESTS-012)
const transient = new Set([
  'node-archiver/test/fixtures/directory/subdir/level0link.txt',
  'node-archiver/test/fixtures/directory/subdir/subsublink',
]);

function fail(message) {
  console.error('vendor-upstream-tests: ' + message);
  process.exit(1);
}

function walk(base, rel, out) {
  const names = fs.readdirSync(path.join(base, rel)).sort();
  for (const name of names) {
    const child = rel + '/' + name;
    if (transient.has(child)) continue;
    const stat = fs.lstatSync(path.join(base, child));
    if (stat.isDirectory()) {
      walk(base, child, out);
    } else if (stat.isFile()) {
      out.push({ path: child, mode: stat.mode });
    } else {
      fail('.upstream/' + child + ' is neither a file nor a directory');
    }
  }
  return out;
}

function copy(from, to, mode) {
  const bytes = fs.readFileSync(from);
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.writeFileSync(to, bytes);
  fs.chmodSync(to, mode & 0o111 ? 0o755 : 0o644);
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

if (!fs.existsSync(upstream)) {
  fail('missing .upstream/ (run scripts/fetch-upstream.sh first)');
}

const sums = [];

for (const { tree, files } of trees) {
  const found = walk(upstream, tree, []);
  if (found.length !== files) {
    fail('.upstream/' + tree + ' has ' + found.length + ' files, expected ' + files);
  }
  fs.rmSync(path.join(vendored, tree), { recursive: true, force: true });
  for (const file of found) {
    const hash = copy(path.join(upstream, file.path), path.join(vendored, file.path), file.mode);
    sums.push({ path: file.path, hash });
  }
}

for (const { from, to } of licenses) {
  const hash = copy(path.join(upstream, from), path.join(vendored, to), 0o644);
  sums.push({ path: to, hash });
}

sums.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
fs.writeFileSync(
  path.join(vendored, 'SHA256SUMS'),
  sums.map((entry) => entry.hash + '  ' + entry.path + '\n').join(''),
);

console.log('vendor-upstream-tests: ' + sums.length + ' files written to tests/upstream/');
