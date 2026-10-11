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
  'dist/index.mjs', 'dist/index.cjs', 'dist/index.d.ts', 'dist/index.d.cts',
  'cjs/index.cjs', 'cjs/index.d.cts',
  'pkg/ykk_wasm.cjs', 'pkg/ykk_wasm_bg.wasm', 'pkg/ykk_wasm.d.cts',
];
const FORBIDDEN = ['src/', 'crates/', 'tests/', '.upstream/'];
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
  // `npm pack` runs prepack, and the output of that script precedes the JSON report on stdout.
  const packed = run('npm pack', npm, ['pack', '--json', '--pack-destination', work], { cwd: root });
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
  fs.writeFileSync(path.join(project, 'smoke.cts'),
    "import archiver = require('" + name + "'); const a: archiver.Archiver = archiver('zip'); new archiver.ZipArchive();\n");
  fs.writeFileSync(path.join(project, 'smoke.mts'),
    "import a, { ZipArchive } from '" + name + "'; new ZipArchive();\n");
  const tsc = path.join(project, 'node_modules', 'typescript', 'bin', 'tsc');
  for (const file of ['smoke.cts', 'smoke.mts']) {
    run('tsc ' + file, process.execPath, [tsc, '--module', 'node16', '--moduleResolution', 'node16', '--strict', '--noEmit', file], options);
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
