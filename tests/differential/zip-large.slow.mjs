// PORTING.md 14.2: cases S1 to S5 (entries above 4 GiB, buffers above 1 GiB, 65536 entries). No upstream source.
// Run on demand: mocha --no-config --timeout 0 "tests/differential/*.slow.mjs"
import assert from 'node:assert/strict';
import { constants as bufferConstants } from 'node:buffer';
import crypto from 'node:crypto';
import { once } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Writable } from 'node:stream';
import { finished } from 'node:stream/promises';
import zlib from 'node:zlib';
import { decryptAes, decryptZip20 } from './helpers/decrypt.mjs';
import { omitV15Keys, selectEvents } from './helpers/events.mjs';
import { runBoth } from './helpers/run-both.mjs';
import { maskCentral, maskDescriptor, maskEndRecords, maskLocal, parseZip } from './helpers/zip-records.mjs';

const DATE = new Date('2020-03-04T05:06:08.000Z');
const PASSWORD = '123';
const SALT = Buffer.from('000102030405060708090a0b0c0d0e0f', 'hex');
const ZIP20_HEADER = Buffer.from('a0a1a2a3a4a5a6a7a8a9aaab', 'hex');
const NAME = 'big.bin';

const GIB = 0x40000000;
// S1: above 0xFFFFFFFF, so that the entry is zip64 by its size
const STREAMED_SIZE = 4 * GIB + 4096;
// S2: 1.5 GiB, more than one wasm call can carry and more than half of what a wasm vector can hold
const BUFFER_SIZE = 0x60000000;
// S3: the smallest length above 0xFFFFFFFF, which is also buffer.constants.MAX_LENGTH of Node 18 and 20
const HUGE_BUFFER_SIZE = 4 * GIB;
// S4: above the 2 GiB a wasm vector can hold, which the entry had to fit in while it was buffered in wasm (V16)
const ZIP20_SIZE = 2 * GIB + 0x100000;

// PORTING.md 17.2: salt (16), password verifier (2), MAC (10); the 12 ZipCrypto header bytes
const AES_OVERHEAD = 28;
const ZIP20_OVERHEAD = 12;
// what the sink keeps of both ends of an archive: more than the records around one entry
const KEEP = 0x10000;
const HASH_SLICE = 0x4000000;

let dir;

// PORTING.md 14.2 (S1, S4: a sparse file of zero bytes)
function sparseFile(name, size) {
  const file = path.join(dir, name);
  fs.closeSync(fs.openSync(file, 'w'));
  fs.truncateSync(file, size);
  return file;
}

// PORTING.md 14.2 (helper of the test: a destination that keeps the length, a SHA-256 and both ends of the output)
function digestSink() {
  const hash = crypto.createHash('sha256');
  let length = 0;
  let head = Buffer.alloc(0);
  let tail = Buffer.alloc(0);
  const sink = new Writable({
    write(chunk, encoding, callback) {
      for (let at = 0; at < chunk.length; at += HASH_SLICE) {
        hash.update(chunk.subarray(at, at + HASH_SLICE));
      }
      if (head.length < KEEP) {
        head = Buffer.concat([head, chunk.subarray(0, KEEP - head.length)]);
      }
      if (chunk.length >= KEEP) {
        tail = Buffer.from(chunk.subarray(chunk.length - KEEP));
      } else {
        tail = Buffer.concat([tail, chunk]);
        if (tail.length > KEEP) {
          tail = tail.subarray(tail.length - KEEP);
        }
      }
      length += chunk.length;
      callback();
    },
  });
  sink.summary = () => ({ length, sha256: hash.digest('hex'), head, tail });
  return sink;
}

// PORTING.md 14.2 (the suite runs without a timeout, and an 'error' unpipes the engine from the archive, after
// which finalize() never settles: the first 'error' fails the scenario instead)
async function finalized(archive) {
  const failed = once(archive, 'error').then(([err]) => {
    throw err;
  });
  await Promise.race([archive.finalize(), failed]);
}

// PORTING.md 14.2 (an archive too large to keep: it is piped into the sink, the scenario returns the summary)
function digested(format, options, add) {
  return async (impl, ctx) => {
    const archive = ctx.create(format, options(), { data: false });
    const sink = digestSink();
    archive.pipe(sink);
    add(archive);
    await finalized(archive);
    await finished(sink);
    return sink.summary();
  };
}

// PORTING.md 14.2 (an archive that is small because its one entry deflates well: collected as usual)
function collected(format, options, add) {
  return async (impl, ctx) => {
    const archive = ctx.create(format, options());
    add(archive);
    await finalized(archive);
  };
}

// PORTING.md 14.2 (events: for aes256 and zip20 the keys only the archiver 7 stack writes are ignored, V15)
function comparedEvents(run) {
  return omitV15Keys(selectEvents(run.events));
}

// PORTING.md 14.2 (comparison rules, stored zip and tar: whole-archive byte equality, by length and digest)
function assertSameDigest(upstream, ykk) {
  assert.deepStrictEqual(ykk.error, upstream.error);
  assert.equal(ykk.error, null);
  assert.equal(ykk.value.length, upstream.value.length);
  assert.equal(ykk.value.sha256, upstream.value.sha256);
  assert.deepStrictEqual(ykk.value.head, upstream.value.head);
  assert.deepStrictEqual(ykk.value.tail, upstream.value.tail);
  assert.deepStrictEqual(comparedEvents(ykk), comparedEvents(upstream));
  assert.equal(ykk.pointer, upstream.pointer);
  assert.equal(ykk.pointer, ykk.value.length);
}

// PORTING.md 17.1 (the local header at the start of an archive, from the kept head)
function readLocal(summary) {
  const head = summary.head;
  assert.equal(head.readUInt32LE(0), 0x04034b50);
  const nameLength = head.readUInt16LE(26);
  const extraLength = head.readUInt16LE(28);
  return {
    versionNeeded: head.readUInt16LE(4),
    flags: head.readUInt16LE(6),
    method: head.readUInt16LE(8),
    crc: head.readUInt32LE(14),
    compressedSize: head.readUInt32LE(18),
    size: head.readUInt32LE(22),
    name: head.toString('utf8', 30, 30 + nameLength),
    extra: head.subarray(30 + nameLength, 30 + nameLength + extraLength),
    length: 30 + nameLength + extraLength,
  };
}

// PORTING.md 17.1 (the end records, the one central header and the bytes in front of it, from the kept tail)
function readEnd(summary) {
  const tail = summary.tail;
  const base = summary.length - tail.length;
  const eocd = tail.length - 22;
  assert.equal(tail.readUInt32LE(eocd), 0x06054b50);
  const end = {
    entries: tail.readUInt16LE(eocd + 10),
    centralSize: tail.readUInt32LE(eocd + 12),
    centralOffset: tail.readUInt32LE(eocd + 16),
  };
  const zip64 = tail.readUInt32LE(eocd - 20) === 0x07064b50;
  let { entries, centralSize, centralOffset } = end;
  if (zip64) {
    const record = eocd - 20 - 56;
    assert.equal(tail.readUInt32LE(record), 0x06064b50);
    entries = Number(tail.readBigUInt64LE(record + 32));
    centralSize = Number(tail.readBigUInt64LE(record + 40));
    centralOffset = Number(tail.readBigUInt64LE(record + 48));
    assert.equal(Number(tail.readBigUInt64LE(eocd - 20 + 8)), centralOffset + centralSize);
  }
  const at = centralOffset - base;
  assert.equal(tail.readUInt32LE(at), 0x02014b50);
  const nameLength = tail.readUInt16LE(at + 28);
  const extraLength = tail.readUInt16LE(at + 30);
  return {
    zip64,
    end,
    entries,
    centralSize,
    centralOffset,
    central: {
      versionMadeBy: tail.readUInt16LE(at + 4),
      versionNeeded: tail.readUInt16LE(at + 6),
      flags: tail.readUInt16LE(at + 8),
      method: tail.readUInt16LE(at + 10),
      crc: tail.readUInt32LE(at + 16),
      compressedSize: tail.readUInt32LE(at + 20),
      size: tail.readUInt32LE(at + 24),
      localHeaderOffset: tail.readUInt32LE(at + 42),
      extra: tail.subarray(at + 46 + nameLength, at + 46 + nameLength + extraLength),
    },
    beforeCentral: tail.subarray(0, at),
  };
}

// PORTING.md 17.1 (zip64 extra: 01 00, 18 00, size, compressed size, local header offset)
function zip64Extra(size, compressedSize, localHeaderOffset) {
  const extra = Buffer.alloc(28);
  extra.writeUInt16LE(0x0001, 0);
  extra.writeUInt16LE(24, 2);
  extra.writeBigUInt64LE(BigInt(size), 4);
  extra.writeBigUInt64LE(BigInt(compressedSize), 12);
  extra.writeBigUInt64LE(BigInt(localHeaderOffset), 20);
  return extra;
}

// PORTING.md 17.1 (data descriptor of a zip64 entry: signature, CRC, 8-byte sizes)
function readDescriptor24(bytes) {
  const descriptor = bytes.subarray(bytes.length - 24);
  assert.equal(descriptor.readUInt32LE(0), 0x08074b50);
  return {
    crc: descriptor.readUInt32LE(4),
    compressedSize: Number(descriptor.readBigUInt64LE(8)),
    size: Number(descriptor.readBigUInt64LE(16)),
  };
}

// PORTING.md 14.2 (comparison rules, deflated zip: the inflated payload, as length and digest)
async function inflatedDigest(compressed) {
  const hash = crypto.createHash('sha256');
  let length = 0;
  const inflate = zlib.createInflateRaw();
  inflate.on('data', (chunk) => {
    hash.update(chunk);
    length += chunk.length;
  });
  const ended = once(inflate, 'end');
  inflate.end(compressed);
  await ended;
  return { length, sha256: hash.digest('hex') };
}

// PORTING.md 14.2 (comparison rules, deflated zip: central directory size and offset are checked only relationally)
function assertEndRecords(zip) {
  assert.equal(zip.centralEnd, zip.centralOffset + zip.centralSize, 'central directory size');
  assert.equal(zip.centralEnd, zip.zip64End !== null ? zip.zip64End.offset : zip.end.offset, 'central directory end');
  if (zip.zip64Locator !== null) {
    assert.equal(zip.zip64Locator.zip64EndOffset, zip.zip64End.offset, 'zip64 locator offset');
  }
}

// PORTING.md 14.2 (comparison rules, deflated zip: one entry whose inflated payload cannot be kept in memory)
async function assertSameDeflated(upstream, ykk, size, overhead) {
  assert.deepStrictEqual(ykk.error, upstream.error);
  assert.equal(ykk.error, null);
  const u = parseZip(upstream.bytes);
  const y = parseZip(ykk.bytes);
  assert.deepStrictEqual(y.entries.map((entry) => entry.name), [NAME]);
  assert.deepStrictEqual(u.entries.map((entry) => entry.name), [NAME]);
  const digests = [];
  for (const entry of [u.entries[0], y.entries[0]]) {
    assert.equal(entry.central.effective.compressedSize, entry.payload.length);
    assert.equal(entry.descriptor.compressedSize, entry.payload.length);
    let compressed = entry.payload;
    if (overhead === AES_OVERHEAD) {
      const decrypted = decryptAes(entry.payload, PASSWORD);
      assert.equal(decrypted.verifierOk, true);
      assert.equal(decrypted.macOk, true);
      compressed = decrypted.data;
    }
    assert.equal(entry.payload.length, compressed.length + overhead);
    digests.push(await inflatedDigest(compressed));
  }
  assert.equal(digests[0].length, size);
  assert.deepStrictEqual(digests[1], digests[0]);
  assert.deepStrictEqual(maskLocal(y.entries[0].local), maskLocal(u.entries[0].local));
  assert.deepStrictEqual(maskDescriptor(y.entries[0].descriptor), maskDescriptor(u.entries[0].descriptor));
  assert.deepStrictEqual(maskCentral(y.entries[0].central), maskCentral(u.entries[0].central));
  assert.deepStrictEqual(maskEndRecords(y), maskEndRecords(u));
  assertEndRecords(u);
  assertEndRecords(y);
  assert.deepStrictEqual(comparedEvents(ykk), comparedEvents(upstream));
  return { u, y };
}

describe('differential (slow): large zip entries', function () {
  before(function () {
    dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ykk-diff-large-')));
  });

  after(function () {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  describe('S1 a streamed entry above 4 GiB from a sparse file (P15, P18, P19)', function () {
    let sparse;
    const add = (archive) => {
      archive.append(fs.createReadStream(sparse), { name: NAME, date: DATE });
    };

    before(function () {
      sparse = sparseFile('above-4gib.bin', STREAMED_SIZE);
    });

    it('zip, stored', async function () {
      const { upstream, ykk } = await runBoth(digested('zip', () => ({ store: true }), add));
      assertSameDigest(upstream, ykk);
      const local = readLocal(ykk.value);
      const end = readEnd(ykk.value);
      assert.equal(ykk.value.length, local.length + STREAMED_SIZE + 24 + end.centralSize + 56 + 20 + 22);
      // no zip64 extra in the local header (P15)
      assert.equal(local.versionNeeded, 20);
      assert.equal(local.flags, 0x0008);
      assert.equal(local.method, 0);
      assert.deepStrictEqual([local.crc, local.compressedSize, local.size], [0, 0, 0]);
      assert.equal(local.extra.length, 0);
      const descriptor = readDescriptor24(end.beforeCentral);
      assert.equal(descriptor.compressedSize, STREAMED_SIZE);
      assert.equal(descriptor.size, STREAMED_SIZE);
      assert.equal(descriptor.crc, end.central.crc);
      assert.equal(end.central.versionNeeded, 45);
      assert.equal(end.central.compressedSize, 0xffffffff);
      assert.equal(end.central.size, 0xffffffff);
      assert.equal(end.central.localHeaderOffset, 0xffffffff);
      assert.deepStrictEqual(end.central.extra, zip64Extra(STREAMED_SIZE, STREAMED_SIZE, 0));
      assert.equal(end.zip64, true);
      assert.equal(end.entries, 1);
      assert.equal(end.centralOffset, local.length + STREAMED_SIZE + 24);
      assert.deepStrictEqual(end.end, { entries: 0xffff, centralSize: 0xffffffff, centralOffset: 0xffffffff });
    });

    it('zip, deflated', async function () {
      const { upstream, ykk } = await runBoth(collected('zip', () => ({}), add));
      const zips = await assertSameDeflated(upstream, ykk, STREAMED_SIZE, 0);
      for (const parsed of [zips.u, zips.y]) {
        const entry = parsed.entries[0];
        assert.equal(entry.local.extraLength, 0);
        assert.equal(entry.local.versionNeeded, 20);
        assert.equal(entry.descriptor.length, 24);
        assert.equal(entry.descriptor.size, STREAMED_SIZE);
        assert.equal(entry.central.versionNeeded, 45);
        assert.equal(entry.central.size, 0xffffffff);
        assert.equal(entry.central.compressedSize, 0xffffffff);
        assert.equal(entry.central.localHeaderOffset, 0xffffffff);
        assert.equal(entry.central.zip64.size, STREAMED_SIZE);
        assert.equal(parsed.zip64End, null);
      }
    });

    it('aes256, stored', async function () {
      const { upstream, ykk } = await runBoth(
        digested('aes256', () => ({ password: PASSWORD, salt: Buffer.from(SALT), store: true }), add)
      );
      assertSameDigest(upstream, ykk);
      const local = readLocal(ykk.value);
      const end = readEnd(ykk.value);
      const aesExtra = Buffer.from('0199070001004145030000', 'hex');
      assert.equal(ykk.value.length, local.length + STREAMED_SIZE + AES_OVERHEAD + 24 + end.centralSize + 56 + 20 + 22);
      assert.equal(local.versionNeeded, 51);
      assert.equal(local.flags, 0x0009);
      assert.equal(local.method, 99);
      assert.deepStrictEqual(local.extra, aesExtra);
      const descriptor = readDescriptor24(end.beforeCentral);
      assert.equal(descriptor.compressedSize, STREAMED_SIZE + AES_OVERHEAD);
      assert.equal(descriptor.size, STREAMED_SIZE);
      // AE-1: the real CRC (P19)
      assert.notEqual(descriptor.crc, 0);
      assert.equal(end.central.crc, descriptor.crc);
      // 51 lowered to 45 for zip64 (P18)
      assert.equal(end.central.versionNeeded, 45);
      assert.equal(end.central.method, 99);
      assert.equal(end.central.compressedSize, 0xffffffff);
      assert.equal(end.central.size, 0xffffffff);
      // the 32-bit offset stays real unless the offset itself overflows (P19)
      assert.equal(end.central.localHeaderOffset, 0);
      assert.deepStrictEqual(
        end.central.extra,
        Buffer.concat([aesExtra, zip64Extra(STREAMED_SIZE, STREAMED_SIZE + AES_OVERHEAD, 0)])
      );
      assert.equal(end.zip64, true);
    });

    it('aes256, deflated', async function () {
      const { upstream, ykk } = await runBoth(
        collected('aes256', () => ({ password: PASSWORD, salt: Buffer.from(SALT) }), add)
      );
      const zips = await assertSameDeflated(upstream, ykk, STREAMED_SIZE, AES_OVERHEAD);
      for (const parsed of [zips.u, zips.y]) {
        const entry = parsed.entries[0];
        assert.equal(entry.local.versionNeeded, 51);
        assert.equal(entry.central.versionNeeded, 45);
        assert.equal(entry.central.localHeaderOffset, 0);
        assert.equal(entry.central.aes.method, 8);
        assert.equal(entry.central.zip64.size, STREAMED_SIZE);
        assert.equal(entry.descriptor.length, 24);
      }
    });
  });

  describe('S2 a 1.5 GiB Buffer (V16)', function () {
    let buffer;
    const add = (archive) => {
      archive.append(buffer, { name: NAME, date: DATE });
    };

    before(function () {
      buffer = Buffer.alloc(BUFFER_SIZE);
    });

    after(function () {
      buffer = undefined;
    });

    it('zip, stored', async function () {
      const { upstream, ykk } = await runBoth(digested('zip', () => ({ store: true }), add));
      assertSameDigest(upstream, ykk);
      const local = readLocal(ykk.value);
      const end = readEnd(ykk.value);
      assert.equal(ykk.value.length, local.length + BUFFER_SIZE + end.centralSize + 22);
      assert.equal(local.versionNeeded, 10);
      assert.equal(local.flags, 0);
      assert.equal(local.compressedSize, BUFFER_SIZE);
      assert.equal(local.size, BUFFER_SIZE);
      assert.equal(local.crc, end.central.crc);
      assert.notEqual(local.crc, 0);
      assert.equal(end.central.size, BUFFER_SIZE);
      assert.equal(end.zip64, false);
    });

    it('zip, deflated', async function () {
      const { upstream, ykk } = await runBoth(collected('zip', () => ({}), add));
      const zips = await assertSameDeflated(upstream, ykk, BUFFER_SIZE, 0);
      assert.equal(zips.y.entries[0].central.size, BUFFER_SIZE);
      assert.equal(zips.y.entries[0].descriptor.length, 16);
    });

    it('aes256, stored', async function () {
      const { upstream, ykk } = await runBoth(
        digested('aes256', () => ({ password: PASSWORD, salt: Buffer.from(SALT), store: true }), add)
      );
      assertSameDigest(upstream, ykk);
      const local = readLocal(ykk.value);
      const end = readEnd(ykk.value);
      assert.equal(ykk.value.length, local.length + BUFFER_SIZE + AES_OVERHEAD + end.centralSize + 22);
      assert.equal(local.versionNeeded, 51);
      assert.equal(local.flags, 0x0001);
      assert.equal(local.compressedSize, BUFFER_SIZE + AES_OVERHEAD);
      assert.equal(local.size, BUFFER_SIZE);
      assert.equal(end.central.compressedSize, BUFFER_SIZE + AES_OVERHEAD);
      assert.deepStrictEqual(ykk.value.head.subarray(local.length, local.length + 16), SALT);
    });

    it('aes256, deflated', async function () {
      const { upstream, ykk } = await runBoth(
        collected('aes256', () => ({ password: PASSWORD, salt: Buffer.from(SALT) }), add)
      );
      const zips = await assertSameDeflated(upstream, ykk, BUFFER_SIZE, AES_OVERHEAD);
      assert.equal(zips.y.entries[0].central.size, BUFFER_SIZE);
    });

    it('tar', async function () {
      const { upstream, ykk } = await runBoth(digested('tar', () => ({}), add));
      assertSameDigest(upstream, ykk);
      // header block, body (a multiple of 512), two zero blocks
      assert.equal(ykk.value.length, 512 + BUFFER_SIZE + 1024);
      assert.equal(ykk.value.head.toString('latin1', 0, NAME.length), NAME);
    });
  });

  describe('S3 a stored Buffer above 0xFFFFFFFF bytes (ZIP-058)', function () {
    // "where the Node version allows one": the case exists only there
    if (bufferConstants.MAX_LENGTH >= HUGE_BUFFER_SIZE) {
      it('zip, stored', async function () {
        let buffer = Buffer.alloc(HUGE_BUFFER_SIZE);
        const { upstream, ykk } = await runBoth(
          digested('zip', () => ({ store: true }), (archive) => {
            archive.append(buffer, { name: NAME, date: DATE });
          })
        );
        buffer = undefined;
        assertSameDigest(upstream, ykk);
        const local = readLocal(ykk.value);
        const end = readEnd(ykk.value);
        assert.equal(ykk.value.length, local.length + HUGE_BUFFER_SIZE + 24 + end.centralSize + 56 + 20 + 22);
        // already zip64 when the local header is written: descriptor bit forced on, version 45, no zip64 extra
        assert.equal(local.versionNeeded, 45);
        assert.equal(local.flags, 0x0008);
        assert.equal(local.method, 0);
        assert.deepStrictEqual([local.crc, local.compressedSize, local.size], [0, 0, 0]);
        assert.equal(local.extra.length, 0);
        const descriptor = readDescriptor24(end.beforeCentral);
        assert.equal(descriptor.compressedSize, HUGE_BUFFER_SIZE);
        assert.equal(descriptor.size, HUGE_BUFFER_SIZE);
        assert.equal(descriptor.crc, end.central.crc);
        assert.equal(end.central.versionNeeded, 45);
        assert.equal(end.central.flags, 0x0008);
        assert.deepStrictEqual(end.central.extra, zip64Extra(HUGE_BUFFER_SIZE, HUGE_BUFFER_SIZE, 0));
        assert.equal(end.zip64, true);
      });
    }
  });

  describe('S4 a ZipCrypto entry above 1 GiB (V16)', function () {
    let sparse;
    const add = (archive) => {
      archive.append(fs.createReadStream(sparse), { name: NAME, date: DATE });
    };

    before(function () {
      sparse = sparseFile('above-2gib.bin', ZIP20_SIZE);
    });

    it('zip20, stored', async function () {
      const { upstream, ykk } = await runBoth(
        digested('zip20', () => ({ password: PASSWORD, store: true }), add),
        { random: ZIP20_HEADER }
      );
      assertSameDigest(upstream, ykk);
      assert.deepStrictEqual(selectEvents(ykk.events, ['error', 'warning']), []);
      assert.equal(selectEvents(ykk.events, ['entry']).length, 1);
      for (const run of [upstream, ykk]) {
        const local = readLocal(run.value);
        const end = readEnd(run.value);
        assert.equal(run.value.length, local.length + ZIP20_OVERHEAD + ZIP20_SIZE + end.centralSize + 22);
        // the entry is buffered until it ends (V16 (c)), so the local header has the sizes and no descriptor follows
        assert.equal(local.flags, 0x0001);
        assert.equal(local.method, 0);
        assert.equal(local.size, ZIP20_SIZE);
        assert.equal(local.compressedSize, ZIP20_SIZE + ZIP20_OVERHEAD);
        assert.notEqual(local.crc, 0);
        assert.equal(end.central.crc, local.crc);
        assert.equal(end.central.flags, 0x0001);
        assert.equal(end.central.size, ZIP20_SIZE);
        assert.equal(end.central.compressedSize, ZIP20_SIZE + ZIP20_OVERHEAD);
        assert.equal(end.central.localHeaderOffset, 0);
        assert.equal(end.zip64, false);
        assert.equal(end.entries, 1);
        assert.equal(end.centralOffset, local.length + ZIP20_OVERHEAD + ZIP20_SIZE);
      }
    });

    it('zip20, deflated', async function () {
      const { upstream, ykk } = await runBoth(collected('zip20', () => ({ password: PASSWORD }), add), {
        random: ZIP20_HEADER,
      });
      assert.deepStrictEqual(ykk.error, upstream.error);
      assert.equal(ykk.error, null);
      const u = parseZip(upstream.bytes);
      const y = parseZip(ykk.bytes);
      const digests = [];
      for (const parsed of [u, y]) {
        assert.deepStrictEqual(parsed.entries.map((entry) => entry.name), [NAME]);
        const entry = parsed.entries[0];
        assert.equal(entry.local.flags, 0x0001);
        assert.equal(entry.local.method, 8);
        assert.equal(entry.local.size, ZIP20_SIZE);
        assert.equal(entry.local.compressedSize, entry.payload.length);
        assert.equal(entry.descriptor, null);
        assert.equal(entry.central.size, ZIP20_SIZE);
        assert.equal(entry.central.compressedSize, entry.payload.length);
        assert.equal(entry.central.crc, entry.local.crc);
        const decrypted = await decryptZip20(entry.payload, PASSWORD);
        assert.equal(entry.payload.length, decrypted.data.length + ZIP20_OVERHEAD);
        // bytes 10 and 11 of the header are the CRC check bytes (V10)
        assert.deepStrictEqual(decrypted.header.subarray(0, 10), ZIP20_HEADER.subarray(0, 10));
        assert.equal(decrypted.header.readUInt16LE(10), entry.central.crc >>> 16);
        digests.push(await inflatedDigest(decrypted.data));
        assertEndRecords(parsed);
        assert.equal(parsed.zip64End, null);
      }
      assert.equal(digests[0].length, ZIP20_SIZE);
      assert.deepStrictEqual(digests[1], digests[0]);
      assert.equal(y.entries[0].central.crc, u.entries[0].central.crc);
      assert.deepStrictEqual(maskLocal(y.entries[0].local), maskLocal(u.entries[0].local));
      assert.deepStrictEqual(maskCentral(y.entries[0].central), maskCentral(u.entries[0].central));
      assert.deepStrictEqual(maskEndRecords(y), maskEndRecords(u));
      assert.deepStrictEqual(comparedEvents(ykk), comparedEvents(upstream));
      assert.deepStrictEqual(selectEvents(ykk.events, ['error', 'warning']), []);
    });
  });

  describe('S5 zip64 by entry count', function () {
    const scenario = (count) =>
      async (impl, ctx) => {
        const archive = ctx.create('zip', { store: true });
        for (let i = 0; i < count; i++) {
          archive.append('', { name: `e${i}`, date: DATE });
        }
        await finalized(archive);
      };

    it('65535 entries: no zip64 records', async function () {
      const { upstream, ykk } = await runBoth(scenario(65535));
      assert.deepStrictEqual(ykk.error, upstream.error);
      assert.deepStrictEqual(selectEvents(ykk.events), selectEvents(upstream.events));
      assert.deepStrictEqual(ykk.bytes, upstream.bytes);
      assert.equal(ykk.pointer, upstream.pointer);
      const parsed = parseZip(ykk.bytes);
      assert.equal(parsed.zip64End, null);
      assert.equal(parsed.zip64Locator, null);
      assert.equal(parsed.end.entries, 65535);
      assert.equal(parsed.entries.length, 65535);
    });

    it('65536 entries', async function () {
      const { upstream, ykk } = await runBoth(scenario(65536));
      assert.deepStrictEqual(ykk.error, upstream.error);
      assert.deepStrictEqual(selectEvents(ykk.events), selectEvents(upstream.events));
      assert.deepStrictEqual(ykk.bytes, upstream.bytes);
      assert.equal(ykk.pointer, upstream.pointer);
      const parsed = parseZip(ykk.bytes);
      assert.notEqual(parsed.zip64End, null);
      assert.notEqual(parsed.zip64Locator, null);
      assert.equal(parsed.end.entries, 0xffff);
      assert.equal(parsed.end.entriesOnDisk, 0xffff);
      assert.equal(parsed.end.centralSize, 0xffffffff);
      assert.equal(parsed.end.centralOffset, 0xffffffff);
      assert.equal(parsed.zip64End.entries, 65536);
      assert.equal(parsed.zip64End.entriesOnDisk, 65536);
      assert.equal(parsed.entries.length, 65536);
      assert.equal(parsed.entries[65535].name, 'e65535');
      // the entries themselves stay as they are (P15)
      assert.equal(parsed.entries[65535].central.versionNeeded, 10);
      assert.equal(parsed.entries[65535].central.extraLength, 0);
    });
  });
});
