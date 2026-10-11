import type { Dirent, Stats } from 'node:fs';
import type { Readable, TransformOptions } from 'node:stream';
import type { ZlibOptions } from 'node:zlib';
import type { ArchiverError } from './error.js';
import type { Options as ReaddirGlobOptions } from './readdir-glob.js';

export interface DateFields {
  year: number; month: number; date: number; hours: number; minutes: number; seconds: number;
}

export interface EntryData {
  type?: string;                          // 'file' | 'directory' | 'symlink'
  name?: string | null;
  date?: Date | string | null;
  mode?: number | null;
  prefix?: string | null;
  sourcePath?: string | null;
  stats?: Stats | Dirent | false | null;
  sourceType?: 'buffer' | 'stream';
  linkname?: string;
  callback?: () => void;                  // per-entry completion hook (core.js:358-363)
  store?: boolean; comment?: string; namePrependSlash?: boolean;   // zip entries (deps/zip-stream/index.js:128-135)
  [key: string]: unknown;                 // arbitrary caller keys pass through untouched
}
export type EntryDataFunction = (data: EntryData) => EntryData | false;

export interface ProgressData {
  entries: { total: number; processed: number };
  fs: { totalBytes: number; processedBytes: number };
}

/** Options of `Archiver.prototype.glob`: those of readdir-glob, and the `cwd` core.js:694 reads. */
export type GlobOptions = ReaddirGlobOptions & { cwd?: string };

/** Listeners of the events an `Archiver` emits (core.js) and of the stream events it is used with. */
export interface ArchiverEvents {
  entry: (entry: EntryData) => void;
  progress: (progress: ProgressData) => void;
  warning: (err: ArchiverError) => void;
  error: (err: ArchiverError) => void;
  data: (chunk: Buffer) => void;
  end: () => void;
  close: () => void;
  finish: () => void;
  drain: () => void;
  pipe: (src: Readable) => void;
  unpipe: (src: Readable) => void;
}

export type ModuleCallback = (err?: Error | null, entry?: unknown) => void;

/** The plugin ("module") contract of core.js:164-247 (ARCHIVER-CORE-106). */
export interface ArchiverModule {
  append(source: Buffer | Readable, data: EntryData, callback: ModuleCallback): void;
  finalize?(): void;
  end?(): void;
  on(event: string, listener: (...args: unknown[]) => void): unknown;
  pipe(destination: NodeJS.WritableStream, options?: unknown): unknown;
  unpipe(destination?: NodeJS.WritableStream): unknown;
  supports?: { directory?: boolean; symlink?: boolean };   // archiver 7 (V12)
}
export type ModuleConstructor = new (options?: ArchiverOptions) => ArchiverModule;

export interface CoreOptions extends TransformOptions { statConcurrency?: number }
export interface ZipOptions {
  comment?: string; forceLocalTime?: boolean; forceZip64?: boolean; namePrependSlash?: boolean;
  store?: boolean; zlib?: ZlibOptions; level?: number;
}
export interface TarOptions { gzip?: boolean; gzipOptions?: ZlibOptions | null }
export interface EncryptedOptions extends ZipOptions {
  password?: string | Buffer;
  encryptionMethod?: 'aes256' | 'zip20';
  salt?: string | Buffer; // AES: fixed salt for every entry (zip-aes-stream.js:162); a string is converted with Buffer.from (7.9)
  zip20Header?: Buffer;   // ZipCrypto: fixed 12-byte random header for every entry (V10); a Buffer of exactly 12 bytes
}
/** Options of the three public cipher streams (they are passed whole to Transform, crypto-stream.js:17). */
export interface CryptoStreamOptions extends TransformOptions { key: string | Buffer; crc: Buffer; header?: Buffer }   // header: V10
export interface DecryptoStreamOptions extends TransformOptions { key: string | Buffer; crc?: Buffer }
export interface AesHmacEtmStreamOptions extends TransformOptions { key: string | Buffer; salt?: string | Buffer | null }
export interface ArchiverOptions extends CoreOptions, EncryptedOptions, TarOptions {
  [key: string]: unknown;
}

export interface Match { relative: string; absolute: string; stat?: Stats | Dirent }

export interface QueueTask { source: Buffer | Readable | null; filepath?: string; data: EntryData }
