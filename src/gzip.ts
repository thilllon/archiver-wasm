import { Transform } from 'node:stream';
import type { TransformCallback } from 'node:stream';
import { wasm, MAX_CHUNK, toBuffer } from './wasm.js';
import type { YkkWasm } from './wasm.js';
import { validateZlibOptions, resolveLevel, resolveStrategy, GZIP_OS } from './zlib-options.js';

// node-archiver/lib/plugins/tar.js:28 (the stream zlib.createGzip returns, PORTING.md 7.7)
export class Gzip extends Transform {
  _wasm: InstanceType<YkkWasm['WasmGzip']>;

  // node-archiver/lib/plugins/tar.js:28 (the zlib.Gzip constructor, PORTING.md 7.7)
  constructor(level: number, strategy: number) {
    super();
    this._wasm = new wasm.WasmGzip(level, strategy, GZIP_OS);
  }

  // node-archiver/lib/plugins/tar.js:28 (the write side of the zlib stream, PORTING.md 5.4, TS-35)
  _transform(chunk: Buffer, encoding: BufferEncoding, callback: TransformCallback): void {
    for (let i = 0; i < chunk.length; i += MAX_CHUNK) {
      const out = this._wasm.write(chunk.subarray(i, i + MAX_CHUNK));
      if (out.length > 0) this.push(toBuffer(out));
    }
    callback();
  }

  // node-archiver/lib/plugins/tar.js:28 (the end of the gzip member, PORTING.md TS-35)
  _flush(callback: TransformCallback): void {
    const out = this._wasm.finish();
    if (out.length > 0) this.push(toBuffer(out));
    callback();
  }

  // node-archiver/lib/plugins/tar.js:28 (the handle zlib closes on destroy, PORTING.md 5.4)
  _destroy(err: Error | null, callback: (error?: Error | null) => void): void {
    this._wasm.free();
    callback(err);
  }
}

/** Replacement for zlib.createGzip(options) (lib/plugins/tar.js:28): validates, then builds a Gzip. */
// node-archiver/lib/plugins/tar.js:28 (zlib.createGzip, PORTING.md 7.7)
export function createGzip(options?: unknown): Gzip {
  validateZlibOptions('gzip', options);
  return new Gzip(resolveLevel(options), resolveStrategy(options));
}
