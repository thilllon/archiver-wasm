// cjs/index.d.cts (scaffold unit, verbatim)
import m = require('../dist/index.cjs');

type Vending = typeof m.default;
type Named = Omit<typeof m, 'default'>;
type Entry = Vending & Named & { default: Entry };

declare const archiver: Entry;
declare namespace archiver {
  // one alias per type that src/index.ts exports: the classes as instance types, then src/types.ts
  type Archiver = m.Archiver;
  type ZipArchive = m.ZipArchive;
  type TarArchive = m.TarArchive;
  type JsonArchive = m.JsonArchive;
  type ArchiverError = m.ArchiverError;
  type DateFields = m.DateFields;
  type EntryData = m.EntryData;
  type EntryDataFunction = m.EntryDataFunction;
  type ProgressData = m.ProgressData;
  type ModuleCallback = m.ModuleCallback;
  type ArchiverModule = m.ArchiverModule;
  type ModuleConstructor = m.ModuleConstructor;
  type CoreOptions = m.CoreOptions;
  type ZipOptions = m.ZipOptions;
  type TarOptions = m.TarOptions;
  type EncryptedOptions = m.EncryptedOptions;
  type CryptoStreamOptions = m.CryptoStreamOptions;
  type DecryptoStreamOptions = m.DecryptoStreamOptions;
  type AesHmacEtmStreamOptions = m.AesHmacEtmStreamOptions;
  type ArchiverOptions = m.ArchiverOptions;
  type Match = m.Match;
  type QueueTask = m.QueueTask;
}
export = archiver;
