/**
 * Implementation of "ZipCrypto"/"Zip 2.0 encryption" cipher used in Zip.
 * This is old and insecure algorithm, AES-based encryption has been introduced into ZIP format since then.
 * Yet, this is the only encryption method supported by Windows systems to open ZIP files as folders.
 */
import { MAX_CHUNK, toBuffer, wasm } from '../../wasm.js';
import type { WasmCryptoCipher } from '../../wasm-types.js';

export class CryptoCipher {
    key: Buffer;
    _wasm: WasmCryptoCipher;

    // archiver-zip-encrypted/lib/zip20/CryptoCipher.js:14-21
    constructor(key: string | Buffer) {
        this.key = key as Buffer;
        if (!Buffer.isBuffer(key)) {
            this.key = Buffer.from(this.key);
        }

        this._wasm = new wasm.WasmCryptoCipher(this.key);
    }

    // archiver-zip-encrypted/lib/zip20/CryptoCipher.js:57-63
    encrypt(data: Buffer): Buffer {
        // PORTING.md V14 (ENCRYPTED-107)
        if (!(data instanceof Uint8Array)) {
            throw new TypeError('data must be a Buffer');
        }
        const encryptedData: Buffer[] = [];
        for (let i = 0; i < data.length; i += MAX_CHUNK) {
            encryptedData.push(toBuffer(this._wasm.encrypt(data.subarray(i, i + MAX_CHUNK))));
        }
        return encryptedData.length === 1 ? encryptedData[0] : Buffer.concat(encryptedData);
    }

    // archiver-zip-encrypted/lib/zip20/CryptoCipher.js:65-71
    decrypt(data: Buffer): Buffer {
        // PORTING.md V14 (ENCRYPTED-107)
        if (!(data instanceof Uint8Array)) {
            throw new TypeError('data must be a Buffer');
        }
        const decryptedData: Buffer[] = [];
        for (let i = 0; i < data.length; i += MAX_CHUNK) {
            decryptedData.push(toBuffer(this._wasm.decrypt(data.subarray(i, i + MAX_CHUNK))));
        }
        return decryptedData.length === 1 ? decryptedData[0] : Buffer.concat(decryptedData);
    }
}
