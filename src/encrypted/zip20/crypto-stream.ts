import * as crypto from 'node:crypto';
import { Transform } from 'node:stream';
import type { TransformCallback } from 'node:stream';
import { callable } from '../../callable.js';
import type { CryptoStreamOptions } from '../../types.js';
import { EMPTY, MAX_CHUNK, toBuffer, wasm } from '../../wasm.js';
import type { WasmCryptoStream } from '../../wasm-types.js';
import { CryptoCipher } from './crypto-cipher.js';

const HEADER_LENGTH = 12;

/**
 * Transform stream that encodes data with CryptoCipher
 */
class CryptoStreamImpl extends Transform {
    key: string | Buffer;
    crc: Buffer;
    cipher: CryptoCipher;
    headerSent: boolean;
    header: Buffer | undefined;
    _wasm: WasmCryptoStream | undefined;

    // archiver-zip-encrypted/lib/zip20/crypto-stream.js:13-24
    constructor(options: CryptoStreamOptions = {key: null, crc: null, transformOptions: {}} as unknown as CryptoStreamOptions) {
        super(options);

        this.key = options.key;
        this.crc = options.crc;
        this.cipher = new CryptoCipher(this.key);

        this.headerSent = false;

        // PORTING.md V10
        this.header = options.header;
        if (this.header !== undefined && !(Buffer.isBuffer(this.header) && this.header.length === HEADER_LENGTH)) {
            throw new TypeError('header must be a Buffer of 12 bytes');
        }
    }

    // archiver-zip-encrypted/lib/zip20/crypto-stream.js:31-50
    _transform(data: Buffer, encoding: BufferEncoding, cb: TransformCallback): void {
        if (!this.headerSent) {
            let header = this.header || crypto.randomBytes(HEADER_LENGTH);
            this._wasm = new wasm.WasmCryptoStream(this.cipher.key, this.crc.readUInt16BE(0), header);

            let encryptedHeader = toBuffer(this._wasm.transform(EMPTY));

            this.push(encryptedHeader);

            this.headerSent = true;
        }

        for (let i = 0; i < data.length; i += MAX_CHUNK) {
            let encrypted = toBuffer((this._wasm as WasmCryptoStream).transform(data.subarray(i, i + MAX_CHUNK)));

            if (encrypted.length > 0) {
                this.push(encrypted);
            }
        }

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

// archiver-zip-encrypted/lib/zip20/crypto-stream.js:14-16 (callable without new, PORTING.md R18)
export const CryptoStream = callable(CryptoStreamImpl);
