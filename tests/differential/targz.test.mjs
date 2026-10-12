// tests/differential/targz.test.mjs
// Differential cases G1 and G2 of PORTING.md 14.2: tar.gz archives, and abort() with and without gzip.
// The scenarios are exported so that a child process and the extraction checks (14.4) can run them;
// g1 takes the fixture tree of makeTree() as ctx.args.root and the gzip option bag as
// ctx.args.gzipOptions (absent: the option is not passed).

import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import zlib from 'node:zlib';

import { selectEvents } from './helpers/events.mjs';
import { HANG_QUIET_MS, load, runBoth } from './helpers/run-both.mjs';
import { parseTar, splitGzip } from './helpers/tar-records.mjs';

const require = createRequire(import.meta.url);
const lazystream = require('lazystream');

const DATE = new Date('2013-01-03T14:26:38.000Z');
// PORTING.md R14: the OS byte of Node's zlib on this platform
const GZIP_OS = process.platform === 'darwin' ? 19 : process.platform === 'win32' ? 10 : 3;
const ABORT_MESSAGE = "Cannot read properties of undefined (reading 'apply')";

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
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'archiver-wasm-diff-targz-')));
  const target = path.join(root, 'b.bin');
  fs.writeFileSync(target, Buffer.alloc(600, 0x62));
  fs.chmodSync(target, 0o600);
  fs.lutimesSync(target, DATE, DATE);
  return root;
}

// PORTING.md 14.2
function removeTree(root) {
  fs.rmSync(root, { recursive: true, force: true });
}

// PORTING.md 14.2 (case G1: the inputs of T1 with gzip: true)
async function g1(impl, ctx) {
  const archive = ctx.create('tar.gz', 'gzipOptions' in ctx.args ? { gzipOptions: ctx.args.gzipOptions } : {});
  archive.append(Buffer.alloc(0), { name: 'empty-buffer.txt', date: DATE });
  archive.append(streamOf([]), { name: 'empty-stream.txt', date: DATE });
  archive.append(null, { name: 'null-source.txt', date: DATE });
  archive.append('string', { name: 'string.txt', date: DATE });
  archive.append(binaryBuffer(1), { name: 'buffer-1.bin', date: DATE });
  archive.append(binaryBuffer(511), { name: 'buffer-511.bin', date: DATE });
  archive.append(binaryBuffer(512), { name: 'buffer-512.bin', date: DATE });
  archive.append(binaryBuffer(513), { name: 'buffer-513.bin', date: DATE });
  archive.append(binaryBuffer(1024), { name: 'buffer-1024.bin', date: DATE });
  archive.append(binaryBuffer(16384), { name: 'buffer-16384.bin', date: DATE });
  archive.append(streamOf([binaryBuffer(512)]), { name: 'stream-512.bin', date: DATE });
  archive.append(streamOf([binaryBuffer(300), binaryBuffer(700)]), { name: 'stream-1000.bin', date: DATE });
  archive.append(
    new lazystream.Readable(function () {
      return fs.createReadStream(path.join(ctx.args.root, 'b.bin'));
    }),
    { name: 'lazy-600.bin', date: DATE }
  );
  await archive.finalize();
}

// PORTING.md 14.2 (case G2: abort() with gzip before any entry)
async function g2GzipBeforeEntry(impl, ctx) {
  const archive = ctx.create('tar.gz');
  return archive.abort() === archive;
}

// PORTING.md 14.2 (case G2: abort() with gzip in the tick of an append())
async function g2GzipAfterAppend(impl, ctx) {
  const archive = ctx.create('tar.gz');
  archive.append('x', { name: 'never-written.txt', date: DATE });
  return archive.abort() === archive;
}

// PORTING.md 14.2 (case G2: abort() without gzip throws out of Tar.unpipe, P9)
async function g2PlainBeforeEntry(impl, ctx) {
  const archive = ctx.create('tar');
  assert.throws(
    function () {
      archive.abort();
    },
    { name: 'TypeError', message: ABORT_MESSAGE }
  );
  return archive._state.aborted;
}

// PORTING.md 14.2 (case G2: the same in the tick of an append())
async function g2PlainAfterAppend(impl, ctx) {
  const archive = ctx.create('tar');
  archive.append('x', { name: 'never-written.txt', date: DATE });
  assert.throws(
    function () {
      archive.abort();
    },
    { name: 'TypeError', message: ABORT_MESSAGE }
  );
  return archive._state.aborted;
}

// PORTING.md 14.2 (comparison rules, tar.gz: equal 10-byte header, equal gunzipped payload, equal 8-byte trailer)
function assertSameGzip({ upstream, port }, xfl) {
  assert.strictEqual(upstream.error, null);
  assert.deepStrictEqual(port.error, upstream.error);
  const expected = splitGzip(upstream.bytes);
  const actual = splitGzip(port.bytes);
  const header = Buffer.from([0x1f, 0x8b, 0x08, 0x00, 0x00, 0x00, 0x00, 0x00, xfl, GZIP_OS]).toString('hex');
  assert.strictEqual(expected.header.toString('hex'), header);
  assert.strictEqual(actual.header.toString('hex'), header);
  assert.ok(actual.payload.equals(expected.payload), 'gunzipped payload');
  assert.strictEqual(actual.trailer.toString('hex'), expected.trailer.toString('hex'));
  assert.strictEqual(actual.size, expected.payload.length);
  assert.ok(zlib.gunzipSync(port.bytes).equals(expected.payload), 'one gzip member');
  assert.deepStrictEqual(selectEvents(port.events), selectEvents(upstream.events));
  return parseTar(actual.payload);
}

// PORTING.md 14.2 (class D: whole output, exact event sequences with 'end' and 'close', pointer())
function assertSameAbort({ upstream, port }, value, names) {
  assert.strictEqual(upstream.error, null);
  assert.deepStrictEqual(port.error, upstream.error);
  assert.strictEqual(upstream.value, value);
  assert.strictEqual(port.value, value);
  assert.strictEqual(upstream.bytes.length, 0);
  assert.ok(port.bytes.equals(upstream.bytes));
  assert.deepStrictEqual(
    upstream.events.map((record) => record.event),
    names
  );
  assert.deepStrictEqual(port.events, upstream.events);
  assert.strictEqual(port.pointer, upstream.pointer);
}

describe('differential: tar.gz', function () {
  let root;

  before(function () {
    root = makeTree();
  });

  after(function () {
    removeTree(root);
  });

  it('G1: the T1 inputs with gzip: true and the default level', async function () {
    const tar = assertSameGzip(await runBoth(g1, { args: { root } }), 0);
    assert.deepStrictEqual(
      tar.entries.map((entry) => entry.header.size),
      [0, 0, 0, 6, 1, 511, 512, 513, 1024, 16384, 512, 1000, 600]
    );
    assert.ok(tar.trailer.equals(Buffer.alloc(1024)));
  });

  // XFL (TAR-JSON-005): 2 for level 9, 4 for level 0 and 1 and for the strategies from Z_HUFFMAN_ONLY on, else 0
  for (const [label, gzipOptions, xfl] of [
    ['level 0', { level: 0 }, 4],
    ['level 1', { level: 1 }, 4],
    ['level 6', { level: 6 }, 0],
    ['level 9', { level: 9 }, 2],
    ['level -1', { level: -1 }, 0],
    ['level 6 with Z_HUFFMAN_ONLY', { level: 6, strategy: zlib.constants.Z_HUFFMAN_ONLY }, 4],
    ['level 9 with Z_HUFFMAN_ONLY', { level: 9, strategy: zlib.constants.Z_HUFFMAN_ONLY }, 2],
    ['Z_RLE', { strategy: zlib.constants.Z_RLE }, 4],
    ['Z_FILTERED', { strategy: zlib.constants.Z_FILTERED }, 0],
  ]) {
    it(`G1: gzipOptions with ${label} writes XFL ${xfl} and the OS byte of the platform (R14)`, async function () {
      assertSameGzip(await runBoth(g1, { args: { root, gzipOptions } }), xfl);
    });
  }

  it('G1: gzipOptions null and a gzipOptions that is not an object give the default level', async function () {
    assertSameGzip(await runBoth(g1, { args: { root, gzipOptions: null } }), 0);
    assertSameGzip(await runBoth(g1, { args: { root, gzipOptions: 'fast' } }), 0);
  });

  it('G1: zlib options other than level and strategy are validated and have no effect on the container (V2)', async function () {
    assertSameGzip(await runBoth(g1, { args: { root, gzipOptions: { memLevel: 1, windowBits: 9, chunkSize: 64 } } }), 0);
    const upstream = await load('upstream');
    const port = await load('port');
    for (const gzipOptions of [{ level: 10 }, { level: 'x' }, { windowBits: 7 }, { chunkSize: 1 }, { strategy: 9 }, { memLevel: 0 }]) {
      let expected;
      try {
        new upstream.TarArchive({ gzip: true, gzipOptions });
      } catch (err) {
        expected = err;
      }
      assert.ok(expected instanceof Error, `upstream accepts ${JSON.stringify(gzipOptions)}`);
      assert.throws(
        function () {
          new port.TarArchive({ gzip: true, gzipOptions });
        },
        { name: expected.name, code: expected.code, message: expected.message }
      );
    }
  });

  it('G2: abort() with gzip ends the archive with no output', async function () {
    assertSameAbort(await runBoth(g2GzipBeforeEntry), true, ['end', 'close']);
    assertSameAbort(await runBoth(g2GzipAfterAppend), true, ['end', 'close']);
  });

  // the archive never ends after the throw: the result is taken after the quiet period of the hang rule
  it('G2: abort() without gzip throws the TypeError of Tar.unpipe and never ends (P9)', async function () {
    assertSameAbort(await runBoth(g2PlainBeforeEntry, { hang: HANG_QUIET_MS }), true, []);
  });

  it('G2: abort() without gzip in the tick of an append() writes no entry and never ends (P9)', async function () {
    assertSameAbort(await runBoth(g2PlainAfterAppend, { hang: HANG_QUIET_MS }), true, []);
  });
});
