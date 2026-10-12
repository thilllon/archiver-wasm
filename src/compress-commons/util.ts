import { PassThrough } from "node:stream";
import { isStream } from "../is-stream.js";

// deps/compress-commons/lib/util/index.js:5
export function normalizeInputSource(source: unknown): unknown {
  if (source === null) {
    return Buffer.alloc(0);
  } else if (typeof source === "string") {
    return Buffer.from(source);
  } else if (isStream(source) && !(source as { _readableState?: unknown })._readableState) {
    var normalized = new PassThrough();
    (source as NodeJS.ReadableStream).pipe(normalized);
    return normalized;
  }
  return source;
}
