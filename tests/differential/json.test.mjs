// tests/differential/json.test.mjs
// Differential cases J1 to J3 of PORTING.md 14.2: the json format of the upstream oracle and of ykk.
// The scenarios are exported so that a child process can run them; the fs-backed ones take the fixture
// tree of makeTree() as ctx.args.root.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';

import { selectEvents, sortEvents } from './helpers/events.mjs';
import { runBoth } from './helpers/run-both.mjs';

const DATE = new Date('2013-01-03T14:26:38.000Z');
// PORTING.md 14.2 (comparison rules, json: the stats fields that reading a file or a later chmod changes)
const VOLATILE_STATS_KEYS = ['atime', 'atimeMs', 'ctime', 'ctimeMs'];

// PORTING.md 14.2 (n bytes, byte i is i & 255)
function binaryBuffer(n) {
  const buffer = Buffer.alloc(n);
  for (let i = 0; i < n; i++) {
    buffer[i] = i & 255;
  }
  return buffer;
}

// PORTING.md 14.2 (a stream source, made once per implementation, written in the given chunks)
function streamOf(chunks) {
  const stream = new PassThrough();
  for (const chunk of chunks) {
    stream.write(chunk);
  }
  stream.end();
  return stream;
}

// PORTING.md 14.2 (determinism: modes are set by chmod, times by lutimes)
function makeTree() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ykk-diff-json-')));
  const write = (rel, data, mode) => {
    const target = path.join(root, rel);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, data);
    fs.chmodSync(target, mode);
  };
  write('a.txt', 'this is a test file', 0o644);
  write('b.bin', Buffer.alloc(600, 0x62), 0o600);
  write('sub/c.txt', Buffer.alloc(512, 0x63), 0o640);
  write('sub/empty.txt', '', 0o644);
  write('sub/deep/d.txt', 'deep', 0o755);
  fs.symlinkSync('a.txt', path.join(root, 'link-a'));
  fs.symlinkSync('sub', path.join(root, 'link-sub'));
  fs.chmodSync(path.join(root, 'sub/deep'), 0o700);
  fs.chmodSync(path.join(root, 'sub'), 0o755);
  for (const rel of ['sub/deep/d.txt', 'sub/deep', 'sub/c.txt', 'sub/empty.txt', 'sub', 'a.txt', 'b.bin', 'link-a', 'link-sub', '.']) {
    fs.lutimesSync(path.join(root, rel), DATE, DATE);
  }
  return root;
}

// PORTING.md 14.2
function removeTree(root) {
  fs.rmSync(root, { recursive: true, force: true });
}

// PORTING.md 14.2 (case J1: buffer, string and stream sources; key order; unsigned crc32; caller keys)
async function j1(impl, ctx) {
  const archive = ctx.create('json');
  archive.append(Buffer.from('test'), { name: 'buffer.txt', date: DATE });
  archive.append('string', { name: 'string.txt', date: DATE, mode: 0o600 });
  archive.append(streamOf([binaryBuffer(16384)]), { name: 'stream.bin', date: DATE });
  archive.append(streamOf([binaryBuffer(300), binaryBuffer(700)]), { name: 'stream-chunks.bin', date: DATE });
  archive.append(Buffer.alloc(0), { name: 'empty-buffer.txt', date: DATE });
  archive.append(streamOf([]), { name: 'empty-stream.txt', date: DATE });
  archive.append(null, { name: 'null-source.txt', date: DATE });
  archive.append(binaryBuffer(2621440), { name: 'above-one-mebibyte.bin', date: DATE });
  archive.append(null, { name: 'dir/', date: DATE });
  archive.append('x', { name: 'prefixed.txt', prefix: 'pre', date: DATE });
  archive.append('test', {
    name: 'caller-keys.txt',
    date: DATE,
    zeta: 'z',
    custom: { nested: [1, 2, { three: 3 }] },
    size: 99,
    crc32: 5,
    alpha: null,
    omitted: undefined,
    fn: function () {},
    sourceType: 'caller',
  });
  archive.append('x', { date: DATE, name: 'keys-in-caller-order.txt', mode: 0o640, type: 'file' });
  archive.append('x', { name: 'invalid-date.txt', date: new Date(NaN) });
  archive.append('x', { name: 'date-string.txt', date: '2013-01-03T14:26:38.000Z' });
  archive.append('x', { name: 'grüße/日本語.txt', date: DATE });
  archive.symlink('link', 'target/file.txt');
  archive.symlink('link-with-mode', 'a\\b', 0o777);
  await archive.finalize();
}

// PORTING.md 14.2 (case J2: one file() with stats)
async function j2File(impl, ctx) {
  const archive = ctx.create('json');
  archive.file(path.join(ctx.args.root, ctx.args.rel), { name: ctx.args.name, caller: true });
  await archive.finalize();
}

// PORTING.md 14.2 (case J2: one directory() with stats)
async function j2Directory(impl, ctx) {
  const archive = ctx.create('json');
  archive.directory(ctx.args.root, 'tree', { caller: true });
  await archive.finalize();
}

// PORTING.md 14.2 (case J3: several fs sources, class N)
async function j3(impl, ctx) {
  const root = ctx.args.root;
  const archive = ctx.create('json');
  archive.file(path.join(root, 'a.txt'), { name: 'a.txt' });
  archive.file(path.join(root, 'b.bin'), { name: 'b.bin' });
  archive.file(path.join(root, 'missing.txt'), { name: 'missing.txt' });
  archive.file(path.join(root, 'link-a'), { name: 'link-a' });
  archive.directory(path.join(root, 'sub'), 'one');
  archive.directory(path.join(root, 'sub'), 'two');
  archive.glob('*.txt', { cwd: root }, { prefix: 'globbed' });
  archive.append('x', { name: 'appended.txt', date: DATE });
  await archive.finalize();
}

// PORTING.md 14.2 (comparison rules, json: equal after replacing the volatile stats fields)
function parseFiles(bytes) {
  const files = JSON.parse(bytes.toString('utf8'));
  assert.ok(Array.isArray(files));
  for (const file of files) {
    if (file.stats !== null && typeof file.stats === 'object') {
      for (const key of VOLATILE_STATS_KEYS) {
        if (key in file.stats) {
          file.stats[key] = 0;
        }
      }
    }
  }
  return files;
}

// PORTING.md 14.2 (comparison rules, json: the serialized document with the volatile stats fields replaced)
function maskVolatile(bytes) {
  return bytes
    .toString('utf8')
    .replace(/"(atimeMs|ctimeMs)":[0-9.e+-]+/g, '"$1":0')
    .replace(/"(atime|ctime)":"[^"]*"/g, '"$1":0');
}

// PORTING.md 14.2 (class D with stats: the document, the entry objects in order, key order included, and exact event sequences)
function assertSameFiles({ upstream, ykk }) {
  assert.strictEqual(upstream.error, null);
  assert.deepStrictEqual(ykk.error, upstream.error);
  const expected = parseFiles(upstream.bytes);
  const actual = parseFiles(ykk.bytes);
  assert.deepStrictEqual(
    actual.map((file) => JSON.stringify(file)),
    expected.map((file) => JSON.stringify(file))
  );
  assert.strictEqual(maskVolatile(ykk.bytes), maskVolatile(upstream.bytes));
  assert.deepStrictEqual(selectEvents(ykk.events), selectEvents(upstream.events));
  assert.strictEqual(upstream.pointer, upstream.bytes.length);
  assert.strictEqual(ykk.pointer, ykk.bytes.length);
  return actual;
}

// PORTING.md 14.2 (class N: entry objects keyed by name)
function filesByName(bytes) {
  const byName = new Map();
  for (const file of parseFiles(bytes)) {
    assert.ok(!byName.has(file.name), `entry name ${file.name} is used twice`);
    byName.set(file.name, JSON.stringify(file));
  }
  return byName;
}

describe('differential: json', function () {
  let root;

  before(function () {
    root = makeTree();
  });

  after(function () {
    removeTree(root);
  });

  it('J1: buffer, string and stream sources, key order, unsigned crc32, caller keys', async function () {
    const { upstream, ykk } = await runBoth(j1);
    assert.strictEqual(upstream.error, null);
    assert.deepStrictEqual(ykk.error, upstream.error);
    assert.strictEqual(ykk.bytes.toString('utf8'), upstream.bytes.toString('utf8'));
    assert.ok(ykk.bytes.equals(upstream.bytes));
    assert.deepStrictEqual(selectEvents(ykk.events), selectEvents(upstream.events));
    assert.strictEqual(ykk.pointer, upstream.pointer);
    assert.strictEqual(ykk.pointer, ykk.bytes.length);
    for (const bytes of [upstream.bytes, ykk.bytes]) {
      const files = JSON.parse(bytes.toString('utf8'));
      assert.strictEqual(files.length, 17);
      // TAR-JSON-117
      assert.deepStrictEqual(Object.keys(files[0]), [
        'type',
        'name',
        'date',
        'mode',
        'prefix',
        'sourcePath',
        'stats',
        'sourceType',
        'crc32',
        'size',
      ]);
      assert.deepStrictEqual(files[0], {
        type: 'file',
        name: 'buffer.txt',
        date: '2013-01-03T14:26:38.000Z',
        mode: 420,
        prefix: null,
        sourcePath: null,
        stats: false,
        sourceType: 'buffer',
        crc32: 3632233996,
        size: 4,
      });
      assert.deepStrictEqual(
        files.map((file) => [file.name, file.sourceType, file.crc32, file.size]),
        [
          ['buffer.txt', 'buffer', 3632233996, 4],
          ['string.txt', 'buffer', 2663297705, 6],
          ['stream.bin', 'stream', 3893830384, 16384],
          ['stream-chunks.bin', 'stream', 1923562301, 1000],
          ['empty-buffer.txt', 'buffer', 0, 0],
          ['empty-stream.txt', 'stream', 0, 0],
          ['null-source.txt', 'buffer', 0, 0],
          ['above-one-mebibyte.bin', 'buffer', 3609793343, 2621440],
          ['dir/', 'buffer', 0, 0],
          ['pre/prefixed.txt', 'buffer', 2363233923, 1],
          ['caller-keys.txt', 'buffer', 3632233996, 4],
          ['keys-in-caller-order.txt', 'buffer', 2363233923, 1],
          ['invalid-date.txt', 'buffer', 2363233923, 1],
          ['date-string.txt', 'buffer', 2363233923, 1],
          ['grüße/日本語.txt', 'buffer', 2363233923, 1],
          ['link', 'buffer', 0, 0],
          ['link-with-mode', 'buffer', 0, 0],
        ]
      );
      assert.deepStrictEqual(Object.keys(files[10]), [
        'type',
        'name',
        'date',
        'mode',
        'prefix',
        'sourcePath',
        'stats',
        'zeta',
        'custom',
        'size',
        'crc32',
        'alpha',
        'sourceType',
      ]);
      assert.deepStrictEqual(Object.keys(files[11]), [
        'type',
        'name',
        'date',
        'mode',
        'prefix',
        'sourcePath',
        'stats',
        'sourceType',
        'crc32',
        'size',
      ]);
      assert.strictEqual(files[12].date, null);
      // TAR-JSON-118
      assert.deepStrictEqual(files[15], {
        type: 'symlink',
        name: 'link',
        linkname: 'target/file.txt',
        sourceType: 'buffer',
        crc32: 0,
        size: 0,
      });
      assert.deepStrictEqual(Object.keys(files[16]), ['type', 'name', 'linkname', 'sourceType', 'mode', 'crc32', 'size']);
    }
  });

  it('J2: one file() with stats', async function () {
    const files = assertSameFiles(await runBoth(j2File, { args: { root, rel: 'a.txt', name: 'from-disk.txt' } }));
    assert.strictEqual(files.length, 1);
    assert.strictEqual(files[0].name, 'from-disk.txt');
    assert.strictEqual(files[0].sourceType, 'stream');
    assert.strictEqual(files[0].sourcePath, path.join(root, 'a.txt'));
    assert.strictEqual(files[0].date, '2013-01-03T14:26:38.000Z');
    assert.strictEqual(files[0].mode, 0o644);
    assert.strictEqual(files[0].stats.size, 19);
    assert.strictEqual(files[0].size, 19);
    assert.strictEqual(files[0].crc32, 551708637);
    assert.strictEqual(files[0].caller, true);
  });

  it('J2: file() on a directory and on a symlink', async function () {
    const directory = assertSameFiles(await runBoth(j2File, { args: { root, rel: 'sub', name: 'from-disk' } }));
    assert.deepStrictEqual(
      directory.map((file) => [file.type, file.name, file.sourcePath, file.sourceType, file.size]),
      [['directory', 'from-disk/', path.join(root, 'sub') + '/', 'buffer', 0]]
    );
    const symlink = assertSameFiles(await runBoth(j2File, { args: { root, rel: 'link-a', name: 'from-disk' } }));
    assert.deepStrictEqual(
      symlink.map((file) => [file.type, file.name, file.linkname, file.sourceType, file.size]),
      [['symlink', 'from-disk', 'a.txt', 'buffer', 0]]
    );
  });

  it('J2: one directory() with stats', async function () {
    const files = assertSameFiles(await runBoth(j2Directory, { args: { root } }));
    assert.deepStrictEqual(
      files.map((file) => [file.type, file.name, file.size]).sort(),
      [
        ['directory', 'tree/sub/', 0],
        ['directory', 'tree/sub/deep/', 0],
        ['file', 'tree/a.txt', 19],
        ['file', 'tree/b.bin', 600],
        ['file', 'tree/sub/c.txt', 512],
        ['file', 'tree/sub/deep/d.txt', 4],
        ['file', 'tree/sub/empty.txt', 0],
        ['symlink', 'tree/link-a', 0],
        ['symlink', 'tree/link-sub', 0],
      ]
    );
    for (const file of files) {
      assert.strictEqual(file.caller, true);
      assert.strictEqual(typeof file.stats, 'object');
      assert.strictEqual(file.prefix, null);
    }
  });

  it('J3: several fs sources, compared per entry (class N)', async function () {
    const { upstream, ykk } = await runBoth(j3, { args: { root } });
    assert.strictEqual(upstream.error, null);
    assert.deepStrictEqual(ykk.error, upstream.error);
    const expected = filesByName(upstream.bytes);
    const actual = filesByName(ykk.bytes);
    assert.deepStrictEqual([...actual.keys()].sort(), [...expected.keys()].sort());
    assert.strictEqual(expected.size, 13);
    for (const [name, file] of expected) {
      assert.strictEqual(actual.get(name), file);
    }
    assert.deepStrictEqual(
      sortEvents(selectEvents(ykk.events, ['entry', 'warning', 'error'])),
      sortEvents(selectEvents(upstream.events, ['entry', 'warning', 'error']))
    );
    assert.strictEqual(selectEvents(upstream.events, ['warning']).length, 1);
    assert.strictEqual(selectEvents(ykk.events, ['progress']).length, selectEvents(upstream.events, ['progress']).length);
  });
});
