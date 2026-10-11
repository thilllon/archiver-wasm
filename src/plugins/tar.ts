import { createGzip } from "../gzip.js";
import type { Gzip } from "../gzip.js";
import * as engine from "../tar-stream/index.js";
import type { Pack } from "../tar-stream/index.js";
import { collectStream } from "../utils.js";
import type { Stats } from "node:fs";
import type { Readable } from "node:stream";
import type { ReadableOptions } from "streamx";
import type { ArchiverOptions, EntryData, ModuleCallback } from "../types.js";

/**
 * TAR Format Plugin
 *
 * @module plugins/tar
 * @license [MIT]{@link https://github.com/archiverjs/node-archiver/blob/master/LICENSE}
 * @copyright (c) 2012-2014 Chris Talkington, contributors.
 */
export default class Tar {
  options: ArchiverOptions;
  supports: { directory: boolean; symlink: boolean };
  engine: Pack;
  compressor: Gzip | false;

  /**
   * @constructor
   * @param {TarOptions} options
   */
  // node-archiver/lib/plugins/tar.js:17
  constructor(options?: ArchiverOptions) {
    options = this.options = {
      gzip: false,
      ...options,
    };
    if (typeof options.gzipOptions !== "object") {
      options.gzipOptions = {};
    }
    // archiver-zip-encrypted/node_modules/archiver/lib/plugins/tar.js:30-33 (PORTING.md V12)
    this.supports = {
      directory: true,
      symlink: true,
    };
    this.engine = engine.pack(options as unknown as ReadableOptions);
    this.compressor = false;
    if (options.gzip) {
      this.compressor = createGzip(options.gzipOptions);
      this.compressor.on("error", this._onCompressorError.bind(this));
    }
  }
  /**
   * [_onCompressorError description]
   *
   * @private
   * @param  {Error} err
   * @return void
   */
  // node-archiver/lib/plugins/tar.js:39
  _onCompressorError(err: Error) {
    this.engine.emit("error", err);
  }
  /**
   * [append description]
   *
   * @param  {(Buffer|Stream)} source
   * @param  {TarEntryData} data
   * @param  {Function} callback
   * @return void
   */
  // node-archiver/lib/plugins/tar.js:50
  append(source: Buffer | Readable, data: EntryData, callback: ModuleCallback) {
    var self = this;
    data.mtime = data.date;
    function append(err: Error | null, sourceBuffer?: Buffer) {
      if (err) {
        callback(err);
        return;
      }
      self.engine.entry(data, sourceBuffer, function (err?: Error | null) {
        callback(err, data);
      });
    }
    if (data.sourceType === "buffer") {
      append(null, source as Buffer);
    } else if (data.sourceType === "stream" && data.stats) {
      data.size = (data.stats as Stats).size;
      var entry = self.engine.entry(data, function (err?: Error | null) {
        callback(err, data);
      });
      (source as Readable).pipe(entry as unknown as NodeJS.WritableStream);
    } else if (data.sourceType === "stream") {
      collectStream(source as Readable, append);
    }
  }
  /**
   * [finalize description]
   *
   * @return void
   */
  // node-archiver/lib/plugins/tar.js:79
  finalize() {
    this.engine.finalize();
  }
  /**
   * [on description]
   *
   * @return this.engine
   */
  // node-archiver/lib/plugins/tar.js:87
  on(event: string | symbol, listener: (...args: never[]) => void): Pack;
  on() {
    return this.engine.on.apply(this.engine, arguments as unknown as Parameters<Pack["on"]>);
  }
  /**
   * [pipe description]
   *
   * @param  {String} destination
   * @param  {Object} options
   * @return this.engine
   */
  // node-archiver/lib/plugins/tar.js:97
  pipe(destination: NodeJS.WritableStream, options?: { end?: boolean }) {
    if (this.compressor) {
      return (this.engine.pipe
        .apply(this.engine, [this.compressor]) as Gzip)
        .pipe(destination, options);
    } else {
      return this.engine.pipe.apply(this.engine, arguments as unknown as Parameters<Pack["pipe"]>);
    }
  }
  /**
   * [unpipe description]
   *
   * @return this.engine
   */
  // node-archiver/lib/plugins/tar.js:111
  unpipe(destination?: NodeJS.WritableStream): unknown;
  unpipe() {
    if (this.compressor) {
      return this.compressor.unpipe.apply(this.compressor, arguments as unknown as Parameters<Gzip["unpipe"]>);
    } else {
      return (this.engine as unknown as { unpipe: (...a: unknown[]) => unknown }).unpipe.apply(this.engine, arguments as unknown as unknown[]);
    }
  }
}
