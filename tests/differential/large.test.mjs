// tests/differential/large.test.mjs
// Differential cases of payloads far above MAX_CHUNK (PORTING.md 3.2 V16, 5.4): every loop that slices a
// payload into 1 MiB pieces before a wasm call runs more than once here, with a compressible and an
// incompressible payload of 5 MiB + 123 bytes, as a Buffer, as a stream of one chunk and as a stream
// of chunks cut off the slice boundary. The loops have no upstream counterpart (upstream hands whole
// chunks to zlib, crc32 and the ciphers), so every case compares with upstream and extracts the payload.
//
//   zip, stored and deflated       zip-archive-output-stream.ts:112 (CRC of a buffer), :295 (writeData)
//   zip aes256                     zip-archive-output-stream.ts:112, :295
//   zip zip20                      zip-archive-output-stream.ts:112, :295, :331 (encryptData)
//   tar                            no wasm call carries the payload (tar-stream is TypeScript); same inputs
//   tar.gz                         gzip.ts:21
//   json                           plugins/json.ts:76
//   AesHmacEtmStream               encrypted/aes/aes-hmac-etm-stream.ts:89
//   CryptoStream                   encrypted/zip20/crypto-stream.ts:53
//   DecryptoStream                 encrypted/zip20/decrypto-stream.ts:44
//   CryptoCipher                   encrypted/zip20/crypto-cipher.ts:30, :43

import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { once } from 'node:events';
import { createRequire } from 'node:module';
import { PassThrough } from 'node:stream';
import zlib from 'node:zlib';

import { decryptAes, decryptZip20, entryMethod } from './helpers/decrypt.mjs';
import { omitV15Keys, selectEvents } from './helpers/events.mjs';
import { load, runBoth } from './helpers/run-both.mjs';
import { parseTar, splitGzip } from './helpers/tar-records.mjs';
import { maskCentral, maskDescriptor, maskEndRecords, maskLocal, parseZip } from './helpers/zip-records.mjs';

const require = createRequire(import.meta.url);
// the CRC-32 the upstream stack computes with (deps/crc32-stream/lib/crc32-stream.js:3)
const crc32 = require('crc-32');

const DATE = new Date('2020-03-04T05:06:08.000Z');
const CLOCK = new Date('2021-07-04T09:08:06.000Z');
const PASSWORD = '123';
const SALT = Buffer.from('000102030405060708090a0b0c0d0e0f', 'hex');
const ZIP20_HEADER = Buffer.from('a0a1a2a3a4a5a6a7a8a9aaab', 'hex');
// PORTING.md 5.4
const MAX_CHUNK = 1024 * 1024;
const SIZE = 5 * MAX_CHUNK + 123;
// PORTING.md 17.2: salt (16), password verifier (2), MAC (10); the 12 encrypted header bytes
const AES_OVERHEAD = 28;
const ZIP20_OVERHEAD = 12;
// a run that never ends rejects instead of running into the timeout of the test
const END_TIMEOUT = 15000;

// not periodic: a constant or periodic fill would hide slices that are dropped, repeated or reordered
function compressible(n) {
  const buffer = Buffer.alloc(n);
  for (let i = 0; i < n; i++) {
    buffer[i] = (i * 31 + (i >> 9)) & 255;
  }
  return buffer;
}

// a fixed key stream: the same bytes in every run, and deflate cannot shrink them
function incompressible(n) {
  const cipher = crypto.createCipheriv('aes-256-ctr', Buffer.alloc(32, 7), Buffer.alloc(16, 9));
  return cipher.update(Buffer.alloc(n));
}

const PAYLOADS = { compressible: compressible(SIZE), incompressible: incompressible(SIZE) };

// one chunk past the first slice by a byte, one that spans three slices, the rest
function cut(buffer) {
  const first = MAX_CHUNK + 1;
  const second = first + 3 * MAX_CHUNK - 7;
  return [buffer.subarray(0, first), buffer.subarray(first, second), buffer.subarray(second)];
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

// the three sources of one payload: [entry name, source]
function sources(payload) {
  return [
    ['buffer.bin', () => payload],
    ['stream-1.bin', () => streamOf([payload])],
    ['stream-3.bin', () => streamOf(cut(payload))],
  ];
}

// one archive per implementation with the three sources of `payload`
function archiveOf(format, options, payload) {
  return async (impl, ctx) => {
    const archive = ctx.create(format, options());
    for (const [name, source] of sources(payload)) {
      archive.append(source(), { name, date: DATE });
    }
    await archive.finalize();
  };
}

// equality of two large buffers without the diff of assert on megabytes
function assertBytes(actual, expected, label) {
  assert.ok(Buffer.isBuffer(actual), `${label}: not a Buffer`);
  if (actual.equals(expected)) {
    return;
  }
  let at = 0;
  const shorter = Math.min(actual.length, expected.length);
  while (at < shorter && actual[at] === expected[at]) {
    at++;
  }
  assert.fail(`${label}: ${actual.length} bytes against ${expected.length} expected, first difference at offset ${at}`);
}

// PORTING.md 14.2 (events: for aes256 and zip20 the keys only the archiver 7 stack writes are ignored, V15)
function comparedEvents(run, encrypted) {
  return encrypted ? omitV15Keys(selectEvents(run.events)) : selectEvents(run.events);
}

// helpers/decrypt.mjs entryData, with the encryption overhead checked on the way
async function extract(entry, format) {
  let data = entry.payload;
  if (format === 'aes256') {
    const decrypted = decryptAes(data, PASSWORD);
    assert.equal(decrypted.verifierOk, true, `${entry.name}: password verifier`);
    assert.equal(decrypted.macOk, true, `${entry.name}: MAC`);
    assert.equal(data.length, decrypted.data.length + AES_OVERHEAD, `${entry.name}: payload length`);
    data = decrypted.data;
  } else if (format === 'zip20') {
    const decrypted = await decryptZip20(data, PASSWORD);
    assert.equal(data.length, decrypted.data.length + ZIP20_OVERHEAD, `${entry.name}: payload length`);
    data = decrypted.data;
  }
  return entryMethod(entry) === 8 ? zlib.inflateRawSync(data) : data;
}

// PORTING.md 14.2 (comparison rules: compressed size == payload length; CRC and size are those of the source)
function assertFields(entry, payload) {
  const crc = crc32.buf(payload) >>> 0;
  assert.equal(entry.central.effective.size, payload.length, `${entry.name}: central size`);
  assert.equal(entry.central.effective.compressedSize, entry.payload.length, `${entry.name}: central compressed size`);
  assert.equal(entry.central.crc, crc, `${entry.name}: central CRC`);
  if (entry.descriptor !== null) {
    assert.equal(entry.descriptor.size, payload.length, `${entry.name}: descriptor size`);
    assert.equal(entry.descriptor.compressedSize, entry.payload.length, `${entry.name}: descriptor compressed size`);
    assert.equal(entry.descriptor.crc, crc, `${entry.name}: descriptor CRC`);
  } else {
    assert.equal(entry.local.size, payload.length, `${entry.name}: local size`);
    assert.equal(entry.local.compressedSize, entry.payload.length, `${entry.name}: local compressed size`);
    assert.equal(entry.local.crc, crc, `${entry.name}: local CRC`);
  }
}

// PORTING.md 14.2 (comparison rules: a stored zip is byte-equal; a deflated one is equal record by record
// with the compressed sizes and the offsets after them masked, V1) and, for both, the extracted payload
async function assertSameZip({ upstream, port }, format, store, payload) {
  const encrypted = format !== 'zip';
  assert.strictEqual(upstream.error, null);
  assert.deepStrictEqual(port.error, upstream.error);
  assert.deepStrictEqual(comparedEvents(port, encrypted), comparedEvents(upstream, encrypted));
  assert.equal(upstream.pointer, upstream.bytes.length);
  assert.equal(port.pointer, port.bytes.length);
  const u = parseZip(upstream.bytes);
  const y = parseZip(port.bytes);
  const names = sources(payload).map(([name]) => name);
  assert.deepStrictEqual(u.entries.map((entry) => entry.name), names);
  assert.deepStrictEqual(y.entries.map((entry) => entry.name), names);
  if (store) {
    assertBytes(port.bytes, upstream.bytes, 'archive');
  } else {
    for (let i = 0; i < names.length; i++) {
      const ue = u.entries[i];
      const ye = y.entries[i];
      assert.deepStrictEqual(maskLocal(ye.local), maskLocal(ue.local), `${ue.name}: local header`);
      assert.equal(ye.descriptor === null, ue.descriptor === null, `${ue.name}: data descriptor present`);
      if (ue.descriptor !== null) {
        assert.deepStrictEqual(maskDescriptor(ye.descriptor), maskDescriptor(ue.descriptor), `${ue.name}: data descriptor`);
      }
      assert.deepStrictEqual(maskCentral(ye.central), maskCentral(ue.central), `${ue.name}: central header`);
    }
    assert.deepStrictEqual(maskEndRecords(y), maskEndRecords(u));
  }
  for (const zip of [u, y]) {
    for (const entry of zip.entries) {
      assert.equal(entryMethod(entry), store ? 0 : 8, `${entry.name}: method`);
      assertFields(entry, payload);
      assertBytes(await extract(entry, format), payload, `${entry.name}: extracted payload`);
    }
    assert.equal(zip.centralEnd, zip.zip64End !== null ? zip.zip64End.offset : zip.end.offset, 'central directory end');
  }
  return { u, y };
}

// a transform stream written to directly: `chunks` in, the output tracked
function transformOf(create, chunks) {
  return async (impl, ctx) => {
    const stream = ctx.track(create(impl, ctx), { events: ['error', 'end'] });
    const ended = once(stream, 'end');
    for (const chunk of chunks) {
      stream.write(chunk);
    }
    stream.end();
    await ended;
    return typeof stream.getTotalSize === 'function' ? stream.getTotalSize() : null;
  };
}

describe('differential: payloads above MAX_CHUNK (V16)', function () {
  this.timeout(30000);

  for (const [kind, payload] of Object.entries(PAYLOADS)) {
    describe(kind, function () {
      for (const store of [true, false]) {
        const method = store ? 'stored' : 'deflated';

        it(`zip, ${method}`, async function () {
          const runs = await runBoth(archiveOf('zip', () => ({ store }), payload), { endTimeout: END_TIMEOUT });
          const zips = await assertSameZip(runs, 'zip', store, payload);
          if (!store && kind === 'compressible') {
            assert.ok(zips.y.entries.every((entry) => entry.payload.length < SIZE / 2));
          }
        });

        it(`zip aes256, ${method}`, async function () {
          const runs = await runBoth(archiveOf('aes256', () => ({ password: PASSWORD, salt: SALT, store }), payload), {
            clock: CLOCK,
            endTimeout: END_TIMEOUT,
          });
          await assertSameZip(runs, 'aes256', store, payload);
        });

        it(`zip zip20, ${method}`, async function () {
          const runs = await runBoth(archiveOf('zip20', () => ({ password: PASSWORD, store }), payload), {
            random: ZIP20_HEADER,
            endTimeout: END_TIMEOUT,
          });
          await assertSameZip(runs, 'zip20', store, payload);
        });
      }

      it('tar', async function () {
        const { upstream, port } = await runBoth(archiveOf('tar', () => ({}), payload), { endTimeout: END_TIMEOUT });
        assert.strictEqual(upstream.error, null);
        assert.deepStrictEqual(port.error, upstream.error);
        assertBytes(port.bytes, upstream.bytes, 'archive');
        assert.deepStrictEqual(selectEvents(port.events), selectEvents(upstream.events));
        assert.equal(port.pointer, port.bytes.length);
        const entries = parseTar(port.bytes).entries;
        assert.deepStrictEqual(entries.map((entry) => entry.name), sources(payload).map(([name]) => name));
        for (const entry of entries) {
          assert.equal(entry.header.size, SIZE);
          assertBytes(entry.body, payload, `${entry.name}: body`);
        }
      });

      for (const [title, gzipOptions] of [['default level', undefined], ['level 1', { level: 1 }], ['level 0', { level: 0 }]]) {
        it(`tar.gz, ${title}`, async function () {
          const options = () => (gzipOptions === undefined ? {} : { gzipOptions: { ...gzipOptions } });
          const { upstream, port } = await runBoth(archiveOf('tar.gz', options, payload), { endTimeout: END_TIMEOUT });
          assert.strictEqual(upstream.error, null);
          assert.deepStrictEqual(port.error, upstream.error);
          assert.deepStrictEqual(selectEvents(port.events), selectEvents(upstream.events));
          // finalize() resolves while the gzip stream still writes: the pointer is compared at the end
          assert.equal(upstream.pointerAtEnd, upstream.bytes.length);
          assert.equal(port.pointerAtEnd, port.bytes.length);
          const u = splitGzip(upstream.bytes);
          const y = splitGzip(port.bytes);
          assert.deepStrictEqual(y.header, u.header);
          assert.deepStrictEqual(y.trailer, u.trailer);
          assertBytes(y.payload, u.payload, 'inflated tar');
          assertBytes(zlib.gunzipSync(port.bytes), u.payload, 'gunzip of the whole member');
          assert.equal(y.size, y.payload.length);
          assert.equal(y.crc, crc32.buf(y.payload) >>> 0);
          const entries = parseTar(y.payload).entries;
          assert.deepStrictEqual(entries.map((entry) => entry.name), sources(payload).map(([name]) => name));
          for (const entry of entries) {
            assertBytes(entry.body, payload, `${entry.name}: body`);
          }
        });
      }

      it('json', async function () {
        const { upstream, port } = await runBoth(archiveOf('json', () => ({}), payload), { endTimeout: END_TIMEOUT });
        assert.strictEqual(upstream.error, null);
        assert.deepStrictEqual(port.error, upstream.error);
        assert.deepStrictEqual(port.bytes, upstream.bytes);
        assert.deepStrictEqual(selectEvents(port.events), selectEvents(upstream.events));
        const files = JSON.parse(port.bytes.toString('utf8'));
        assert.deepStrictEqual(
          files.map((file) => [file.name, file.size, file.crc32]),
          sources(payload).map(([name]) => [name, SIZE, crc32.buf(payload) >>> 0])
        );
      });

      for (const [title, chunks] of [['one chunk', [payload]], ['three chunks', cut(payload)]]) {
        it(`AesHmacEtmStream, ${title}`, async function () {
          const { upstream, port } = await runBoth(
            transformOf((impl) => new impl.AesHmacEtmStream({ key: Buffer.from(PASSWORD), salt: Buffer.from(SALT) }), chunks),
            { endTimeout: END_TIMEOUT }
          );
          assert.strictEqual(upstream.error, null);
          assert.deepStrictEqual(port.error, upstream.error);
          assertBytes(port.bytes, upstream.bytes, 'encrypted');
          assert.equal(port.value, upstream.value);
          assert.equal(port.value, SIZE + AES_OVERHEAD);
          const decrypted = decryptAes(port.bytes, PASSWORD);
          assert.deepStrictEqual([decrypted.verifierOk, decrypted.macOk], [true, true]);
          assertBytes(decrypted.data, payload, 'decrypted');
        });

        it(`CryptoStream, ${title}`, async function () {
          const crc = Buffer.alloc(4);
          crc.writeUInt32BE(crc32.buf(payload) >>> 0);
          const { upstream, port } = await runBoth(
            transformOf(
              (impl, ctx) =>
                new impl.CryptoStream(
                  impl.name === 'port'
                    ? { key: Buffer.from(PASSWORD), crc, header: Buffer.from(ctx.zip20Header) }
                    : { key: Buffer.from(PASSWORD), crc }
                ),
              chunks
            ),
            { random: ZIP20_HEADER, endTimeout: END_TIMEOUT }
          );
          assert.strictEqual(upstream.error, null);
          assert.deepStrictEqual(port.error, upstream.error);
          assertBytes(port.bytes, upstream.bytes, 'encrypted');
          assert.equal(port.bytes.length, SIZE + ZIP20_OVERHEAD);
          assertBytes((await decryptZip20(port.bytes, PASSWORD)).data, payload, 'decrypted');
        });

        it(`DecryptoStream, ${title}`, async function () {
          const { CryptoCipher } = await load('upstream');
          const cipher = new CryptoCipher(Buffer.from(PASSWORD));
          const encrypted = Buffer.concat([cipher.encrypt(ZIP20_HEADER), cipher.encrypt(payload)]);
          const pieces = chunks.length === 1 ? [encrypted] : cut(encrypted);
          const { upstream, port } = await runBoth(
            transformOf((impl) => new impl.DecryptoStream({ key: Buffer.from(PASSWORD) }), pieces),
            { endTimeout: END_TIMEOUT }
          );
          assert.strictEqual(upstream.error, null);
          assert.deepStrictEqual(port.error, upstream.error);
          assertBytes(port.bytes, upstream.bytes, 'decrypted against upstream');
          assertBytes(port.bytes, payload, 'decrypted');
          assert.equal(port.value, upstream.value);
          assert.equal(port.value, SIZE);
        });
      }

      it('CryptoCipher: encrypt() and decrypt() of one Buffer', async function () {
        const upstream = await load('upstream');
        const port = await load('port');
        const key = Buffer.from(PASSWORD);
        const expected = new upstream.CryptoCipher(key).encrypt(payload);
        const encrypted = new port.CryptoCipher(key).encrypt(payload);
        assertBytes(encrypted, expected, 'encrypt()');
        assertBytes(new port.CryptoCipher(key).decrypt(expected), payload, 'decrypt()');
        assertBytes(new upstream.CryptoCipher(key).decrypt(encrypted), payload, 'decrypt() of upstream');
        // the key state runs on over the slices and over the calls
        const cipher = new port.CryptoCipher(key);
        const [first, second, third] = cut(payload);
        assertBytes(
          Buffer.concat([cipher.encrypt(first), cipher.encrypt(second), cipher.encrypt(third)]),
          expected,
          'encrypt() in three calls'
        );
      });
    });
  }
});
