// scripts/verify-oracle-versions.mjs
// Fails unless the installed upstream packages have the versions of the oracle table (PORTING.md 14.2).
// Run before the differential tests and before scripts/capture-golden.mjs.
//
//   node scripts/verify-oracle-versions.mjs

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// [name, version, dependencies]: each package is located from the directory of the package that
// depends on it. The three rows of the table are the root, `archiver` 8.0.0 and
// `archiver-zip-encrypted` 2.0.0; below them the nesting follows the `dependencies` of each package.
// One package beyond the table: the crc32-stream that compress-commons 6.0.0 resolves (its own 5.0.1,
// not the 6.0.0 of the third row), which every entry of the archiver 7 stack passes through.
const ORACLE = [
  [
    'archiver',
    '8.0.0',
    [
      [
        'zip-stream',
        '7.0.5',
        [
          [
            'compress-commons',
            '7.0.1',
            [
              ['crc32-stream', '7.0.1', [['crc-32', '1.2.2', []]]],
              ['crc-32', '1.2.2', []],
              ['is-stream', '4.0.1', []],
              ['normalize-path', '3.0.0', []],
            ],
          ],
          ['normalize-path', '3.0.0', []],
        ],
      ],
      [
        'tar-stream',
        '3.2.2',
        [
          ['streamx', '2.28.1', []],
          ['b4a', '1.9.0', []],
        ],
      ],
      ['readdir-glob', '3.0.0', []],
      ['async', '3.2.6', []],
      ['buffer-crc32', '1.0.0', []],
      ['is-stream', '4.0.1', []],
      ['lazystream', '1.0.1', []],
      ['normalize-path', '3.0.0', []],
    ],
  ],
  [
    'archiver-zip-encrypted',
    '2.0.0',
    [
      [
        'archiver',
        '7.0.0',
        [
          ['zip-stream', '6.0.0', [['compress-commons', '6.0.0', [['crc32-stream', '5.0.1', []]]], ['archiver-utils', '5.0.1', []]]],
          ['archiver-utils', '5.0.1', []],
          ['buffer-crc32', '1.0.0', []],
        ],
      ],
      ['zip-stream', '6.0.0', [['compress-commons', '6.0.0', [['crc32-stream', '5.0.1', []]]], ['archiver-utils', '5.0.1', []]]],
      ['compress-commons', '6.0.0', [['crc32-stream', '5.0.1', []]]],
      ['crc32-stream', '6.0.0', []],
      ['archiver-utils', '5.0.1', []],
      ['aes-js', '3.1.2', []],
      ['buffer-crc32', '1.0.0', []],
    ],
  ],
];

// Node's resolution order: <dir>/node_modules/<name>, then the same in every parent directory
function locate(name, fromDirectory) {
  let directory = fromDirectory;
  for (;;) {
    if (path.basename(directory) !== 'node_modules') {
      const candidate = path.join(directory, 'node_modules', name);
      if (fs.existsSync(path.join(candidate, 'package.json'))) {
        return fs.realpathSync(candidate);
      }
    }
    const parent = path.dirname(directory);
    if (parent === directory) {
      return null;
    }
    directory = parent;
  }
}

function check(nodes, fromDirectory, fromLabel, rows) {
  for (const [name, expected, dependencies] of nodes) {
    const directory = locate(name, fromDirectory);
    const found =
      directory === null ? null : JSON.parse(fs.readFileSync(path.join(directory, 'package.json'), 'utf8')).version;
    rows.push({ name, expected, found, from: fromLabel, directory, ok: found === expected });
    if (directory !== null) {
      check(dependencies, directory, `${name} ${found}`, rows);
    }
  }
}

function verifyOracleVersions() {
  const rows = [];
  check(ORACLE, fs.realpathSync(ROOT), 'the repository root', rows);
  const wrong = rows.filter((row) => !row.ok);
  if (wrong.length > 0) {
    const lines = wrong.map(
      (row) =>
        `  ${row.name}: expected ${row.expected}, found ${row.found === null ? 'nothing' : row.found}` +
        ` (resolved from ${row.from}${row.directory === null ? '' : `, at ${path.relative(ROOT, row.directory)}`})`
    );
    throw new Error(`oracle versions differ from PORTING.md 14.2:\n${lines.join('\n')}`);
  }
  return rows;
}

try {
  const rows = verifyOracleVersions();
  console.log(`oracle versions ok: ${rows.length} packages checked`);
} catch (err) {
  console.error(err.message);
  process.exit(1);
}
