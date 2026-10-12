#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
rm -rf dist/wasm
wasm-pack build crates/archiver-wasm --release --target nodejs --out-dir ../../dist/wasm --out-name archiver_wasm --no-pack
rm -f dist/wasm/.gitignore dist/wasm/package.json dist/wasm/README.md dist/wasm/archiver_wasm_bg.wasm.d.ts
mv dist/wasm/archiver_wasm.js dist/wasm/archiver_wasm.cjs
mv dist/wasm/archiver_wasm.d.ts dist/wasm/archiver_wasm.d.cts
node -e "const w = require('./dist/wasm/archiver_wasm.cjs'); if (typeof w.WasmZipStream !== 'function' || w.crc32Update(0, Buffer.from('test')) !== 3632233996) process.exit(1)"
