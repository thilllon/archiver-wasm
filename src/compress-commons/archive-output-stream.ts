import { isStream } from "../is-stream.js";
import { Transform } from "node:stream";
import type { TransformCallback, TransformOptions } from "node:stream";
import ArchiveEntry from "./archive-entry.js";
import { normalizeInputSource } from "./util.js";
import type { ModuleCallback } from "../types.js";

/** `_archive` of both classes: the three flags of archive-output-stream.js:12-16, and the keys zip-archive-output-stream.js:50-59 adds. */
export interface ArchiveState {
  finish: boolean;
  finished: boolean;
  processing: boolean;
  centralLength?: number;
  centralOffset?: number;
  comment?: string | null;
  forceZip64?: boolean;
  forceLocalTime?: boolean;
}

type WriteCallback = (error: Error | null | undefined) => void;

export default class ArchiveOutputStream extends Transform {
  offset: number;
  _archive: ArchiveState;
  _entry?: ArchiveEntry | null;

  // deps/compress-commons/lib/archivers/archive-output-stream.js:8
  constructor(options?: TransformOptions) {
    super(options);

    this.offset = 0;
    this._archive = {
      finish: false,
      finished: false,
      processing: false,
    };
  }

  // deps/compress-commons/lib/archivers/archive-output-stream.js:19
  _appendBuffer(zae: ArchiveEntry, source: Buffer, callback: ModuleCallback) {
    // scaffold only
  }

  // deps/compress-commons/lib/archivers/archive-output-stream.js:23
  _appendStream(zae: ArchiveEntry, source: NodeJS.ReadableStream | NodeJS.WritableStream, callback: ModuleCallback) {
    // scaffold only
  }

  // deps/compress-commons/lib/archivers/archive-output-stream.js:27
  _emitErrorCallback = function (this: ArchiveOutputStream, err?: Error | null) {
    if (err) {
      this.emit("error", err);
    }
  };

  // deps/compress-commons/lib/archivers/archive-output-stream.js:33
  _finish(ae?: ArchiveEntry) {
    // scaffold only
  }

  // deps/compress-commons/lib/archivers/archive-output-stream.js:37
  _normalizeEntry(ae: ArchiveEntry) {
    // scaffold only
  }

  // deps/compress-commons/lib/archivers/archive-output-stream.js:41
  _transform(chunk: unknown, encoding: BufferEncoding, callback: TransformCallback) {
    callback(null, chunk);
  }

  // deps/compress-commons/lib/archivers/archive-output-stream.js:45
  entry(ae: unknown, source?: unknown, callback?: ModuleCallback): this | undefined {
    source = source || null;
    if (typeof callback !== "function") {
      callback = this._emitErrorCallback.bind(this);
    }
    if (!(ae instanceof ArchiveEntry)) {
      callback(new Error("not a valid instance of ArchiveEntry"));
      return;
    }
    if (this._archive.finish || this._archive.finished) {
      callback(new Error("unacceptable entry after finish"));
      return;
    }
    if (this._archive.processing) {
      callback(new Error("already processing an entry"));
      return;
    }
    this._archive.processing = true;
    this._normalizeEntry(ae);
    this._entry = ae;
    source = normalizeInputSource(source);
    if (Buffer.isBuffer(source)) {
      this._appendBuffer(ae, source, callback);
    } else if (isStream(source)) {
      this._appendStream(ae, source, callback);
    } else {
      this._archive.processing = false;
      callback(
        new Error("input source must be valid Stream or Buffer instance"),
      );
      return;
    }
    return this;
  }

  // deps/compress-commons/lib/archivers/archive-output-stream.js:80
  finish() {
    if (this._archive.processing) {
      this._archive.finish = true;
      return;
    }
    this._finish();
  }

  // deps/compress-commons/lib/archivers/archive-output-stream.js:88
  getBytesWritten() {
    return this.offset;
  }

  // deps/compress-commons/lib/archivers/archive-output-stream.js:92
  write(chunk: Uint8Array | string, cb?: BufferEncoding | WriteCallback): boolean {
    if (chunk) {
      this.offset += chunk.length;
    }
    return super.write(chunk, cb as WriteCallback);
  }
}
