// src/wasm.ts
import { createRequire } from 'node:module';
import type { ArchiverWasm } from './wasm-types.js';

export type { ArchiverWasm, WasmZipEntryInfo } from './wasm-types.js';

// __filename exists in the CommonJS bundle; import.meta.url is the ES module one.
const nodeRequire = createRequire(typeof __filename === 'string' ? __filename : import.meta.url);

/**
 * The instantiated wasm module. Loaded synchronously when this module is evaluated.
 * The path is relative to the bundle (dist/index.mjs, dist/index.cjs): scripts/build-wasm.sh
 * writes the glue to dist/wasm. Both bundles load the same file, so there is one wasm instance.
 */
export const wasm = nodeRequire('./wasm/archiver_wasm.cjs') as ArchiverWasm;

export const EMPTY: Buffer = Buffer.alloc(0);

/** Largest payload slice one wasm call may carry (5.4, V16). */
export const MAX_CHUNK = 1024 * 1024;

/** Wraps wasm output (a JS-owned Uint8Array) as a Buffer without copying. */
export function toBuffer(u8: Uint8Array): Buffer {
  return Buffer.from(u8.buffer, u8.byteOffset, u8.byteLength);
}

/** Guards an argument of a `&str` or `Option<String>` parameter: the glue traps on most non-strings (5.6). */
export function wasmString(value: unknown): string {
  if (typeof value !== 'string') { throw new TypeError('expected a string'); }
  return value;
}
