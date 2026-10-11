// PORTING.md 14.2: cases Z1 to Z15 (plain zip). No upstream source.
import assert from 'node:assert/strict';
import { once } from 'node:events';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { PassThrough, Readable } from 'node:stream';
import { entryData } from './helpers/decrypt.mjs';
import { selectEvents, sortEvents } from './helpers/events.mjs';
import { runBoth } from './helpers/run-both.mjs';
import { maskCentral, maskDescriptor, maskEndRecords, maskLocal, parseZip } from './helpers/zip-records.mjs';

const require = createRequire(import.meta.url);
const lazystream = require('lazystream');

const DATE = new Date('2020-03-04T05:06:08.000Z');
const CLOCK = new Date('2021-07-04T09:08:06.000Z');
const TEXT = Buffer.from('this is a text file');
const BIG = Buffer.alloc(4000, 'abcdefghij');

let root;

// PORTING.md 14.2 (determinism: file modes are set by chmod in the test, times by lutimes)
function makeTree() {
  const tree = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ykk-diff-zip-')));
  const write = (rel, data, mode) => {
    const target = path.join(tree, rel);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, data);
    fs.chmodSync(target, mode);
  };
  write('file.txt', TEXT, 0o644);
  write('exec.sh', '#!/bin/sh\n', 0o755);
  write('dir/a.txt', BIG, 0o644);
  write('dir/b.txt', 'b', 0o600);
  write('dir/.hidden', 'hidden', 0o644);
  write('dir/empty.txt', '', 0o644);
  write('dir/sub/c.txt', 'c', 0o640);
  write('dir/sub/ignore.txt', 'ignore', 0o644);
  write('dir/sub/deep/d.txt', 'deep', 0o644);
  write('links/target.txt', 'target', 0o644);
  fs.symlinkSync('target.txt', path.join(tree, 'links/link.txt'));
  fs.symlinkSync('../dir/sub', path.join(tree, 'links/dirlink'));
  for (const rel of ['dir/sub/deep', 'dir/sub', 'dir', 'links']) {
    fs.chmodSync(path.join(tree, rel), 0o755);
  }
  for (const rel of [
    'dir/sub/deep/d.txt', 'dir/sub/deep', 'dir/sub/c.txt', 'dir/sub/ignore.txt', 'dir/sub', 'dir/a.txt', 'dir/b.txt',
    'dir/.hidden', 'dir/empty.txt', 'dir', 'links/target.txt', 'links/link.txt', 'links/dirlink', 'links', 'file.txt',
    'exec.sh',
  ]) {
    fs.lutimesSync(path.join(tree, rel), DATE, DATE);
  }
  return tree;
}

// PORTING.md 14.2 (helper of the test: a path inside the fixture tree)
function fixture(rel) {
  return path.join(root, rel);
}

// PORTING.md 14.2 (helper of the test: a fresh stream per implementation, written in the given chunks)
function streamOf(chunks) {
  const stream = new PassThrough();
  for (const chunk of chunks) {
    stream.write(chunk);
  }
  stream.end();
  return stream;
}

// PORTING.md 14.2 (helper of the test: a stream that delivers 3000 bytes and then fails, Z11)
function failingStream() {
  let sent = false;
  return new Readable({
    read() {
      if (!sent) {
        sent = true;
        this.push(Buffer.alloc(3000, 'x'));
      } else {
        this.destroy(new Error('source failed'));
      }
    },
  });
}

// PORTING.md 14.2 (one ZipArchive per implementation: `options()` is a fresh object per run, `add` appends)
function zip(options, add) {
  return async (impl, ctx) => {
    const archive = ctx.create('zip', options());
    await add(archive, impl);
    await archive.finalize();
  };
}

// PORTING.md 14.2 (Z12: the class of the engine a ZipArchive runs on; ykk does not export ZipStream by name)
function zipStreamClass(impl) {
  const archive = new impl.ZipArchive();
  const ZipStream = archive._module.engine.constructor;
  archive._module.engine.destroy();
  archive.destroy();
  return ZipStream;
}

// PORTING.md 14.2 (comparison rules, deflated zip: compressed sizes are checked only relationally)
function assertSizes(entry) {
  assert.equal(entry.central.effective.compressedSize, entry.payload.length, `${entry.name}: central compressed size`);
  if (entry.descriptor !== null) {
    assert.equal(entry.descriptor.compressedSize, entry.payload.length, `${entry.name}: descriptor compressed size`);
  } else {
    assert.equal(entry.local.compressedSize, entry.payload.length, `${entry.name}: local compressed size`);
  }
}

// PORTING.md 14.2 (comparison rules, deflated zip: central directory size and offset are checked only relationally)
function assertEndRecords(zip) {
  assert.equal(zip.centralEnd, zip.centralOffset + zip.centralSize, 'central directory size');
  assert.equal(zip.centralEnd, zip.zip64End !== null ? zip.zip64End.offset : zip.end.offset, 'central directory end');
  if (zip.zip64Locator !== null) {
    assert.equal(zip.zip64Locator.zip64EndOffset, zip.zip64End.offset, 'zip64 locator offset');
  }
}

// PORTING.md 14.2 (comparison rules, deflated zip: one entry)
async function assertSameEntry(u, y) {
  assert.deepStrictEqual(maskLocal(y.local), maskLocal(u.local), `${u.name}: local header`);
  assert.deepStrictEqual(await entryData(y), await entryData(u), `${u.name}: inflated payload`);
  assert.equal(y.descriptor === null, u.descriptor === null, `${u.name}: data descriptor present`);
  if (u.descriptor !== null) {
    assert.deepStrictEqual(maskDescriptor(y.descriptor), maskDescriptor(u.descriptor), `${u.name}: data descriptor`);
  }
  assert.deepStrictEqual(maskCentral(y.central), maskCentral(u.central), `${u.name}: central header`);
  assertSizes(u);
  assertSizes(y);
}

// PORTING.md 14.2 (comparison rules, deflated zip, class D: entry order, entries, end records)
async function assertSameArchive(upstream, ykk) {
  assert.deepStrictEqual(ykk.error, upstream.error);
  const u = parseZip(upstream.bytes);
  const y = parseZip(ykk.bytes);
  assert.deepStrictEqual(y.entries.map((entry) => entry.name), u.entries.map((entry) => entry.name));
  for (let i = 0; i < u.entries.length; i++) {
    await assertSameEntry(u.entries[i], y.entries[i]);
  }
  assert.deepStrictEqual(y.prefix, u.prefix);
  assert.deepStrictEqual(maskEndRecords(y), maskEndRecords(u));
  assertEndRecords(u);
  assertEndRecords(y);
  return { u, y };
}

// PORTING.md 14.2 (comparison rules, deflated zip, class D; events: the exact sequence)
async function assertSameZip(upstream, ykk) {
  const zips = await assertSameArchive(upstream, ykk);
  assert.deepStrictEqual(selectEvents(ykk.events), selectEvents(upstream.events));
  return zips;
}

// PORTING.md 14.2 (comparison rules, stored zip: whole-archive byte equality, events, pointer)
function assertSameBytes(upstream, ykk) {
  assert.deepStrictEqual(ykk.error, upstream.error);
  assert.deepStrictEqual(ykk.bytes, upstream.bytes);
  assert.deepStrictEqual(selectEvents(ykk.events), selectEvents(upstream.events));
  assert.equal(ykk.pointer, upstream.pointer);
  if (ykk.pointer !== null) {
    assert.equal(ykk.pointer, ykk.bytes.length);
  }
  return { u: parseZip(upstream.bytes), y: parseZip(ykk.bytes) };
}

// PORTING.md 14.2 (order class N: per entry, keyed by name, offsets masked; multisets of names and events)
async function assertSameEntries(upstream, ykk) {
  assert.deepStrictEqual(ykk.error, upstream.error);
  const u = parseZip(upstream.bytes);
  const y = parseZip(ykk.bytes);
  const names = (zip) => zip.entries.map((entry) => entry.name).sort();
  assert.deepStrictEqual(names(y), names(u));
  assert.equal(new Set(names(u)).size, u.entries.length);
  const byName = new Map(u.entries.map((entry) => [entry.name, entry]));
  for (const entry of y.entries) {
    await assertSameEntry(byName.get(entry.name), entry);
  }
  assert.deepStrictEqual(maskEndRecords(y), maskEndRecords(u));
  assertEndRecords(u);
  assertEndRecords(y);
  const unordered = (run) => sortEvents(selectEvents(run.events, ['entry', 'warning', 'error']));
  assert.deepStrictEqual(unordered(ykk), unordered(upstream));
  const progress = (run) => selectEvents(run.events, ['progress']).map((record) => record.payload);
  const processed = (run) => progress(run).map((payload) => payload.entries.processed).sort((a, b) => a - b);
  assert.deepStrictEqual(processed(ykk), processed(upstream));
  assert.deepStrictEqual(progress(ykk).at(-1), progress(upstream).at(-1));
  return { u, y };
}

// PORTING.md 14.2 (helper of the test: the entries of both archives, for an assertion made on each)
function both(zips) {
  return [zips.u, zips.y];
}

describe('differential: zip (plain)', function () {
  before(function () {
    root = makeTree();
  });

  after(function () {
    fs.rmSync(root, { recursive: true, force: true });
  });

  describe('Z1 buffer, string, stream and lazy file sources', function () {
    const add = (archive) => {
      archive.append(BIG, { name: 'buffer.txt', date: DATE });
      archive.append('this is a string source', { name: 'string.txt', date: DATE });
      archive.append(fs.createReadStream(fixture('dir/a.txt')), { name: 'stream.txt', date: DATE });
      archive.append(new lazystream.Readable(() => fs.createReadStream(fixture('dir/a.txt'))), {
        name: 'lazy.txt',
        date: DATE,
      });
    };

    it('default method (V1)', async function () {
      const { upstream, ykk } = await runBoth(zip(() => ({}), add));
      const zips = await assertSameZip(upstream, ykk);
      for (const parsed of both(zips)) {
        assert.deepStrictEqual(parsed.entries.map((entry) => entry.central.method), [8, 8, 8, 8]);
        assert.deepStrictEqual(parsed.entries.map((entry) => entry.central.size), [4000, 23, 4000, 4000]);
      }
    });

    it('stored', async function () {
      const { upstream, ykk } = await runBoth(zip(() => ({ store: true }), add));
      assertSameBytes(upstream, ykk);
    });
  });

  describe('Z2 empty buffer and empty stream', function () {
    const add = (archive) => {
      archive.append(Buffer.alloc(0), { name: 'empty-buffer.txt', date: DATE });
      archive.append(streamOf([]), { name: 'empty-stream.txt', date: DATE });
      archive.append('', { name: 'empty-string.txt', date: DATE });
    };

    it('default method (P14)', async function () {
      const { upstream, ykk } = await runBoth(zip(() => ({}), add));
      const zips = await assertSameZip(upstream, ykk);
      for (const parsed of both(zips)) {
        const empty = parsed.entries[0];
        assert.equal(empty.local.versionNeeded, 20);
        assert.equal(empty.local.flags, 0x0008);
        assert.equal(empty.local.method, 0);
        assert.equal(empty.payload.length, 0);
        assert.deepStrictEqual(empty.descriptor.bytes, Buffer.from('504b0708000000000000000000000000', 'hex'));
        assert.equal(parsed.entries[1].central.method, 8);
        assert.equal(parsed.entries[2].central.method, 0);
      }
    });

    it('stored', async function () {
      const { upstream, ykk } = await runBoth(zip(() => ({ store: true }), add));
      const zips = assertSameBytes(upstream, ykk);
      assert.equal(zips.y.entries[0].local.versionNeeded, 10);
      assert.equal(zips.y.entries[0].local.flags, 0);
      assert.equal(zips.y.entries[0].descriptor, null);
    });
  });

  describe('Z3 directories', function () {
    it('append(null, { name: "d/" }) and type "directory"', async function () {
      const { upstream, ykk } = await runBoth(
        zip(() => ({}), (archive) => {
          archive.append(null, { name: 'd/', date: DATE });
          archive.append(null, { name: 'typed', type: 'directory', date: DATE });
          archive.append(null, { name: 'mode/', date: DATE, mode: 0o700 });
          archive.append(TEXT, { name: 'd/file.txt', date: DATE, store: true });
        })
      );
      const zips = assertSameBytes(upstream, ykk);
      assert.deepStrictEqual(zips.y.entries.map((entry) => entry.name), ['d/', 'typed/', 'mode/', 'd/file.txt']);
      assert.equal(zips.y.entries[0].central.externalAttributes, ((0o40755 << 16) | 0x10) >>> 0);
    });

    it('file() on a directory', async function () {
      const { upstream, ykk } = await runBoth(
        zip(() => ({}), (archive) => {
          archive.file(fixture('dir'), { name: 'from-file', date: DATE });
        })
      );
      const zips = assertSameBytes(upstream, ykk);
      assert.deepStrictEqual(zips.y.entries.map((entry) => entry.name), ['from-file/']);
    });

    it('one directory()', async function () {
      const { upstream, ykk } = await runBoth(
        zip(() => ({}), (archive) => {
          archive.directory(fixture('dir'), 'walk', { date: DATE });
        })
      );
      const zips = await assertSameZip(upstream, ykk);
      assert.deepStrictEqual(
        zips.y.entries.map((entry) => entry.name).sort(),
        [
          'walk/.hidden', 'walk/a.txt', 'walk/b.txt', 'walk/empty.txt', 'walk/sub/', 'walk/sub/c.txt',
          'walk/sub/deep/', 'walk/sub/deep/d.txt', 'walk/sub/ignore.txt',
        ]
      );
    });

    it('one directory() with destpath false and a data function', async function () {
      const { upstream, ykk } = await runBoth(
        zip(() => ({ store: true }), (archive) => {
          archive.directory(fixture('dir'), false, (data) => {
            if (data.name === 'sub/ignore.txt') {
              return false;
            }
            data.date = DATE;
            data.funcProp = true;
            return data;
          });
        })
      );
      const zips = assertSameBytes(upstream, ykk);
      assert.ok(!zips.y.entries.some((entry) => entry.name === 'sub/ignore.txt'));
    });
  });

  describe('Z4 symlinks', function () {
    it('symlink()', async function () {
      const { upstream, ykk } = await runBoth(
        zip(() => ({}), (archive) => {
          archive.append(TEXT, { name: 'target.txt', date: DATE, store: true });
          archive.symlink('link.txt', 'target.txt');
          archive.symlink('sub/link-mode.txt', '../target.txt', 0o600);
        }),
        { clock: CLOCK }
      );
      const zips = assertSameBytes(upstream, ykk);
      const link = zips.y.entries[1];
      assert.deepStrictEqual(link.payload, Buffer.from('target.txt'));
      assert.equal(link.central.externalAttributes >>> 16, 0o120000);
      assert.equal(zips.y.entries[2].central.externalAttributes >>> 16, 0o120600);
      assert.notEqual(link.central.dosTime, zips.y.entries[0].central.dosTime);
    });

    it('from disk', async function () {
      const { upstream, ykk } = await runBoth(
        zip(() => ({ store: true }), (archive) => {
          archive.directory(fixture('links'), 'links', { date: DATE });
        })
      );
      const zips = assertSameBytes(upstream, ykk);
      const byName = new Map(zips.y.entries.map((entry) => [entry.name, entry]));
      assert.deepStrictEqual([...byName.keys()].sort(), ['links/dirlink', 'links/link.txt', 'links/target.txt']);
      assert.deepStrictEqual(byName.get('links/link.txt').payload, Buffer.from('target.txt'));
      assert.equal(byName.get('links/link.txt').central.externalAttributes >>> 28, 0o12);
      assert.equal(byName.get('links/dirlink').central.externalAttributes >>> 28, 0o12);
    });
  });

  describe('Z5 names (R6)', function () {
    const add = (archive) => {
      archive.append(TEXT, { name: 'a.txt', prefix: 'pre/fix', date: DATE });
      archive.append(TEXT, { name: 'back\\slash\\b.txt', date: DATE });
      archive.append(TEXT, { name: 'c:c:/x', date: DATE });
      archive.append(TEXT, { name: '../up/../x.txt', date: DATE });
      archive.append(TEXT, { name: '/abs.txt', date: DATE });
      archive.append(TEXT, { name: './dot/./d.txt', date: DATE });
      archive.append(TEXT, { name: 'slash.txt', date: DATE, namePrependSlash: true });
    };

    it('prefix, backslash names, "c:c:/x", namePrependSlash per entry', async function () {
      const { upstream, ykk } = await runBoth(zip(() => ({ store: true }), add));
      const zips = assertSameBytes(upstream, ykk);
      assert.deepStrictEqual(
        zips.y.entries.map((entry) => entry.name),
        ['pre/fix/a.txt', 'back/slash/b.txt', 'x', 'up/../x.txt', 'abs.txt', './dot/./d.txt', '/slash.txt']
      );
    });

    it('namePrependSlash per archive', async function () {
      const { upstream, ykk } = await runBoth(zip(() => ({ store: true, namePrependSlash: true }), add));
      const zips = assertSameBytes(upstream, ykk);
      assert.deepStrictEqual(
        zips.y.entries.map((entry) => entry.name),
        ['/pre/fix/a.txt', '/back/slash/b.txt', '/x', '/up/../x.txt', '/abs.txt', '/./dot/./d.txt', '/slash.txt']
      );
    });

    it('default method', async function () {
      const { upstream, ykk } = await runBoth(zip(() => ({}), add));
      await assertSameZip(upstream, ykk);
    });
  });

  describe('Z6 non-ASCII names and comments (V5)', function () {
    const add = (archive) => {
      archive.append(TEXT, { name: 'plain.txt', date: DATE, comment: 'an ASCII entry comment' });
      archive.append(TEXT, { name: 'é.txt', date: DATE });
      archive.append(TEXT, { name: '日本語/ファイル.txt', date: DATE, comment: 'ü comment' });
      archive.append(TEXT, { name: 'ascii-name.txt', date: DATE, comment: 'コメント' });
    };

    for (const comment of ['an ASCII archive comment', 'archive ü 日本語']) {
      it(`archive comment ${JSON.stringify(comment)}`, async function () {
        const { upstream, ykk } = await runBoth(async (impl, ctx) => {
          const archive = ctx.create('zip', { store: true, comment });
          add(archive);
          await archive.finalize();
          return archive._module.engine.getBytesWritten();
        });
        const zips = assertSameBytes(upstream, ykk);
        // upstream counts the archive comment in UTF-16 units (ZIP-101), ykk in bytes (V5)
        assert.equal(upstream.value, upstream.bytes.length - (Buffer.byteLength(comment) - comment.length));
        assert.equal(ykk.value, ykk.bytes.length);
        assert.deepStrictEqual(zips.y.end.comment, Buffer.from(comment));
        assert.equal(zips.y.end.commentLength, Buffer.byteLength(comment));
        assert.deepStrictEqual(
          zips.y.entries.map((entry) => entry.central.flags & 0x0800),
          [0, 0x0800, 0x0800, 0x0800]
        );
      });
    }

    it('default method', async function () {
      const { upstream, ykk } = await runBoth(zip(() => ({ comment: 'archive ü' }), add));
      await assertSameZip(upstream, ykk);
    });
  });

  describe('Z7 mode', function () {
    it('0, null, 0644, 0777, absent', async function () {
      const { upstream, ykk } = await runBoth(
        zip(() => ({ store: true }), (archive) => {
          archive.append(TEXT, { name: 'mode-0.txt', date: DATE, mode: 0 });
          archive.append(TEXT, { name: 'mode-null.txt', date: DATE, mode: null });
          archive.append(TEXT, { name: 'mode-0644.txt', date: DATE, mode: 0o644 });
          archive.append(TEXT, { name: 'mode-0777.txt', date: DATE, mode: 0o777 });
          archive.append(TEXT, { name: 'mode-absent.txt', date: DATE });
          archive.append(TEXT, { name: 'mode-17777.txt', date: DATE, mode: 0o17777 });
          archive.append(null, { name: 'dir-mode-0/', date: DATE, mode: 0 });
        })
      );
      const zips = assertSameBytes(upstream, ykk);
      assert.deepStrictEqual(
        zips.y.entries.map((entry) => entry.central.externalAttributes >>> 16),
        [0o100000, 0o100644, 0o100644, 0o100777, 0o100644, 0o107777, 0o40000]
      );
      assert.deepStrictEqual(
        zips.y.entries.map((entry) => entry.central.versionMadeBy),
        [0x032d, 0x032d, 0x032d, 0x032d, 0x032d, 0x032d, 0x032d]
      );
    });
  });

  describe('Z8 store, zlib.level, level, forceZip64 with level 0 (ZIP-008, ZIP-136)', function () {
    const add = (archive) => {
      archive.append(BIG, { name: 'buffer.txt', date: DATE });
      archive.append(BIG, { name: 'stored.txt', date: DATE, store: true });
      archive.append(streamOf([BIG.subarray(0, 1500), BIG.subarray(1500)]), { name: 'stream.txt', date: DATE });
    };
    const cases = [
      { title: 'store per entry', options: () => ({}), methods: [8, 0, 8], shrinks: true },
      { title: 'store per archive', options: () => ({ store: true }), methods: [0, 0, 0] },
      { title: 'zlib.level 0', options: () => ({ zlib: { level: 0 } }), methods: [0, 0, 0] },
      { title: 'zlib.level 1', options: () => ({ zlib: { level: 1 } }), methods: [8, 0, 8], shrinks: true },
      { title: 'zlib.level 9', options: () => ({ zlib: { level: 9 } }), methods: [8, 0, 8], shrinks: true },
      { title: 'zlib.level NaN', options: () => ({ zlib: { level: NaN } }), methods: [8, 0, 8], shrinks: true },
      { title: 'zlib.level 0.9', options: () => ({ zlib: { level: 0.9 } }), methods: [8, 0, 8], shrinks: false },
      { title: 'level 9', options: () => ({ level: 9 }), methods: [8, 0, 8], shrinks: true },
      { title: 'level 0', options: () => ({ level: 0 }), methods: [0, 0, 0] },
      {
        title: 'forceZip64 with zlib.level 0',
        options: () => ({ forceZip64: true, zlib: { level: 0 } }),
        methods: [8, 0, 8],
        shrinks: false,
      },
    ];

    for (const { title, options, methods, shrinks } of cases) {
      it(title, async function () {
        const { upstream, ykk } = await runBoth(zip(options, add));
        const zips = methods.includes(8) ? await assertSameZip(upstream, ykk) : assertSameBytes(upstream, ykk);
        for (const parsed of both(zips)) {
          assert.deepStrictEqual(parsed.entries.map((entry) => entry.central.method), methods);
          for (const entry of parsed.entries) {
            if (entry.central.method === 8) {
              assert.equal(entry.payload.length < BIG.length, shrinks, `${entry.name}: compressed length`);
            } else {
              assert.equal(entry.payload.length, BIG.length);
            }
          }
        }
      });
    }
  });

  describe('Z9 forceZip64 (P15)', function () {
    it('stored', async function () {
      const { upstream, ykk } = await runBoth(
        zip(() => ({ forceZip64: true, store: true }), (archive) => {
          archive.append(TEXT, { name: 'a.txt', date: DATE });
          archive.append(streamOf([TEXT]), { name: 'stream.txt', date: DATE });
        })
      );
      const zips = assertSameBytes(upstream, ykk);
      const parsed = zips.y;
      assert.notEqual(parsed.zip64End, null);
      assert.notEqual(parsed.zip64Locator, null);
      assert.equal(parsed.end.entries, 0xffff);
      assert.equal(parsed.end.centralSize, 0xffffffff);
      assert.equal(parsed.end.centralOffset, 0xffffffff);
      assert.equal(parsed.zip64End.entries, 2);
      assert.equal(parsed.zip64Locator.zip64EndOffset, parsed.centralOffset + parsed.centralSize);
      for (const entry of parsed.entries) {
        assert.equal(entry.local.extraLength, 0);
        assert.equal(entry.central.extraLength, 0);
      }
      assert.deepStrictEqual(parsed.entries.map((entry) => entry.local.versionNeeded), [10, 20]);
      assert.equal(parsed.entries[1].descriptor.length, 16);
    });

    it('default method', async function () {
      const { upstream, ykk } = await runBoth(
        zip(() => ({ forceZip64: true }), (archive) => {
          archive.append(BIG, { name: 'a.txt', date: DATE });
        })
      );
      const zips = await assertSameZip(upstream, ykk);
      for (const parsed of both(zips)) {
        assert.notEqual(parsed.zip64End, null);
        assert.equal(parsed.entries[0].local.extraLength, 0);
        assert.equal(parsed.entries[0].central.versionNeeded, 20);
        assert.equal(parsed.entries[0].descriptor.length, 16);
      }
    });
  });

  describe('Z10 dates with TZ set (P7, P20)', function () {
    const TZ = process.env.TZ;
    const add = (archive) => {
      archive.append(TEXT, { name: '1979.txt', date: new Date('1979-12-31T23:59:59.000Z') });
      archive.append(TEXT, { name: '1980.txt', date: new Date('1980-01-01T00:00:00.000Z') });
      archive.append(TEXT, { name: '2020.txt', date: new Date('2020-06-15T20:30:45.000Z') });
      archive.append(TEXT, { name: '2043.txt', date: new Date('2043-12-31T23:59:58.000Z') });
      archive.append(TEXT, { name: '2044.txt', date: new Date('2044-01-01T00:00:00.000Z') });
      archive.append(TEXT, { name: 'invalid.txt', date: new Date('not a date') });
      archive.append(TEXT, { name: 'string.txt', date: '2013-01-03T14:26:38.000Z' });
      archive.append(TEXT, { name: 'garbage-string.txt', date: 'garbage' });
      archive.append(TEXT, { name: '1979-local.txt', date: new Date('1979-12-31T10:00:00.000Z') });
      archive.append(TEXT, { name: '1980-mid.txt', date: new Date('1980-06-15T12:00:00.000Z') });
      archive.append(TEXT, { name: '2043-mid.txt', date: new Date('2043-06-15T12:34:56.000Z') });
    };
    const times = (parsed) => parsed.entries.map((entry) => entry.central.dosTime);

    before(function () {
      process.env.TZ = 'Asia/Tokyo';
    });

    after(function () {
      if (TZ === undefined) {
        delete process.env.TZ;
      } else {
        process.env.TZ = TZ;
      }
    });

    it('the time zone is in effect', function () {
      assert.equal(new Date('2020-06-15T20:30:45.000Z').getHours(), 5);
    });

    it('default options: UTC fields', async function () {
      const { upstream, ykk } = await runBoth(zip(() => ({ store: true }), add));
      const zips = assertSameBytes(upstream, ykk);
      // 1980-1-1 00:00:00 below 1980, 2043-12-31 23:59:58 from 2044 on, 0 for an Invalid Date (ZIP-086)
      assert.deepStrictEqual(times(zips.y), [
        2162688,
        2162688,
        ((2020 - 1980) << 25) | (6 << 21) | (15 << 16) | (20 << 11) | (30 << 5) | 22,
        2141175677,
        2141175677,
        0,
        ((2013 - 1980) << 25) | (1 << 21) | (3 << 16) | (14 << 11) | (26 << 5) | 19,
        0,
        2162688,
        ((1980 - 1980) << 25) | (6 << 21) | (15 << 16) | (12 << 11) | (0 << 5) | 0,
        ((2043 - 1980) << 25) | (6 << 21) | (15 << 16) | (12 << 11) | (34 << 5) | 28,
      ]);
    });

    it('forceLocalTime: local fields', async function () {
      const { upstream, ykk } = await runBoth(zip(() => ({ store: true, forceLocalTime: true }), add));
      const zips = assertSameBytes(upstream, ykk);
      assert.deepStrictEqual(times(zips.y), [
        ((1980 - 1980) << 25) | (1 << 21) | (1 << 16) | (8 << 11) | (59 << 5) | 29,
        ((1980 - 1980) << 25) | (1 << 21) | (1 << 16) | (9 << 11) | (0 << 5) | 0,
        ((2020 - 1980) << 25) | (6 << 21) | (16 << 16) | (5 << 11) | (30 << 5) | 22,
        2141175677,
        2141175677,
        0,
        ((2013 - 1980) << 25) | (1 << 21) | (3 << 16) | (23 << 11) | (26 << 5) | 19,
        0,
        2162688,
        ((1980 - 1980) << 25) | (6 << 21) | (15 << 16) | (21 << 11) | (0 << 5) | 0,
        ((2043 - 1980) << 25) | (6 << 21) | (15 << 16) | (21 << 11) | (34 << 5) | 28,
      ]);
    });

    it('forceUTC changes nothing (P20)', async function () {
      const plain = await runBoth(zip(() => ({ store: true }), add));
      const forceUTC = await runBoth(zip(() => ({ store: true, forceUTC: true }), add));
      const notUTC = await runBoth(zip(() => ({ store: true, forceUTC: false }), add));
      assertSameBytes(forceUTC.upstream, forceUTC.ykk);
      assertSameBytes(notUTC.upstream, notUTC.ykk);
      assert.deepStrictEqual(forceUTC.ykk.bytes, plain.ykk.bytes);
      assert.deepStrictEqual(notUTC.ykk.bytes, plain.ykk.bytes);
      assert.deepStrictEqual(forceUTC.upstream.bytes, plain.upstream.bytes);
    });

    it('a numeric date becomes the current time (P7)', async function () {
      const numeric = new Date('2000-01-02T03:04:06.000Z').getTime();
      const scenario = (date) =>
        zip(() => ({ store: true }), (archive) => {
          archive.append(TEXT, { name: 'numeric.txt', date });
        });
      const asNumber = await runBoth(scenario(numeric), { clock: CLOCK });
      const asNow = await runBoth(scenario(new Date(CLOCK.getTime())), { clock: CLOCK });
      const asDate = await runBoth(scenario(new Date(numeric)), { clock: CLOCK });
      const zips = assertSameBytes(asNumber.upstream, asNumber.ykk);
      assert.deepStrictEqual(asNumber.ykk.bytes, asNow.ykk.bytes);
      assert.notDeepStrictEqual(asNumber.ykk.bytes, asDate.ykk.bytes);
      assert.equal(
        zips.y.entries[0].central.dosTime,
        ((2021 - 1980) << 25) | (7 << 21) | (4 << 16) | (9 << 11) | (8 << 5) | 3
      );
    });
  });

  describe('Z11 a source stream that errors midway (P16)', function () {
    for (const store of [true, false]) {
      it(store ? 'stored' : 'default method', async function () {
        const { upstream, ykk } = await runBoth(async (impl, ctx) => {
          const ZipStream = zipStreamClass(impl);
          const engine = ctx.track(new ZipStream({ store }));
          const ended = once(engine, 'end');
          const reported = await new Promise((resolve) => {
            engine.entry(failingStream(), { name: 'partial.txt', date: DATE }, (err, entry) => {
              resolve({ message: err && err.message, entry: entry !== undefined && entry !== null });
            });
          });
          engine.entry(TEXT, { name: 'after.txt', date: DATE }, (err) => {
            assert.ifError(err);
            engine.finalize();
          });
          await ended;
          return reported;
        });
        assert.deepStrictEqual(upstream.value, { message: 'source failed', entry: true });
        assert.deepStrictEqual(ykk.value, upstream.value);
        const zips = store ? assertSameBytes(upstream, ykk) : await assertSameZip(upstream, ykk);
        for (const parsed of both(zips)) {
          assert.deepStrictEqual(parsed.entries.map((entry) => entry.name), ['partial.txt', 'after.txt']);
          assert.equal(parsed.entries[0].central.size, 3000);
          assert.deepStrictEqual(await entryData(parsed.entries[0]), Buffer.alloc(3000, 'x'));
        }
      });
    }
  });

  describe('Z12 ZipStream used directly (ZIP-135)', function () {
    for (const store of [true, false]) {
      it(store ? 'stored' : 'default method', async function () {
        const { upstream, ykk } = await runBoth(async (impl, ctx) => {
          const ZipStream = zipStreamClass(impl);
          const engine = ctx.track(new ZipStream({ store }));
          const ended = once(engine, 'end');
          engine.write('PREFIX');
          engine.entry(BIG, { name: 'a.txt', date: DATE }, (err) => {
            assert.ifError(err);
            engine.finalize();
          });
          await ended;
        });
        const zips = store ? assertSameBytes(upstream, ykk) : await assertSameZip(upstream, ykk);
        for (const parsed of both(zips)) {
          assert.deepStrictEqual(parsed.prefix, Buffer.from('PREFIX'));
          assert.equal(parsed.entries[0].central.localHeaderOffset, 6);
          assert.equal(parsed.entries[0].local.offset, 6);
          assert.equal(parsed.end.centralOffset, parsed.buffer.indexOf(Buffer.from('504b0102', 'hex')));
          assert.equal(parsed.end.centralOffset + parsed.end.centralSize, parsed.end.offset);
        }
      });
    }
  });

  describe('Z13 several fs sources (class N, GLOB-FS-068)', function () {
    it('several file() calls with the default statConcurrency', async function () {
      const { upstream, ykk } = await runBoth(
        zip(() => ({}), (archive) => {
          archive.file(fixture('file.txt'), { name: 'file.txt', date: DATE });
          archive.file(fixture('exec.sh'), { name: 'exec.sh', date: DATE });
          archive.file(fixture('dir/a.txt'), { name: 'a.txt', date: DATE });
          archive.file(fixture('dir/b.txt'), { name: 'b.txt', date: DATE });
          archive.file(fixture('dir/sub/c.txt'), { name: 'c.txt', date: DATE });
          archive.file(fixture('dir/empty.txt'), { name: 'empty.txt', date: DATE });
          archive.file(fixture('links/link.txt'), { name: 'link.txt', date: DATE });
        })
      );
      const zips = await assertSameEntries(upstream, ykk);
      assert.equal(zips.y.entries.length, 7);
    });

    it('file() plus directory()', async function () {
      const { upstream, ykk } = await runBoth(
        zip(() => ({}), (archive) => {
          archive.file(fixture('file.txt'), { name: 'file.txt', date: DATE });
          archive.directory(fixture('dir'), 'dir', { date: DATE });
          archive.file(fixture('exec.sh'), { name: 'exec.sh', date: DATE });
        })
      );
      const zips = await assertSameEntries(upstream, ykk);
      assert.equal(zips.y.entries.length, 11);
    });

    it('three directory() walks', async function () {
      const { upstream, ykk } = await runBoth(
        zip(() => ({}), (archive) => {
          archive.directory(fixture('dir'), 'one', { date: DATE });
          archive.directory(fixture('dir'), 'Win\\DS\\', { date: DATE });
          archive.directory(fixture('links'), 'three', { date: DATE });
        })
      );
      const zips = await assertSameEntries(upstream, ykk);
      assert.equal(zips.y.entries.length, 9 + 9 + 3);
    });
  });

  describe('Z14 statConcurrency 1', function () {
    it('file() calls including missing files (warnings)', async function () {
      const { upstream, ykk } = await runBoth(
        zip(() => ({ statConcurrency: 1 }), (archive) => {
          archive.file(fixture('file.txt'), { name: 'file.txt', date: DATE });
          archive.file(fixture('missing-1.txt'), { name: 'missing-1.txt', date: DATE });
          archive.file(fixture('exec.sh'), { name: 'exec.sh', date: DATE });
          archive.file(fixture('dir/a.txt'), { name: 'a.txt', date: DATE });
          archive.file(fixture('missing-2.txt'), { name: 'missing-2.txt', date: DATE });
          archive.file(fixture('dir/b.txt'), { name: 'b.txt', date: DATE });
        })
      );
      const zips = await assertSameArchive(upstream, ykk);
      assert.deepStrictEqual(zips.y.entries.map((entry) => entry.name), ['file.txt', 'exec.sh', 'a.txt', 'b.txt']);
      // upstream orders neither 'warning' nor entries.total / fs.totalBytes against 'entry' (stat queue)
      for (const kind of ['entry', 'warning', 'error']) {
        assert.deepStrictEqual(selectEvents(ykk.events, [kind]), selectEvents(upstream.events, [kind]));
      }
      const processed = (run) =>
        selectEvents(run.events, ['progress']).map((record) => [
          record.payload.entries.processed,
          record.payload.fs.processedBytes,
        ]);
      assert.deepStrictEqual(processed(ykk), processed(upstream));
      assert.deepStrictEqual(processed(ykk), [[1, 19], [2, 29], [3, 4029], [4, 4030]]);
      const warnings = selectEvents(ykk.events, ['warning']);
      assert.deepStrictEqual(warnings.map((record) => record.payload.code), ['ENOENT', 'ENOENT']);
      assert.deepStrictEqual(
        zips.y.entries.map((entry) => entry.central.externalAttributes >>> 16),
        [0o100644, 0o100755, 0o100644, 0o100600]
      );
    });
  });

  describe('Z15 one glob()', function () {
    it('cwd, ignore and dot', async function () {
      const { upstream, ykk } = await runBoth(
        zip(() => ({}), (archive) => {
          archive.glob(
            '**/*',
            { cwd: fixture('dir'), ignore: ['sub/ignore.txt', 'sub/deep/**'], dot: true },
            { date: DATE, prefix: 'globbed' }
          );
        })
      );
      const zips = await assertSameZip(upstream, ykk);
      assert.deepStrictEqual(
        zips.y.entries.map((entry) => entry.name).sort(),
        ['globbed/.hidden', 'globbed/a.txt', 'globbed/b.txt', 'globbed/empty.txt', 'globbed/sub/', 'globbed/sub/c.txt']
      );
    });

    it('cwd without dot', async function () {
      const { upstream, ykk } = await runBoth(
        zip(() => ({ store: true }), (archive) => {
          archive.glob('**/*', { cwd: fixture('dir') }, { date: DATE });
        })
      );
      const zips = assertSameBytes(upstream, ykk);
      assert.deepStrictEqual(
        zips.y.entries.map((entry) => entry.name).sort(),
        ['a.txt', 'b.txt', 'empty.txt', 'sub/', 'sub/c.txt', 'sub/deep/', 'sub/deep/d.txt', 'sub/ignore.txt']
      );
    });
  });
});
