#!/usr/bin/env node
// PORTING.md 14.5: fails if a vendored test file differs from tests/upstream/SHA256SUMS, from
// its hash at the pinned upstream commit (below), from its source under .upstream/ (when that
// directory is present) or from its row of tests/upstream/LEDGER.tsv, if a file was added to
// or removed from a vendored tree, and if a shim differs from its text in PORTING.md 14.1.
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
// scripts/fetch-upstream.sh (SHA-256 of every vendored file at node-archiver
// 52d1d349dfa2bf17956ecab56f477736688a9c5e and archiver-zip-encrypted
// 0be6b0e6cbc2c4fbd15342a4b1389862679d7668; .upstream/ is absent in CI, and SHA256SUMS is
// written by the same commit that could edit a vendored test)
const pinned = {
  'LICENSE.archiver-zip-encrypted': 'adb1eb7da86ec03af695b93cc0486cc4239d8863dead4ee7dd855727c2f0aded',
  'LICENSE.node-archiver': '9e23899170d96e708b24a2afce11e96d169c8cebf1bd24ac60b675a400cb1cf1',
  'archiver-zip-encrypted/test/aes-hmac-etm-stream.js': '478460075385e0e826d8b5b33264b4b016642956242034ef7f9bb1542ae612a3',
  'archiver-zip-encrypted/test/as-stream.js': '7324745a11f94682c5e8483e085663b0ed4577528dfecfc9f1e48a468fd2db47',
  'archiver-zip-encrypted/test/crypto-stream.js': 'c21eb8dc644ffebbbb4e046a052668ff133158e797605b44c7e4c765023cf1da',
  'archiver-zip-encrypted/test/resources/dir/sub/test.txt': 'a665a45920422f9d417e4867efdc4fb8a04a1f3fff1fa07e998e86f7f7a27ae3',
  'archiver-zip-encrypted/test/resources/empty-file.txt': 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
  'archiver-zip-encrypted/test/resources/test.txt': '813466902ecdae6b43b158879d91968bff0c877661c1d48345ba855f7336a60b',
  'archiver-zip-encrypted/test/zip-aes.js': '94ba0e66c6eebd77ee04c161a21dc60f11ca1a95c242fb8022681ab9e42d069a',
  'archiver-zip-encrypted/test/zip-encrypted.js': '2d0ca041bfa6ab616c92bd723f7bfa105f5f1ab7803181ce2d79cb96cb698be2',
  'archiver-zip-encrypted/test/zip20.js': '27dba6276aa8fd6ceb1c034145ec4e6133bb049c0111b2eacc00f185ff8804f1',
  'node-archiver/test/archiver.js': '13541e9cba4cf9ee90fd8511b3949ec01884df544e9a6747736f4f7d919ab871',
  'node-archiver/test/fixtures/directory/.dotfile': '6b2cf8741093450229512f00f1b33477e570fc504a46304287197d999bf879d0',
  'node-archiver/test/fixtures/directory/ignore.txt': 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
  'node-archiver/test/fixtures/directory/level0.txt': '1ef128f5e74f227d60fd632d3574fe72618dbebfeb35266d84ffe58f0ea4f171',
  'node-archiver/test/fixtures/directory/subdir/level1.txt': '5bce0fe268fa6b4b801fb1082f185b90000ab1258202c653f64b4f037d172336',
  'node-archiver/test/fixtures/directory/subdir/subsub/level2.txt': '9ea9b8889de45fa608597cb52b79749e2e32c97ef6481cfe6b315655933331f8',
  'node-archiver/test/fixtures/empty.txt': 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
  'node-archiver/test/fixtures/executable.sh': '3667bb6922c0f881f5357826a9130fcce94a7144915ea65dfa472e65ae3b2049',
  'node-archiver/test/fixtures/test.txt': 'dadc624d4454e10293dbd1b701b9ee9f99ef83b4cd07b695111d37eb95abcff8',
  'node-archiver/test/helpers/index.js': 'c9ad8d89a25f140931291c50e1bb93c8e01e03eb5060308ecbfbaef1fd766a44',
  'node-archiver/test/plugins.js': '065579681d9586e1dabf2fbb465c725c65888c70c12b1d51b443e33dfdc8c18d',
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
  'node-archiver/index.js': ['export * from "../../../esm/index.mjs";'],
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
  if (!Object.hasOwn(pinned, file)) {
    problems.push('SHA256SUMS: ' + file + ' is not a file of the pinned upstream commits');
  } else if (pinned[file] !== expected) {
    problems.push('SHA256SUMS: ' + file + ' differs from its hash at the pinned upstream commit');
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

for (const file of Object.keys(pinned)) {
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
  'verify-upstream-tests: ' + sums.size + ' vendored files match SHA256SUMS and the pinned upstream hashes' +
    (hasUpstream ? ' and .upstream/' : ' (.upstream/ is absent, not compared)'),
);
