// cjs/index.d.cts (scaffold unit, verbatim)
import m = require('../dist/index.cjs');

declare function archiver(format: string, options?: m.ArchiverOptions): m.Archiver;
declare namespace archiver {
  // one line per export of src/index.ts: the values, then the types of src/types.ts
  export import Archiver = m.Archiver;
  export import ZipArchive = m.ZipArchive;
  export import TarArchive = m.TarArchive;
  export import JsonArchive = m.JsonArchive;
  export import ArchiverError = m.ArchiverError;
  export import ZipEncrypted = m.ZipEncrypted;
  export import ZipAesStream = m.ZipAesStream;
  export import AesHmacEtmStream = m.AesHmacEtmStream;
  export import ZipCryptoStream = m.ZipCryptoStream;
  export import CryptoStream = m.CryptoStream;
  export import DecryptoStream = m.DecryptoStream;
  export import CryptoCipher = m.CryptoCipher;
  export import create = m.create;
  export import registerFormat = m.registerFormat;
  export import isRegisteredFormat = m.isRegisteredFormat;
  export type DateFields = m.DateFields;
  export type EntryData = m.EntryData;
  export type EntryDataFunction = m.EntryDataFunction;
  export type ProgressData = m.ProgressData;
  export type GlobOptions = m.GlobOptions;
  export type ArchiverEvents = m.ArchiverEvents;
  export type ModuleCallback = m.ModuleCallback;
  export type ArchiverModule = m.ArchiverModule;
  export type ModuleConstructor = m.ModuleConstructor;
  export type CoreOptions = m.CoreOptions;
  export type ZipOptions = m.ZipOptions;
  export type TarOptions = m.TarOptions;
  export type EncryptedOptions = m.EncryptedOptions;
  export type CryptoStreamOptions = m.CryptoStreamOptions;
  export type DecryptoStreamOptions = m.DecryptoStreamOptions;
  export type AesHmacEtmStreamOptions = m.AesHmacEtmStreamOptions;
  export type ArchiverOptions = m.ArchiverOptions;
  export type Match = m.Match;
  export type QueueTask = m.QueueTask;
  const _default: typeof archiver;
  export { _default as default };
}
export = archiver;
