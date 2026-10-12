// src/wasm-types.ts: the TypeScript view of section 5.3. Hand-written; nothing is imported from dist/wasm/.
export interface WasmZipEntryInfo {
  readonly name: string;
  readonly size: number;
  readonly csize: number;
  readonly crc: number;
  readonly method: number;
  readonly time: number;
  readonly minver: number;
  readonly platform: number;
  readonly exattr: number;
  readonly inattr: number;
  readonly gpb: number;
  readonly extra: Uint8Array;
  readonly comment: string;
  readonly offsetFile: number;
  readonly offsetData: number;
  readonly offsetContents: number;
  free(): void;
}
interface WasmZipStream {
  setComment(comment: string): void;
  setOffset(offset: number): void;
  entry(
    name: string,
    year: number, month: number, date: number, hours: number, minutes: number, seconds: number,
    namePrependSlash: boolean, store: boolean, comment: string,
    hasMode: boolean, mode: number, level: number,
    key: Uint8Array, random: Uint8Array,
    isBuffer: boolean, sourceLen: number, sourceCrc: number,
  ): number;
  completeStored(): void;
  writeData(chunk: Uint8Array): void;
  endData(): void;
  encryptData(chunk: Uint8Array): void;
  encryptEnd(): void;
  finish(): void;
  takeOutput(): Uint8Array;
  isZip64(): boolean;
  centralOffset(): number;
  centralLength(): number;
  lastEntry(): WasmZipEntryInfo | undefined;
  free(): void;
}
interface WasmPack {
  paxRecord(body: string): void;
  encode(
    name: string, typeflagIs5: boolean, mode: number,
    uidOct: string, gidOct: string, size: number, sizeOct: string, mtime: number, type: string,
    linkname: string | undefined, uname: string | undefined, gname: string | undefined,
    devmajorOct: string, devminorOct: string, forcePax: boolean,
  ): void;
  overflow(size: number): void;
  finalize(): void;
  takeOutput(): Uint8Array;
  free(): void;
}
interface WasmGzip { write(chunk: Uint8Array): Uint8Array; finish(): Uint8Array; free(): void }
export interface WasmCryptoCipher { encrypt(data: Uint8Array): Uint8Array; decrypt(data: Uint8Array): Uint8Array; free(): void }
export interface WasmCryptoStream { transform(data: Uint8Array): Uint8Array; free(): void }
export interface WasmDecryptoStream { transform(data: Uint8Array): Uint8Array; getTotalSize(): number; free(): void }
export interface WasmAesHmacEtmStream {
  transform(data: Uint8Array): Uint8Array; flush(): Uint8Array; getTotalSize(): number; free(): void;
}

export interface YkkWasm {
  WasmZipStream: new (forceZip64: boolean, encryption: number) => WasmZipStream;
  WasmPack: new () => WasmPack;
  WasmGzip: new (level: number, strategy: number, os: number) => WasmGzip;
  WasmCryptoCipher: new (key: Uint8Array) => WasmCryptoCipher;
  WasmCryptoStream: new (key: Uint8Array, crc: number, header: Uint8Array) => WasmCryptoStream;
  WasmDecryptoStream: new (key: Uint8Array) => WasmDecryptoStream;
  WasmAesHmacEtmStream: {
    new (aesKey: Uint8Array, hmacKey: Uint8Array, passwordVerifier: Uint8Array, salt: Uint8Array): WasmAesHmacEtmStream;
    deriveKey(salt: Uint8Array, key: Uint8Array): Uint8Array;
  };
  jsonAppend(seed: number, chunk: Uint8Array): number;
  crc32Update(seed: number, chunk: Uint8Array): number;
}
