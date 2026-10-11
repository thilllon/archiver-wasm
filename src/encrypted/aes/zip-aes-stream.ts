import * as crypto from 'node:crypto';
import { callable } from '../../callable.js';
import type { ArchiverOptions } from '../../types.js';
import ZipStream from '../../zip-stream/index.js';
import { toBytes } from './aes-hmac-etm-stream.js';

/**
 * Overrides ZipStream with AES-256 encryption
 */
class ZipAesStreamImpl extends ZipStream {
    key: Buffer;

    // archiver-zip-encrypted/lib/aes/zip-aes-stream.js:16-27
    constructor(options: ArchiverOptions = {zlib: {}}) {
        let key = options.password;
        if (!Buffer.isBuffer(key)) {
            key = Buffer.from(key as string);
        }

        super(options);
        this.key = key;
    }

    // PORTING.md 7.5
    _encryptionMethod(): number {
        return 2;
    }

    // archiver-zip-encrypted/lib/aes/zip-aes-stream.js:162 (key: this.key)
    _entryKey(): Buffer {
        return this.key;
    }

    // archiver-zip-encrypted/lib/aes/zip-aes-stream.js:162 (salt: this.options.salt, with aes-hmac-etm-stream.js:37-40, 55)
    _entryRandom(): Buffer {
        const salt = this.options.salt;
        return salt ? toBytes(salt, 'salt') : crypto.randomBytes(16);
    }
}

// archiver-zip-encrypted/lib/aes/zip-aes-stream.js:17-19 (callable without new, PORTING.md R18)
export const ZipAesStream = callable(ZipAesStreamImpl);
