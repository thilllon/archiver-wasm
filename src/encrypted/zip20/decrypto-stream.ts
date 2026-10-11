import { Transform } from 'node:stream';
import type { TransformCallback } from 'node:stream';
import { callable } from '../../callable.js';
import type { DecryptoStreamOptions } from '../../types.js';
import { MAX_CHUNK, toBuffer, wasm } from '../../wasm.js';
import type { WasmDecryptoStream } from '../../wasm-types.js';
import { CryptoCipher } from './crypto-cipher.js';

const HEADER_LENGTH = 12;

/**
 * Transform stream that encodes data with CryptoCipher
 */
class DecryptoStreamImpl extends Transform {
    key: string | Buffer;
    crc: Buffer | undefined;
    cipher: CryptoCipher;
    header: Buffer;
    headerProcessed: boolean;
    totalSize: number;
    _wasm: WasmDecryptoStream;

    // archiver-zip-encrypted/lib/zip20/decrypto-stream.js:12-25
    constructor(options: DecryptoStreamOptions = {key: null, crc: null, transformOptions: {}} as unknown as DecryptoStreamOptions) {
        super(options);

        this.key = options.key;
        this.crc = options.crc;
        this.cipher = new CryptoCipher(this.key);
        this._wasm = new wasm.WasmDecryptoStream(this.cipher.key);

        this.header = Buffer.alloc(0);
        this.headerProcessed = false;
        this.totalSize = 0;
    }

    // archiver-zip-encrypted/lib/zip20/decrypto-stream.js:29-31
    getTotalSize(): number {
        return this.totalSize;
    }

    // archiver-zip-encrypted/lib/zip20/decrypto-stream.js:37-60
    _transform(data: Buffer, encoding: BufferEncoding, cb: TransformCallback): void {
        for (let i = 0; i < data.length; i += MAX_CHUNK) {
            let decrypted = toBuffer(this._wasm.transform(data.subarray(i, i + MAX_CHUNK)));

            if (decrypted.length > 0) {
                this.push(decrypted);
            }
            this.totalSize = this._wasm.getTotalSize();
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

// archiver-zip-encrypted/lib/zip20/decrypto-stream.js:13-15 (callable without new, PORTING.md R18)
export const DecryptoStream = callable(DecryptoStreamImpl);
