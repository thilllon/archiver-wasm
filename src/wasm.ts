// src/wasm.ts
import { createRequire } from 'node:module';
import type { YkkWasm } from './wasm-types.js';

export type { YkkWasm, WasmZipEntryInfo } from './wasm-types.js';

// __filename exists in the CommonJS bundle; tsup's import.meta.url shim there mangles '#', '?' and '%' in the path.
const nodeRequire = createRequire(typeof __filename === 'string' ? __filename : import.meta.url);

/** The instantiated wasm module. Loaded synchronously when this module is evaluated. */
export const wasm = nodeRequire('../pkg/ykk_wasm.cjs') as YkkWasm;

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
