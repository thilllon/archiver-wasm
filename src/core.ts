import { createReadStream, lstat, readlinkSync, Stats } from "node:fs";
import type { Dirent } from "node:fs";
import { isStream } from "./is-stream.js";
import readdirGlob from "./readdir-glob.js";
import type { Options } from "./readdir-glob.js";
import { Readable } from "./lazystream.js";
import { queue } from "./queue.js";
import type { QueueObject } from "./queue.js";
import {
  dirname,
  relative as relativePath,
  resolve as resolvePath,
} from "node:path";
import { ArchiverError } from "./error.js";
import { Transform } from "node:stream";
import type { Readable as StreamReadable, TransformCallback } from "node:stream";
import {
  dateify,
  normalizeInputSource,
  sanitizePath,
  trailingSlashIt,
} from "./utils.js";
import type {
  ArchiverModule,
  ArchiverOptions,
  EntryData,
  EntryDataFunction,
  Match,
  QueueTask,
} from "./types.js";
const { ReaddirGlob } = readdirGlob;
const win32 = process.platform === "win32";

// node-archiver/lib/core.js:22
export default class Archiver extends Transform {
  _supportsDirectory = false;
  _supportsSymlink = false;
  declare options: ArchiverOptions;
  declare _format: string | false;
  declare _module: ArchiverModule | false;
  declare _pending: number;
  declare _pointer: number;
  declare _entriesCount: number;
  declare _entriesProcessedCount: number;
  declare _fsEntriesTotalBytes: number;
  declare _fsEntriesProcessedBytes: number;
  declare _queue: QueueObject<QueueTask>;
  declare _statQueue: QueueObject<QueueTask>;
  declare _state: { aborted: boolean; finalize: boolean; finalizing: boolean; finalized: boolean; modulePiped: boolean };
  declare _streams: unknown[];
  declare _task?: QueueTask | null;

  // node-archiver/lib/core.js:31 (archiver-zip-encrypted/node_modules/archiver/lib/core.js:30-33 for the format argument, PORTING.md V11)
  constructor(format?: string | ArchiverOptions, options?: ArchiverOptions) {
    if (typeof format !== "string") {
      options = format;
    }
    options = {
      highWaterMark: 1024 * 1024,
      statConcurrency: 4,
      ...options,
    };
    super(options);
    this.options = options;
    this._format = false;
    this._module = false;
    this._pending = 0;
    this._pointer = 0;
    this._entriesCount = 0;
    this._entriesProcessedCount = 0;
    this._fsEntriesTotalBytes = 0;
    this._fsEntriesProcessedBytes = 0;
    this._queue = queue(this._onQueueTask.bind(this), 1);
    this._queue.drain(this._onQueueDrain.bind(this));
    this._statQueue = queue(
      this._onStatQueueTask.bind(this),
      options.statConcurrency,
    );
    this._statQueue.drain(this._onQueueDrain.bind(this));
    this._state = {
      aborted: false,
      finalize: false,
      finalizing: false,
      finalized: false,
      modulePiped: false,
    };
    this._streams = [];
  }

  // node-archiver/lib/core.js:70
  _abort(): void {
    this._state.aborted = true;
    this._queue.kill();
    this._statQueue.kill();
    if (this._queue.idle()) {
      this._shutdown();
    }
  }

  // node-archiver/lib/core.js:86
  _append(filepath: string, data?: EntryData): void {
    data = data || {};
    let task: QueueTask | null = {
      source: null,
      filepath: filepath,
    } as QueueTask;
    if (!data.name) {
      data.name = filepath;
    }
    data.sourcePath = filepath;
    task.data = data;
    this._entriesCount++;
    if (data.stats && data.stats instanceof Stats) {
      task = this._updateQueueTaskWithStats(task, data.stats);
      if (task) {
        if (data.stats.size) {
          this._fsEntriesTotalBytes += data.stats.size;
        }
        this._queue.push(task);
      }
    } else {
      this._statQueue.push(task);
    }
  }

  // node-archiver/lib/core.js:116
  _finalize(): void {
    if (
      this._state.finalizing ||
      this._state.finalized ||
      this._state.aborted
    ) {
      return;
    }
    this._state.finalizing = true;
    this._moduleFinalize();
    this._state.finalizing = false;
    this._state.finalized = true;
  }

  // node-archiver/lib/core.js:135
  _maybeFinalize(): boolean {
    if (
      this._state.finalizing ||
      this._state.finalized ||
      this._state.aborted
    ) {
      return false;
    }
    if (
      this._state.finalize &&
      this._pending === 0 &&
      this._queue.idle() &&
      this._statQueue.idle()
    ) {
      this._finalize();
      return true;
    }
    return false;
  }

  // node-archiver/lib/core.js:164
  _moduleAppend(source: Buffer | StreamReadable, data: EntryData, callback: () => void): void {
    if (this._state.aborted) {
      callback();
      return;
    }
    (this._module as ArchiverModule).append(
      source,
      data,
      function (this: Archiver, err?: Error | null) {
        this._task = null;
        if (this._state.aborted) {
          this._shutdown();
          return;
        }
        if (err) {
          this.emit("error", err);
          setImmediate(callback);
          return;
        }
        this.emit("entry", data);
        this._entriesProcessedCount++;
        if (data.stats && (data.stats as Stats).size) {
          this._fsEntriesProcessedBytes += (data.stats as Stats).size;
        }
        this.emit("progress", {
          entries: {
            total: this._entriesCount,
            processed: this._entriesProcessedCount,
          },
          fs: {
            totalBytes: this._fsEntriesTotalBytes,
            processedBytes: this._fsEntriesProcessedBytes,
          },
        });
        setImmediate(callback);
      }.bind(this),
    );
  }

  // node-archiver/lib/core.js:218
  _moduleFinalize(): void {
    if (typeof (this._module as ArchiverModule).finalize === "function") {
      (this._module as Required<ArchiverModule>).finalize();
    } else if (typeof (this._module as ArchiverModule).end === "function") {
      (this._module as Required<ArchiverModule>).end();
    } else {
      this.emit("error", new ArchiverError("NOENDMETHOD"));
    }
  }

  // node-archiver/lib/core.js:233
  _modulePipe(): void {
    (this._module as ArchiverModule).on("error", this._onModuleError.bind(this) as (...args: unknown[]) => void);
    (this._module as ArchiverModule).pipe(this);
    this._state.modulePiped = true;
  }

  // node-archiver/lib/core.js:244
  _moduleUnpipe(): void {
    (this._module as ArchiverModule).unpipe(this);
    this._state.modulePiped = false;
  }

  // archiver-zip-encrypted/node_modules/archiver/lib/core.js:260-266
  _moduleSupports(key: "directory" | "symlink"): boolean {
    const supports = (this._module as ArchiverModule).supports;
    if (!supports || !supports[key]) {
      return false;
    }
    return supports[key] as boolean;
  }

  // node-archiver/lib/core.js:256
  _normalizeEntryData(data?: EntryData, stats?: Stats | Dirent): EntryData {
    data = {
      type: "file",
      name: null,
      date: null,
      mode: null,
      prefix: null,
      sourcePath: null,
      stats: false,
      ...data,
    };
    if (stats && data.stats === false) {
      data.stats = stats;
    }
    let isDir = data.type === "directory";
    if (data.name) {
      if (typeof data.prefix === "string" && "" !== data.prefix) {
        data.name = data.prefix + "/" + data.name;
        data.prefix = null;
      }
      data.name = sanitizePath(data.name);
      if (data.type !== "symlink" && data.name.slice(-1) === "/") {
        isDir = true;
        data.type = "directory";
      } else if (isDir) {
        data.name += "/";
      }
    }
    // 511 === 0777; 493 === 0755; 438 === 0666; 420 === 0644
    if (typeof data.mode === "number") {
      if (win32) {
        data.mode &= 511;
      } else {
        data.mode &= 4095;
      }
    } else if (data.stats && data.mode === null) {
      if (win32) {
        data.mode = (data.stats as Stats).mode & 511;
      } else {
        data.mode = (data.stats as Stats).mode & 4095;
      }
      // stat isn't reliable on windows; force 0755 for dir
      if (win32 && isDir) {
        data.mode = 493;
      }
    } else if (data.mode === null) {
      data.mode = isDir ? 493 : 420;
    }
    if (data.stats && data.date === null) {
      data.date = (data.stats as Stats).mtime;
    } else {
      data.date = dateify(data.date);
    }
    return data;
  }

  // node-archiver/lib/core.js:318
  _onModuleError(err: Error): void {
    this.emit("error", err);
  }

  // node-archiver/lib/core.js:332
  _onQueueDrain(): void {
    if (
      this._state.finalizing ||
      this._state.finalized ||
      this._state.aborted
    ) {
      return;
    }
    if (
      this._state.finalize &&
      this._pending === 0 &&
      this._queue.idle() &&
      this._statQueue.idle()
    ) {
      this._finalize();
    }
  }

  // node-archiver/lib/core.js:357
  _onQueueTask(task: QueueTask, callback: () => void): void {
    const fullCallback = () => {
      if (task.data.callback) {
        task.data.callback();
      }
      callback();
    };
    if (
      this._state.finalizing ||
      this._state.finalized ||
      this._state.aborted
    ) {
      fullCallback();
      return;
    }
    this._task = task;
    this._moduleAppend(task.source as Buffer | StreamReadable, task.data, fullCallback);
  }

  // node-archiver/lib/core.js:383
  _onStatQueueTask(task: QueueTask, callback: () => void): void {
    if (
      this._state.finalizing ||
      this._state.finalized ||
      this._state.aborted
    ) {
      callback();
      return;
    }
    lstat(
      task.filepath as string,
      function (this: Archiver, err: NodeJS.ErrnoException | null, stats: Stats) {
        if (this._state.aborted) {
          setImmediate(callback);
          return;
        }
        if (err) {
          this._entriesCount--;
          this.emit("warning", err);
          setImmediate(callback);
          return;
        }
        task = this._updateQueueTaskWithStats(task, stats) as QueueTask;
        if (task) {
          if (stats.size) {
            this._fsEntriesTotalBytes += stats.size;
          }
          this._queue.push(task);
        }
        setImmediate(callback);
      }.bind(this),
    );
  }

  // node-archiver/lib/core.js:426
  _shutdown(): void {
    this._moduleUnpipe();
    this.end();
  }

  // node-archiver/lib/core.js:439
  _transform(chunk: Buffer, encoding: BufferEncoding, callback: TransformCallback): void {
    if (chunk) {
      this._pointer += chunk.length;
    }
    callback(null, chunk);
  }

  // node-archiver/lib/core.js:453
  _updateQueueTaskWithStats(task: QueueTask, stats: Stats | Dirent): QueueTask | null {
    if (stats.isFile()) {
      task.data.type = "file";
      task.data.sourceType = "stream";
      task.source = new Readable(function () {
        return createReadStream(task.filepath as string);
      });
    } else if (stats.isDirectory() && this._supportsDirectory) {
      task.data.name = trailingSlashIt(task.data.name as string);
      task.data.type = "directory";
      task.data.sourcePath = trailingSlashIt(task.filepath as string);
      task.data.sourceType = "buffer";
      task.source = Buffer.concat([]);
    } else if (stats.isSymbolicLink() && this._supportsSymlink) {
      const linkPath = readlinkSync(task.filepath as string);
      const dirName = dirname(task.filepath as string);
      task.data.type = "symlink";
      task.data.linkname = relativePath(
        dirName,
        resolvePath(dirName, linkPath),
      );
      task.data.sourceType = "buffer";
      task.source = Buffer.concat([]);
    } else {
      if (stats.isDirectory()) {
        this.emit(
          "warning",
          new ArchiverError("DIRECTORYNOTSUPPORTED", task.data),
        );
      } else if (stats.isSymbolicLink()) {
        this.emit(
          "warning",
          new ArchiverError("SYMLINKNOTSUPPORTED", task.data),
        );
      } else {
        this.emit("warning", new ArchiverError("ENTRYNOTSUPPORTED", task.data));
      }
      return null;
    }
    task.data = this._normalizeEntryData(task.data, stats);
    return task;
  }

  // node-archiver/lib/core.js:507
  abort(): this {
    if (this._state.aborted || this._state.finalized) {
      return this;
    }
    this._abort();
    return this;
  }

  // node-archiver/lib/core.js:525
  append(source: Buffer | StreamReadable | string | null, data?: EntryData): this {
    if (this._state.finalize || this._state.aborted) {
      this.emit("error", new ArchiverError("QUEUECLOSED"));
      return this;
    }
    data = this._normalizeEntryData(data);
    if (typeof data.name !== "string" || data.name.length === 0) {
      this.emit("error", new ArchiverError("ENTRYNAMEREQUIRED"));
      return this;
    }
    if (data.type === "directory" && !this._supportsDirectory) {
      this.emit(
        "error",
        new ArchiverError("DIRECTORYNOTSUPPORTED", { name: data.name }),
      );
      return this;
    }
    source = normalizeInputSource(source) as Buffer | StreamReadable | string | null;
    if (Buffer.isBuffer(source)) {
      data.sourceType = "buffer";
    } else if (isStream(source)) {
      data.sourceType = "stream";
    } else {
      this.emit(
        "error",
        new ArchiverError("INPUTSTEAMBUFFERREQUIRED", { name: data.name }),
      );
      return this;
    }
    this._entriesCount++;
    this._queue.push({
      data: data,
      source: source,
    });
    return this;
  }

  // node-archiver/lib/core.js:570
  directory(dirpath: string, destpath?: string | false | null, data?: EntryData | EntryDataFunction | null): this {
    if (this._state.finalize || this._state.aborted) {
      this.emit("error", new ArchiverError("QUEUECLOSED"));
      return this;
    }
    if (typeof dirpath !== "string" || dirpath.length === 0) {
      this.emit("error", new ArchiverError("DIRECTORYDIRPATHREQUIRED"));
      return this;
    }
    this._pending++;
    if (destpath === false) {
      destpath = "";
    } else if (typeof destpath !== "string") {
      destpath = dirpath;
    }
    var dataFunction: EntryDataFunction | false = false;
    if (typeof data === "function") {
      dataFunction = data;
      data = {};
    } else if (typeof data !== "object") {
      data = {};
    }
    var globOptions = {
      stat: true,
      dot: true,
    };
    function onGlobEnd(this: Archiver) {
      this._pending--;
      this._maybeFinalize();
    }
    function onGlobError(this: Archiver, err: Error) {
      this.emit("error", err);
    }
    function onGlobMatch(this: Archiver, match: Match) {
      globber.pause();
      let ignoreMatch = false;
      let entryData: EntryData | false = Object.assign({}, data as EntryData);
      entryData.name = match.relative;
      entryData.prefix = destpath as string;
      entryData.stats = match.stat;
      entryData.callback = globber.resume.bind(globber);
      try {
        if (dataFunction) {
          entryData = dataFunction(entryData);
          if (entryData === false) {
            ignoreMatch = true;
          } else if (typeof entryData !== "object") {
            throw new ArchiverError("DIRECTORYFUNCTIONINVALIDDATA", {
              dirpath: dirpath,
            });
          }
        }
      } catch (e) {
        this.emit("error", e);
        return;
      }
      if (ignoreMatch) {
        globber.resume();
        return;
      }
      this._append(match.absolute, entryData as EntryData);
    }
    const globber = readdirGlob(dirpath, globOptions);
    globber.on("error", onGlobError.bind(this));
    globber.on("match", onGlobMatch.bind(this));
    globber.on("end", onGlobEnd.bind(this));
    return this;
  }

  // node-archiver/lib/core.js:651
  file(filepath: string, data?: EntryData): this {
    if (this._state.finalize || this._state.aborted) {
      this.emit("error", new ArchiverError("QUEUECLOSED"));
      return this;
    }
    if (typeof filepath !== "string" || filepath.length === 0) {
      this.emit("error", new ArchiverError("FILEFILEPATHREQUIRED"));
      return this;
    }
    this._append(filepath, data);
    return this;
  }

  // node-archiver/lib/core.js:672
  glob(pattern: string, options?: Options, data?: EntryData): this {
    this._pending++;
    options = {
      stat: true,
      pattern: pattern,
      ...options,
    };
    function onGlobEnd(this: Archiver) {
      this._pending--;
      this._maybeFinalize();
    }
    function onGlobError(this: Archiver, err: Error) {
      this.emit("error", err);
    }
    function onGlobMatch(this: Archiver, match: Match) {
      globber.pause();
      const entryData: EntryData = Object.assign({}, data);
      entryData.callback = globber.resume.bind(globber);
      entryData.stats = match.stat;
      entryData.name = match.relative;
      this._append(match.absolute, entryData);
    }
    const globber = new ReaddirGlob((options as { cwd?: string }).cwd || ".", options);
    globber.on("error", onGlobError.bind(this));
    globber.on("match", onGlobMatch.bind(this));
    globber.on("end", onGlobEnd.bind(this));
    return this;
  }

  // node-archiver/lib/core.js:710
  finalize(): Promise<void> {
    if (this._state.aborted) {
      var abortedError = new ArchiverError("ABORTED");
      this.emit("error", abortedError);
      return Promise.reject(abortedError);
    }
    if (this._state.finalize) {
      var finalizingError = new ArchiverError("FINALIZING");
      this.emit("error", finalizingError);
      return Promise.reject(finalizingError);
    }
    this._state.finalize = true;
    if (this._pending === 0 && this._queue.idle() && this._statQueue.idle()) {
      this._finalize();
    }
    var self = this;
    return new Promise<void>(function (resolve, reject) {
      var errored: boolean | undefined;
      (self._module as ArchiverModule).on("end", function () {
        if (!errored) {
          resolve();
        }
      });
      (self._module as ArchiverModule).on("error", function (err) {
        errored = true;
        reject(err);
      });
    });
  }

  // node-archiver/lib/core.js:749
  symlink(filepath: string, target: string, mode?: number): this {
    if (this._state.finalize || this._state.aborted) {
      this.emit("error", new ArchiverError("QUEUECLOSED"));
      return this;
    }
    if (typeof filepath !== "string" || filepath.length === 0) {
      this.emit("error", new ArchiverError("SYMLINKFILEPATHREQUIRED"));
      return this;
    }
    if (typeof target !== "string" || target.length === 0) {
      this.emit(
        "error",
        new ArchiverError("SYMLINKTARGETREQUIRED", { filepath: filepath }),
      );
      return this;
    }
    if (!this._supportsSymlink) {
      this.emit(
        "error",
        new ArchiverError("SYMLINKNOTSUPPORTED", { filepath: filepath }),
      );
      return this;
    }
    var data: EntryData = {};
    data.type = "symlink";
    data.name = filepath.replace(/\\/g, "/");
    data.linkname = target.replace(/\\/g, "/");
    data.sourceType = "buffer";
    if (typeof mode === "number") {
      data.mode = mode;
    }
    this._entriesCount++;
    this._queue.push({
      data: data,
      source: Buffer.concat([]),
    });
    return this;
  }

  // node-archiver/lib/core.js:792
  pointer(): number {
    return this._pointer;
  }

  // archiver-zip-encrypted/node_modules/archiver/lib/core.js:813-822
  setFormat(format: string): this {
    if (this._format) {
      this.emit("error", new ArchiverError("FORMATSET"));
      return this;
    }
    this._format = format;
    return this;
  }

  // archiver-zip-encrypted/node_modules/archiver/lib/core.js:830-845
  setModule(module: ArchiverModule): this {
    if (this._state.aborted) {
      this.emit("error", new ArchiverError("ABORTED"));
      return this;
    }
    // PORTING.md P23
    if ((this._state as { module?: unknown }).module) {
      this.emit("error", new ArchiverError("MODULESET"));
      return this;
    }
    this._module = module;
    this._modulePipe();
    this._supportsDirectory = this._moduleSupports("directory");
    this._supportsSymlink = this._moduleSupports("symlink");
    return this;
  }
}
