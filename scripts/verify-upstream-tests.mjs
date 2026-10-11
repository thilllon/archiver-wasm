#!/usr/bin/env node
// PORTING.md 14.5: fails if a vendored test file differs from tests/upstream/SHA256SUMS, from
// its source under .upstream/ (when that directory is present) or from its row of
// tests/upstream/LEDGER.tsv, if a file was added to or removed from a vendored tree, and if a
// shim differs from its text in PORTING.md 14.1.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const upstream = path.join(root, '.upstream');
const vendored = path.join(root, 'tests', 'upstream');

const trees = ['node-archiver/test', 'archiver-zip-encrypted/test'];
const licenses = {
  'LICENSE.node-archiver': 'node-archiver/LICENSE',
  'LICENSE.archiver-zip-encrypted': 'archiver-zip-encrypted/LICENSE',
};
// PORTING.md 14.1 (the hand-written shims; 14.6: none is smarter than a re-export)
const shims = {
  'alias-archiver.cjs': [
    "const Module = require('node:module');",
    "const path = require('node:path');",
    "const target = path.resolve(__dirname, '../../cjs/index.cjs');",
    'const resolveFilename = Module._resolveFilename;',
    'Module._resolveFilename = function (request, ...rest) {',
    "  return request === 'archiver' ? target : resolveFilename.call(this, request, ...rest);",
    '};',
  ],
  'node-archiver/package.json': ['{"type":"module"}'],
  'node-archiver/index.js': ['export * from "../../../dist/index.mjs";'],
  'archiver-zip-encrypted/package.json': ['{"type":"commonjs"}'],
  'archiver-zip-encrypted/index.js': ["module.exports = require('./lib/zip-encrypted');"],
  'archiver-zip-encrypted/lib/zip-encrypted.js': ["module.exports = require('../../../../cjs/index.cjs').ZipEncrypted;"],
  'archiver-zip-encrypted/lib/aes/aes-hmac-etm-stream.js': [
    '// The upstream test decrypts with aes-js and relies on the little-endian counter patch that',
    "// upstream's library applied globally when required (aes-hmac-etm-stream.js:16-25, N7).",
    "const aes = require('aes-js');",
    'aes.Counter.prototype.increment = function () {',
    '  for (var i = 0; i < 16; i++) {',
    '    if (this._counter[i] === 255) { this._counter[i] = 0; } else { this._counter[i]++; break; }',
    '  }',
    '};',
    "module.exports = require('../../../../../cjs/index.cjs').AesHmacEtmStream;",
  ],
  'archiver-zip-encrypted/lib/zip20/zip-crypto-stream.js': ["module.exports = require('../../../../../cjs/index.cjs').ZipCryptoStream;"],
  'archiver-zip-encrypted/lib/zip20/crypto-stream.js': ["module.exports = require('../../../../../cjs/index.cjs').CryptoStream;"],
  'archiver-zip-encrypted/lib/zip20/decrypto-stream.js': ["module.exports = require('../../../../../cjs/index.cjs').DecryptoStream;"],
};
// PORTING.md 14.5 (it() cases per spec file, in mocha's order; TESTS-001)
const counts = {
  'node-archiver/test/archiver.js': 24,
  'node-archiver/test/plugins.js': 16,
  'archiver-zip-encrypted/test/aes-hmac-etm-stream.js': 1,
  'archiver-zip-encrypted/test/as-stream.js': 1,
  'archiver-zip-encrypted/test/crypto-stream.js': 1,
  'archiver-zip-encrypted/test/zip-aes.js': 3,
  'archiver-zip-encrypted/test/zip-encrypted.js': 4,
  'archiver-zip-encrypted/test/zip20.js': 2,
};
// node-archiver/test/archiver.js:34-48, node-archiver/test/plugins.js:27-38 (links the suites
// create and remove; a crashed run leaves them behind, TESTS-012)
const transient = new Set([
  'node-archiver/test/fixtures/directory/subdir/level0link.txt',
  'node-archiver/test/fixtures/directory/subdir/subsublink',
]);

const problems = [];

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function isFile(file) {
  const stat = fs.lstatSync(file, { throwIfNoEntry: false });
  return stat !== undefined && stat.isFile();
}

function walk(base, rel, out) {
  const names = fs.readdirSync(path.join(base, rel)).sort();
  for (const name of names) {
    const child = rel + '/' + name;
    if (transient.has(child)) continue;
    if (fs.lstatSync(path.join(base, child)).isDirectory()) {
      walk(base, child, out);
    } else {
      out.push(child);
    }
  }
  return out;
}

function readRows(file) {
  return fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .filter((line) => line !== '');
}

const sums = new Map();
for (const line of readRows(path.join(vendored, 'SHA256SUMS'))) {
  const match = /^([0-9a-f]{64}) {2}(.+)$/.exec(line);
  if (match === null) {
    problems.push('SHA256SUMS: malformed line ' + JSON.stringify(line));
  } else if (sums.has(match[2])) {
    problems.push('SHA256SUMS: ' + match[2] + ' is listed twice');
  } else {
    sums.set(match[2], match[1]);
  }
}

const hasUpstream = fs.existsSync(upstream);

for (const [file, expected] of sums) {
  const inTree = trees.some((tree) => file.startsWith(tree + '/'));
  if (!inTree && !(file in licenses)) {
    problems.push('SHA256SUMS: ' + file + ' is not a vendored path');
    continue;
  }
  if (!isFile(path.join(vendored, file))) {
    problems.push('tests/upstream/' + file + ' is missing or is not a regular file');
    continue;
  }
  if (sha256(path.join(vendored, file)) !== expected) {
    problems.push('tests/upstream/' + file + ' differs from SHA256SUMS');
  }
  if (hasUpstream) {
    const source = path.join(upstream, inTree ? file : licenses[file]);
    if (!isFile(source)) {
      problems.push('.upstream/' + path.relative(upstream, source) + ' is missing');
    } else if (sha256(source) !== expected) {
      problems.push('SHA256SUMS: ' + file + ' differs from .upstream/' + path.relative(upstream, source));
    }
  }
}

for (const file of Object.keys(licenses)) {
  if (!sums.has(file)) {
    problems.push('SHA256SUMS: ' + file + ' is not listed');
  }
}

for (const tree of trees) {
  if (!fs.existsSync(path.join(vendored, tree))) {
    problems.push('tests/upstream/' + tree + ' is missing');
    continue;
  }
  for (const file of walk(vendored, tree, [])) {
    if (!sums.has(file)) {
      problems.push('tests/upstream/' + file + ' is not listed in SHA256SUMS');
    }
  }
  if (hasUpstream) {
    for (const file of walk(upstream, tree, [])) {
      if (!sums.has(file)) {
        problems.push('.upstream/' + file + ' is not vendored');
      }
    }
  }
}

for (const [file, lines] of Object.entries(shims)) {
  if (!isFile(path.join(vendored, file))) {
    problems.push('tests/upstream/' + file + ' is missing or is not a regular file');
  } else if (fs.readFileSync(path.join(vendored, file), 'utf8').replace(/\r\n/g, '\n') !== lines.join('\n') + '\n') {
    problems.push('tests/upstream/' + file + ' differs from its text in PORTING.md 14.1');
  }
}

const ledger = readRows(path.join(vendored, 'LEDGER.tsv'));
if (ledger[0] !== 'suite\tfile\tsha256\ttests') {
  problems.push('LEDGER.tsv: the first row must be the header suite, file, sha256, tests');
}
const listed = new Set();
for (const line of ledger.slice(1)) {
  const [suite, file, hash, tests] = line.split('\t');
  const key = suite + '/' + file;
  if (listed.has(key)) {
    problems.push('LEDGER.tsv: ' + key + ' is listed twice');
    continue;
  }
  listed.add(key);
  if (!(key in counts)) {
    problems.push('LEDGER.tsv: ' + key + ' is not an upstream spec file');
    continue;
  }
  if (tests !== String(counts[key])) {
    problems.push('LEDGER.tsv: ' + key + ' has ' + tests + ' tests, PORTING.md 14.5 has ' + counts[key]);
  }
  if (sums.get(key) !== hash) {
    problems.push('LEDGER.tsv: the sha256 of ' + key + ' differs from SHA256SUMS');
  }
  if (isFile(path.join(vendored, key))) {
    const source = fs.readFileSync(path.join(vendored, key), 'utf8');
    const cases = (source.match(/^\s*it\(/gm) || []).length;
    if (cases !== counts[key]) {
      problems.push('tests/upstream/' + key + ' has ' + cases + ' it( cases, expected ' + counts[key]);
    }
  }
}
for (const key of Object.keys(counts)) {
  if (!listed.has(key)) {
    problems.push('LEDGER.tsv: ' + key + ' is not listed');
  }
}

// Mocha's default spec is ./test/*.{js,cjs,mjs}, not recursive (PORTING.md 14.1).
for (const tree of trees) {
  if (!fs.existsSync(path.join(vendored, tree))) continue;
  for (const name of fs.readdirSync(path.join(vendored, tree)).sort()) {
    if (/\.(js|cjs|mjs)$/.test(name) && !listed.has(tree + '/' + name)) {
      problems.push('tests/upstream/' + tree + '/' + name + ' is a spec file without a LEDGER.tsv row');
    }
  }
}

if (problems.length > 0) {
  for (const problem of problems) {
    console.error('verify-upstream-tests: ' + problem);
  }
  process.exit(1);
}
console.log(
  'verify-upstream-tests: ' + sums.size + ' vendored files match SHA256SUMS' +
    (hasUpstream ? ' and .upstream/' : ' (.upstream/ is absent, not compared)'),
);
