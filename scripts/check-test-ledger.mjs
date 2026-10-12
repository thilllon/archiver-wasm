#!/usr/bin/env node
// PORTING.md 14.5: runs both upstream suites with mocha's json reporter and fails unless
// every spec file of tests/upstream/LEDGER.tsv ran its exact number of tests with none
// pending and none failing; then fails unless `cargo test -- --list` prints every test named
// in crates/archiver-core/tests/LEDGER.tsv for the test binary of the file its row names, and
// `--list --ignored` prints none of them.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const vendored = path.join(root, 'tests', 'upstream');
const mocha = createRequire(import.meta.url).resolve('mocha/bin/mocha.js');

// PORTING.md 14.1 (the arguments of the npm scripts test:upstream:archiver and
// test:upstream:encrypted, with the reporter replaced and without the lookup of a .mocharc in
// a directory above the checkout) and 14.5 (the totals)
const suites = [
  { suite: 'node-archiver', args: ['--no-config'], total: 40 },
  { suite: 'archiver-zip-encrypted', args: ['--no-config', '--require', '../alias-archiver.cjs'], total: 12 },
];
// node-archiver/test/archiver.js:34-48, node-archiver/test/plugins.js:27-38 (TESTS-012: the
// npm script removes the links a crashed run left behind before it starts mocha)
const transient = [
  'node-archiver/test/fixtures/directory/subdir/level0link.txt',
  'node-archiver/test/fixtures/directory/subdir/subsublink',
];
// node-archiver/test/plugins.js:123-125 (the one upstream-conditional skip, win32 only)
const pendingAllowed = process.platform === 'win32' ? { 'node-archiver/test/plugins.js': 1 } : {};

const problems = [];

function readRows(file) {
  return fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .filter((line) => line !== '');
}

function countByFile(list, suiteDir) {
  const counts = new Map();
  for (const item of list) {
    const key = item.file === undefined ? '(no file)' : path.relative(suiteDir, fs.realpathSync(item.file)).split(path.sep).join('/');
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  return counts;
}

const ledger = new Map(suites.map(({ suite }) => [suite, new Map()]));
const ledgerRows = readRows(path.join(vendored, 'LEDGER.tsv'));
if (ledgerRows[0] !== 'suite\tfile\tsha256\ttests') {
  problems.push('tests/upstream/LEDGER.tsv: the first row must be the header suite, file, sha256, tests');
}
for (const line of ledgerRows.slice(1)) {
  const [suite, file, , tests] = line.split('\t');
  if (!ledger.has(suite) || !/^[0-9]+$/.test(tests)) {
    problems.push('tests/upstream/LEDGER.tsv: malformed row ' + JSON.stringify(line));
    continue;
  }
  ledger.get(suite).set(file, Number(tests));
}

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'archiver-wasm-test-ledger-'));

function runSuite({ suite, args, total }) {
  const suiteDir = fs.realpathSync(path.join(vendored, suite));
  const expected = ledger.get(suite);
  const sum = [...expected.values()].reduce((a, b) => a + b, 0);
  if (sum !== total) {
    problems.push('tests/upstream/LEDGER.tsv: ' + suite + ' sums to ' + sum + ' tests, expected ' + total);
  }

  for (const link of transient) {
    if (link.startsWith(suite + '/')) {
      fs.rmSync(path.join(vendored, link), { force: true });
    }
  }
  const output = path.join(scratch, suite + '.json');
  const run = spawnSync(
    process.execPath,
    [mocha, ...args, '--reporter', 'json', '--reporter-option', 'output=' + output],
    { cwd: suiteDir, stdio: ['ignore', 'inherit', 'inherit'] },
  );
  if (!fs.existsSync(output)) {
    problems.push(suite + ': mocha wrote no report (exit status ' + run.status + ', signal ' + run.signal + ')');
    return;
  }
  let report;
  try {
    report = JSON.parse(fs.readFileSync(output, 'utf8'));
  } catch {
    problems.push(suite + ': mocha wrote an unreadable report (exit status ' + run.status + ', signal ' + run.signal + ')');
    return;
  }

  const tests = countByFile(report.tests, suiteDir);
  const passes = countByFile(report.passes, suiteDir);
  const pending = countByFile(report.pending, suiteDir);
  const failures = countByFile(report.failures, suiteDir);

  for (const [file, count] of expected) {
    const allowed = pendingAllowed[suite + '/' + file] || 0;
    const got = {
      tests: tests.get(file) || 0,
      passes: passes.get(file) || 0,
      pending: pending.get(file) || 0,
      failures: failures.get(file) || 0,
    };
    if (got.tests !== count || got.passes !== count - allowed || got.pending !== allowed || got.failures !== 0) {
      problems.push(
        suite + '/' + file + ': ' + got.tests + ' tests, ' + got.passes + ' passing, ' + got.pending +
          ' pending, ' + got.failures + ' failing; the ledger requires ' + count + ' tests, ' +
          (count - allowed) + ' passing, ' + allowed + ' pending, 0 failing',
      );
    }
  }
  for (const counts of [tests, failures]) {
    for (const [file, count] of counts) {
      if (!expected.has(file)) {
        problems.push(suite + ': ' + count + ' tests or failures in ' + file + ', which has no ledger row');
      }
    }
  }

  const allowedTotal = [...expected.keys()].reduce((a, file) => a + (pendingAllowed[suite + '/' + file] || 0), 0);
  const stats = report.stats;
  if (stats.tests !== total || stats.passes !== total - allowedTotal || stats.pending !== allowedTotal || stats.failures !== 0) {
    problems.push(
      suite + ': ' + stats.tests + ' tests, ' + stats.passes + ' passing, ' + stats.pending + ' pending, ' +
        stats.failures + ' failing; expected ' + total + ' tests, ' + (total - allowedTotal) + ' passing, ' +
        allowedTotal + ' pending, 0 failing',
    );
  }
  if (run.status !== 0) {
    problems.push(suite + ': mocha exited with status ' + run.status + ' (signal ' + run.signal + ')');
  }
}

try {
  for (const entry of suites) {
    runSuite(entry);
  }
} finally {
  fs.rmSync(scratch, { recursive: true, force: true });
}

// PORTING.md 14.3, 14.5: one required cargo test per row, as `cargo test -- --list` prints it
// for the test binary of the file in the second column (the library's unit tests for
// crates/<package>/src/**, the integration test for crates/<package>/tests/<name>.rs).
const cargoLedger = 'crates/archiver-core/tests/LEDGER.tsv';
const cargoRows = readRows(path.join(root, cargoLedger));
if (cargoRows[0] !== 'test\tfile') {
  problems.push(cargoLedger + ': the first row must be the header test, file');
}
const required = [];
const targets = new Map();
for (const line of cargoRows.slice(1)) {
  const [name, file] = line.split('\t');
  const match = /^crates\/([^/]+)\/(?:src\/.+|tests\/([^/]+))\.rs$/.exec(file || '');
  if (name === '' || match === null) {
    problems.push(cargoLedger + ': malformed row ' + JSON.stringify(line));
    continue;
  }
  const target = match[2] === undefined ? ['-p', match[1], '--lib'] : ['-p', match[1], '--test', match[2]];
  const key = target.join(' ');
  if (!targets.has(key)) {
    targets.set(key, { target, names: [] });
  }
  targets.get(key).names.push(name);
  required.push(name);
}
if (required.length === 0) {
  problems.push(cargoLedger + ' lists no test');
}

function listTests(target, flags) {
  const command = ['test', ...target, '--', ...flags];
  const cargo = spawnSync('cargo', command, {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  if (cargo.status !== 0) {
    problems.push('cargo ' + command.join(' ') + ' failed (exit status ' + cargo.status + ', signal ' + cargo.signal + ')');
    return null;
  }
  const names = new Set();
  for (const line of cargo.stdout.split('\n')) {
    const match = /^(.+): test$/.exec(line.trimEnd());
    if (match !== null) {
      names.add(match[1]);
    }
  }
  return names;
}

for (const [key, { target, names }] of targets) {
  const present = listTests(target, ['--list']);
  const ignored = present === null ? null : listTests(target, ['--list', '--ignored']);
  if (present === null || ignored === null) continue;
  for (const name of names) {
    if (!present.has(name)) {
      problems.push('cargo test ' + key + ' -- --list does not print ' + name);
    } else if (ignored.has(name)) {
      problems.push('cargo test ' + key + ': ' + name + ' is #[ignore]d');
    }
  }
}

if (problems.length > 0) {
  for (const problem of problems) {
    console.error('check-test-ledger: ' + problem);
  }
  process.exit(1);
}
console.log(
  'check-test-ledger: ' + suites.map(({ suite, total }) => suite + ' ' + total).join(', ') +
    ' upstream tests and ' + required.length + ' required cargo tests are present',
);
