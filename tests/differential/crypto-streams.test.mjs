// tests/differential/crypto-streams.test.mjs
// PORTING.md 14.2: the exported encryption classes used on their own (AesHmacEtmStream, CryptoStream,
// DecryptoStream, CryptoCipher; 7.9) and passwords outside ASCII (ENCRYPTED-006). No upstream source.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import { once } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { decryptAes, decryptZip20, entryData } from './helpers/decrypt.mjs';
import { omitV15Keys, selectEvents } from './helpers/events.mjs';
import { load, runBoth } from './helpers/run-both.mjs';
import { parseZip } from './helpers/zip-records.mjs';

const DATE = new Date('2020-03-04T05:06:08.000Z');
const SALT = Buffer.from('000102030405060708090a0b0c0d0e0f', 'hex');
const ZIP20_HEADER = Buffer.from('a0a1a2a3a4a5a6a7a8a9aaab', 'hex');
// archiver-zip-encrypted/test/crypto-stream.js:10
const CRC = Buffer.from('ABF033D8', 'hex');
const TEXT = Buffer.from('this is a text file');
// PORTING.md 17.2: salt (16), password verifier (2), MAC (10); the 12 encrypted header bytes
const AES_OVERHEAD = 28;
const ZIP20_OVERHEAD = 12;
// PORTING.md 5.4 (MAX_CHUNK: the wrappers pass larger chunks to wasm in slices of 1 MiB)
const MEBIBYTE = 1024 * 1024;
// a password outside ASCII whose characters have no canonical decomposition (p7zip on macOS decomposes its arguments)
const PASSWORD = '日本€-pw';
const PASSWORD_UTF8 = Buffer.from(PASSWORD, 'utf-8');
const PASSWORD_LATIN1 = Buffer.from(PASSWORD, 'latin1');
// not valid UTF-8: a Buffer password is used as its bytes (zip-encrypted.js:27-29)
const PASSWORD_BYTES = Buffer.from([0x70, 0xe4, 0x80, 0xff, 0x31]);

// PORTING.md 14.2 (n bytes, byte i is (i * 7 + 3) & 255)
function binaryBuffer(n) {
  const buffer = Buffer.alloc(n);
  for (let i = 0; i < n; i++) {
    buffer[i] = (i * 7 + 3) & 255;
  }
  return buffer;
}

const DATA = binaryBuffer(5000);
const LARGE = binaryBuffer(3 * MEBIBYTE + 17);

// PORTING.md 14.2 (byte equality; a failure names the first differing offset instead of printing megabytes)
function assertBytes(found, expected, message = 'bytes') {
  assert.equal(Buffer.isBuffer(found), true, `${message}: a Buffer`);
  if (found.equals(expected)) {
    return;
  }
  let at = 0;
  while (at < found.length && at < expected.length && found[at] === expected[at]) {
    at += 1;
  }
  assert.fail(
    `${message}: ${found.length} bytes, expected ${expected.length}; first difference at ${at}: ` +
      `${found.subarray(at, at + 16).toString('hex')} != ${expected.subarray(at, at + 16).toString('hex')}`
  );
}

// PORTING.md 14.2 (determinism: every crypto.randomBytes of the run returns the leading bytes of `bytes`)
async function withRandom(bytes, run) {
  const randomBytes = crypto.randomBytes;
  const calls = [];
  crypto.randomBytes = function (size) {
    calls.push(size);
    return Buffer.from(bytes.subarray(0, size));
  };
  try {
    return { ...(await run()), randomBytes: calls };
  } finally {
    crypto.randomBytes = randomBytes;
  }
}

// PORTING.md 14.2 (one Transform driven to its end: the bytes, and the counters after every write and at the end)
async function drive(stream, chunks) {
  const out = [];
  const steps = [];
  const state = () => ({
    totalSize: stream.totalSize,
    getTotalSize: typeof stream.getTotalSize === 'function' ? stream.getTotalSize() : undefined,
    headerSent: stream.headerSent,
  });
  stream.on('data', (chunk) => {
    assert.equal(Buffer.isBuffer(chunk), true, 'a data chunk is a Buffer');
    out.push(chunk);
  });
  const ended = once(stream, 'end');
  for (const chunk of chunks) {
    await new Promise((resolve, reject) => {
      stream.write(chunk, (err) => (err ? reject(err) : resolve()));
    });
    steps.push(state());
  }
  stream.end();
  await ended;
  steps.push(state());
  return { bytes: Buffer.concat(out), steps };
}

// PORTING.md 14.2 (the same stream of each implementation, upstream first, under the same random bytes)
async function driveBoth(make, chunks, random = SALT) {
  const upstream = await withRandom(random, async () => drive(make(await load('upstream')), chunks));
  const ykk = await withRandom(random, async () => drive(make(await load('ykk')), chunks));
  assert.deepStrictEqual(ykk.steps, upstream.steps);
  assert.deepStrictEqual(ykk.randomBytes, upstream.randomBytes);
  assertBytes(ykk.bytes, upstream.bytes);
  return { upstream, ykk };
}

// PORTING.md 12.3 (7z is a prerequisite on PATH; p7zip reads its arguments in the encoding of the locale)
function run7z(commandArgs) {
  const env = process.platform === 'darwin' ? process.env : { ...process.env, LC_ALL: 'C.UTF-8' };
  const result = spawnSync('7z', commandArgs, { encoding: 'utf8', env });
  assert.equal(result.error, undefined, `7z: ${result.error}`);
  assert.equal(result.status, 0, `7z ${commandArgs.join(' ')}\n${result.stdout}${result.stderr}`);
  return result.stdout;
}

// PORTING.md 14.2 (events: for aes256 and zip20 the keys only the archiver 7 stack writes are ignored, V15)
function comparedEvents(run) {
  return omitV15Keys(selectEvents(run.events));
}

// PORTING.md 14.2 (comparison rules, stored encrypted zip: whole-archive byte equality, events, pointer)
function assertSameBytes(upstream, ykk) {
  assert.deepStrictEqual(ykk.error, upstream.error);
  assert.equal(ykk.error, null);
  assertBytes(ykk.bytes, upstream.bytes, 'archive');
  assert.deepStrictEqual(comparedEvents(ykk), comparedEvents(upstream));
  assert.equal(ykk.pointer, upstream.pointer);
  return { u: parseZip(upstream.bytes), y: parseZip(ykk.bytes) };
}

describe('differential: the encryption classes on their own (PORTING.md 7.9)', function () {
  this.timeout(30000);

  describe('W1 AesHmacEtmStream (aes-hmac-etm-stream.js:31-105)', function () {
    const cases = [
      ['a salt and a Buffer key, two chunks', (impl) => new impl.AesHmacEtmStream({ salt: SALT, key: Buffer.from('pw') }), [DATA.subarray(0, 3000), DATA.subarray(3000)], 'pw'],
      ['called without new', (impl) => impl.AesHmacEtmStream({ salt: SALT, key: 'pw' }), [DATA], 'pw'],
      ['no salt: crypto.randomBytes(16)', (impl) => new impl.AesHmacEtmStream({ key: 'pw' }), [DATA.subarray(0, 1), DATA.subarray(1)], 'pw'],
      ['a string key outside ASCII', (impl) => new impl.AesHmacEtmStream({ salt: SALT, key: PASSWORD }), [DATA], PASSWORD_UTF8],
      ['a Buffer key that is not UTF-8', (impl) => new impl.AesHmacEtmStream({ salt: SALT, key: PASSWORD_BYTES }), [DATA], PASSWORD_BYTES],
      ['no data', (impl) => new impl.AesHmacEtmStream({ salt: SALT, key: 'pw' }), [], 'pw'],
      ['one chunk of no bytes', (impl) => new impl.AesHmacEtmStream({ salt: SALT, key: 'pw' }), [Buffer.alloc(0)], 'pw'],
      ['a chunk of no bytes between two chunks', (impl) => new impl.AesHmacEtmStream({ salt: SALT, key: 'pw' }), [DATA.subarray(0, 16), Buffer.alloc(0), DATA.subarray(16, 33)], 'pw'],
      ['chunks of 1 to 40 bytes', (impl) => new impl.AesHmacEtmStream({ salt: SALT, key: 'pw' }), Array.from({ length: 40 }, (_, i) => DATA.subarray(i * 40, i * 40 + i + 1)), 'pw'],
      ['one chunk above 3 MiB', (impl) => new impl.AesHmacEtmStream({ salt: SALT, key: 'pw' }), [LARGE], 'pw'],
      ['chunks of 1 MiB, 1 MiB + 1 and 1 MiB - 1', (impl) => new impl.AesHmacEtmStream({ salt: SALT, key: 'pw' }), [LARGE.subarray(0, MEBIBYTE), LARGE.subarray(MEBIBYTE, 2 * MEBIBYTE + 1), LARGE.subarray(2 * MEBIBYTE + 1, 3 * MEBIBYTE)], 'pw'],
    ];

    for (const [title, make, chunks, password] of cases) {
      it(title, async function () {
        const { upstream, ykk } = await driveBoth(make, chunks);
        const input = Buffer.concat(chunks);
        for (const run of [upstream, ykk]) {
          // aes-hmac-etm-stream.js:27-30 (${salt}${passwordVerifier}${encodedData}${hmac})
          assert.equal(run.bytes.length, input.length + AES_OVERHEAD);
          const decrypted = decryptAes(run.bytes, password);
          assert.deepStrictEqual(decrypted.salt, SALT);
          assert.equal(decrypted.verifierOk, true, 'password verifier');
          assert.deepStrictEqual(decrypted.mac, decrypted.expectedMac, 'MAC');
          assertBytes(decrypted.data, input, 'decrypted data');
          // aes-hmac-etm-stream.js:63-65, 97-100
          const last = run.steps[run.steps.length - 1];
          assert.deepStrictEqual(last, { totalSize: run.bytes.length, getTotalSize: run.bytes.length, headerSent: true });
        }
        // aes-hmac-etm-stream.js:37-39
        assert.deepStrictEqual(ykk.randomBytes, title.startsWith('no salt') ? [16] : []);
      });
    }

    it('the salt, key and password verifier fields (aes-hmac-etm-stream.js:36-47)', async function () {
      const fields = async (name, options) => {
        const impl = await load(name);
        const stream = new impl.AesHmacEtmStream(options);
        const found = {
          salt: stream.salt,
          aesKey: Buffer.from(stream.key.aesKey),
          hmacKey: Buffer.from(stream.key.hmacKey),
          passwordVerifier: Buffer.from(stream.passwordVerifier),
          sameVerifier: stream.passwordVerifier === stream.key.passwordVerifier,
          headerSent: stream.headerSent,
          totalSize: stream.getTotalSize(),
          derived: stream.deriveKey(Buffer.from('ffeeddccbbaa99887766554433221100', 'hex'), PASSWORD),
        };
        stream.destroy();
        return found;
      };
      for (const key of ['pw', PASSWORD, PASSWORD_UTF8, PASSWORD_BYTES]) {
        const upstream = await fields('upstream', { salt: SALT, key });
        const ykk = await fields('ykk', { salt: SALT, key });
        assert.deepStrictEqual(ykk, upstream);
        // aes-hmac-etm-stream.js:54-61 (PBKDF2-HMAC-SHA1, 1000 iterations, 66 bytes)
        const composite = crypto.pbkdf2Sync(key, SALT, 1000, 66, 'sha1');
        assert.deepStrictEqual(ykk.aesKey, composite.subarray(0, 32));
        assert.deepStrictEqual(ykk.hmacKey, composite.subarray(32, 64));
        assert.deepStrictEqual(ykk.passwordVerifier, composite.subarray(64));
      }
    });
  });

  describe('W2 CryptoStream (crypto-stream.js:13-50)', function () {
    const cases = [
      ['a string key, two chunks', (impl) => new impl.CryptoStream({ key: '123', crc: CRC }), [DATA.subarray(0, 10), DATA.subarray(10)], '123'],
      ['called without new, a Buffer key', (impl) => impl.CryptoStream({ key: Buffer.from('123'), crc: CRC }), [DATA], '123'],
      ['a string key outside ASCII', (impl) => new impl.CryptoStream({ key: PASSWORD, crc: CRC }), [DATA], PASSWORD_UTF8],
      ['a Buffer key that is not UTF-8', (impl) => new impl.CryptoStream({ key: PASSWORD_BYTES, crc: CRC }), [DATA], PASSWORD_BYTES],
      ['a crc of 00000001', (impl) => new impl.CryptoStream({ key: '123', crc: Buffer.from('00000001', 'hex') }), [DATA], '123', Buffer.from('00000001', 'hex')],
      ['a crc of ff0100fe', (impl) => new impl.CryptoStream({ key: '123', crc: Buffer.from('ff0100fe', 'hex') }), [DATA], '123', Buffer.from('ff0100fe', 'hex')],
      ['one chunk of no bytes: the header alone', (impl) => new impl.CryptoStream({ key: '123', crc: CRC }), [Buffer.alloc(0)], '123'],
      ['chunks of 1 to 40 bytes', (impl) => new impl.CryptoStream({ key: '123', crc: CRC }), Array.from({ length: 40 }, (_, i) => DATA.subarray(i * 40, i * 40 + i + 1)), '123'],
      ['one chunk above 3 MiB', (impl) => new impl.CryptoStream({ key: '123', crc: CRC }), [LARGE], '123'],
    ];

    for (const [title, make, chunks, password, crc = CRC] of cases) {
      it(title, async function () {
        const { upstream, ykk } = await driveBoth(make, chunks, ZIP20_HEADER);
        const input = Buffer.concat(chunks);
        for (const run of [upstream, ykk]) {
          assert.equal(run.bytes.length, input.length + ZIP20_OVERHEAD);
          const decrypted = await decryptZip20(run.bytes, password);
          // crypto-stream.js:33-34 (10 random bytes, then bits 16..31 of the CRC, low byte first)
          assert.deepStrictEqual(decrypted.header, Buffer.concat([ZIP20_HEADER.subarray(0, 10), Buffer.from([crc[1], crc[0]])]));
          assertBytes(decrypted.data, input, 'decrypted data');
          assert.deepStrictEqual(run.randomBytes, [12]);
          assert.equal(run.steps[run.steps.length - 1].headerSent, true);
        }
      });
    }

    it('the check bytes of crc abf033d8 are f0 ab (crypto-stream.js:34)', async function () {
      const { ykk } = await driveBoth((impl) => new impl.CryptoStream({ key: '123', crc: CRC }), [TEXT], ZIP20_HEADER);
      const header = (await decryptZip20(ykk.bytes, '123')).header;
      assert.equal(header.toString('hex'), 'a0a1a2a3a4a5a6a7a8a9f0ab');
    });

    it('no data: nothing is written and no random bytes are drawn (crypto-stream.js:31-32)', async function () {
      const { ykk } = await driveBoth((impl) => new impl.CryptoStream({ key: '123', crc: CRC }), [], ZIP20_HEADER);
      assert.equal(ykk.bytes.length, 0);
      assert.deepStrictEqual(ykk.randomBytes, []);
      assert.deepStrictEqual(ykk.steps, [{ totalSize: undefined, getTotalSize: undefined, headerSent: false }]);
    });

    it('the header option of ykk replaces crypto.randomBytes(12) (V10)', async function () {
      const chunks = [DATA.subarray(0, 100), DATA.subarray(100)];
      const upstream = await withRandom(ZIP20_HEADER, async () =>
        drive(new (await load('upstream')).CryptoStream({ key: PASSWORD, crc: CRC }), chunks)
      );
      const header = Buffer.from(ZIP20_HEADER);
      const ykk = await withRandom(Buffer.alloc(12, 0xee), async () =>
        drive(new (await load('ykk')).CryptoStream({ key: PASSWORD, crc: CRC, header }), chunks)
      );
      assertBytes(ykk.bytes, upstream.bytes);
      assert.deepStrictEqual(ykk.steps, upstream.steps);
      assert.deepStrictEqual(ykk.randomBytes, []);
    });
  });

  describe('W3 DecryptoStream (decrypto-stream.js:12-60)', function () {
    let payload;
    let large;

    // the input is upstream's own ciphertext
    async function encrypt(key, data) {
      const upstream = await load('upstream');
      return (await withRandom(ZIP20_HEADER, () => drive(new upstream.CryptoStream({ key, crc: CRC }), [data]))).bytes;
    }

    before(async function () {
      payload = await encrypt('123', DATA);
      large = await encrypt('123', LARGE);
    });

    const cases = [
      ['one chunk', () => [payload]],
      ['the header split across two chunks', () => [payload.subarray(0, 8), payload.subarray(8)]],
      ['a first chunk of exactly the 12 header bytes', () => [payload.subarray(0, 12), payload.subarray(12)]],
      ['a first chunk of 13 bytes', () => [payload.subarray(0, 13), payload.subarray(13)]],
      ['the header in chunks of 5 and 7 bytes', () => [payload.subarray(0, 5), payload.subarray(5, 12), payload.subarray(12, 2000), payload.subarray(2000)]],
      ['one byte at a time', () => Array.from({ length: 64 }, (_, i) => payload.subarray(i, i + 1))],
      ['a chunk of no bytes inside the header and after it', () => [payload.subarray(0, 6), Buffer.alloc(0), payload.subarray(6, 30), Buffer.alloc(0), payload.subarray(30)]],
      ['11 bytes: nothing is written', () => [payload.subarray(0, 11)]],
      ['12 bytes: nothing is written', () => [payload.subarray(0, 12)]],
      ['no data', () => []],
      ['one chunk above 3 MiB', () => [large], LARGE],
      ['the header and the data above 3 MiB in two chunks', () => [large.subarray(0, 12), large.subarray(12)], LARGE],
    ];

    for (const [title, chunksOf, plain = DATA] of cases) {
      it(title, async function () {
        const chunks = chunksOf();
        const { ykk } = await driveBoth((impl) => new impl.DecryptoStream({ key: '123' }), chunks);
        const length = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
        const expected = plain.subarray(0, Math.max(0, length - ZIP20_OVERHEAD));
        assertBytes(ykk.bytes, expected, 'decrypted data');
        // decrypto-stream.js:29-31, 54-57
        assert.equal(ykk.steps[ykk.steps.length - 1].getTotalSize, expected.length);
        assert.equal(ykk.steps[ykk.steps.length - 1].totalSize, expected.length);
      });
    }

    it('called without new, a Buffer key and a key outside ASCII', async function () {
      for (const [key, bytes] of [[Buffer.from('123'), '123'], [PASSWORD, PASSWORD_UTF8], [PASSWORD_BYTES, PASSWORD_BYTES]]) {
        const encrypted = await encrypt(bytes, DATA);
        const { ykk } = await driveBoth((impl) => impl.DecryptoStream({ key }), [encrypted.subarray(0, 7), encrypted.subarray(7)]);
        assertBytes(ykk.bytes, DATA, 'decrypted data');
      }
    });

    it('a wrong key: the same wrong bytes', async function () {
      const { ykk } = await driveBoth((impl) => new impl.DecryptoStream({ key: PASSWORD_LATIN1 }), [await encrypt(PASSWORD, DATA)]);
      assert.equal(ykk.bytes.length, DATA.length);
      assert.notDeepStrictEqual(ykk.bytes, DATA);
    });

    it('CryptoStream piped into DecryptoStream (archiver-zip-encrypted/test/crypto-stream.js:10-27)', async function () {
      for (const name of ['upstream', 'ykk']) {
        const impl = await load(name);
        const cryptoStream = new impl.CryptoStream({ crc: CRC, key: PASSWORD });
        const decryptoStream = new impl.DecryptoStream({ key: PASSWORD });
        const chunks = [];
        const ended = once(decryptoStream, 'end');
        cryptoStream.pipe(decryptoStream).on('data', (data) => chunks.push(data));
        cryptoStream.write(LARGE.subarray(0, MEBIBYTE + 5));
        cryptoStream.end(LARGE.subarray(MEBIBYTE + 5));
        await ended;
        assertBytes(Buffer.concat(chunks), LARGE, name);
        assert.equal(decryptoStream.getTotalSize(), LARGE.length, name);
      }
    });
  });

  describe('W4 CryptoCipher (CryptoCipher.js:14-71)', function () {
    const keys = [
      ['a string key', '123'],
      ['a Buffer key', Buffer.from('123')],
      ['a string key outside ASCII', PASSWORD],
      ['a Buffer key that is not UTF-8', PASSWORD_BYTES],
      ['an empty key', ''],
    ];

    for (const [title, key] of keys) {
      it(`${title}: encrypt and decrypt, call after call`, async function () {
        const upstream = await load('upstream');
        const ykk = await load('ykk');
        const parts = [Buffer.from('hello world!'), Buffer.alloc(0), DATA, Buffer.from([0x00]), Buffer.from([0xff, 0x00, 0x80])];

        const u = new upstream.CryptoCipher(key);
        const y = new ykk.CryptoCipher(key);
        // CryptoCipher.js:15-18
        assert.equal(Buffer.isBuffer(y.key), true);
        assert.deepStrictEqual(y.key, u.key);
        const encrypted = [];
        for (const part of parts) {
          const expected = u.encrypt(Buffer.from(part));
          const found = y.encrypt(Buffer.from(part));
          assert.equal(Buffer.isBuffer(found), true);
          assert.deepStrictEqual(found, expected);
          encrypted.push(expected);
        }
        assert.notDeepStrictEqual(encrypted[0], parts[0]);

        const ud = new upstream.CryptoCipher(key);
        const yd = new ykk.CryptoCipher(key);
        for (const [index, part] of encrypted.entries()) {
          const expected = ud.decrypt(Buffer.from(part));
          const found = yd.decrypt(Buffer.from(part));
          assert.equal(Buffer.isBuffer(found), true);
          assert.deepStrictEqual(found, expected);
          assert.deepStrictEqual(found, parts[index]);
        }

        // CryptoCipher.js:51-55 (decrypt updates the keys with the plain byte: not the inverse call order of encrypt)
        const um = new upstream.CryptoCipher(key);
        const ym = new ykk.CryptoCipher(key);
        assert.deepStrictEqual(ym.decrypt(Buffer.from(parts[0])), um.decrypt(Buffer.from(parts[0])));
        assert.deepStrictEqual(ym.encrypt(Buffer.from(parts[2])), um.encrypt(Buffer.from(parts[2])));
      });
    }

    it('known bytes: key 123, hello world!', async function () {
      const upstream = await load('upstream');
      const ykk = await load('ykk');
      const expected = new upstream.CryptoCipher('123').encrypt(Buffer.from('hello world!')).toString('hex');
      assert.equal(new ykk.CryptoCipher('123').encrypt(Buffer.from('hello world!')).toString('hex'), expected);
      assert.equal(new ykk.CryptoCipher(Buffer.from('123')).decrypt(Buffer.from(expected, 'hex')).toString(), 'hello world!');
    });

    it('data above 3 MiB', async function () {
      const upstream = await load('upstream');
      const ykk = await load('ykk');
      const expected = new upstream.CryptoCipher(PASSWORD).encrypt(LARGE);
      const found = new ykk.CryptoCipher(PASSWORD).encrypt(LARGE);
      assertBytes(found, expected, 'encrypted');
      assertBytes(new ykk.CryptoCipher(PASSWORD).decrypt(expected), LARGE, 'decrypted');
    });
  });
});

describe('differential: passwords outside ASCII (ENCRYPTED-006)', function () {
  this.timeout(30000);
  let root;
  let serial = 0;

  before(function () {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ykk-diff-password-')));
  });

  after(function () {
    fs.rmSync(root, { recursive: true, force: true });
  });

  const entries = [
    { name: 'a.txt', data: TEXT },
    { name: 'big.bin', data: DATA },
  ];

  // PORTING.md 14.2 (one encrypted archive per implementation through the vending function)
  function archiveOf(method, password, options) {
    return async (impl, ctx) => {
      const archive = ctx.create(method, { password, ...(method === 'aes256' ? { salt: SALT } : {}), ...options });
      for (const entry of entries) {
        archive.append(entry.data, { name: entry.name, date: DATE });
      }
      await archive.finalize();
    };
  }

  // PORTING.md 14.2 (the engine built by hand: zip-aes-stream.js:20-27, zip-crypto-stream.js:17-24)
  function engineOf(method, password, options) {
    return async (impl, ctx) => {
      const engine = ctx.track(
        method === 'aes256'
          ? new impl.ZipAesStream({ password, salt: SALT, ...options })
          : new impl.ZipCryptoStream({ password, zip20Header: Buffer.from(ctx.zip20Header), ...options })
      );
      const ended = once(engine, 'end');
      for (const entry of entries) {
        await new Promise((resolve, reject) => {
          engine.entry(entry.data, { name: entry.name, date: DATE }, (err) => (err ? reject(err) : resolve()));
        });
      }
      engine.finalize();
      await ended;
    };
  }

  // PORTING.md 14.2 (decrypt.mjs: upstream's code and Node's crypto under the bytes of the password)
  async function assertDecrypts(zip, method, key, wrong) {
    assert.deepStrictEqual(zip.entries.map((entry) => entry.name), entries.map((entry) => entry.name));
    for (const [index, entry] of zip.entries.entries()) {
      assert.equal(entry.central.flags & 0x0001, 0x0001, `${entry.name}: encrypted`);
      assert.deepStrictEqual(await entryData(entry, key), entries[index].data, `${entry.name}: content`);
      if (method === 'aes256') {
        const decrypted = decryptAes(entry.payload, key);
        assert.equal(decrypted.verifierOk, true, `${entry.name}: password verifier`);
        assert.equal(decrypted.macOk, true, `${entry.name}: MAC`);
        if (wrong !== undefined) {
          assert.equal(decryptAes(entry.payload, wrong).verifierOk, false, `${entry.name}: verifier under the wrong bytes`);
        }
      } else {
        const crc = entry.central.crc;
        const check = Buffer.from([(crc >>> 16) & 0xff, (crc >>> 24) & 0xff]);
        const header = (await decryptZip20(entry.payload, key)).header;
        assert.deepStrictEqual(header, Buffer.concat([ZIP20_HEADER.subarray(0, 10), check]), `${entry.name}: encryption header`);
        if (wrong !== undefined) {
          const other = (await decryptZip20(entry.payload, wrong)).header;
          assert.notDeepStrictEqual(other.subarray(10), check, `${entry.name}: check bytes under the wrong bytes`);
        }
      }
    }
  }

  // PORTING.md 14.4 (`7z t -p` and `7z x -p` with the password as typed)
  function assert7z(bytes, password) {
    serial += 1;
    const file = path.join(root, `archive-${serial}.zip`);
    const out = path.join(root, `out-${serial}`);
    fs.writeFileSync(file, bytes);
    run7z(['t', `-p${password}`, file]);
    run7z(['x', '-y', `-p${password}`, `-o${out}`, file]);
    assert.deepStrictEqual(fs.readdirSync(out).sort(), entries.map((entry) => entry.name).sort());
    for (const entry of entries) {
      assert.deepStrictEqual(fs.readFileSync(path.join(out, entry.name)), entry.data, `${entry.name}: extracted content`);
    }
  }

  for (const method of ['aes256', 'zip20']) {
    describe(method, function () {
      it('a string password, stored: the bytes of upstream, decrypted under its UTF-8 bytes and by 7z', async function () {
        const { upstream, ykk } = await runBoth(archiveOf(method, PASSWORD, { store: true }), { random: ZIP20_HEADER });
        const zips = assertSameBytes(upstream, ykk);
        // zip-encrypted.js:27-29 (Buffer.from(password, 'utf-8'))
        await assertDecrypts(zips.y, method, PASSWORD_UTF8, PASSWORD_LATIN1);
        assert7z(ykk.bytes, PASSWORD);
      });

      it('a string password, default method: decrypted under its UTF-8 bytes and by 7z', async function () {
        const { upstream, ykk } = await runBoth(archiveOf(method, PASSWORD, {}), { random: ZIP20_HEADER });
        assert.equal(ykk.error, null);
        assert.equal(upstream.error, null);
        await assertDecrypts(parseZip(upstream.bytes), method, PASSWORD_UTF8, PASSWORD_LATIN1);
        await assertDecrypts(parseZip(ykk.bytes), method, PASSWORD_UTF8, PASSWORD_LATIN1);
        assert7z(ykk.bytes, PASSWORD);
        assert7z(upstream.bytes, PASSWORD);
      });

      it('a Buffer password of the same UTF-8 bytes: the archive of the string password', async function () {
        const text = await runBoth(archiveOf(method, PASSWORD, { store: true }), { random: ZIP20_HEADER });
        const { upstream, ykk } = await runBoth(archiveOf(method, Buffer.from(PASSWORD_UTF8), { store: true }), { random: ZIP20_HEADER });
        assertSameBytes(upstream, ykk);
        assertBytes(ykk.bytes, text.ykk.bytes, 'archive of the string password');
        assert7z(ykk.bytes, PASSWORD);
      });

      it('a Buffer password that is not UTF-8, stored: the bytes of upstream, decrypted under those bytes', async function () {
        const { upstream, ykk } = await runBoth(archiveOf(method, Buffer.from(PASSWORD_BYTES), { store: true }), { random: ZIP20_HEADER });
        const zips = assertSameBytes(upstream, ykk);
        await assertDecrypts(zips.y, method, PASSWORD_BYTES, Buffer.from(PASSWORD_BYTES.toString('utf-8'), 'utf-8'));
      });

      it('a Buffer password of the latin1 bytes is another password', async function () {
        const text = await runBoth(archiveOf(method, PASSWORD, { store: true }), { random: ZIP20_HEADER });
        const { upstream, ykk } = await runBoth(archiveOf(method, Buffer.from(PASSWORD_LATIN1), { store: true }), { random: ZIP20_HEADER });
        assertSameBytes(upstream, ykk);
        assert.notDeepStrictEqual(ykk.bytes, text.ykk.bytes);
      });

      // zip-aes-stream.js:22-24, zip-crypto-stream.js:19-21 (the engine converts a string password itself)
      it('the engine built by hand, a string password: the bytes of upstream, decrypted under its UTF-8 bytes and by 7z', async function () {
        const { upstream, ykk } = await runBoth(engineOf(method, PASSWORD, { store: true }), { random: ZIP20_HEADER });
        assert.deepStrictEqual(ykk.error, upstream.error);
        assert.equal(ykk.error, null);
        assertBytes(ykk.bytes, upstream.bytes, 'archive');
        await assertDecrypts(parseZip(ykk.bytes), method, PASSWORD_UTF8, PASSWORD_LATIN1);
        assert7z(ykk.bytes, PASSWORD);
      });

      it('the engine built by hand, a Buffer password that is not UTF-8: the bytes of upstream', async function () {
        const { upstream, ykk } = await runBoth(engineOf(method, Buffer.from(PASSWORD_BYTES), { store: true }), { random: ZIP20_HEADER });
        assert.deepStrictEqual(ykk.error, upstream.error);
        assert.equal(ykk.error, null);
        assertBytes(ykk.bytes, upstream.bytes, 'archive');
        await assertDecrypts(parseZip(ykk.bytes), method, PASSWORD_BYTES);
      });
    });
  }
});
