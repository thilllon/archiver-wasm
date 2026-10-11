import Archiver from "./core.js";
import Zip from "./plugins/zip.js";
import Tar from "./plugins/tar.js";
import Json from "./plugins/json.js";
import type { ArchiverOptions } from "./types.js";

export { Archiver };

// node-archiver/index.js:8-17
export class ZipArchive extends Archiver {
  constructor(options?: ArchiverOptions) {
    super(options);
    this._format = "zip";
    this._module = new Zip(options);
    this._supportsDirectory = true;
    this._supportsSymlink = true;
    this._modulePipe();
  }
}

// node-archiver/index.js:19-28
export class TarArchive extends Archiver {
  constructor(options?: ArchiverOptions) {
    super(options);
    this._format = "tar";
    this._module = new Tar(options);
    this._supportsDirectory = true;
    this._supportsSymlink = true;
    this._modulePipe();
  }
}

// node-archiver/index.js:30-39
export class JsonArchive extends Archiver {
  constructor(options?: ArchiverOptions) {
    super(options);
    this._format = "json";
    this._module = new Json(options);
    this._supportsDirectory = true;
    this._supportsSymlink = true;
    this._modulePipe();
  }
}

// PORTING.md 7.2
export { ArchiverError } from "./error.js";
export { ZipEncrypted } from "./encrypted/zip-encrypted.js";
export { ZipAesStream } from "./encrypted/aes/zip-aes-stream.js";
export { AesHmacEtmStream } from "./encrypted/aes/aes-hmac-etm-stream.js";
export { ZipCryptoStream } from "./encrypted/zip20/zip-crypto-stream.js";
export { CryptoStream } from "./encrypted/zip20/crypto-stream.js";
export { DecryptoStream } from "./encrypted/zip20/decrypto-stream.js";
export { CryptoCipher } from "./encrypted/zip20/crypto-cipher.js";
export { create, registerFormat, isRegisteredFormat } from "./vending.js";
export type * from "./types.js";
export { default } from "./vending.js";
