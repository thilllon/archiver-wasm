import { Transform } from "node:stream";
import type { Readable, TransformCallback } from "node:stream";
import { collectStream } from "../utils.js";
import { MAX_CHUNK, wasm } from "../wasm.js";
import type { ArchiverOptions, EntryData, ModuleCallback } from "../types.js";

/**
 * JSON Format Plugin
 *
 * @module plugins/json
 * @license [MIT]{@link https://github.com/archiverjs/node-archiver/blob/master/LICENSE}
 * @copyright (c) 2012-2014 Chris Talkington, contributors.
 */
export default class Json extends Transform {
  supports: { directory: boolean; symlink: boolean };
  files: EntryData[];

  /**
   * @constructor
   * @param {(JsonOptions|TransformOptions)} options
   */
  // node-archiver/lib/plugins/json.js:17-20
  constructor(options?: ArchiverOptions) {
    super({ ...options });
    // archiver-zip-encrypted/node_modules/archiver/lib/plugins/json.js:27-30 (PORTING.md V12)
    this.supports = {
      directory: true,
      symlink: true
    };
    this.files = [];
  }
  /**
   * [_transform description]
   *
   * @private
   * @param  {Buffer}   chunk
   * @param  {String}   encoding
   * @param  {Function} callback
   * @return void
   */
  // node-archiver/lib/plugins/json.js:30-32
  _transform(chunk: Buffer, encoding: BufferEncoding, callback: TransformCallback): void {
    callback(null, chunk);
  }
  /**
   * [_writeStringified description]
   *
   * @private
   * @return void
   */
  // node-archiver/lib/plugins/json.js:39-42
  _writeStringified(): void {
    var fileString = JSON.stringify(this.files);
    this.write(fileString);
  }
  /**
   * [append description]
   *
   * @param  {(Buffer|Stream)}   source
   * @param  {EntryData}   data
   * @param  {Function} callback
   * @return void
   */
  // node-archiver/lib/plugins/json.js:51-69
  append(source: Buffer | Readable, data: EntryData, callback: ModuleCallback): void {
    var self = this;
    data.crc32 = 0;
    function onend(err: Error | null, sourceBuffer: Buffer) {
      if (err) {
        callback(err);
        return;
      }
      data.size = sourceBuffer.length || 0;
      // node-archiver/lib/plugins/json.js:60 (crc32.unsigned(sourceBuffer) in slices, PORTING.md 7.10)
      var crc = 0;
      for (var i = 0; i < sourceBuffer.length; i += MAX_CHUNK) {
        crc = wasm.jsonAppend(crc, sourceBuffer.subarray(i, i + MAX_CHUNK));
      }
      data.crc32 = crc;
      self.files.push(data);
      callback(null, data);
    }
    if (data.sourceType === "buffer") {
      onend(null, source as Buffer);
    } else if (data.sourceType === "stream") {
      collectStream(source as Readable, onend as (err: Error | null, buffer?: Buffer) => void);
    }
  }
  /**
   * [finalize description]
   *
   * @return void
   */
  // node-archiver/lib/plugins/json.js:75-78
  finalize(): void {
    this._writeStringified();
    this.end();
  }
}
