#!/usr/bin/env node
// PORTING.md 15.3: fails unless the declarations wasm-pack generated (dist/wasm/archiver_wasm.d.cts)
// satisfy the hand-written interface ArchiverWasm of src/wasm-types.ts. One-directional.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const generated = path.join(root, 'dist', 'wasm', 'archiver_wasm.cjs');
const declared = path.join(root, 'src', 'wasm-types.ts');

for (const file of [generated, path.join(root, 'dist', 'wasm', 'archiver_wasm.d.cts'), declared]) {
  if (!fs.existsSync(file)) {
    console.error('check-wasm-types: missing ' + path.relative(root, file) + ' (run scripts/build-wasm.sh first)');
    process.exit(1);
  }
}

const spec = (file) => JSON.stringify(file.split(path.sep).join('/'));
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'archiver-wasm-types-'));
const probe = path.join(dir, 'probe.ts');
fs.writeFileSync(
  probe,
  'import type { ArchiverWasm } from ' + spec(declared) + ';\n' +
    'declare const generated: typeof import(' + spec(generated) + ');\n' +
    'export const check: ArchiverWasm = generated;\n',
);

const tsc = createRequire(import.meta.url).resolve('typescript/bin/tsc');
const result = spawnSync(
  process.execPath,
  [
    tsc, '--noEmit', '--strict', '--pretty', 'false',
    '--target', 'ES2022', '--module', 'ESNext', '--moduleResolution', 'Bundler',
    '--allowImportingTsExtensions', '--types', 'node',
    probe,
  ],
  { cwd: root, encoding: 'utf8' },
);
fs.rmSync(dir, { recursive: true, force: true });

if (result.error) { throw result.error; }
if (result.status !== 0) {
  process.stderr.write(result.stdout);
  process.stderr.write(result.stderr);
  console.error('check-wasm-types: dist/wasm/archiver_wasm.d.cts does not satisfy ArchiverWasm (src/wasm-types.ts, PORTING.md 5.3 and 15.3)');
  process.exit(1);
}
console.log('check-wasm-types: dist/wasm/archiver_wasm.d.cts satisfies ArchiverWasm');
