// PORTING.md 14.2: cases A1 to A4 (WinZip AES-256; A4 also on ZipCrypto). No upstream source.
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { decryptAes, entryData } from './helpers/decrypt.mjs';
import { omitV15Keys, selectEvents } from './helpers/events.mjs';
import { runBoth } from './helpers/run-both.mjs';
import { maskCentral, maskDescriptor, maskEndRecords, maskLocal, parseZip } from './helpers/zip-records.mjs';

const DATE = new Date('2020-03-04T05:06:08.000Z');
const CLOCK = new Date('2021-07-04T09:08:06.000Z');
const PASSWORD = '123';
const SALT = Buffer.from('000102030405060708090a0b0c0d0e0f', 'hex');
const ZIP20_HEADER = Buffer.from('a0a1a2a3a4a5a6a7a8a9aaab', 'hex');
const TEXT = Buffer.from('this is a text file');
const BIG = Buffer.alloc(4000, 'abcdefghij');
// PORTING.md 17.2: salt (16), password verifier (2), MAC (10)
const AES_OVERHEAD = 28;

// PORTING.md 14.2 (helper of the test: a fresh stream per implementation, written in the given chunks)
function streamOf(chunks) {
  const stream = new PassThrough();
  for (const chunk of chunks) {
    stream.write(chunk);
  }
  stream.end();
  return stream;
}

// PORTING.md 14.2 (one aes256 archive per implementation: `options()` is a fresh object per run, `add` appends)
function aes(options, add) {
  return async (impl, ctx) => {
    const archive = ctx.create('aes256', { password: PASSWORD, ...options() });
    await add(archive, impl);
    await archive.finalize();
  };
}

// PORTING.md 14.2 (events: for aes256 and zip20 the keys only the archiver 7 stack writes are ignored, V15)
function comparedEvents(run) {
  return omitV15Keys(selectEvents(run.events));
}

// PORTING.md 14.2 (comparison rules: compressed size == payload length; 17.2: payload = salt, verifier, data, MAC)
function assertSizes(entry) {
  assert.equal(entry.central.effective.compressedSize, entry.payload.length, `${entry.name}: central compressed size`);
  if (entry.descriptor !== null) {
    assert.equal(entry.descriptor.compressedSize, entry.payload.length, `${entry.name}: descriptor compressed size`);
  } else {
    assert.equal(entry.local.compressedSize, entry.payload.length, `${entry.name}: local compressed size`);
  }
  const decrypted = decryptAes(entry.payload, PASSWORD);
  assert.equal(decrypted.verifierOk, true, `${entry.name}: password verifier`);
  assert.equal(decrypted.macOk, true, `${entry.name}: MAC`);
  assert.equal(entry.payload.length, decrypted.data.length + AES_OVERHEAD, `${entry.name}: payload length`);
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
  assertSizes(u);
  assertSizes(y);
}

// PORTING.md 14.2 (comparison rules, deflated zip, class D; events: the exact sequence)
async function assertSameZip(upstream, ykk) {
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
  assert.deepStrictEqual(comparedEvents(ykk), comparedEvents(upstream));
  return { u, y };
}

// PORTING.md 14.2 (comparison rules, stored encrypted zip: whole-archive byte equality, events, pointer)
function assertSameBytes(upstream, ykk) {
  assert.deepStrictEqual(ykk.error, upstream.error);
  assert.deepStrictEqual(ykk.bytes, upstream.bytes);
  assert.deepStrictEqual(comparedEvents(ykk), comparedEvents(upstream));
  assert.equal(ykk.pointer, upstream.pointer);
  assert.equal(ykk.pointer, ykk.bytes.length);
  return { u: parseZip(upstream.bytes), y: parseZip(ykk.bytes) };
}

// PORTING.md 14.2 (helper of the test: the entries of both archives, for an assertion made on each)
function both(zips) {
  return [zips.u, zips.y];
}

describe('differential: zip (aes256)', function () {
  describe('A1 buffer and stream, empty file, directory (P18, P19)', function () {
    const add = (archive) => {
      archive.append(BIG, { name: 'buffer.txt', date: DATE });
      archive.append(streamOf([BIG.subarray(0, 1500), BIG.subarray(1500)]), { name: 'stream.txt', date: DATE });
      archive.append(Buffer.alloc(0), { name: 'empty.txt', date: DATE });
      archive.append(streamOf([]), { name: 'empty-stream.txt', date: DATE });
      archive.append(null, { name: 'd/', date: DATE });
    };

    it('stored', async function () {
      const { upstream, ykk } = await runBoth(aes(() => ({ salt: SALT, store: true }), add));
      const zips = assertSameBytes(upstream, ykk);
      const entries = zips.y.entries;
      assert.deepStrictEqual(entries.map((entry) => entry.local.versionNeeded), [51, 51, 51, 51, 51]);
      assert.deepStrictEqual(entries.map((entry) => entry.central.versionNeeded), [51, 51, 51, 51, 51]);
      assert.deepStrictEqual(entries.map((entry) => entry.local.flags), [0x0001, 0x0009, 0x0001, 0x0009, 0x0001]);
      assert.deepStrictEqual(entries.map((entry) => entry.descriptor !== null), [false, true, false, true, false]);
      assert.deepStrictEqual(
        entries.map((entry) => entry.payload.length),
        [4000 + AES_OVERHEAD, 4000 + AES_OVERHEAD, AES_OVERHEAD, AES_OVERHEAD, AES_OVERHEAD]
      );
      assert.equal(entries[0].local.compressedSize, 4000 + AES_OVERHEAD);
      assert.equal(entries[0].local.size, 4000);
      for (const entry of entries) {
        assertSizes(entry);
        assert.equal(entry.central.method, 99);
        assert.deepStrictEqual(entry.central.extra, Buffer.from('0199070001004145030000', 'hex'));
        assert.deepStrictEqual(entry.local.extra, entry.central.extra);
        assert.deepStrictEqual(decryptAes(entry.payload, PASSWORD).salt, SALT);
      }
      // AE-1: the real CRC stays (P19)
      assert.notEqual(entries[0].central.crc, 0);
      assert.equal(entries[0].local.crc, entries[0].central.crc);
      assert.equal(entries[1].central.crc, entries[0].central.crc);
    });

    it('deflated', async function () {
      const { upstream, ykk } = await runBoth(aes(() => ({ salt: SALT }), add));
      const zips = await assertSameZip(upstream, ykk);
      for (const parsed of both(zips)) {
        const entries = parsed.entries;
        assert.deepStrictEqual(entries.map((entry) => entry.local.versionNeeded), [51, 51, 51, 51, 51]);
        assert.deepStrictEqual(entries.map((entry) => entry.local.flags), [0x0009, 0x0009, 0x0009, 0x0009, 0x0001]);
        assert.deepStrictEqual(entries.map((entry) => entry.central.aes.method), [8, 8, 8, 8, 0]);
        assert.deepStrictEqual(entries.map((entry) => entry.central.aes.version), [1, 1, 1, 1, 1]);
        assert.deepStrictEqual(entries.map((entry) => entry.central.method), [99, 99, 99, 99, 99]);
        assert.notEqual(entries[0].central.crc, 0);
        assert.equal(entries[1].central.crc, entries[0].central.crc);
        assert.ok(entries[0].payload.length < BIG.length);
        for (const entry of entries) {
          assert.deepStrictEqual(decryptAes(entry.payload, PASSWORD).salt, SALT);
        }
      }
    });

    it('deflated, zlib.level 9', async function () {
      const { upstream, ykk } = await runBoth(aes(() => ({ salt: SALT, zlib: { level: 9 } }), add));
      await assertSameZip(upstream, ykk);
    });
  });

  describe('A2 forceZip64, comments, non-ASCII names', function () {
    const add = (archive) => {
      archive.append(TEXT, { name: 'plain.txt', date: DATE, comment: 'an ASCII entry comment' });
      archive.append(TEXT, { name: 'é.txt', date: DATE, comment: 'ü comment' });
      archive.append(streamOf([TEXT]), { name: '日本語/ファイル.txt', date: DATE });
    };

    it('stored', async function () {
      const { upstream, ykk } = await runBoth(
        aes(() => ({ salt: SALT, store: true, forceZip64: true, comment: 'archive ü' }), add)
      );
      const zips = assertSameBytes(upstream, ykk);
      const parsed = zips.y;
      assert.notEqual(parsed.zip64End, null);
      assert.notEqual(parsed.zip64Locator, null);
      assert.equal(parsed.end.entries, 0xffff);
      assert.deepStrictEqual(parsed.end.comment, Buffer.from('archive ü'));
      for (const entry of parsed.entries) {
        assert.equal(entry.central.zip64, null);
        assert.equal(entry.central.versionNeeded, 51);
        assert.equal(entry.local.extraLength, 11);
      }
      assert.deepStrictEqual(parsed.entries.map((entry) => entry.central.flags & 0x0800), [0, 0x0800, 0x0800]);
    });

    it('deflated', async function () {
      const { upstream, ykk } = await runBoth(
        aes(() => ({ salt: SALT, forceZip64: true, comment: 'an ASCII archive comment' }), add)
      );
      const zips = await assertSameZip(upstream, ykk);
      for (const parsed of both(zips)) {
        assert.notEqual(parsed.zip64End, null);
        assert.equal(parsed.entries[0].descriptor.length, 16);
      }
    });
  });

  describe('A3 salt (V10, V14)', function () {
    const add = (archive) => {
      archive.append(TEXT, { name: 'buffer.txt', date: DATE, store: true });
      archive.append(BIG, { name: 'deflated.txt', date: DATE });
      archive.append(streamOf([TEXT]), { name: 'stream.txt', date: DATE, store: true });
    };

    it('salt as a Buffer', async function () {
      const salt = Buffer.alloc(16, 0xa5);
      const stored = await runBoth(aes(() => ({ salt: Buffer.from(salt), store: true }), add));
      const zips = assertSameBytes(stored.upstream, stored.ykk);
      for (const entry of zips.y.entries) {
        assert.deepStrictEqual(entry.payload.subarray(0, 16), salt);
      }
      const deflated = await runBoth(aes(() => ({ salt: Buffer.from(salt) }), add));
      await assertSameZip(deflated.upstream, deflated.ykk);
    });

    it('salt as a string', async function () {
      const salt = '0123456789abcdef';
      const stored = await runBoth(aes(() => ({ salt, store: true }), add));
      const zips = assertSameBytes(stored.upstream, stored.ykk);
      for (const entry of zips.y.entries) {
        assert.deepStrictEqual(entry.payload.subarray(0, 16), Buffer.from(salt));
        assertSizes(entry);
      }
      const deflated = await runBoth(aes(() => ({ salt }), add));
      await assertSameZip(deflated.upstream, deflated.ykk);
    });

    it('a salt of another length is written with its own length (ENCRYPTED-060)', async function () {
      const salt = Buffer.alloc(8, 0x5a);
      const { upstream, ykk } = await runBoth(aes(() => ({ salt: Buffer.from(salt), store: true }), add));
      const zips = assertSameBytes(upstream, ykk);
      assert.equal(zips.y.entries[0].payload.length, 8 + 2 + TEXT.length + 10);
      assert.equal(zips.y.entries[0].central.compressedSize, 8 + 2 + TEXT.length + 10);
      assert.deepStrictEqual(zips.y.entries[0].payload.subarray(0, 8), salt);
    });

    it('no salt: structure and lengths', async function () {
      const { upstream, ykk } = await runBoth(aes(() => ({}), add));
      const zips = await assertSameZip(upstream, ykk);
      assert.deepStrictEqual(
        [zips.y.entries[0].payload.length, zips.y.entries[2].payload.length],
        [zips.u.entries[0].payload.length, zips.u.entries[2].payload.length]
      );
      for (const parsed of both(zips)) {
        const salts = parsed.entries.map((entry) => entry.payload.subarray(0, 16).toString('hex'));
        assert.equal(new Set(salts).size, salts.length);
      }
      assert.notDeepStrictEqual(zips.y.entries[0].payload, zips.u.entries[0].payload);
    });
  });
});

for (const format of ['aes256', 'zip20']) {
  // PORTING.md 14.2 (A4: the archive is built by hand, so that the caller's own options object is the one passed)
  const create = (impl, ctx, extra) => {
    const options = { encryptionMethod: format, password: PASSWORD, store: true, ...extra };
    if (format === 'aes256') {
      options.salt = Buffer.from(SALT);
    } else if (impl.name === 'ykk') {
      options.zip20Header = Buffer.from(ctx.zip20Header);
    }
    return { options, archive: ctx.track(impl.archiver.create('zip-encrypted', options)) };
  };

  describe(`differential: A4 the archiver 7 surface (V15), ${format}`, function () {
    it('(a) caller options and entry data are not mutated; "entry" payload keys', async function () {
      const { upstream, ykk } = await runBoth(
        async (impl, ctx) => {
          const { options, archive } = create(impl, ctx);
          const data = { name: 'a.txt', date: DATE };
          archive.append(TEXT, data);
          archive.symlink('link', 'a.txt');
          await archive.finalize();
          return { options: Object.keys(options), data: Object.keys(data) };
        },
        { clock: CLOCK, random: ZIP20_HEADER }
      );

      assert.equal(upstream.value.options.includes('highWaterMark'), true);
      assert.equal(upstream.value.options.includes('statConcurrency'), true);
      assert.equal(ykk.value.options.includes('highWaterMark'), false);
      assert.equal(ykk.value.options.includes('statConcurrency'), false);

      assert.deepStrictEqual(upstream.value.data, [
        'name', 'date', 'type', 'mode', 'prefix', 'sourcePath', 'stats', 'sourceType', 'namePrependSlash', 'linkname',
        'store', 'comment',
      ]);
      assert.deepStrictEqual(ykk.value.data, ['name', 'date']);

      const keys = (run) => selectEvents(run.events, ['entry']).map((record) => Object.keys(record.payload));
      assert.deepStrictEqual(keys(upstream), [
        [
          'name', 'date', 'type', 'mode', 'prefix', 'sourcePath', 'stats', 'sourceType', 'namePrependSlash',
          'linkname', 'store', 'comment',
        ],
        ['type', 'name', 'linkname', 'sourceType', 'namePrependSlash', 'date', 'mode', 'store', 'comment'],
      ]);
      assert.deepStrictEqual(keys(ykk), [
        ['type', 'name', 'date', 'mode', 'prefix', 'sourcePath', 'stats', 'sourceType'],
        ['type', 'name', 'linkname', 'sourceType'],
      ]);

      assert.deepStrictEqual(comparedEvents(ykk), comparedEvents(upstream));
      assert.deepStrictEqual(ykk.bytes, upstream.bytes);
      assert.equal(ykk.pointer, upstream.pointer);
    });

    it('(b) mode: undefined is not defaulted', async function () {
      const { upstream, ykk } = await runBoth(
        async (impl, ctx) => {
          const { archive } = create(impl, ctx);
          archive.append(TEXT, { name: 'a.txt', date: DATE, mode: undefined });
          await archive.finalize();
        },
        { random: ZIP20_HEADER }
      );
      const u = parseZip(upstream.bytes).entries[0];
      const y = parseZip(ykk.bytes).entries[0];
      assert.equal(u.central.versionMadeBy, 0x032d);
      assert.equal(u.central.externalAttributes, 0x81a40020);
      assert.equal(y.central.versionMadeBy, 0x002d);
      assert.equal(y.central.externalAttributes, 0);
      assert.deepStrictEqual(y.local.bytes, u.local.bytes);
      assert.deepStrictEqual(y.payload, u.payload);
      const withoutPlatform = (entry) => {
        const bytes = Buffer.from(entry.central.bytes);
        bytes.fill(0, 4, 6);
        bytes.fill(0, 38, 42);
        return bytes;
      };
      assert.deepStrictEqual(withoutPlatform(y), withoutPlatform(u));
    });

    it('(c) a duck-typed stream source is accepted', async function () {
      const { upstream, ykk } = await runBoth(
        async (impl, ctx) => {
          const { archive } = create(impl, ctx);
          const duck = {
            readable: true,
            pipe(destination) {
              destination.end(TEXT);
              return destination;
            },
          };
          let refused = false;
          archive.on('error', () => {
            refused = true;
          });
          archive.append(duck, { name: 'duck.txt', date: DATE });
          if (refused) {
            // the 'error' unpiped the engine from the archive: finalize() would never settle
            archive.destroy();
            return;
          }
          await archive.finalize();
        },
        { random: ZIP20_HEADER }
      );

      const upstreamErrors = selectEvents(upstream.events, ['error']);
      assert.equal(upstreamErrors.length, 1);
      assert.equal(upstreamErrors[0].payload.code, 'INPUTSTEAMBUFFERREQUIRED');
      assert.deepStrictEqual(upstreamErrors[0].payload.data, { name: 'duck.txt' });
      assert.equal(upstream.bytes.length, 0);

      assert.deepStrictEqual(selectEvents(ykk.events, ['error']), []);
      const entries = parseZip(ykk.bytes).entries;
      assert.deepStrictEqual(entries.map((entry) => entry.name), ['duck.txt']);
      assert.deepStrictEqual(await entryData(entries[0], PASSWORD), TEXT);
      assert.equal(selectEvents(ykk.events, ['entry'])[0].payload.sourceType, 'stream');
    });
  });
}
