#!/usr/bin/env node
// PORTING.md 14.3: drives the upstream engines directly with fixed inputs and writes the
// golden files of crates/ykk-core/tests/golden/ and tests/vectors/sanitize-path.json.
// Re-run only when an upstream pin changes (PORTING.md 14.6).
process.env.TZ = 'UTC';

import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const goldenDir = path.join(root, 'crates', 'ykk-core', 'tests', 'golden');
const vectorsDir = path.join(root, 'tests', 'vectors');
const require = createRequire(import.meta.url);

// PORTING.md 14.2 (the oracle is the pinned source)
execFileSync(process.execPath, [path.join(root, 'scripts', 'verify-oracle-versions.mjs')], { stdio: 'inherit' });

// PORTING.md 14.2 (Node's resolution order: node_modules directories upward from the dependent)
function locate(from, name) {
  for (let dir = from; ; dir = path.dirname(dir)) {
    const candidate = path.join(dir, 'node_modules', name);
    if (fs.existsSync(path.join(candidate, 'package.json'))) {
      return fs.realpathSync(candidate);
    }
    if (path.dirname(dir) === dir) {
      throw new Error('cannot locate ' + name + ' from ' + from);
    }
  }
}

// PORTING.md 14.2 (the oracle table: the version each package reports)
function version(dir) {
  return JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')).version;
}

const archiver = locate(root, 'archiver');
const encrypted = locate(root, 'archiver-zip-encrypted');
const zipStream = locate(archiver, 'zip-stream');
const compressCommons = locate(zipStream, 'compress-commons');
const crc32Stream = locate(compressCommons, 'crc32-stream');
const tarStream = locate(archiver, 'tar-stream');
const normalizePathDir = locate(zipStream, 'normalize-path');

// PORTING.md 14.2 (the oracle table, row by row; a nested package is named after its row)
const upstreamVersions = [
  ['archiver', archiver],
  ['archiver-zip-encrypted', encrypted],
  ['archiver/zip-stream', zipStream],
  ['archiver/compress-commons', compressCommons],
  ['archiver/crc32-stream', crc32Stream],
  ['archiver/crc-32', locate(crc32Stream, 'crc-32')],
  ['archiver/tar-stream', tarStream],
  ['archiver/streamx', locate(tarStream, 'streamx')],
  ['archiver/b4a', locate(tarStream, 'b4a')],
  ['archiver/readdir-glob', locate(archiver, 'readdir-glob')],
  ['archiver/async', locate(archiver, 'async')],
  ['archiver/buffer-crc32', locate(archiver, 'buffer-crc32')],
  ['archiver/is-stream', locate(archiver, 'is-stream')],
  ['archiver/lazystream', locate(archiver, 'lazystream')],
  ['archiver/normalize-path', locate(archiver, 'normalize-path')],
  ['archiver-zip-encrypted/archiver', locate(encrypted, 'archiver')],
  ['archiver-zip-encrypted/zip-stream', locate(encrypted, 'zip-stream')],
  ['archiver-zip-encrypted/compress-commons', locate(encrypted, 'compress-commons')],
  ['archiver-zip-encrypted/crc32-stream', locate(encrypted, 'crc32-stream')],
  ['archiver-zip-encrypted/archiver-utils', locate(encrypted, 'archiver-utils')],
  ['archiver-zip-encrypted/aes-js', locate(encrypted, 'aes-js')],
  ['archiver-zip-encrypted/buffer-crc32', locate(encrypted, 'buffer-crc32')],
].map(([name, dir]) => [name, version(dir)]);

const ZipStream = (await import(pathToFileURL(path.join(zipStream, 'index.js')).href)).default;
const zipStreamUtils = await import(pathToFileURL(path.join(zipStream, 'utils.js')).href);
const archiverUtils = await import(pathToFileURL(path.join(archiver, 'lib', 'utils.js')).href);
const normalizePath = require(normalizePathDir);
const ZipAesStream = require(path.join(encrypted, 'lib', 'aes', 'zip-aes-stream.js'));
const ZipCryptoStream = require(path.join(encrypted, 'lib', 'zip20', 'zip-crypto-stream.js'));
const tarPack = require(tarStream).pack;

const EMPTY = Buffer.alloc(0);
const DATE = new Date('2013-01-03T14:26:38Z');
const TEXT = Buffer.from('this is a text file');
const AES_SALT = Buffer.from('000102030405060708090a0b0c0d0e0f', 'hex');
const ZIP20_HEADER = Buffer.from('0102030405060708090a0b0c', 'hex');

// PORTING.md 14.3 (compressible payloads of a given length)
function text(bytes, seed) {
  let result = '';
  for (let i = 0; result.length < bytes; i++) {
    result += seed + ' line ' + i + ': the quick brown fox jumps over the lazy dog\n';
  }
  return Buffer.from(result.slice(0, bytes));
}

const DEFLATE_BUFFER = text(4000, 'buffer');
const DEFLATE_STREAM = text(4000, 'stream');

// PORTING.md 14.3 (the binding scenario list). `source` is a Buffer, an array of chunks
// (a stream) or null (a symlink, whose payload is its link name).
const zipScenarios = [
  {
    name: 'zip-stored-buffers',
    engine: 'plain',
    options: () => ({ zlib: { level: 1 } }),
    entries: [
      { source: TEXT, data: { name: 'a.txt', date: DATE, store: true, mode: 420 } },
      { source: EMPTY, data: { name: 'empty.txt', date: DATE } },
      { source: EMPTY, data: { name: 'd/', date: DATE, mode: 493 } },
      { source: null, data: { name: 'link', type: 'symlink', linkname: 'a.txt', date: DATE } },
    ],
    compare: 'Bytes',
  },
  {
    name: 'zip-stored-stream',
    engine: 'plain',
    options: () => ({ zlib: { level: 1 } }),
    entries: [
      { source: [Buffer.from('this is a '), Buffer.from('text file')], data: { name: 'stream.txt', date: DATE, store: true } },
    ],
    compare: 'Bytes',
  },
  {
    name: 'zip-names-comments',
    engine: 'plain',
    options: () => ({ zlib: { level: 1 }, comment: 'archive ü' }),
    entries: [
      { source: TEXT, data: { name: 'é.txt', date: DATE, store: true, comment: 'ü' } },
      { source: TEXT, data: { name: 'p.txt', date: DATE, store: true, namePrependSlash: true } },
    ],
    compare: 'Bytes',
  },
  {
    name: 'zip-dos-dates',
    engine: 'plain',
    options: () => ({ zlib: { level: 1 } }),
    entries: [
      { source: TEXT, data: { name: '1979.txt', date: new Date('1979-12-31T23:59:59Z'), store: true } },
      { source: TEXT, data: { name: '2044.txt', date: new Date('2044-01-01T00:00:00Z'), store: true } },
      { source: TEXT, data: { name: 'invalid.txt', date: new Date(NaN), store: true } },
    ],
    compare: 'Bytes',
  },
  {
    name: 'zip-force-zip64',
    engine: 'plain',
    options: () => ({ forceZip64: true }),
    entries: [
      { source: TEXT, data: { name: 'a.txt', date: DATE, store: true } },
    ],
    compare: 'Bytes',
  },
  {
    name: 'zip-deflate',
    engine: 'plain',
    options: () => ({ zlib: { level: 6 } }),
    entries: [
      { source: DEFLATE_BUFFER, data: { name: 'buffer.txt', date: DATE } },
      {
        source: [DEFLATE_STREAM.subarray(0, 1500), DEFLATE_STREAM.subarray(1500, 3000), DEFLATE_STREAM.subarray(3000)],
        data: { name: 'stream.txt', date: DATE },
      },
    ],
    compare: 'Structure',
  },
  {
    name: 'zip20-stored',
    engine: 'zip20',
    options: () => ({ password: '123' }),
    entries: [
      { source: TEXT, data: { name: 'buffer.txt', date: DATE, store: true } },
      { source: [Buffer.from('this is a '), Buffer.from('text file')], data: { name: 'stream.txt', date: DATE, store: true } },
      { source: EMPTY, data: { name: 'd/', date: DATE } },
    ],
    compare: 'Bytes',
  },
  {
    name: 'aes-stored',
    engine: 'aes256',
    options: () => ({ password: '123', salt: Buffer.from(AES_SALT) }),
    entries: [
      { source: TEXT, data: { name: 'buffer.txt', date: DATE, store: true } },
      { source: [Buffer.from('this is a '), Buffer.from('text file')], data: { name: 'stream.txt', date: DATE, store: true } },
      { source: EMPTY, data: { name: 'd/', date: DATE } },
    ],
    compare: 'Bytes',
  },
];

// PORTING.md 14.3 (tar: every header field is set explicitly)
function tarHeader(fields) {
  return () => ({ uid: 0, gid: 0, size: 0, mtime: new Date(DATE.getTime()), uname: '', gname: '', devmajor: 0, devminor: 0, ...fields });
}

// PORTING.md 14.3 (tar: every header field is set explicitly)
function tarFile(name, body, fields) {
  return { header: tarHeader({ name, type: 'file', mode: 0o644, size: body.length, ...fields }), body };
}

// PORTING.md 10.6 (one row of the table per entry)
const tarMtimes = [
  ['2013', new Date('2013-01-03T14:26:38.999Z')],
  ['2038-max', new Date('2038-01-19T03:14:07Z')],
  ['2038-wrap', new Date('2038-01-19T03:14:08Z')],
  ['2080', new Date('2080-01-01T00:00:00Z')],
  ['2107', new Date('2107-01-01T00:00:00Z')],
  ['1969', new Date('1969-12-31T23:59:59Z')],
  ['minus-500ms', new Date(-500)],
  ['invalid', new Date(NaN)],
];

// PORTING.md 14.3 (the binding scenario list). `body` is a Buffer, or null for an entry
// type that takes no body.
const tarScenarios = [
  {
    name: 'tar-basic',
    entries: [
      tarFile('a.txt', TEXT),
      { header: tarHeader({ name: 'd/', type: 'directory', mode: 0o755 }), body: null },
      { header: tarHeader({ name: 'link', type: 'symlink', mode: 0o644, linkname: 'a.txt' }), body: null },
    ],
  },
  {
    name: 'tar-long-names',
    entries: [
      tarFile('a'.repeat(100), TEXT),
      tarFile('a'.repeat(101), TEXT),
      tarFile('p'.repeat(155) + '/' + 'n'.repeat(100), TEXT),
      tarFile('b'.repeat(149) + '/' + 'c'.repeat(150), TEXT),
      tarFile('é.txt', TEXT),
    ],
  },
  {
    name: 'tar-mtime',
    entries: tarMtimes.map(([name, mtime]) => tarFile(name + '.txt', EMPTY, { mtime })),
  },
  {
    name: 'tar-fields',
    entries: [
      tarFile('ids.txt', text(512, 'ids'), { uid: 1000, gid: 1001, uname: 'alice', gname: 'staff' }),
      tarFile('owners.txt', text(513, 'owners'), { uname: 'u'.repeat(40), gname: 'g'.repeat(40) }),
      { header: tarHeader({ name: 'dev', type: 'character-device', mode: 0o644, devmajor: 8 }), body: null },
      tarFile('pax.txt', TEXT, { pax: { comment: 'x' } }),
    ],
  },
];

// PORTING.md 14.3 (shared sanitizer vectors, R6). No input has a lone surrogate.
const sanitizeInputs = [
  '',
  '/',
  '\\',
  'a',
  '.',
  '..',
  'a/b',
  'a/b/',
  'a\\b',
  'a\\b\\',
  'a\\b//c/',
  'a//b\\\\c',
  'a/\\/\\b',
  '//',
  '\\\\',
  '///a',
  '/abs/path',
  '//server/share',
  '\\\\server\\share',
  '\\\\?\\',
  '\\\\?\\C:\\foo',
  '\\\\.\\dev\\null',
  '\\\\?/C:/foo',
  '\\\\?é\\x',
  '\\\\é\\x\\y',
  'é\\?\\x',
  'c:c:/x',
  'c:/x',
  'c:x',
  'C:\\Users\\x',
  'c:',
  ':a',
  'a:b:c',
  'word_1:rest',
  '_x:/y',
  '0:/y',
  'é:x',
  'a b:c',
  'a/c:d',
  'http://example.com/x',
  '../a',
  '../../a',
  '..\\..\\a',
  '/../a',
  '/../../a/../b',
  '../',
  '..a/b',
  '.../a',
  './a',
  './../a',
  'a/../b',
  'a/./b',
  'c:../a',
  'c:/../a',
  'c:\\..\\a',
  'x:y:/../z',
  'dir/',
  'dir\\',
  'dir//',
  'a b/c d',
  ' a',
  'a.txt',
  '.hidden',
  'é/ü.txt',
  'é\\ü\\',
  '日本語/ファイル.txt',
  '😀/x',
  '/😀',
  'a\nb/c',
  'a\tb\\c',
  'a"b/c',
  'file.tar.gz',
  'very/deep/tree/of/directories/with/a/file.txt',
];

// PORTING.md 14.3 (the upstream bytes of one scenario)
function collect(stream) {
  const chunks = [];
  stream.on('data', (chunk) => { chunks.push(chunk); });
  const done = new Promise((resolve, reject) => {
    stream.on('end', () => { resolve(Buffer.concat(chunks)); });
    stream.on('error', reject);
  });
  return done;
}

// PORTING.md 7.7 (resolveLevel)
function resolveLevel(options) {
  const level = options?.level;
  return typeof level === 'number' && !Number.isNaN(level) ? level : -1;
}

// PORTING.md 14.3: ZipEntryData as src/zip-stream/index.ts and _engineEntry (7.5, 7.6) hand it to Rust.
function marshalZipEntry(zip, entry) {
  const data = zip._normalizeFileData({ ...entry.data });
  if (data.name !== entry.data.name || zipStreamUtils.sanitizePath(data.name) !== data.name) {
    throw new Error(JSON.stringify(entry.data.name) + ' is not a fixed point of sanitizePath');
  }
  if (!(data.date instanceof Date) || entry.data.date !== data.date) {
    throw new Error(data.name + ': date must be a Date');
  }
  if (data.mode !== null && typeof data.mode !== 'number') {
    throw new Error(data.name + ': mode must be a number or absent');
  }
  let source = entry.source;
  // deps/zip-stream/index.js:137-148
  if (data.type === 'symlink' && typeof data.mode !== 'number') {
    data.mode = 40960;
  }
  if (typeof data.mode === 'number') {
    if (data.type === 'symlink') {
      data.mode |= 40960;
    }
  }
  if (data.type === 'symlink' && typeof data.linkname === 'string') {
    source = Buffer.from(data.linkname);
  }
  const d = data.date;
  return {
    name: data.name,
    date: [d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), d.getUTCHours(), d.getUTCMinutes(), d.getUTCSeconds()],
    namePrependSlash: !!data.namePrependSlash,
    store: !!data.store,
    comment: data.comment.length > 0 ? data.comment : '',
    mode: typeof data.mode === 'number' ? data.mode : null,
    payload: source,
  };
}

// PORTING.md 14.3 (a chunk array is given to upstream as a stream)
function toSource(source) {
  if (!Array.isArray(source)) {
    return source;
  }
  const stream = new PassThrough();
  for (const chunk of source) {
    stream.write(chunk);
  }
  stream.end();
  return stream;
}

// PORTING.md 14.3: new ZipStream(options), entry(source, data, callback), finalize()
async function captureZip(scenario) {
  const options = scenario.options();
  const zip = scenario.engine === 'aes256' ? new ZipAesStream(options)
    : scenario.engine === 'zip20' ? new ZipCryptoStream(options)
      : new ZipStream(options);
  const output = collect(zip);
  const entries = [];
  for (const entry of scenario.entries) {
    entries.push(marshalZipEntry(zip, entry));
    await new Promise((resolve, reject) => {
      zip.entry(toSource(entry.source), { ...entry.data }, (err) => {
        if (err) { reject(err); } else { resolve(); }
      });
    });
  }
  zip.finalize();
  const expected = await output;
  const salt = zip.options.salt;
  return {
    name: scenario.name,
    encryption: scenario.engine === 'aes256' ? 2 : scenario.engine === 'zip20' ? 1 : 0,
    forceZip64: !!zip.options.forceZip64,
    level: resolveLevel(zip.options.zlib),
    archiveComment: zip.getComment(),
    key: scenario.engine === 'plain' ? EMPTY : zip.key,
    random: scenario.engine === 'aes256' ? (Buffer.isBuffer(salt) ? salt : Buffer.from(salt))
      : scenario.engine === 'zip20' ? ZIP20_HEADER
        : EMPTY,
    entries,
    compare: scenario.compare,
    expected,
  };
}

// PORTING.md 14.2 (the stub returns the same fixed bytes for every call of length 12)
async function withFixedZip20Header(run) {
  const randomBytes = crypto.randomBytes;
  crypto.randomBytes = function (size, ...rest) {
    if (size === 12) {
      return Buffer.from(ZIP20_HEADER);
    }
    return randomBytes.call(this, size, ...rest);
  };
  try {
    return await run();
  } finally {
    crypto.randomBytes = randomBytes;
  }
}

// PORTING.md 7.8 (the arguments of the _encode call)
function marshalTarEntry(header, body) {
  const pax = header.pax;
  let records = null;
  if (pax) {
    records = [];
    for (const key in pax) records.push(' ' + key + '=' + pax[key] + '\n');
  }
  return {
    header: {
      name: header.name,
      typeflagIs5: header.typeflag === 5,
      mode: header.mode | 0,
      uidOct: header.uid.toString(8),
      gidOct: header.gid.toString(8),
      size: header.size,
      sizeOct: header.size.toString(8),
      mtime: header.mtime.getTime(),
      type: typeof header.type === 'string' ? header.type : '',
      linkname: header.linkname ? header.linkname : null,
      uname: header.uname ? header.uname : null,
      gname: header.gname ? header.gname : null,
      devmajorOct: (header.devmajor || 0).toString(8),
      devminorOct: (header.devminor || 0).toString(8),
    },
    pax: records,
    body: body === null ? EMPTY : body,
  };
}

// PORTING.md 14.3: pack(), entry(header, body, callback), finalize()
async function captureTar(scenario) {
  const pack = tarPack();
  const output = collect(pack);
  const entries = [];
  for (const entry of scenario.entries) {
    const header = entry.header();
    await new Promise((resolve, reject) => {
      pack.entry(header, entry.body, (err) => {
        if (err) { reject(err); } else { resolve(); }
      });
      entries.push(marshalTarEntry(header, entry.body));
    });
  }
  pack.finalize();
  return { name: scenario.name, entries, expected: await output };
}

// PORTING.md 14.3 (generated Rust tables)
function rustStr(s) {
  let out = '"';
  for (const ch of s) {
    const code = ch.codePointAt(0);
    if (code >= 0xd800 && code <= 0xdfff) {
      throw new Error('lone surrogate in ' + JSON.stringify(s));
    }
    if (ch === '\\' || ch === '"') {
      out += '\\' + ch;
    } else if (code >= 0x20 && code < 0x7f) {
      out += ch;
    } else {
      out += '\\u{' + code.toString(16) + '}';
    }
  }
  return out + '"';
}

// PORTING.md 14.3 (generated Rust tables)
function rustBytes(buf) {
  let out = 'b"';
  for (const byte of buf) {
    if (byte === 0x5c || byte === 0x22) {
      out += '\\' + String.fromCharCode(byte);
    } else if (byte === 0x0a) {
      out += '\\n';
    } else if (byte >= 0x20 && byte < 0x7f) {
      out += String.fromCharCode(byte);
    } else {
      out += '\\x' + byte.toString(16).padStart(2, '0');
    }
  }
  return out + '"';
}

// PORTING.md 14.3 (generated Rust tables)
function rustF64(n) {
  if (Number.isNaN(n)) {
    return 'f64::NAN';
  }
  if (!Number.isFinite(n)) {
    throw new Error('no infinite value is expected in a scenario');
  }
  return Number.isInteger(n) ? n + '.0' : String(n);
}

// PORTING.md 14.3 (generated Rust tables)
function rustI32(n) {
  if (!Number.isInteger(n) || n < -2147483648 || n > 2147483647) {
    throw new Error(n + ' is not an i32');
  }
  return String(n);
}

// PORTING.md 14.3 (generated Rust tables)
function rustOption(value, format) {
  return value === null ? 'None' : 'Some(' + format(value) + ')';
}

// PORTING.md 14.3 (generated Rust tables)
function rustPayload(payload) {
  if (Array.isArray(payload)) {
    return 'Payload::Stream(&[' + payload.map((chunk) => rustBytes(chunk) + ' as &[u8]').join(', ') + '])';
  }
  return 'Payload::Buffer(' + rustBytes(payload) + ')';
}

// PORTING.md 14.3 (generated Rust tables)
function rustZipScenario(s) {
  const lines = [];
  lines.push('    ZipScenario {');
  lines.push('        name: ' + rustStr(s.name) + ',');
  lines.push('        encryption: ' + s.encryption + ',');
  lines.push('        force_zip64: ' + s.forceZip64 + ',');
  lines.push('        level: ' + rustI32(s.level) + ',');
  lines.push('        archive_comment: ' + rustStr(s.archiveComment) + ',');
  lines.push('        key: ' + rustBytes(s.key) + ',');
  lines.push('        random: ' + rustBytes(s.random) + ',');
  lines.push('        entries: &[');
  for (const e of s.entries) {
    lines.push('            ZipEntry {');
    lines.push('                name: ' + rustStr(e.name) + ',');
    lines.push('                date: [' + e.date.map(rustF64).join(', ') + '],');
    lines.push('                name_prepend_slash: ' + e.namePrependSlash + ',');
    lines.push('                store: ' + e.store + ',');
    lines.push('                comment: ' + rustStr(e.comment) + ',');
    lines.push('                mode: ' + rustOption(e.mode, rustI32) + ',');
    lines.push('                payload: ' + rustPayload(e.payload) + ',');
    lines.push('            },');
  }
  lines.push('        ],');
  lines.push('        compare: Compare::' + s.compare + ',');
  lines.push('        expected: include_bytes!(' + rustStr(s.name + '.bin') + '),');
  lines.push('    },');
  return lines;
}

// PORTING.md 14.3 (generated Rust tables)
function rustTarScenario(s) {
  const lines = [];
  lines.push('    TarScenario {');
  lines.push('        name: ' + rustStr(s.name) + ',');
  lines.push('        entries: &[');
  for (const e of s.entries) {
    const h = e.header;
    lines.push('            TarEntry {');
    lines.push('                header: TarHeader {');
    lines.push('                    name: ' + rustStr(h.name) + ',');
    lines.push('                    typeflag_is_5: ' + h.typeflagIs5 + ',');
    lines.push('                    mode: ' + rustI32(h.mode) + ',');
    lines.push('                    uid_oct: ' + rustStr(h.uidOct) + ',');
    lines.push('                    gid_oct: ' + rustStr(h.gidOct) + ',');
    lines.push('                    size: ' + rustF64(h.size) + ',');
    lines.push('                    size_oct: ' + rustStr(h.sizeOct) + ',');
    lines.push('                    mtime: ' + rustF64(h.mtime) + ',');
    lines.push('                    type_: ' + rustStr(h.type) + ',');
    lines.push('                    linkname: ' + rustOption(h.linkname, rustStr) + ',');
    lines.push('                    uname: ' + rustOption(h.uname, rustStr) + ',');
    lines.push('                    gname: ' + rustOption(h.gname, rustStr) + ',');
    lines.push('                    devmajor_oct: ' + rustStr(h.devmajorOct) + ',');
    lines.push('                    devminor_oct: ' + rustStr(h.devminorOct) + ',');
    lines.push('                },');
    lines.push('                pax: ' + rustOption(e.pax, (records) => '&[' + records.map(rustStr).join(', ') + ']') + ',');
    lines.push('                body: ' + rustBytes(e.body) + ',');
    lines.push('            },');
  }
  lines.push('        ],');
  lines.push('        expected: include_bytes!(' + rustStr(s.name + '.bin') + '),');
  lines.push('    },');
  return lines;
}

const GENERATED = '// Generated by scripts/capture-golden.mjs from the upstream packages (PORTING.md 14.3). Do not edit.';

const zipResults = [];
for (const scenario of zipScenarios) {
  zipResults.push(scenario.engine === 'zip20'
    ? await withFixedZip20Header(() => captureZip(scenario))
    : await captureZip(scenario));
}
const tarResults = [];
for (const scenario of tarScenarios) {
  tarResults.push(await captureTar(scenario));
}

// PORTING.md 14.3: rows [input, normalizePath(input, false), sanitizePath(input)]
const sanitizeVectors = sanitizeInputs.map((input) => {
  const sanitized = zipStreamUtils.sanitizePath(input);
  if (archiverUtils.sanitizePath(input) !== sanitized) {
    throw new Error('the upstream sanitizePath copies disagree on ' + JSON.stringify(input));
  }
  return [input, normalizePath(input, false), sanitized];
});

fs.mkdirSync(goldenDir, { recursive: true });
fs.mkdirSync(vectorsDir, { recursive: true });

for (const result of [...zipResults, ...tarResults]) {
  fs.writeFileSync(path.join(goldenDir, result.name + '.bin'), result.expected);
}

fs.writeFileSync(path.join(goldenDir, 'scenarios.rs'), [
  GENERATED,
  'use super::{Compare, Payload, TarEntry, TarHeader, TarScenario, ZipEntry, ZipScenario};',
  '',
  'pub const UPSTREAM_VERSIONS: &[(&str, &str)] = &[',
  ...upstreamVersions.map(([name, v]) => '    (' + rustStr(name) + ', ' + rustStr(v) + '),'),
  '];',
  '',
  'pub const ZIP_SCENARIOS: &[ZipScenario] = &[',
  ...zipResults.flatMap(rustZipScenario),
  '];',
  '',
  'pub const TAR_SCENARIOS: &[TarScenario] = &[',
  ...tarResults.flatMap(rustTarScenario),
  '];',
  '',
].join('\n'));

fs.writeFileSync(path.join(goldenDir, 'sanitize_path_vectors.rs'), [
  GENERATED,
  'pub const SANITIZE_PATH_VECTORS: &[(&str, &str, &str)] = &[',
  ...sanitizeVectors.map((row) => '    (' + row.map(rustStr).join(', ') + '),'),
  '];',
  '',
].join('\n'));

fs.writeFileSync(path.join(vectorsDir, 'sanitize-path.json'),
  '[\n' + sanitizeVectors.map((row) => '  ' + JSON.stringify(row)).join(',\n') + '\n]\n');

console.log('captured ' + zipResults.length + ' zip scenarios, ' + tarResults.length + ' tar scenarios and '
  + sanitizeVectors.length + ' sanitizer vectors');
