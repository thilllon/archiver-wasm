import normalizePath from "./normalize-path.js";
import { PassThrough } from "node:stream";
import { isStream } from "./is-stream.js";

// node-archiver/lib/utils.js:5
export function collectStream(source: NodeJS.ReadableStream, callback: (err: Error | null, buffer?: Buffer) => void): void {
  var collection: Buffer[] = [];
  var size = 0;

  source.on("error", callback);

  source.on("data", function (chunk: Buffer) {
    collection.push(chunk);
    size += chunk.length;
  });

  source.on("end", function () {
    var buf = Buffer.alloc(size);
    var offset = 0;

    collection.forEach(function (data) {
      data.copy(buf, offset);
      offset += data.length;
    });

    callback(null, buf);
  });
}

// node-archiver/lib/utils.js:29
export function dateify(dateish?: unknown): Date {
  dateish = dateish || new Date();

  if (dateish instanceof Date) {
    dateish = dateish;
  } else if (typeof dateish === "string") {
    dateish = new Date(dateish);
  } else {
    dateish = new Date();
  }

  return dateish as Date;
}

// node-archiver/lib/utils.js:43
export function normalizeInputSource(source: unknown): unknown {
  if (source === null) {
    return Buffer.alloc(0);
  } else if (typeof source === "string") {
    return Buffer.from(source);
  } else if (isStream(source)) {
    // Always pipe through a PassThrough stream to guarantee pausing the stream if it's already flowing,
    // since it will only be processed in a (distant) future iteration of the event loop, and will lose
    // data if already flowing now.
    return (source as NodeJS.ReadableStream).pipe(new PassThrough());
  }

  return source;
}

// node-archiver/lib/utils.js:58
export function sanitizePath(filepath: string): string {
  return normalizePath(filepath, false)
    .replace(/^\w+:/, "")
    .replace(/^(\.\.\/|\/)+/, "");
}

// node-archiver/lib/utils.js:64
export function trailingSlashIt(str: string): string {
  return str.slice(-1) !== "/" ? str + "/" : str;
}
