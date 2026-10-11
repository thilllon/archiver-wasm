/**
 * ZIP with encryption
 */
import { callable } from '../callable.js';
import Zip from '../plugins/zip.js';
import type { ArchiverOptions } from '../types.js';
import { ZipAesStream } from './aes/zip-aes-stream.js';
import { ZipCryptoStream } from './zip20/zip-crypto-stream.js';

/**
 * Options copied from Zip plugin in archiver, with inclusion of password and method of encryption
 * @constructor
 * @param {ZipOptions} [options]
 * @param {String | Buffer} [options.password] password for encrypted data
 * @param {String} [options.encryptionMethod] "aes256" for AES-256 or "zip20" for legacy Zip 2.0 encryption
 * @param {String} [options.comment] Sets the zip archive comment.
 * @param {Boolean} [options.forceLocalTime=false] Forces the archive to contain local file times instead of UTC.
 * @param {Boolean} [options.forceZip64=false] Forces the archive to contain ZIP64 headers.
 * @param {Boolean} [options.store=false] Sets the compression method to STORE.
 * @param {Object} [options.zlib] Passed to [zlib]{@link https://nodejs.org/api/zlib.html#zlib_class_options}
 */
class ZipEncryptedImpl extends Zip {
    // archiver-zip-encrypted/lib/zip-encrypted.js:23-42
    constructor(options: ArchiverOptions = {}) {
        if (!options.password) {
            throw new Error('options.password is required');
        }
        if (!Buffer.isBuffer(options.password)) {
            options.password = Buffer.from(options.password, 'utf-8');
        }

        // archiver-zip-encrypted/node_modules/archiver/lib/plugins/zip.js:26-31 (lodash defaults, in place, PORTING.md 7.9)
        if (options.comment === undefined) {
            options.comment = '';
        }
        if (options.forceUTC === undefined) {
            options.forceUTC = false;
        }
        if (options.namePrependSlash === undefined) {
            options.namePrependSlash = false;
        }
        if (options.store === undefined) {
            options.store = false;
        }

        super(options);
        this.options = options;

        switch (options.encryptionMethod) {
        case 'aes256': this.engine = new ZipAesStream(options); break;
        case 'zip20': this.engine = new ZipCryptoStream(options); break;
        default: throw new Error(`Unsupported encryption method: '${options.encryptionMethod}'. Please use either 'aes256' or 'zip20'.`);
        }
    }
}

// archiver-zip-encrypted/lib/zip-encrypted.js:31-33 (callable without new, PORTING.md R18); archiver-zip-encrypted/index.js:1
export const ZipEncrypted = callable(ZipEncryptedImpl);
