// The CommonJS entry. `require('@thilllon/ykk')` is the archiver 7 vending function itself, with
// every export of src/index.ts as a property (archiver 7: `require('archiver')('zip')`).
import * as m from './index.js';

function archiver(format: string, options?: m.ArchiverOptions): m.Archiver {
  return m.default(format, options);
}

namespace archiver {
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
}

// The types of src/types.ts as members: `import archiver = require(...)`, then `archiver.EntryData`.
// Ambient, so nothing is emitted for it.
declare namespace archiver {
  export import DateFields = m.DateFields;
  export import EntryData = m.EntryData;
  export import EntryDataFunction = m.EntryDataFunction;
  export import ProgressData = m.ProgressData;
  export import GlobOptions = m.GlobOptions;
  export import ArchiverEvents = m.ArchiverEvents;
  export import ModuleCallback = m.ModuleCallback;
  export import ArchiverModule = m.ArchiverModule;
  export import ModuleConstructor = m.ModuleConstructor;
  export import CoreOptions = m.CoreOptions;
  export import ZipOptions = m.ZipOptions;
  export import TarOptions = m.TarOptions;
  export import EncryptedOptions = m.EncryptedOptions;
  export import CryptoStreamOptions = m.CryptoStreamOptions;
  export import DecryptoStreamOptions = m.DecryptoStreamOptions;
  export import AesHmacEtmStreamOptions = m.AesHmacEtmStreamOptions;
  export import ArchiverOptions = m.ArchiverOptions;
  export import Match = m.Match;
  export import QueueTask = m.QueueTask;
}

// Transpiled `import archiver from` reads `.default` of the required module.
(archiver as { default?: unknown }).default = archiver;

export default archiver;
