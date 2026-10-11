import * as zlib from 'node:zlib';
import type { ZlibOptions } from 'node:zlib';

/** Throws exactly what Node throws for an invalid option bag, by constructing and closing
 *  the zlib object upstream would have constructed. No data is ever written to it. */
// deps/compress-commons/lib/archivers/zip/zip-archive-output-stream.js:150, node-archiver/lib/plugins/tar.js:28 (the zlib constructor calls, PORTING.md 7.7)
export function validateZlibOptions(kind: 'deflateRaw' | 'gzip', options: unknown): void {
  if (kind === 'deflateRaw') {
    zlib.createDeflateRaw(options as ZlibOptions).close();
  } else {
    zlib.createGzip(options as ZlibOptions).close();
  }
}

/** options.level if it is a number and not NaN, else -1 (zlib default). */
// PORTING.md 7.7 (ZIP-136)
export function resolveLevel(options: unknown): number {
  const level = (options as { level?: unknown } | null | undefined)?.level;
  return typeof level === 'number' && !Number.isNaN(level) ? level : -1;
}

/** options.strategy if it is a number and not NaN, else 0. */
// PORTING.md 7.7
export function resolveStrategy(options: unknown): number {
  const strategy = (options as { strategy?: unknown } | null | undefined)?.strategy;
  return typeof strategy === 'number' && !Number.isNaN(strategy) ? strategy : 0;
}

/** gzip header OS byte of Node's zlib on this platform (R14). */
export const GZIP_OS: number = process.platform === 'darwin' ? 19 : process.platform === 'win32' ? 10 : 3;
