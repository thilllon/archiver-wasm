import { Transform } from "node:stream";
import type { TransformCallback } from "node:stream";
import type { ZlibOptions } from "node:zlib";
import ArchiveOutputStream from "./archive-output-stream.js";
import ZipArchiveEntry from "./zip-archive-entry.js";
import { resolveLevel, validateZlibOptions } from "../zlib-options.js";
import { EMPTY, MAX_CHUNK, toBuffer, wasm, wasmString } from "../wasm.js";
import type { YkkWasm } from "../wasm.js";
import type { ArchiverOptions, ModuleCallback } from "../types.js";

// deps/compress-commons/lib/archivers/zip/constants.js:28
const ZLIB_BEST_SPEED = 1;

/** The options object after `_defaults` (zip-archive-output-stream.js:28-41). */
export type ZipArchiveOutputStreamOptions = ArchiverOptions & {
  zlib: ZlibOptions;
  forceZip64: boolean;
  forceLocalTime: boolean;
};

// deps/compress-commons/lib/archivers/zip/zip-archive-output-stream.js:28
function _defaults(o?: ArchiverOptions): ZipArchiveOutputStreamOptions {
  if (typeof o !== "object") {
    o = {};
  }
  if (typeof o.zlib !== "object") {
    o.zlib = {};
  }
  if (typeof o.zlib.level !== "number") {
    o.zlib.level = ZLIB_BEST_SPEED;
  }
  o.forceZip64 = !!o.forceZip64;
  o.forceLocalTime = !!o.forceLocalTime;
  return o as ZipArchiveOutputStreamOptions;
}

export default class ZipArchiveOutputStream extends ArchiveOutputStream {
  options: ZipArchiveOutputStreamOptions;
  _entries: ZipArchiveEntry[];
  _engine: InstanceType<YkkWasm["WasmZipStream"]>;

  // deps/compress-commons/lib/archivers/zip/zip-archive-output-stream.js:44
  constructor(options?: ArchiverOptions) {
    const _options = _defaults(options);
    super(_options);
    this.options = _options;
    this._entry = null;
    this._entries = [];
    this._archive = {
      centralLength: 0,
      centralOffset: 0,
      comment: "",
      finish: false,
      finished: false,
      processing: false,
      forceZip64: _options.forceZip64,
      forceLocalTime: _options.forceLocalTime,
    };
    this._engine = new wasm.WasmZipStream(_options.forceZip64, this._encryptionMethod());
  }

  // PORTING.md 7.5 (hook of the encrypted subclasses: ZipCryptoStream 1, ZipAesStream 2)
  _encryptionMethod(): number {
    return 0;
  }

  // PORTING.md 7.5 (hook of the encrypted subclasses: this.key)
  _entryKey(): Buffer {
    return EMPTY;
  }

  // PORTING.md 7.5 (hook of the encrypted subclasses: the salt, or the 12 header bytes)
  _entryRandom(): Buffer {
    return EMPTY;
  }

  // PORTING.md 5.4 (the only free() of the encoder)
  _destroy(err: Error | null, callback: (error?: Error | null) => void): void {
    this._engine.free();
    callback(err);
  }

  // deps/compress-commons/lib/archivers/zip/zip-archive-output-stream.js:325-351 (the this.write calls of the record writers: what the last wasm call produced, PORTING.md V4)
  _drain(): void {
    const out = this._engine.takeOutput();
    if (out.length > 0) {
      this.write(toBuffer(out));
    }
  }

  // deps/compress-commons/lib/archivers/zip/zip-archive-output-stream.js:75-84, 100-102 (Rust ZipStream::entry, PORTING.md 7.5)
  _engineEntry(ae: ZipArchiveEntry, source: Buffer | null): number {
    const d = ae.date;
    let crc = 0;
    if (source !== null) {
      // deps/compress-commons/lib/archivers/zip/zip-archive-output-stream.js:82
      for (let i = 0; i < source.length; i += MAX_CHUNK) {
        crc = wasm.crc32Update(crc, source.subarray(i, i + MAX_CHUNK));
      }
    }
    const key = this._entryKey();
    const random = this._entryRandom(); // PORTING.md V10
    this._engine.setOffset(this.offset);
    const status = this._engine.entry(
      wasmString(ae.name),
      d.year,
      d.month,
      d.date,
      d.hours,
      d.minutes,
      d.seconds,
      ae.namePrependSlash,
      ae.store,
      wasmString(ae.comment),
      ae.mode !== undefined,
      ae.mode !== undefined ? ae.mode : 0,
      resolveLevel(this.options.zlib),
      key,
      random,
      source !== null,
      source !== null ? source.length : 0,
      crc,
    );
    this._drain();
    return status;
  }

  // deps/compress-commons/lib/archivers/zip/zip-archive-output-stream.js:62
  _afterAppend(ae: ZipArchiveEntry): void {
    this._entries.push(ae);
    this._archive.processing = false;
    this._entry = null;
    if (this._archive.finish && !this._archive.finished) {
      this._finish();
    }
  }

  // deps/compress-commons/lib/archivers/zip/zip-archive-output-stream.js:74
  _appendBuffer(ae: ZipArchiveEntry, source: Buffer, callback: ModuleCallback): void {
    const status = this._engineEntry(ae, source);
    if (status === 0) {
      this.write(source);
      this._engine.completeStored();
      this._drain();
      ae._setInfo(this._engine.lastEntry());
      this._afterAppend(ae);
      callback(null, ae);
      return;
    }
    this._smartStream(ae, callback, status === 2).end(source);
  }

  // deps/compress-commons/lib/archivers/zip/zip-archive-output-stream.js:99
  _appendStream(ae: ZipArchiveEntry, source: NodeJS.ReadableStream | NodeJS.WritableStream, callback: ModuleCallback): void {
    const status = this._engineEntry(ae, null);
    var smart = this._smartStream(ae, callback, status === 2);
    source.once("error", function (err: Error) {
      smart.emit("error", err);
      smart.end();
    });
    (source as NodeJS.ReadableStream).pipe(smart);
  }

  // deps/compress-commons/lib/archivers/zip/zip-archive-output-stream.js:111
  _finish(): void {
    this._engine.setComment(wasmString(this.getComment()));
    this._engine.setOffset(this.offset);
    this._engine.finish();
    this._archive.centralOffset = this._engine.centralOffset();
    this._archive.centralLength = this._engine.centralLength();
    this._drain();
    this._archive.processing = false;
    this._archive.finish = true;
    this._archive.finished = true;
    this.end();
  }

  // deps/compress-commons/lib/archivers/zip/zip-archive-output-stream.js:129
  _normalizeEntry(ae: ZipArchiveEntry): void {
    // :130-136 and :140-144 are performed in Rust (_normalize_entry) at the start of entry()
    if (ae.date === undefined) {
      ae.setTime(new Date(), this._archive.forceLocalTime);
    }
  }

  // deps/compress-commons/lib/archivers/zip/zip-archive-output-stream.js:147
  _smartStream(ae: ZipArchiveEntry, callback: ModuleCallback, deflate: boolean): SmartStream {
    if (deflate) {
      // deps/compress-commons/lib/archivers/zip/zip-archive-output-stream.js:150
      validateZlibOptions("deflateRaw", this.options.zlib);
    }
    var process = new SmartStream(this, function (err: Error) {
      callback(err, ae);
    });
    var error: Error | null = null;
    function handleStuff(this: ZipArchiveOutputStream) {
      ae._setInfo(this._engine.lastEntry());
      this._afterAppend(ae);
      callback(error, ae);
    }
    process.once("end", handleStuff.bind(this));
    process.once("error", function (err: Error) {
      error = err;
    });
    process.pipe(this, { end: false });
    return process;
  }

  // deps/compress-commons/lib/archivers/zip/zip-archive-output-stream.js:355
  getComment(comment?: unknown): string | undefined {
    return this._archive.comment !== null ? this._archive.comment : "";
  }

  // deps/compress-commons/lib/archivers/zip/zip-archive-output-stream.js:359
  isZip64(): boolean {
    return this._engine.isZip64();
  }

  // deps/compress-commons/lib/archivers/zip/zip-archive-output-stream.js:368
  setComment(comment: string): void {
    this._archive.comment = comment;
  }
}

// deps/compress-commons/lib/archivers/zip/zip-archive-output-stream.js:149-151 (stands in for CRC32Stream / DeflateCRC32Stream and, in the encrypted engines, the encryption stream piped behind them, PORTING.md 7.5)
class SmartStream extends Transform {
  _zip: ZipArchiveOutputStream;
  _onEngineError: (err: Error) => void;

  // deps/crc32-stream/lib/crc32-stream.js:5-10, deps/crc32-stream/lib/deflate-crc32-stream.js:5-11 (the state lives in Rust)
  constructor(zip: ZipArchiveOutputStream, onEngineError: (err: Error) => void) {
    super();
    this._zip = zip;
    this._onEngineError = onEngineError;
  }

  // deps/crc32-stream/lib/crc32-stream.js:11-17, deps/crc32-stream/lib/deflate-crc32-stream.js:18-24 (one wasm call per slice, PORTING.md 5.4)
  _transform(chunk: Buffer, encoding: BufferEncoding, callback: TransformCallback): void {
    try {
      for (let i = 0; i < chunk.length; i += MAX_CHUNK) {
        this._zip._engine.writeData(chunk.subarray(i, i + MAX_CHUNK));
        const out = this._zip._engine.takeOutput();
        if (out.length > 0) {
          this.push(toBuffer(out));
        }
      }
    } catch (err) {
      this._fail(err);
      return;
    }
    callback();
  }

  // deps/compress-commons/lib/archivers/zip/zip-archive-output-stream.js:153-157 (the end of the processor; Rust writes the data descriptor of :64-66)
  _flush(callback: TransformCallback): void {
    try {
      // archiver-zip-encrypted/lib/zip20/zip-crypto-stream.js:65 (ZipCrypto writes its local header now, PORTING.md ZIP-135)
      if (this._zip._encryptionMethod() === 1) {
        this._zip._engine.setOffset(this._zip.offset);
      }
      this._zip._engine.endData();
      const out = this._zip._engine.takeOutput();
      if (out.length > 0) {
        this.push(toBuffer(out));
      }
    } catch (err) {
      this._fail(err);
      return;
    }
    callback();
  }

  // PORTING.md 13.4 (an engine failure is delivered through the entry callback, never swallowed)
  _fail(err: unknown): void {
    this.destroy();
    this._onEngineError(err as Error);
  }
}
