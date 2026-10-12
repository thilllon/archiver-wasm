// PORTING.md 14.2 case X1 and 14.4: the port archives are opened by tools that share no code with port. No upstream source.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { load, runBoth, runOne } from './helpers/run-both.mjs';
import { parseZip } from './helpers/zip-records.mjs';

const require = createRequire(import.meta.url);
const yauzl = require('yauzl');
const tar = require('tar');

const DATE = new Date('2013-01-03T14:26:38.000Z');
const PASSWORD = '123';
const ZIP20_HEADER = Buffer.from('0102030405060708090a0b0c', 'hex');
// modes that the umask of the test (0o022) leaves alone when a tool restores them
const UMASK = 0o022;
// PORTING.md 17.2: the 12-byte ZipCrypto header a stored entry declares
const ZIP20_OVERHEAD = 12;
const S_IFMT = 0o170000;
const S_IFREG = 0o100000;
const S_IFDIR = 0o040000;
const S_IFLNK = 0o120000;

// PORTING.md 14.2 (helper of the test: a buffer of n bytes, byte i is i & 255)
function binaryBuffer(n) {
  const buffer = Buffer.alloc(n);
  for (let i = 0; i < n; i++) {
    buffer[i] = i & 255;
  }
  return buffer;
}

// PORTING.md 14.2 (helper of the test: a fresh stream, written in the given chunks)
function streamOf(chunks) {
  const stream = new PassThrough();
  for (const chunk of chunks) {
    stream.write(chunk);
  }
  stream.end();
  return stream;
}

// the inputs of the Z, T, G and A cases, one entry per kind of source (PORTING.md 14.2)
const ENTRIES = [
  { name: 'buffer.txt', type: 'file', source: 'buffer', data: Buffer.from('this is a text file'), mode: 0o644 },
  { name: 'docs/string.txt', type: 'file', source: 'string', data: Buffer.from('string source'), mode: 0o600 },
  { name: 'docs/stream.bin', type: 'file', source: 'stream', data: binaryBuffer(70000), mode: 0o755 },
  { name: 'docs/block.bin', type: 'file', source: 'buffer', data: binaryBuffer(512), mode: 0o644 },
  { name: 'disk.txt', type: 'file', source: 'file', data: Buffer.from('file on disk\n'), mode: 0o640 },
  {
    name: 'docs/stored.txt',
    type: 'file',
    source: 'buffer',
    data: Buffer.from('stored in an archive of the default method'),
    mode: 0o644,
    options: { name: 'docs/stored.txt', mode: 0o644, store: true },
  },
  { name: 'empty.txt', type: 'file', source: 'buffer', data: Buffer.alloc(0), mode: 0o644 },
  { name: 'empty-stream.txt', type: 'file', source: 'stream', data: Buffer.alloc(0), mode: 0o644 },
  { name: 'emptydir/', type: 'directory', mode: 0o755 },
  { name: 'link.txt', type: 'symlink', target: 'buffer.txt' },
];

// P17: a ZipCrypto entry without data bytes is malformed upstream too, so the extracted archives have none
const HAS_BYTES = (entry) => entry.type === 'symlink' || (entry.type === 'file' && entry.data.length > 0);
const ZIP20_ENTRIES = ENTRIES.filter(HAS_BYTES);
const P17_ENTRIES = ENTRIES.filter((entry) => !HAS_BYTES(entry));

// the names of case Z5 that a file system and yauzl accept; `options` is the entry data as the caller passes it
const NAME_ENTRIES = [
  {
    name: 'pre/fix/prefixed.txt',
    type: 'file',
    source: 'buffer',
    data: Buffer.from('prefix'),
    mode: 0o644,
    options: { name: 'prefixed.txt', prefix: 'pre/fix', mode: 0o644 },
  },
  {
    name: 'back/slash.txt',
    type: 'file',
    source: 'string',
    data: Buffer.from('backslash'),
    mode: 0o600,
    options: { name: 'back\\slash.txt', mode: 0o600 },
  },
  {
    name: 'up.txt',
    type: 'file',
    source: 'buffer',
    data: Buffer.from('parent directory'),
    mode: 0o644,
    options: { name: '../../up.txt', mode: 0o644 },
  },
  // sanitized twice: node-archiver/lib/core.js:276 leaves 'c:/x', deps/zip-stream/index.js:71 leaves 'x'
  { name: 'x', type: 'file', source: 'buffer', data: Buffer.from('drive'), mode: 0o644, options: { name: 'c:c:/x', mode: 0o644 } },
];

// the name of case Z5 that yauzl refuses as an absolute path: read without its name validation, not extracted
const RAW_NAME_ENTRIES = [
  {
    name: '/slashed.txt',
    type: 'file',
    source: 'string',
    data: Buffer.from('namePrependSlash'),
    mode: 0o644,
    options: { name: 'slashed.txt', mode: 0o644, namePrependSlash: true },
  },
];

// the modes of case Z7; a file of mode 0 cannot be read back, so these archives are not extracted
const MODE_ENTRIES = [
  { name: 'mode-0.txt', type: 'file', source: 'buffer', data: Buffer.from('mode 0'), mode: 0 },
  { name: 'mode-null.txt', type: 'file', source: 'string', data: Buffer.from('mode null'), mode: 0o644, options: { name: 'mode-null.txt', mode: null } },
  { name: 'mode-absent.txt', type: 'file', source: 'buffer', data: Buffer.from('mode absent'), mode: 0o644, options: { name: 'mode-absent.txt' } },
  { name: 'mode-777.txt', type: 'file', source: 'buffer', data: Buffer.from('mode 777'), mode: 0o777 },
  { name: 'mode-null-dir/', type: 'directory', mode: 0o755, options: { name: 'mode-null-dir/', mode: null } },
];

// the dates of case Z10: before 1980, 2043 and 2044, Invalid Date and a numeric date (P7)
const DATE_ENTRIES = [
  ['date-1975.txt', new Date('1975-06-01T12:00:00.000Z')],
  ['date-2043.txt', new Date('2043-12-31T12:00:00.000Z')],
  ['date-2044.txt', new Date('2044-01-01T12:00:00.000Z')],
  ['date-invalid.txt', new Date(NaN)],
  ['date-number.txt', 1357223198000],
].map(([name, date]) => ({ name, type: 'file', source: 'buffer', data: Buffer.from(name), mode: 0o644, options: { name, mode: 0o644, date } }));

// the header fields of case T5; `tar` is what npm tar Parse must read back (mode 0 is FMODE, deps/tar-stream/pack.js:149)
const OWNER_ENTRIES = [
  {
    name: 'owner.txt',
    type: 'file',
    source: 'buffer',
    data: Buffer.from('owner'),
    mode: 0o640,
    options: { name: 'owner.txt', mode: 0o640, uid: 1000, gid: 1001, uname: 'archiver-wasm-user', gname: 'archiver-wasm-group', devmajor: 7 },
    tar: { uid: 1000, gid: 1001, uname: 'archiver-wasm-user', gname: 'archiver-wasm-group', devmaj: 7 },
  },
  {
    name: 'pax.txt',
    type: 'file',
    source: 'string',
    data: Buffer.from('caller pax'),
    mode: 0o644,
    options: { name: 'pax.txt', mode: 0o644, pax: { comment: 'pax comment' } },
  },
  { name: 'mode-0.txt', type: 'file', source: 'buffer', data: Buffer.from('mode 0'), mode: 0o644, options: { name: 'mode-0.txt', mode: 0 } },
  { name: 'mode-null.txt', type: 'file', source: 'buffer', data: Buffer.from('mode null'), mode: 0o644, options: { name: 'mode-null.txt', mode: null } },
];

// the one entry of cases Z12 and C2, written after bytes that are not part of the archive
const ENGINE_PREFIX = 'PREFIX';
const ENGINE_ENTRY = { name: 'a.txt', type: 'file', source: 'buffer', data: binaryBuffer(3000), mode: 0o644 };

// the name lengths of case T3: 100, 101, 155 + 1 + 100 and a pax path, each component short enough for a file system
const LONG_NAME_ENTRIES = [
  `n100/${'a'.repeat(95)}`,
  `n101/${'b'.repeat(96)}`,
  `${'p'.repeat(155)}/${'c'.repeat(100)}`,
  `${'q'.repeat(99)}/${'r'.repeat(99)}/${'s'.repeat(100)}`,
].map((name) => ({ name, type: 'file', source: 'buffer', data: Buffer.from(`${name.length} bytes`), mode: 0o644 }));

// names outside ASCII are checked with the tools whose result does not depend on the locale
const UNICODE_ENTRIES = [
  { name: 'é.txt', type: 'file', source: 'buffer', data: Buffer.from('e acute'), mode: 0o644, comment: 'ü comment' },
  { name: 'dir-ü/日本.txt', type: 'file', source: 'string', data: Buffer.from('nihon'), mode: 0o600 },
];

// the trees of the directory() walks: [name, type, mode, data or target]
const TREE = [
  ['a.txt', 'file', 0o644, 'this is a text file'],
  ['run.sh', 'file', 0o755, '#!/bin/sh\n'],
  ['sub', 'directory', 0o755],
  ['sub/b.bin', 'file', 0o600, binaryBuffer(600)],
  ['sub/empty.txt', 'file', 0o644, ''],
  ['sub/deep', 'directory', 0o700],
  ['sub/deep/c.txt', 'file', 0o644, 'deep'],
  ['emptydir', 'directory', 0o755],
  ['link-a', 'symlink', 0, 'a.txt'],
];

// a walk without directories and without empty files, so that its ZipCrypto archive has no P17 entry
const FLAT = [
  ['one.txt', 'file', 0o644, 'one'],
  ['two.bin', 'file', 0o600, binaryBuffer(300)],
  ['link-one', 'symlink', 0, 'one.txt'],
];
const TREES = { tree: TREE, flat: FLAT };

// PORTING.md 14.2 (determinism: file modes are set by chmod in the test)
function makeTree(root, tree) {
  fs.mkdirSync(root);
  for (const [name, type, , content] of tree) {
    const target = path.join(root, name);
    if (type === 'directory') {
      fs.mkdirSync(target);
    } else if (type === 'symlink') {
      fs.symlinkSync(content, target);
    } else {
      fs.writeFileSync(target, content);
    }
  }
  for (const [name, type, mode] of tree.slice().reverse()) {
    if (type !== 'symlink') {
      fs.chmodSync(path.join(root, name), mode);
    }
  }
}

// PORTING.md 14.4 (the inputs of a walk: the entries a directory(dir, key) walk over TREES[key] must produce)
function treeEntries(key = 'tree') {
  return TREES[key].map(([name, type, mode, content]) => {
    if (type === 'directory') {
      return { name: `${key}/${name}/`, type, mode };
    }
    if (type === 'symlink') {
      return { name: `${key}/${name}`, type, target: content };
    }
    return { name: `${key}/${name}`, type, mode, data: Buffer.from(content) };
  });
}

// PORTING.md 14.2 (helper of the test: a fresh source per run, of the kind the entry names)
function sourceOf(entry) {
  switch (entry.source) {
    case 'string':
      return entry.data.toString('utf8');
    case 'stream':
      return streamOf([entry.data.subarray(0, 1000), entry.data.subarray(1000)]);
    default:
      return Buffer.from(entry.data);
  }
}

// PORTING.md 14.2 (determinism: every entry gets an explicit `date`; `options` is passed as the caller wrote it)
function dataOf(entry) {
  const data = entry.options === undefined ? { name: entry.name, mode: entry.mode } : { ...entry.options };
  if (entry.comment !== undefined) {
    data.comment = entry.comment;
  }
  return { date: DATE, ...data };
}

// node-archiver/lib/core.js:525-568, 651-662, 749-790 (append, file and symlink, one call per entry)
function addEntries(archive, entries, disk) {
  for (const entry of entries) {
    if (entry.type === 'symlink') {
      archive.symlink(entry.name, entry.target);
    } else if (entry.type === 'directory') {
      archive.append(null, dataOf(entry));
    } else if (entry.source === 'file') {
      archive.file(path.join(disk, entry.name), dataOf(entry));
    } else {
      archive.append(sourceOf(entry), dataOf(entry));
    }
  }
}

// PORTING.md 14.4 (one archive of the given format with the given entries)
function archiveOf(format, options, entries) {
  return async (impl, ctx) => {
    const archive = ctx.create(format, options);
    addEntries(archive, entries, ctx.args.disk);
    await archive.finalize();
  };
}

// node-archiver/lib/core.js:570-649 (one directory() walk)
function walkOf(format, options, key = 'tree') {
  return async (impl, ctx) => {
    const archive = ctx.create(format, options);
    archive.directory(ctx.args[key], key);
    await archive.finalize();
  };
}

// PORTING.md 14.2 (Z12: the class of the engine a ZipArchive runs on; port does not export ZipStream by name)
function zipStreamClass(impl) {
  const archive = new impl.ZipArchive();
  const ZipStream = archive._module.engine.constructor;
  archive._module.engine.destroy();
  archive.destroy();
  return ZipStream;
}

// deps/compress-commons/lib/archivers/archive-output-stream.js:41-48 (Z12 and C2: write(), then one entry, then finalize())
function engineOf(format) {
  return async (impl, ctx) => {
    const engine = ctx.track(format === 'zip20' ? new impl.ZipCryptoStream({ password: PASSWORD }) : new (zipStreamClass(impl))());
    const ended = once(engine, 'end');
    engine.write(ENGINE_PREFIX);
    await new Promise((resolve, reject) => {
      engine.entry(Buffer.from(ENGINE_ENTRY.data), dataOf(ENGINE_ENTRY), (err) => (err ? reject(err) : resolve()));
    });
    engine.finalize();
    await ended;
  };
}

// PORTING.md 12.3 (7z, tar and gzip are prerequisites on PATH)
function run(command, commandArgs) {
  const result = spawnSync(command, commandArgs, { encoding: 'utf8' });
  assert.equal(result.error, undefined, `${command}: ${result.error}`);
  assert.equal(result.status, 0, `${command} ${commandArgs.join(' ')}\n${result.stdout}${result.stderr}`);
  return result.stdout;
}

// PORTING.md 14.4 (helper of the checks: the tools list in their own order, so both sides are sorted by name)
function byName(a, b) {
  return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
}

// PORTING.md 14.4 (helper of the checks: the path of a directory entry on disk)
function stripSlash(name) {
  return name.endsWith('/') ? name.slice(0, -1) : name;
}

// PORTING.md 14.4 (helper of the checks: every path below `dir`, relative, sorted)
function walk(dir, relative = '') {
  const found = [];
  for (const name of fs.readdirSync(path.join(dir, relative))) {
    const child = relative === '' ? name : `${relative}/${name}`;
    found.push(child);
    if (fs.lstatSync(path.join(dir, child)).isDirectory()) {
      found.push(...walk(dir, child));
    }
  }
  return found.sort();
}

// PORTING.md 14.4 (extracted file contents, modes and symlink targets are compared with the inputs)
function assertExtracted(dir, entries) {
  const expected = new Set();
  for (const entry of entries) {
    const parts = stripSlash(entry.name).split('/');
    for (let i = 1; i <= parts.length; i++) {
      expected.add(parts.slice(0, i).join('/'));
    }
  }
  assert.deepStrictEqual(walk(dir), [...expected].sort());
  for (const entry of entries) {
    const target = path.join(dir, stripSlash(entry.name));
    const stats = fs.lstatSync(target);
    if (entry.type === 'symlink') {
      assert.ok(stats.isSymbolicLink(), `${entry.name}: not a symlink`);
      assert.equal(fs.readlinkSync(target), entry.target, `${entry.name}: link target`);
    } else if (entry.type === 'directory') {
      assert.ok(stats.isDirectory(), `${entry.name}: not a directory`);
      assert.equal(stats.mode & 0o777, entry.mode, `${entry.name}: mode`);
    } else {
      assert.ok(stats.isFile(), `${entry.name}: not a file`);
      assert.ok(fs.readFileSync(target).equals(entry.data), `${entry.name}: content`);
      assert.equal(stats.mode & 0o777, entry.mode, `${entry.name}: mode`);
    }
  }
}

// PORTING.md 14.4 (yauzl 3.3.0: every central entry, and the inflated data of the entries that are not encrypted)
function readZip(buffer, raw) {
  // without decodeStrings yauzl hands out the bytes and validates no name; the archives write UTF-8
  const text = (value) => (raw ? value.toString('utf8') : value);
  return new Promise((resolve, reject) => {
    yauzl.fromBuffer(buffer, { lazyEntries: true, decodeStrings: !raw }, (err, zipfile) => {
      if (err) {
        reject(err);
        return;
      }
      const entries = [];
      zipfile.on('error', reject);
      zipfile.on('end', () => resolve({ comment: text(zipfile.comment), entries }));
      zipfile.on('entry', (entry) => {
        const record = {
          name: text(entry.fileName),
          attributes: entry.externalFileAttributes >>> 16,
          size: entry.uncompressedSize,
          comment: text(entry.fileComment),
          encrypted: entry.isEncrypted(),
          data: null,
        };
        entries.push(record);
        if (record.encrypted || record.name.endsWith('/')) {
          zipfile.readEntry();
          return;
        }
        zipfile.openReadStream(entry, (openError, stream) => {
          if (openError) {
            reject(openError);
            return;
          }
          const chunks = [];
          stream.on('error', reject);
          stream.on('data', (chunk) => chunks.push(chunk));
          stream.on('end', () => {
            record.data = Buffer.concat(chunks);
            zipfile.readEntry();
          });
        });
      });
      zipfile.readEntry();
    });
  });
}

// PORTING.md 14.4 (yauzl): names, type bits, modes and contents; an encrypted entry is only listed
async function assertYauzl(buffer, entries, { encrypted = false, comment = '', raw = false } = {}) {
  const zip = await readZip(buffer, raw);
  assert.equal(zip.comment, comment);
  const found = zip.entries.slice().sort(byName);
  const expected = entries.slice().sort(byName);
  assert.deepStrictEqual(
    found.map((entry) => entry.name),
    expected.map((entry) => entry.name)
  );
  for (const [index, entry] of expected.entries()) {
    const record = found[index];
    if (entry.type === 'symlink') {
      assert.equal(record.attributes & S_IFMT, S_IFLNK, `${entry.name}: type bits`);
    } else if (entry.type === 'directory') {
      assert.equal(record.attributes & S_IFMT, S_IFDIR, `${entry.name}: type bits`);
      assert.equal(record.attributes & 0o777, entry.mode, `${entry.name}: mode`);
    } else {
      assert.equal(record.attributes & S_IFMT, S_IFREG, `${entry.name}: type bits`);
      assert.equal(record.attributes & 0o777, entry.mode, `${entry.name}: mode`);
      assert.equal(record.size, entry.data.length, `${entry.name}: size`);
      assert.equal(record.encrypted, encrypted, `${entry.name}: encryption flag`);
    }
    if (entry.comment !== undefined) {
      assert.equal(record.comment, entry.comment, `${entry.name}: comment`);
    }
    if (record.data !== null) {
      const data = entry.type === 'symlink' ? Buffer.from(entry.target) : entry.data;
      assert.ok(record.data.equals(data), `${entry.name}: content`);
    }
  }
}

// PORTING.md 14.4 (npm tar 6.2.1 Parse in strict mode: every entry with its body; a tar.gz is gunzipped by the parser)
function readTar(buffer) {
  return new Promise((resolve, reject) => {
    const entries = [];
    const parser = new tar.Parse({ strict: true });
    parser.on('error', reject);
    parser.on('entry', (entry) => {
      const chunks = [];
      entry.on('data', (chunk) => chunks.push(chunk));
      entry.on('end', () => {
        entries.push({
          name: entry.path,
          type: entry.type,
          mode: entry.mode,
          size: entry.size,
          linkpath: entry.linkpath,
          uid: entry.uid,
          gid: entry.gid,
          uname: entry.uname,
          gname: entry.gname,
          devmaj: entry.header.devmaj,
          data: Buffer.concat(chunks),
        });
      });
    });
    parser.on('end', () => resolve(entries));
    parser.end(buffer);
  });
}

// PORTING.md 14.4 (npm tar 6 Parse): names, types, modes, sizes, link targets and contents
async function assertTarParse(buffer, entries) {
  const found = (await readTar(buffer)).sort(byName);
  const expected = entries.slice().sort(byName);
  assert.deepStrictEqual(
    found.map((entry) => entry.name),
    expected.map((entry) => entry.name)
  );
  for (const [index, entry] of expected.entries()) {
    const record = found[index];
    if (entry.type === 'symlink') {
      assert.equal(record.type, 'SymbolicLink', `${entry.name}: type`);
      assert.equal(record.linkpath, entry.target, `${entry.name}: link target`);
    } else if (entry.type === 'directory') {
      assert.equal(record.type, 'Directory', `${entry.name}: type`);
      assert.equal(record.mode, entry.mode, `${entry.name}: mode`);
    } else {
      assert.equal(record.type, 'File', `${entry.name}: type`);
      assert.equal(record.mode, entry.mode, `${entry.name}: mode`);
      assert.equal(record.size, entry.data.length, `${entry.name}: size`);
      assert.ok(record.data.equals(entry.data), `${entry.name}: content`);
    }
    if (entry.tar !== undefined) {
      for (const field of Object.keys(entry.tar)) {
        assert.equal(record[field], entry.tar[field], `${entry.name}: ${field}`);
      }
    }
  }
}

describe('differential: extraction with independent tools (PORTING.md 14.2 X1, 14.4)', () => {
  let root;
  let args;
  let umask;
  let serial = 0;

  // PORTING.md 14.4 (the port archive of one case, written where the command line tools can read it)
  async function build(scenario, extension) {
    const result = await runOne('port', scenario, { args });
    assert.equal(result.error, null, 'port: the scenario threw');
    serial += 1;
    const file = path.join(root, `archive-${serial}.${extension}`);
    fs.writeFileSync(file, result.bytes);
    return { file, bytes: result.bytes, out: path.join(root, `out-${serial}`) };
  }

  // PORTING.md 14.4 (`7z t` and `7z x`, with `-p` for both encryption methods)
  function assert7z(archive, entries, password) {
    const secret = password === undefined ? [] : [`-p${password}`];
    run('7z', ['t', ...secret, archive.file]);
    run('7z', ['x', '-y', ...secret, `-o${archive.out}`, archive.file]);
    assertExtracted(archive.out, entries);
  }

  // PORTING.md 14.4 (`tar -tf` and `tar -xf`; -p keeps the archived modes)
  function assertTar(archive, entries) {
    const listed = run('tar', ['-tf', archive.file]).split('\n').filter((line) => line !== '');
    assert.deepStrictEqual(listed.slice().sort(), entries.map((entry) => entry.name).sort());
    fs.mkdirSync(archive.out);
    run('tar', ['-xpf', archive.file, '-C', archive.out]);
    assertExtracted(archive.out, entries);
  }

  before(async () => {
    await load('upstream');
    await load('port');
    umask = process.umask(UMASK);
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'archiver-wasm-diff-extraction-')));
    const disk = path.join(root, 'disk');
    fs.mkdirSync(disk);
    for (const entry of ENTRIES.filter((candidate) => candidate.source === 'file')) {
      fs.writeFileSync(path.join(disk, entry.name), entry.data);
    }
    const tree = path.join(root, 'tree');
    makeTree(tree, TREE);
    const flat = path.join(root, 'flat');
    makeTree(flat, FLAT);
    args = { disk, tree, flat };
  });

  after(() => {
    process.umask(umask);
    fs.rmSync(root, { recursive: true, force: true });
  });

  describe('zip', () => {
    const variants = [
      ['default method', {}, {}],
      ['store', { store: true }, {}],
      ['zlib level 1', { zlib: { level: 1 } }, {}],
      ['zlib level 9', { zlib: { level: 9 } }, {}],
      ['zlib level 0', { zlib: { level: 0 } }, {}],
      ['zlib level NaN', { zlib: { level: NaN } }, {}],
      ['zlib level 0.9', { zlib: { level: 0.9 } }, {}],
      ['the level shortcut', { level: 1 }, {}],
      ['forceZip64', { forceZip64: true }, {}],
      ['forceZip64 with zlib level 0', { forceZip64: true, zlib: { level: 0 } }, {}],
      ['forceLocalTime', { forceLocalTime: true }, {}],
      ['archive comment', { comment: 'archive comment' }, { comment: 'archive comment' }],
      ['an archive comment outside ASCII', { comment: 'ü 日本 comment' }, { comment: 'ü 日本 comment', raw: true }],
    ];
    for (const [title, options, expected] of variants) {
      it(`${title}: 7z t, 7z x and yauzl`, async () => {
        const archive = await build(archiveOf('zip', options, ENTRIES), 'zip');
        assert7z(archive, ENTRIES);
        await assertYauzl(archive.bytes, ENTRIES, expected);
      });
    }

    it('one directory() walk: 7z t, 7z x and yauzl', async () => {
      const archive = await build(walkOf('zip', {}), 'zip');
      assert7z(archive, treeEntries());
      await assertYauzl(archive.bytes, treeEntries());
    });

    it('names outside ASCII and entry comments: 7z t and yauzl', async () => {
      const archive = await build(archiveOf('zip', {}, UNICODE_ENTRIES), 'zip');
      run('7z', ['t', archive.file]);
      await assertYauzl(archive.bytes, UNICODE_ENTRIES);
    });

    it("prefix, backslash, parent directory and 'c:c:/x' names: 7z t, 7z x and yauzl", async () => {
      const archive = await build(archiveOf('zip', {}, NAME_ENTRIES), 'zip');
      assert7z(archive, NAME_ENTRIES);
      await assertYauzl(archive.bytes, NAME_ENTRIES);
    });

    it('namePrependSlash: 7z t and yauzl without its name validation', async () => {
      const archive = await build(archiveOf('zip', {}, RAW_NAME_ENTRIES), 'zip');
      run('7z', ['t', archive.file]);
      await assertYauzl(archive.bytes, RAW_NAME_ENTRIES, { raw: true });
    });

    it('mode 0, null, absent and 0777: 7z t and yauzl', async () => {
      const archive = await build(archiveOf('zip', {}, MODE_ENTRIES), 'zip');
      run('7z', ['t', archive.file]);
      await assertYauzl(archive.bytes, MODE_ENTRIES);
    });

    it('dates before 1980, in 2043 and 2044, Invalid Date and a numeric date: 7z t, 7z x and yauzl', async () => {
      const archive = await build(archiveOf('zip', {}, DATE_ENTRIES), 'zip');
      assert7z(archive, DATE_ENTRIES);
      await assertYauzl(archive.bytes, DATE_ENTRIES);
    });

    it("ZipStream used directly, write('PREFIX') before the entry: 7z t, 7z x and yauzl", async () => {
      const archive = await build(engineOf('zip'), 'zip');
      assert.deepStrictEqual(archive.bytes.subarray(0, ENGINE_PREFIX.length), Buffer.from(ENGINE_PREFIX));
      assert7z(archive, [ENGINE_ENTRY]);
      await assertYauzl(archive.bytes, [ENGINE_ENTRY]);
    });
  });

  describe('tar', () => {
    it('every kind of source: tar -tf, tar -xf and npm tar Parse', async () => {
      const archive = await build(archiveOf('tar', {}, ENTRIES), 'tar');
      assertTar(archive, ENTRIES);
      await assertTarParse(archive.bytes, ENTRIES);
    });

    it('names of 100, 101, 256 and 300 bytes: tar -tf, tar -xf and npm tar Parse', async () => {
      const archive = await build(archiveOf('tar', {}, LONG_NAME_ENTRIES), 'tar');
      assertTar(archive, LONG_NAME_ENTRIES);
      await assertTarParse(archive.bytes, LONG_NAME_ENTRIES);
    });

    it('one directory() walk: tar -tf, tar -xf and npm tar Parse', async () => {
      const archive = await build(walkOf('tar', {}), 'tar');
      assertTar(archive, treeEntries());
      await assertTarParse(archive.bytes, treeEntries());
    });

    it('names outside ASCII: npm tar Parse', async () => {
      const archive = await build(archiveOf('tar', {}, UNICODE_ENTRIES), 'tar');
      await assertTarParse(archive.bytes, UNICODE_ENTRIES);
    });

    it('uid, gid, uname, gname, devmajor, caller pax, mode 0 and null: tar -tf, tar -xf and npm tar Parse', async () => {
      const archive = await build(archiveOf('tar', {}, OWNER_ENTRIES), 'tar');
      assertTar(archive, OWNER_ENTRIES);
      await assertTarParse(archive.bytes, OWNER_ENTRIES);
    });
  });

  describe('tar.gz', () => {
    for (const level of [1, 6, 9]) {
      it(`gzipOptions.level ${level}: gzip -t, tar -tf, tar -xf and npm tar Parse`, async () => {
        const archive = await build(archiveOf('tar.gz', { gzipOptions: { level } }, ENTRIES), 'tar.gz');
        run('gzip', ['-t', archive.file]);
        assertTar(archive, ENTRIES);
        await assertTarParse(archive.bytes, ENTRIES);
      });
    }

    it('one directory() walk: gzip -t, tar -tf, tar -xf and npm tar Parse', async () => {
      const archive = await build(walkOf('tar.gz', {}), 'tar.gz');
      run('gzip', ['-t', archive.file]);
      assertTar(archive, treeEntries());
      await assertTarParse(archive.bytes, treeEntries());
    });
  });

  describe('aes256', () => {
    const variants = [
      ['default method', {}, {}],
      ['store', { store: true }, {}],
      ['forceZip64 and an archive comment', { forceZip64: true, comment: 'archive comment' }, { comment: 'archive comment' }],
    ];
    for (const [title, options, expected] of variants) {
      it(`${title}: 7z t -p, 7z x -p and the yauzl listing`, async () => {
        const archive = await build(archiveOf('aes256', { password: PASSWORD, ...options }, ENTRIES), 'zip');
        assert7z(archive, ENTRIES, PASSWORD);
        await assertYauzl(archive.bytes, ENTRIES, { encrypted: true, ...expected });
      });
    }

    it('one directory() walk: 7z t -p, 7z x -p and the yauzl listing', async () => {
      const archive = await build(walkOf('aes256', { password: PASSWORD }), 'zip');
      assert7z(archive, treeEntries(), PASSWORD);
      await assertYauzl(archive.bytes, treeEntries(), { encrypted: true });
    });

    it('names outside ASCII and entry comments: 7z t -p and the yauzl listing', async () => {
      const archive = await build(archiveOf('aes256', { password: PASSWORD }, UNICODE_ENTRIES), 'zip');
      run('7z', ['t', `-p${PASSWORD}`, archive.file]);
      await assertYauzl(archive.bytes, UNICODE_ENTRIES, { encrypted: true });
    });
  });

  describe('zip20', () => {
    const variants = [
      ['default method', {}],
      ['store', { store: true }],
    ];
    for (const [title, options] of variants) {
      it(`${title}: 7z t -p, 7z x -p and the yauzl listing`, async () => {
        const archive = await build(archiveOf('zip20', { password: PASSWORD, ...options }, ZIP20_ENTRIES), 'zip');
        assert7z(archive, ZIP20_ENTRIES, PASSWORD);
        await assertYauzl(archive.bytes, ZIP20_ENTRIES, { encrypted: true });
      });
    }

    it('one directory() walk without directories: 7z t -p, 7z x -p and the yauzl listing', async () => {
      const archive = await build(walkOf('zip20', { password: PASSWORD }, 'flat'), 'zip');
      assert7z(archive, treeEntries('flat'), PASSWORD);
      await assertYauzl(archive.bytes, treeEntries('flat'), { encrypted: true });
    });

    it('names outside ASCII and entry comments: 7z t -p and the yauzl listing', async () => {
      const archive = await build(archiveOf('zip20', { password: PASSWORD }, UNICODE_ENTRIES), 'zip');
      run('7z', ['t', `-p${PASSWORD}`, archive.file]);
      await assertYauzl(archive.bytes, UNICODE_ENTRIES, { encrypted: true });
    });

    it("ZipCryptoStream written to directly, write('PREFIX') before the entry: 7z t -p, 7z x -p and the yauzl listing", async () => {
      const archive = await build(engineOf('zip20'), 'zip');
      assert.deepStrictEqual(archive.bytes.subarray(0, ENGINE_PREFIX.length), Buffer.from(ENGINE_PREFIX));
      assert7z(archive, [ENGINE_ENTRY], PASSWORD);
      await assertYauzl(archive.bytes, [ENGINE_ENTRY], { encrypted: true });
    });

    it('an archive that reproduces P17 equals upstream byte for byte and is not extracted', async () => {
      const scenario = archiveOf('zip20', { password: PASSWORD, store: true }, P17_ENTRIES);
      const { upstream, port } = await runBoth(scenario, { random: ZIP20_HEADER, args });
      assert.equal(upstream.error, null, 'upstream: the scenario threw');
      assert.equal(port.error, null, 'port: the scenario threw');
      const zip = parseZip(upstream.bytes);
      assert.deepStrictEqual(
        zip.entries.map((entry) => entry.name),
        P17_ENTRIES.map((entry) => entry.name)
      );
      for (const entry of zip.entries) {
        assert.equal(entry.central.compressedSize, ZIP20_OVERHEAD, `${entry.name}: declared compressed size`);
        assert.equal(entry.payload.length, 0, `${entry.name}: bytes really written`);
      }
      assert.ok(port.bytes.equals(upstream.bytes), 'zip20: archive bytes differ');
    });
  });
});
