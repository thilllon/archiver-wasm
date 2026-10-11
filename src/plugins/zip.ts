import type { Readable } from "node:stream";
import engine from "../zip-stream/index.js";
import type ZipStream from "../zip-stream/index.js";
import type { ArchiverOptions, EntryData, ModuleCallback } from "../types.js";

/**
 * ZIP Format Plugin
 *
 * @module plugins/zip
 * @license [MIT]{@link https://github.com/archiverjs/node-archiver/blob/master/LICENSE}
 * @copyright (c) 2012-2014 Chris Talkington, contributors.
 */
export default class Zip {
  options: ArchiverOptions;
  supports: { directory: boolean; symlink: boolean };
  engine: ZipStream;

  /**
   * @constructor
   * @param {ZipOptions} [options]
   * @param {String} [options.comment] Sets the zip archive comment.
   * @param {Boolean} [options.forceLocalTime=false] Forces the archive to contain local file times instead of UTC.
   * @param {Boolean} [options.forceZip64=false] Forces the archive to contain ZIP64 headers.
   * @param {Boolean} [options.namePrependSlash=false] Prepends a forward slash to archive file paths.
   * @param {Boolean} [options.store=false] Sets the compression method to STORE.
   * @param {Object} [options.zlib] Passed to [zlib]{@link https://nodejs.org/api/zlib.html#zlib_class_options}
   */
  // node-archiver/lib/plugins/zip.js:21-30
  constructor(options?: ArchiverOptions) {
    options = this.options = {
      comment: "",
      forceUTC: false,
      namePrependSlash: false,
      store: false,
      ...options,
    };
    // archiver-zip-encrypted/node_modules/archiver/lib/plugins/zip.js:33-36 (PORTING.md V12)
    this.supports = {
      directory: true,
      symlink: true,
    };
    this.engine = new engine(options);
  }
  /**
   * @param  {(Buffer|Stream)} source
   * @param  {ZipEntryData} data
   * @param  {String} data.name Sets the entry name including internal path.
   * @param  {(String|Date)} [data.date=NOW()] Sets the entry date.
   * @param  {Number} [data.mode=D:0755/F:0644] Sets the entry permissions.
   * @param  {String} [data.prefix] Sets a path prefix for the entry name. Useful
   * when working with methods like `directory` or `glob`.
   * @param  {fs.Stats} [data.stats] Sets the fs stat data for this entry allowing
   * for reduction of fs stat calls when stat data is already known.
   * @param  {Boolean} [data.store=ZipOptions.store] Sets the compression method to STORE.
   * @param  {Function} callback
   * @return void
   */
  // node-archiver/lib/plugins/zip.js:45-47
  append(source: Buffer | Readable, data: EntryData, callback: ModuleCallback): void {
    this.engine.entry(source, data, callback);
  }
  /**
   * @return void
   */
  // node-archiver/lib/plugins/zip.js:51-53
  finalize(): void {
    this.engine.finalize();
  }
  /**
   * @return this.engine
   */
  // node-archiver/lib/plugins/zip.js:57-59
  on() {
    return this.engine.on.apply(this.engine, arguments as unknown as Parameters<ZipStream['on']>);
  }
  /**
   * @return this.engine
   */
  // node-archiver/lib/plugins/zip.js:63-65
  pipe() {
    return this.engine.pipe.apply(this.engine, arguments as unknown as Parameters<ZipStream['pipe']>);
  }
  /**
   * @return this.engine
   */
  // node-archiver/lib/plugins/zip.js:69-71
  unpipe() {
    return this.engine.unpipe.apply(this.engine, arguments as unknown as Parameters<ZipStream['unpipe']>);
  }
}
