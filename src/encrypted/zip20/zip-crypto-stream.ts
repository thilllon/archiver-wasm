import * as crypto from 'node:crypto';
import { callable } from '../../callable.js';
import type { ArchiverOptions } from '../../types.js';
import ZipStream from '../../zip-stream/index.js';

// PORTING.md 7.9 (V10)
function checkHeader(h: unknown): Buffer | undefined {
    if (!h) {
        return undefined;
    }
    if (Buffer.isBuffer(h) && h.length === 12) {
        return h;
    }
    throw new TypeError('zip20Header must be a Buffer of 12 bytes');
}

/**
 * Overrides ZipStream with ZipCrypto/Zip2.0 encryption
 */
class ZipCryptoStreamImpl extends ZipStream {
    key: Buffer;

    // archiver-zip-encrypted/lib/zip20/zip-crypto-stream.js:13-24
    constructor(options: ArchiverOptions = {zlib: {}}) {
        let key = options.password;
        if (!Buffer.isBuffer(key)) {
            key = Buffer.from(options.password as string);
        }
        checkHeader(options.zip20Header);   // PORTING.md V10

        super(options);
        this.key = key;
    }

    // PORTING.md 7.5
    _encryptionMethod(): number {
        return 1;
    }

    // archiver-zip-encrypted/lib/zip20/zip-crypto-stream.js:68 (key: this.key)
    _entryKey(): Buffer {
        return this.key;
    }

    // archiver-zip-encrypted/lib/zip20/crypto-stream.js:33 (crypto.randomBytes(HEADER_LENGTH), PORTING.md V10)
    _entryRandom(): Buffer {
        const h = checkHeader(this.options.zip20Header);
        return h ? h : crypto.randomBytes(12);
    }
}

// archiver-zip-encrypted/lib/zip20/zip-crypto-stream.js:14-16 (callable without new, PORTING.md R18)
export const ZipCryptoStream = callable(ZipCryptoStreamImpl);
