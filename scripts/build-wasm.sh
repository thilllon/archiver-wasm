#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
rm -rf dist/wasm
wasm-pack build crates/ykk-wasm --release --target nodejs --out-dir ../../dist/wasm --out-name ykk_wasm --no-pack
rm -f dist/wasm/.gitignore dist/wasm/package.json dist/wasm/README.md dist/wasm/ykk_wasm_bg.wasm.d.ts
mv dist/wasm/ykk_wasm.js dist/wasm/ykk_wasm.cjs
mv dist/wasm/ykk_wasm.d.ts dist/wasm/ykk_wasm.d.cts
node -e "const w = require('./dist/wasm/ykk_wasm.cjs'); if (typeof w.WasmZipStream !== 'function' || w.crc32Update(0, Buffer.from('test')) !== 3632233996) process.exit(1)"
