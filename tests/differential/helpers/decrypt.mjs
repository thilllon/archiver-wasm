// tests/differential/helpers/decrypt.mjs
// Payload decryption for the differential tests, built from upstream's own code and Node's crypto
// (PORTING.md 14.2). No port code.
//
//   decryptZip20(payload, password) -> Promise<{ header, data }>
//       header: the 12 decrypted header bytes (fewer when the payload is shorter, P17)
//   decryptAes(payload, password)   -> { salt, verifierOk, data, mac, expectedMac, macOk }
//   entryMethod(entry)              -> the real compression method of a parsed zip entry (0 or 8)
//   entryData(entry, password)      -> Promise<Buffer>: the decrypted and inflated payload of an
//                                      entry parsed by zip-records.mjs

import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import zlib from 'node:zlib';

const require = createRequire(import.meta.url);
const aes = require('aes-js');
const DecryptoStream = require('archiver-zip-encrypted/lib/zip20/decrypto-stream.js');
const CryptoCipher = require('archiver-zip-encrypted/lib/zip20/CryptoCipher.js');

// archiver-zip-encrypted/lib/zip20/crypto-stream.js:8
const HEADER_LENGTH = 12;

// archiver-zip-encrypted/lib/aes/aes-hmac-etm-stream.js:8-11
const SALT_LENGTH = 16;
const KEY_LENGTH = 32;
const COMPOSITE_KEY_LENGTH = 2 * KEY_LENGTH + 2;
const PBKDF2_ITERATION_COUNT = 1000;
const VERIFIER_LENGTH = 2;
const HMAC_LENGTH = 10;

const METHOD_AES = 99;

// archiver-zip-encrypted/lib/aes/aes-hmac-etm-stream.js:16-25 (set on the one counter, not on aes-js globally)
function increment() {
  for (var i = 0; i < 16; i++) {
    if (this._counter[i] === 255) {
      this._counter[i] = 0;
    } else {
      this._counter[i]++;
      break;
    }
  }
}

// archiver-zip-encrypted/lib/aes/aes-hmac-etm-stream.js:55-62
function deriveKey(salt, key) {
  const compositeKey = crypto.pbkdf2Sync(key, salt, PBKDF2_ITERATION_COUNT, COMPOSITE_KEY_LENGTH, 'sha1');
  return {
    aesKey: compositeKey.slice(0, KEY_LENGTH),
    hmacKey: compositeKey.slice(KEY_LENGTH, 2 * KEY_LENGTH),
    passwordVerifier: compositeKey.slice(2 * KEY_LENGTH),
  };
}

function toKey(password) {
  // archiver-zip-encrypted/lib/zip-encrypted.js:27-29
  return Buffer.isBuffer(password) ? password : Buffer.from(password, 'utf-8');
}

// archiver-zip-encrypted/test/crypto-stream.js:11-27 (the upstream DecryptoStream, driven to its end)
export function decryptZip20(payload, password) {
  const key = toKey(password);
  const header = new CryptoCipher(key).decrypt(payload.subarray(0, HEADER_LENGTH));
  return new Promise((resolve, reject) => {
    const decryptoStream = new DecryptoStream({ key });
    let finalData = Buffer.alloc(0);
    decryptoStream
      .on('data', (data) => {
        finalData = Buffer.concat([finalData, data]);
      })
      .on('error', reject)
      .on('end', () => {
        resolve({ header, data: finalData });
      });
    decryptoStream.end(payload);
  });
}

// archiver-zip-encrypted/test/aes-hmac-etm-stream.js:31-47 (salt, verifier, aes-js CTR decipher, 10-byte MAC)
export function decryptAes(payload, password) {
  if (payload.length < SALT_LENGTH + VERIFIER_LENGTH + HMAC_LENGTH) {
    throw new Error(`decrypt: an AES payload needs 28 bytes, found ${payload.length}`);
  }
  const salt = payload.subarray(0, SALT_LENGTH);
  const verifier = payload.subarray(SALT_LENGTH, SALT_LENGTH + VERIFIER_LENGTH);
  const ciphertext = payload.subarray(SALT_LENGTH + VERIFIER_LENGTH, payload.length - HMAC_LENGTH);
  const mac = payload.subarray(payload.length - HMAC_LENGTH);

  const compositeKey = deriveKey(salt, toKey(password));
  const counter = new aes.Counter(new Uint8Array(Buffer.from('01000000000000000000000000000000', 'hex')));
  counter.increment = increment;
  const decipher = new aes.ModeOfOperation.ctr(new Uint8Array(compositeKey.aesKey), counter);
  const data = Buffer.from(decipher.decrypt(new Uint8Array(ciphertext)));
  const expectedMac = crypto.createHmac('sha1', compositeKey.hmacKey).update(ciphertext).digest().slice(0, HMAC_LENGTH);

  return {
    salt,
    verifierOk: compositeKey.passwordVerifier.equals(verifier),
    data,
    mac,
    expectedMac,
    macOk: expectedMac.equals(mac),
  };
}

// PORTING.md 17.2: an AES entry has method 99 and keeps the real method in its extra field
export function entryMethod(entry) {
  const header = entry.central;
  if (header.method !== METHOD_AES) {
    return header.method;
  }
  if (!header.aes || header.aes.method === null) {
    throw new Error(`decrypt: entry ${JSON.stringify(entry.name)} has method 99 and no AES extra field`);
  }
  return header.aes.method;
}

export async function entryData(entry, password) {
  let data = entry.payload;
  if ((entry.central.flags & 0x0001) !== 0) {
    if (password === undefined) {
      throw new Error(`decrypt: entry ${JSON.stringify(entry.name)} is encrypted and no password was given`);
    }
    data =
      entry.central.method === METHOD_AES
        ? decryptAes(data, password).data
        : (await decryptZip20(data, password)).data;
  }
  return entryMethod(entry) === 8 ? zlib.inflateRawSync(data) : data;
}
