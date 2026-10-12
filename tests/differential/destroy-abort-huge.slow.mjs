// PORTING.md 14.2 (R4, the cases at the 64 MiB limit of V16 (d)). They live in
// destroy-abort.test.mjs next to their scenarios and are registered only from here.
process.env.ARCHIVER_WASM_SLOW = '1';
await import('./destroy-abort.test.mjs');
