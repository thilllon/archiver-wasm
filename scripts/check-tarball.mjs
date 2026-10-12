#!/usr/bin/env node
// PORTING.md 15.5: packs the package, checks the file list, installs the tarball into an
// empty project and runs the smoke checks of section 16 item 4 under the running Node.
// With `--spec <package spec>` nothing is packed: that spec is installed instead
// (.github/workflows/release.yml checks the published version this way).
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));

const REQUIRED = [
  'dist/index.mjs', 'dist/index.d.mts', 'dist/index.cjs', 'dist/index.d.cts',
  'dist/wasm/ykk_wasm.cjs', 'dist/wasm/ykk_wasm_bg.wasm', 'dist/wasm/ykk_wasm.d.cts',
  'THIRD_PARTY_NOTICES.md',
];
const FORBIDDEN = ['src/', 'crates/', 'tests/', '.upstream/', 'scripts/'];
const TIMEOUT = 120000; // a smoke check that has not exited by itself after this many ms fails

const specIndex = process.argv.indexOf('--spec');
const spec = specIndex < 0 ? null : process.argv[specIndex + 1];
if (specIndex >= 0 && !spec) {
  console.error('check-tarball: --spec needs a package spec');
  process.exit(2);
}

function run(label, command, args, options) {
  const result = spawnSync(command, args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, ...options });
  if (result.error) {
    const timedOut = result.error.code === 'ETIMEDOUT';
    throw new Error(label + ': ' + (timedOut ? 'did not exit within ' + TIMEOUT + ' ms' : result.error.message));
  }
  if (result.status !== 0) {
    process.stderr.write(result.stdout || '');
    process.stderr.write(result.stderr || '');
    throw new Error(label + ': exit status ' + result.status + (result.signal ? ' (' + result.signal + ')' : ''));
  }
  return result;
}

function pack(work) {
  // Packs the dist/ that `npm run build` wrote, without lifecycle scripts: the tests run on every
  // supported Node, and the build tools need a newer one than the package does (15.5).
  const packed = run('npm pack', npm, ['pack', '--json', '--ignore-scripts', '--pack-destination', work], { cwd: root });
  const start = Math.max(packed.stdout.lastIndexOf('\n[\n'), packed.stdout.lastIndexOf('\n[\r\n'));
  const report = JSON.parse(start < 0 ? packed.stdout : packed.stdout.slice(start + 1));
  const files = report[0].files.map((file) => file.path);
  const tarballs = fs.readdirSync(work).filter((name) => name.endsWith('.tgz'));
  if (tarballs.length !== 1) { throw new Error('expected one tarball in ' + work + ', found ' + tarballs.length); }

  const missing = REQUIRED.filter((file) => !files.includes(file));
  if (missing.length > 0) { throw new Error('missing from the tarball: ' + missing.join(', ')); }
  const leaked = files.filter((file) => FORBIDDEN.some((prefix) => file.startsWith(prefix)));
  if (leaked.length > 0) { throw new Error('must not be in the tarball: ' + leaked.join(', ')); }
  return { install: path.join(work, tarballs[0]), label: tarballs[0] + ' (' + files.length + ' files)' };
}

// The two bundles of 15.4: the same names in both, `require()` callable, one format registry and
// one wasm instance for both.
const BOTH_FORMATS = [
  "import { createRequire } from 'node:module';",
  "import * as ns from '%s';",
  "const require = createRequire(import.meta.url);",
  "const cjs = require('%s');",
  "const names = (o) => Object.keys(o).filter((key) => key !== 'default').sort();",
  "if (typeof cjs !== 'function' || cjs.default !== cjs) { throw new Error('require() is not the vending function'); }",
  "if (names(ns).join() !== names(cjs).join()) { throw new Error('import exports ' + names(ns) + ', require ' + names(cjs)); }",
  "class Format { append() {} finalize() {} }",
  "cjs.registerFormat('from-require', Format);",
  "ns.registerFormat('from-import', Format);",
  "if (!ns.isRegisteredFormat('from-require') || !cjs.isRegisteredFormat('from-import')) { throw new Error('import and require have two format registries'); }",
  "for (const format of ['zip', 'tar', 'json']) { if (!ns.isRegisteredFormat(format) || !cjs.isRegisteredFormat(format)) { throw new Error(format + ' is not registered'); } }",
  "const glue = Object.keys(require.cache).filter((file) => file.endsWith('ykk_wasm.cjs'));",
  "if (glue.length !== 1) { throw new Error('the wasm glue is loaded ' + glue.length + ' times'); }",
  "const err = new ns.ArchiverError('ABORTED');",
  "if (ns.ArchiverError.name !== 'ArchiverError' || err.constructor.name !== 'ArchiverError') { throw new Error('ArchiverError is named ' + ns.ArchiverError.name); }",
  "if (ns.ZipEncrypted.name !== 'ZipEncrypted') { throw new Error('ZipEncrypted is named ' + ns.ZipEncrypted.name); }",
];

// What a consumer writes, for both module formats: named imports, typed events, glob({ cwd }), the encrypted options.
const TYPES = [
  "import type { ArchiverOptions, EntryData, GlobOptions, ProgressData } from '%s';",
  "registerFormat('zip-encrypted', ZipEncrypted);",
  "const options: ArchiverOptions = { zlib: { level: 9 }, password: 'secret', encryptionMethod: 'aes256' };",
  "const encrypted: Archiver = archiver.create('zip-encrypted', options);",
  "const archive = new ZipArchive({ zlib: { level: 9 } });",
  "const globOptions: GlobOptions = {",
  "  cwd: '.', ignore: ['a'], dot: true, nodir: true, mark: true, skip: 'b', follow: true, nocase: true,",
  "  matchBase: true, noglobstar: true, stat: true, absolute: true,",
  "};",
  "const entryData: EntryData = { name: 'a.txt', store: true, custom: 1 };",
  "const onFinish = () => {};",
  "archive.glob('*.txt', globOptions).glob('*.md', { cwd: '.' }).append('text', entryData).append(process.stdin, { name: 'b' });",
  "archive.on('entry', (entry) => { const name: string | null | undefined = entry.name; });",
  "archive.on('progress', (progress) => { const data: ProgressData = progress; });",
  "archive.on('warning', (err) => { const code: string = err.code; });",
  "archive.once('error', (err) => { const error: ArchiverError = err; });",
  "archive.on('data', (chunk) => { const length: number = chunk.length; });",
  "archive.on('end', onFinish).on('close', onFinish).on('finish', onFinish).on('drain', onFinish).off('finish', onFinish);",
  "archive.on('pipe', (source) => { source.unpipe(archive); }).on('custom', (value: number) => {});",
  "encrypted.finalize().then(onFinish);",
  "// @ts-expect-error",
  "archive.on('progress', (progress) => progress.entries.processsed);",
  "// @ts-expect-error",
  "archive.on('entry', (entry) => { const mode: string = entry.mode; });",
  "// @ts-expect-error",
  "archive.on('warning', (err) => { const code: number = err.code; });",
  "// @ts-expect-error",
  "archive.append('text', { name: 'a', store: 'false' });",
  "// @ts-expect-error",
  "archive.glob('*', { cwdd: '.' });",
];
const NAMED = "{ Archiver, ArchiverError, ZipArchive, ZipEncrypted, registerFormat } from '%s';";
const TYPES_ESM = ['import archiver, ' + NAMED, ...TYPES];
const TYPES_CJS = [
  "import archiver = require('%s');",
  'import ' + NAMED,
  ...TYPES,
  "const a: archiver.Archiver = archiver('zip'); new archiver.ZipArchive();",
  "const cipher: archiver.CryptoCipher = new archiver.CryptoCipher(Buffer.from('key'));",
];

function smoke(work, install) {
  // an empty project, with the repository's typescript and @types/node for the two type checks
  const project = path.join(work, 'project');
  fs.mkdirSync(project);
  fs.writeFileSync(path.join(project, 'package.json'), JSON.stringify({ name: 'ykk-tarball-check', version: '0.0.0', private: true }) + '\n');
  run('npm install', npm, [
    'install', '--no-audit', '--no-fund', '--save-exact', install,
    'typescript@' + manifest.devDependencies.typescript,
    '@types/node@' + manifest.devDependencies['@types/node'],
  ], { cwd: project });

  // section 16 item 4
  const name = manifest.name;
  const options = { cwd: project, timeout: TIMEOUT };
  run('require smoke', process.execPath, ['-e', "require('" + name + "')('zip')"], options);
  run('import smoke', process.execPath, ['--input-type=module', '-e', "import a, { ZipArchive } from '" + name + "'; new ZipArchive()"], options);
  const source = (lines) => lines.join('\n').replaceAll('%s', name) + '\n';
  fs.writeFileSync(path.join(project, 'formats.mjs'), source(BOTH_FORMATS));
  run('both formats smoke', process.execPath, ['formats.mjs'], options);

  // smoke.ts is the CommonJS file of a project that resolves the package through "main" and "types"
  fs.writeFileSync(path.join(project, 'smoke.cts'), source(TYPES_CJS));
  fs.writeFileSync(path.join(project, 'smoke.mts'), source(TYPES_ESM));
  fs.writeFileSync(path.join(project, 'smoke.ts'), source(TYPES_CJS));
  const tsc = path.join(project, 'node_modules', 'typescript', 'bin', 'tsc');
  const node16 = ['--module', 'node16', '--moduleResolution', 'node16'];
  const checks = [
    ['smoke.cts', node16], ['smoke.mts', node16],
    ['smoke.mts', ['--module', 'esnext', '--moduleResolution', 'bundler']],
    ['smoke.ts', ['--module', 'commonjs', '--moduleResolution', 'node10']],
  ];
  for (const [file, flags] of checks) {
    run('tsc ' + flags.join(' ') + ' ' + file, process.execPath, [tsc, ...flags, '--strict', '--noEmit', file], options);
  }
}

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'ykk-tarball-'));
try {
  const target = spec ? { install: spec, label: spec } : pack(work);
  smoke(work, target.install);
  console.log('check-tarball: ' + target.label + ' passed on Node ' + process.version);
} catch (err) {
  console.error('check-tarball: ' + err.message);
  process.exitCode = 1;
} finally {
  fs.rmSync(work, { recursive: true, force: true }); // the tarball is deleted with the directory
}
