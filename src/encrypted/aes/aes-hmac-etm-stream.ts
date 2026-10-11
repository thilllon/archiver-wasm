import * as crypto from 'node:crypto';
import { Transform } from 'node:stream';
import type { TransformCallback } from 'node:stream';
import { types } from 'node:util';
import { callable } from '../../callable.js';
import type { AesHmacEtmStreamOptions } from '../../types.js';
import { EMPTY, MAX_CHUNK, toBuffer, wasm } from '../../wasm.js';
import type { WasmAesHmacEtmStream } from '../../wasm-types.js';

const SALT_LENGTH = 16;
const KEY_LENGTH = 32;
const COMPOSITE_KEY_LENGTH = 2 * KEY_LENGTH + 2;
const PBKDF2_ITERATION_COUNT = 1000;

// archiver-zip-encrypted/lib/aes/aes-hmac-etm-stream.js:55 (the argument conversion of crypto.pbkdf2Sync, PORTING.md 7.9)
export function toBytes(value: unknown, name: string): Buffer {
    if (typeof value === 'string') {
        return Buffer.from(value);
    }
    if (Buffer.isBuffer(value)) {
        return value;
    }
    if (ArrayBuffer.isView(value)) {
        return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
    }
    if (types.isAnyArrayBuffer(value)) {
        return Buffer.from(value);
    }
    throw new TypeError('The "' + name + '" argument must be of type string or an instance of ArrayBuffer, Buffer, TypedArray, or DataView.');
}

/**
 * Transform stream that encodes data with AES stream and prepends additional data for authentication and verification:
 * ${salt}${passwordVerifier}${encodedData}${hmac}
 */
class AesHmacEtmStreamImpl extends Transform {
    salt: string | Buffer | null | undefined;
    key: { aesKey: Buffer; hmacKey: Buffer; passwordVerifier: Buffer };
    passwordVerifier: Buffer;
    headerSent: boolean;
    totalSize: number;
    _wasm: WasmAesHmacEtmStream;

    // archiver-zip-encrypted/lib/aes/aes-hmac-etm-stream.js:31-51
    constructor(options: AesHmacEtmStreamOptions = {key: null, salt: null, transformOptions: {}} as unknown as AesHmacEtmStreamOptions) {
        super(options);

        this.salt = options.salt;
        if (!this.salt) {
            this.salt = crypto.randomBytes(SALT_LENGTH);
        }

        this.key = this.deriveKey(this.salt, options.key);
        this._wasm = new wasm.WasmAesHmacEtmStream(this.key.aesKey, this.key.hmacKey, this.key.passwordVerifier, toBytes(this.salt, 'salt'));
        this.passwordVerifier = this.key.passwordVerifier;

        this.headerSent = false;
        this.totalSize = 0;
    }

    // archiver-zip-encrypted/lib/aes/aes-hmac-etm-stream.js:54-61
    deriveKey(salt: string | Buffer, key: string | Buffer): { aesKey: Buffer; hmacKey: Buffer; passwordVerifier: Buffer } {
        const password = toBytes(key, 'password');
        const compositeKey = toBuffer(wasm.WasmAesHmacEtmStream.deriveKey(toBytes(salt, 'salt'), password));
        return {
            aesKey: compositeKey.slice(0, KEY_LENGTH),
            hmacKey: compositeKey.slice(KEY_LENGTH, 2 * KEY_LENGTH),
            passwordVerifier: compositeKey.slice(2 * KEY_LENGTH)
        };
    }

    // archiver-zip-encrypted/lib/aes/aes-hmac-etm-stream.js:63-65
    getTotalSize(): number {
        return this.totalSize;
    }

    // archiver-zip-encrypted/lib/aes/aes-hmac-etm-stream.js:79-91
    _transform(data: Buffer, encoding: BufferEncoding, cb: TransformCallback): void {
        // archiver-zip-encrypted/lib/aes/aes-hmac-etm-stream.js:80 (ensureHeaderSent, also for a zero-length chunk)
        if (!this.headerSent) {
            let header = toBuffer(this._wasm.transform(EMPTY));

            this.push(header);
            this.totalSize = this._wasm.getTotalSize();

            this.headerSent = true;
        }

        for (let i = 0; i < data.length; i += MAX_CHUNK) {
            let encoded = toBuffer(this._wasm.transform(data.subarray(i, i + MAX_CHUNK)));

            if (encoded.length > 0) {
                this.push(encoded);
            }
            this.totalSize = this._wasm.getTotalSize();
        }

        cb();
    }

    // archiver-zip-encrypted/lib/aes/aes-hmac-etm-stream.js:93-103
    _flush(cb: TransformCallback): void {
        // _transform is not called for non-file entries, such as directories
        let hmacData = toBuffer(this._wasm.flush());
        this.headerSent = true;
        if (hmacData.length > 0) {
            this.push(hmacData);
        }

        this.totalSize = this._wasm.getTotalSize();

        cb();
    }

    // PORTING.md 5.4 (lifetime)
    _destroy(err: Error | null, callback: (error: Error | null) => void): void {
        if (this._wasm) {
            this._wasm.free();
        }
        callback(err);
    }
}

// archiver-zip-encrypted/lib/aes/aes-hmac-etm-stream.js:32-34 (callable without new, PORTING.md R18)
export const AesHmacEtmStream = callable(AesHmacEtmStreamImpl);
