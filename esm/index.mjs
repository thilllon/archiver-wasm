// esm/index.mjs (scaffold unit, verbatim)
import archiver from '../cjs/index.cjs';

export default archiver;
export const {
  Archiver, ZipArchive, TarArchive, JsonArchive, ArchiverError,
  ZipEncrypted, ZipAesStream, AesHmacEtmStream, ZipCryptoStream, CryptoStream, DecryptoStream, CryptoCipher,
  create, registerFormat, isRegisteredFormat,
} = archiver;
