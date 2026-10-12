// PORTING.md 14.2: cases C1 and C2 (ZipCrypto). No upstream source.
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { PassThrough } from 'node:stream';
import { decryptZip20, entryData } from './helpers/decrypt.mjs';
import { omitV15Keys, selectEvents } from './helpers/events.mjs';
import { load, runBoth } from './helpers/run-both.mjs';
import { maskCentral, maskDescriptor, maskEndRecords, maskLocal, parseZip } from './helpers/zip-records.mjs';

const DATE = new Date('2020-03-04T05:06:08.000Z');
const PASSWORD = '123';
const ZIP20_HEADER = Buffer.from('a0a1a2a3a4a5a6a7a8a9aaab', 'hex');
const TEXT = Buffer.from('this is a text file');
const BIG = Buffer.alloc(4000, 'abcdefghij');
// PORTING.md 17.2: the 12 encrypted header bytes in front of the data
const ZIP20_OVERHEAD = 12;

// PORTING.md 14.2 (helper of the test: a fresh stream per implementation, written in the given chunks)
function streamOf(chunks) {
  const stream = new PassThrough();
  for (const chunk of chunks) {
    stream.write(chunk);
  }
  stream.end();
  return stream;
}

// PORTING.md 14.2 (one zip20 archive per implementation: `options()` is a fresh object per run, `add` appends)
function zip20(options, add) {
  return async (impl, ctx) => {
    const archive = ctx.create('zip20', { password: PASSWORD, ...options() });
    await add(archive, impl);
    await archive.finalize();
  };
}

// PORTING.md 14.2 (events: for aes256 and zip20 the keys only the archiver 7 stack writes are ignored, V15)
function comparedEvents(run) {
  return omitV15Keys(selectEvents(run.events));
}

// PORTING.md 3.3 P17 (a stored entry with zero data bytes declares 12 bytes and writes none)
function isP17(entry) {
  return entry.central.method === 0 && entry.central.size === 0;
}

// PORTING.md 14.2 (comparison rules: compressed size == payload length; 17.2: header = 10 random bytes, CRC bits 16..31)
async function assertSizes(entry) {
  assert.equal(entry.descriptor, null, `${entry.name}: no data descriptor`);
  assert.equal(entry.local.compressedSize, entry.central.compressedSize, `${entry.name}: local compressed size`);
  if (isP17(entry)) {
    assert.equal(entry.central.compressedSize, ZIP20_OVERHEAD, `${entry.name}: declared compressed size (P17)`);
    assert.equal(entry.payload.length, 0, `${entry.name}: bytes written (P17)`);
    return;
  }
  assert.equal(entry.central.compressedSize, entry.payload.length, `${entry.name}: central compressed size`);
  const decrypted = await decryptZip20(entry.payload, PASSWORD);
  assert.equal(entry.payload.length, decrypted.data.length + ZIP20_OVERHEAD, `${entry.name}: payload length`);
  assert.deepStrictEqual(
    decrypted.header,
    Buffer.concat([
      ZIP20_HEADER.subarray(0, 10),
      Buffer.from([(entry.central.crc >>> 16) & 0xff, (entry.central.crc >>> 24) & 0xff]),
    ]),
    `${entry.name}: encryption header`
  );
}

// PORTING.md 14.2 (comparison rules, deflated zip: central directory size and offset are checked only relationally)
function assertEndRecords(zip) {
  assert.equal(zip.centralEnd, zip.centralOffset + zip.centralSize, 'central directory size');
  assert.equal(zip.centralEnd, zip.zip64End !== null ? zip.zip64End.offset : zip.end.offset, 'central directory end');
  if (zip.zip64Locator !== null) {
    assert.equal(zip.zip64Locator.zip64EndOffset, zip.zip64End.offset, 'zip64 locator offset');
  }
}

// PORTING.md 14.2 (comparison rules, deflated zip: one entry, payload decrypted and inflated)
async function assertSameEntry(u, y) {
  assert.deepStrictEqual(maskLocal(y.local), maskLocal(u.local), `${u.name}: local header`);
  assert.deepStrictEqual(await entryData(y, PASSWORD), await entryData(u, PASSWORD), `${u.name}: payload`);
  assert.equal(y.descriptor === null, u.descriptor === null, `${u.name}: data descriptor present`);
  if (u.descriptor !== null) {
    assert.deepStrictEqual(maskDescriptor(y.descriptor), maskDescriptor(u.descriptor), `${u.name}: data descriptor`);
  }
  assert.deepStrictEqual(maskCentral(y.central), maskCentral(u.central), `${u.name}: central header`);
  await assertSizes(u);
  await assertSizes(y);
}

// PORTING.md 14.2 (comparison rules, deflated zip, class D; events: the exact sequence)
async function assertSameZip(upstream, port) {
  assert.deepStrictEqual(port.error, upstream.error);
  const u = parseZip(upstream.bytes);
  const y = parseZip(port.bytes);
  assert.deepStrictEqual(y.entries.map((entry) => entry.name), u.entries.map((entry) => entry.name));
  for (let i = 0; i < u.entries.length; i++) {
    await assertSameEntry(u.entries[i], y.entries[i]);
  }
  assert.deepStrictEqual(y.prefix, u.prefix);
  assert.deepStrictEqual(maskEndRecords(y), maskEndRecords(u));
  assertEndRecords(u);
  assertEndRecords(y);
  assert.deepStrictEqual(comparedEvents(port), comparedEvents(upstream));
  return { u, y };
}

// PORTING.md 14.2 (comparison rules, stored encrypted zip: whole-archive byte equality, events, pointer)
function assertSameBytes(upstream, port) {
  assert.deepStrictEqual(port.error, upstream.error);
  assert.deepStrictEqual(port.bytes, upstream.bytes);
  assert.deepStrictEqual(comparedEvents(port), comparedEvents(upstream));
  assert.equal(port.pointer, upstream.pointer);
  if (port.pointer !== null) {
    assert.equal(port.pointer, port.bytes.length);
  }
  return { u: parseZip(upstream.bytes), y: parseZip(port.bytes) };
}

// PORTING.md 14.2 (helper of the test: the entries of both archives, for an assertion made on each)
function both(zips) {
  return [zips.u, zips.y];
}

describe('differential: zip (zip20)', function () {
  describe('C1 buffer and stream, the stored empty entry and a directory (P17, P18)', function () {
    const add = (archive) => {
      archive.append(BIG, { name: 'buffer.txt', date: DATE });
      archive.append(streamOf([BIG.subarray(0, 1500), BIG.subarray(1500)]), { name: 'stream.txt', date: DATE });
      archive.append(Buffer.alloc(0), { name: 'empty.txt', date: DATE });
      archive.append(streamOf([]), { name: 'empty-stream.txt', date: DATE });
      archive.append(null, { name: 'd/', date: DATE });
      archive.append(TEXT, { name: 'last.txt', date: DATE });
    };

    it('stored', async function () {
      const { upstream, port } = await runBoth(zip20(() => ({ store: true }), add), { random: ZIP20_HEADER });
      const zips = assertSameBytes(upstream, port);
      const entries = zips.y.entries;
      for (const entry of entries) {
        await assertSizes(entry);
        assert.equal(entry.local.flags, 0x0001);
        assert.equal(entry.central.flags, 0x0001);
        assert.equal(entry.local.crc, entry.central.crc);
        assert.equal(entry.local.size, entry.central.size);
        assert.equal(entry.central.method, 0);
      }
      assert.deepStrictEqual(entries.map((entry) => isP17(entry)), [false, false, true, true, true, false]);
      assert.deepStrictEqual(
        entries.map((entry) => entry.payload.length),
        [4000 + ZIP20_OVERHEAD, 4000 + ZIP20_OVERHEAD, 0, 0, 0, TEXT.length + ZIP20_OVERHEAD]
      );
      // never raised to 20 for the encryption (P18)
      assert.deepStrictEqual(entries.map((entry) => entry.local.versionNeeded), [10, 20, 10, 20, 10, 10]);
      assert.deepStrictEqual(entries.map((entry) => entry.central.versionNeeded), [10, 20, 10, 20, 10, 10]);
      assert.deepStrictEqual(await entryData(entries[5], PASSWORD), TEXT);
    });

    it('deflated', async function () {
      const { upstream, port } = await runBoth(zip20(() => ({}), add), { random: ZIP20_HEADER });
      const zips = await assertSameZip(upstream, port);
      for (const parsed of both(zips)) {
        const entries = parsed.entries;
        assert.deepStrictEqual(entries.map((entry) => entry.central.method), [8, 8, 8, 8, 0, 8]);
        assert.deepStrictEqual(entries.map((entry) => isP17(entry)), [false, false, false, false, true, false]);
        assert.deepStrictEqual(entries.map((entry) => entry.local.versionNeeded), [20, 20, 20, 20, 10, 20]);
        assert.deepStrictEqual(entries.map((entry) => entry.local.flags), [1, 1, 1, 1, 1, 1]);
        assert.ok(entries[0].payload.length < BIG.length);
        assert.notEqual(entries[0].local.crc, 0);
        assert.equal(entries[0].local.size, 4000);
      }
    });

    it('deflated, zlib.level 9', async function () {
      const { upstream, port } = await runBoth(zip20(() => ({ zlib: { level: 9 } }), add), { random: ZIP20_HEADER });
      await assertSameZip(upstream, port);
    });

    it('stored, with comments, non-ASCII names and forceZip64', async function () {
      const { upstream, port } = await runBoth(
        zip20(() => ({ store: true, forceZip64: true, comment: 'archive ü' }), (archive) => {
          archive.append(TEXT, { name: 'é.txt', date: DATE, comment: 'ü comment' });
          archive.append(streamOf([TEXT]), { name: 'plain.txt', date: DATE, mode: 0o600 });
        }),
        { random: ZIP20_HEADER }
      );
      const zips = assertSameBytes(upstream, port);
      assert.notEqual(zips.y.zip64End, null);
      assert.deepStrictEqual(zips.y.entries.map((entry) => entry.central.flags), [0x0801, 0x0001]);
    });
  });

  describe('C2 zip20Header and ZipCryptoStream written to directly (V10, ZIP-135)', function () {
    const wrong = [
      ['a string', 'abcdefghijkl'],
      ['a number', 12],
      ['a Uint8Array', new Uint8Array(12)],
      ['an array', [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]],
      ['11 bytes', Buffer.alloc(11)],
      ['13 bytes', Buffer.alloc(13)],
      ['an empty Buffer', Buffer.alloc(0)],
    ];

    for (const [title, zip20Header] of wrong) {
      it(`zip20Header: ${title} throws`, async function () {
        const port = await load('port');
        const expected = { name: 'TypeError', message: 'zip20Header must be a Buffer of 12 bytes' };
        assert.throws(() => new port.ZipCryptoStream({ password: PASSWORD, zip20Header }), expected);
        assert.throws(() => port.ZipCryptoStream({ password: PASSWORD, zip20Header }), expected);
        assert.throws(
          () => new port.ZipEncrypted({ password: PASSWORD, encryptionMethod: 'zip20', zip20Header }),
          expected
        );
        assert.throws(
          () => port.archiver.create('zip-encrypted', { password: PASSWORD, encryptionMethod: 'zip20', zip20Header }),
          expected
        );
        // upstream has no such option (V10)
        const upstream = await load('upstream');
        new upstream.ZipCryptoStream({ password: PASSWORD, zip20Header }).destroy();
      });
    }

    for (const [title, zip20Header] of [['undefined', undefined], ['null', null], ['a Buffer of 12 bytes', ZIP20_HEADER]]) {
      it(`zip20Header: ${title} is accepted`, async function () {
        const port = await load('port');
        new port.ZipCryptoStream({ password: PASSWORD, zip20Header }).destroy();
      });
    }

    for (const store of [true, false]) {
      it(`write('PREFIX'), then one entry, then finalize(): ${store ? 'stored' : 'default method'}`, async function () {
        const { upstream, port } = await runBoth(
          async (impl, ctx) => {
            const engine = ctx.track(
              new impl.ZipCryptoStream({ password: PASSWORD, store, zip20Header: Buffer.from(ctx.zip20Header) })
            );
            const ended = once(engine, 'end');
            engine.write('PREFIX');
            engine.entry(BIG, { name: 'a.txt', date: DATE }, (err) => {
              assert.ifError(err);
              engine.finalize();
            });
            await ended;
          },
          { random: ZIP20_HEADER }
        );
        const zips = store ? assertSameBytes(upstream, port) : await assertSameZip(upstream, port);
        for (const parsed of both(zips)) {
          assert.deepStrictEqual(parsed.prefix, Buffer.from('PREFIX'));
          assert.equal(parsed.entries[0].central.localHeaderOffset, 6);
          assert.equal(parsed.end.centralOffset, parsed.buffer.indexOf(Buffer.from('504b0102', 'hex')));
          assert.equal(parsed.end.centralOffset + parsed.end.centralSize, parsed.end.offset);
          await assertSizes(parsed.entries[0]);
        }
      });
    }

    it('written to and ended without an entry: the bytes pass through', async function () {
      const { upstream, port } = await runBoth(async (impl, ctx) => {
        const engine = ctx.track(new impl.ZipCryptoStream({ password: PASSWORD, encryptionMethod: 'zip20' }));
        const ended = once(engine, 'end');
        engine.write(TEXT.subarray(0, 7));
        engine.end(TEXT.subarray(7));
        await ended;
      });
      assert.deepStrictEqual(upstream.bytes, TEXT);
      assert.deepStrictEqual(port.bytes, upstream.bytes);
    });
  });
});
