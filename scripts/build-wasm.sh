#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
rm -rf pkg
wasm-pack build crates/ykk-wasm --release --target nodejs --out-dir ../../pkg --out-name ykk_wasm --no-pack
rm -f pkg/.gitignore pkg/package.json pkg/README.md pkg/ykk_wasm_bg.wasm.d.ts
mv pkg/ykk_wasm.js pkg/ykk_wasm.cjs
mv pkg/ykk_wasm.d.ts pkg/ykk_wasm.d.cts
node -e "const w = require('./pkg/ykk_wasm.cjs'); if (typeof w.WasmZipStream !== 'function' || w.crc32Update(0, Buffer.from('test')) !== 3632233996) process.exit(1)"
