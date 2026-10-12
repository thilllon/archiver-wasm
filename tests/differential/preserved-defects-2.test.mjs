// PORTING.md 14.2: cases D9 to D17 (the preserved upstream defects P24 to P32 of 3.3). No upstream source.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { once } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { omitV15Keys, selectEvents, summarizeError } from './helpers/events.mjs';
import { HANG_QUIET_MS, load, runBoth, runBothInChild, scenarioReference } from './helpers/run-both.mjs';
import { parseTar } from './helpers/tar-records.mjs';
import { parseZip } from './helpers/zip-records.mjs';

const DATE = new Date('2013-01-03T14:26:38.000Z');
// tar symlink() entries read the clock (P10)
const CLOCK = new Date('2021-07-04T09:08:07.000Z');
const PASSWORD = '123';
const SALT_HEX = '000102030405060708090a0b0c0d0e0f';
const ZIP20_HEADER = Buffer.from('a0a1a2a3a4a5a6a7a8a9aaab', 'hex');
// the uncaught exceptions of D14 follow the 'error' events within this
const SETTLE_MS = 300;
// D14: the bound of the wait for the two uncaught exceptions on a loaded machine
const UNCAUGHT_WAIT_MS = 10000;
// D15: long enough for a stream that is not stalled to read the whole file and close it
const LEAK_WAIT_MS = 400;
const CLOSE_WAIT_MS = 15000;
const CHILD_TIMEOUT_MS = 30000;
const TEST_TIMEOUT_MS = 2 * CHILD_TIMEOUT_MS + 5000;
// D15: incompressible, and more than every buffer between the file and a consumer that is gone
const LEAK_FILE_SIZE = 16 * 1024 * 1024;
const MAX_FD = 64;

// PORTING.md 14.2 (comparison rules: stored zip, stored encrypted zip and tar are compared as whole archives)
const STORED = {
  zip: { format: 'zip', options: () => ({ store: true }) },
  aes256: { format: 'aes256', options: () => ({ password: PASSWORD, salt: Buffer.from(SALT_HEX, 'hex'), store: true }) },
  zip20: { format: 'zip20', options: () => ({ password: PASSWORD, store: true }) },
  tar: { format: 'tar', options: () => ({}) },
  json: { format: 'json', options: () => ({}) },
};
const ENCRYPTED = ['aes256', 'zip20'];

// PORTING.md 14.2 (D15: the engines that stream a file entry; a child process receives its arguments as JSON)
const STREAMING = {
  'zip, deflated': { format: 'zip', options: () => ({}) },
  'zip, stored': { format: 'zip', options: () => ({ store: true }) },
  aes256: { format: 'aes256', options: () => ({ password: PASSWORD, salt: Buffer.from(SALT_HEX, 'hex') }) },
  'tar.gz': { format: 'tar.gz', options: () => ({}) },
};

// deps/compress-commons/lib/archivers/zip/util.js:45-49 (getShortBytes: the length modulo 65536)
const P24_TEXTS = [
  { label: 'a name of 65535 bytes (the last length that fits)', name: ['a', 65535] },
  { label: 'a name of 65536 bytes (length field 0)', name: ['a', 65536] },
  { label: 'a name of 70000 bytes', name: ['a', 70000] },
  { label: 'a non-ASCII name of 70002 bytes', name: ['\u20ac', 23334] },
  { label: 'an entry comment of 70000 bytes', comment: ['k', 70000] },
  { label: 'a non-ASCII entry comment of 70002 bytes', comment: ['\u20ac', 23334] },
  { label: 'an archive comment of 70000 bytes', archiveComment: ['c', 70000] },
  { label: 'a non-ASCII archive comment of 70002 bytes', archiveComment: ['\u20ac', 23334] },
  { label: 'name, entry comment and archive comment of 70000 bytes each', name: ['a', 70000], comment: ['k', 70000], archiveComment: ['c', 70000] },
];

// node-archiver/lib/utils.js:58-62 (P27: what sanitizePath leaves in a name), with the expected entry name
const P27_NAMES = [
  [{ name: 'a/../../b.txt' }, 'a/../../b.txt'],
  [{ name: 'x/./y/../z.txt' }, 'x/./y/../z.txt'],
  [{ name: '..' }, '..'],
  [{ name: '../../../up.txt' }, 'up.txt'],
  [{ name: '/abs.txt' }, 'abs.txt'],
  [{ name: 'C:\\win\\..\\..\\f.txt' }, 'win/../../f.txt'],
  [{ name: 'c:/drive.txt' }, 'drive.txt'],
  [{ name: 'c:/drive.txt', prefix: 'p' }, 'p/c:/drive.txt'],
  [{ name: '../../up.txt', prefix: 'p' }, 'p/../../up.txt'],
  [{ name: '/abs.txt', prefix: '../q' }, 'q/abs.txt'],
];

// node-archiver/lib/core.js:772-779 (P27: symlink() sanitizes neither its name nor its target): name, target,
// mode, and the name zip-stream writes (deps/zip-stream/index.js:71: its own sanitizePath, for zip only)
const P27_LINKS = [
  ['../../evil-link', '/etc/passwd', undefined, 'evil-link'],
  ['/abs-link', '../../../outside', undefined, 'abs-link'],
  ['c:\\drive-link', 'c:\\target', 0o777, 'drive-link'],
  ['a/../../b-link', 'x/../../y', undefined, 'a/../../b-link'],
];

// PORTING.md 14.2 (helper of the test: what follows a call that leaves no promise to await)
function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// PORTING.md 14.2 (helper of the test: one turn of the event loop)
function immediate() {
  return new Promise((resolve) => setImmediate(resolve));
}

// PORTING.md 14.2 (helper of the test: a text given as [unit, count])
function text(pair) {
  return pair === undefined ? undefined : pair[0].repeat(pair[1]);
}

// deps/compress-commons/lib/archivers/zip/zip-archive-output-stream.js:190-193, 268-293, 325-351 (P24)
async function longTexts(impl, ctx) {
  const { kind, name, comment, archiveComment } = ctx.args;
  const options = STORED[kind].options();
  if (archiveComment !== undefined) {
    options.comment = text(archiveComment);
  }
  const archive = ctx.create(STORED[kind].format, options);
  const data = { name: name === undefined ? 'first.txt' : text(name), date: DATE };
  if (comment !== undefined) {
    data.comment = text(comment);
  }
  archive.append('hi', data);
  archive.append('yo', { name: 'second.txt', date: DATE });
  await archive.finalize();
}

// deps/tar-stream/headers.js:57, 69, 78 (P25: a NUL is ASCII, so the name passes the length test and is written as it is)
async function nulInTarNames(impl, ctx) {
  const archive = ctx.create('tar');
  archive.append('one', { name: 'a\0b.txt', date: DATE });
  archive.append('two', { name: 'dir/c.txt\0', date: DATE });
  archive.symlink('link\0name', 'tar\0get');
  archive.symlink('plain-link', '\0hidden');
  await archive.finalize();
}

// deps/tar-stream/headers.js:59-64 (P26: one segment per iteration, the rest of the name copied each time)
async function manySeparators(impl, ctx) {
  const archive = ctx.create('tar');
  for (const name of ctx.args.names) {
    archive.append('x', { name: text(name.segments) + name.last, date: DATE });
  }
  await archive.finalize();
}

// node-archiver/lib/core.js:271-276, 772-779 (P27)
async function unsanitizedNames(impl, ctx) {
  const kind = STORED[ctx.args.kind];
  const archive = ctx.create(kind.format, kind.options());
  for (const [data] of P27_NAMES) {
    archive.append('x', { ...data, date: DATE });
  }
  for (const [name, target, mode] of P27_LINKS) {
    archive.symlink(name, target, mode);
  }
  await archive.finalize();
}

// deps/readdir-glob/src/index.ts:83-90 (P28: with `follow` a link to a directory is a directory, every time)
async function followedCycle(impl, ctx) {
  const archive = ctx.create(ctx.args.format, ctx.args.options);
  archive.glob('**', { cwd: ctx.args.dir, follow: true }, { date: DATE });
  await archive.finalize();
}

// node-archiver/lib/plugins/tar.js:64-69, deps/tar-stream/pack.js:101-103, 114, 138 (P29). The runner's
// handler ends the child at the first uncaught exception; this scenario has two to record.
export async function sizeMismatch(impl, ctx) {
  const uncaught = [];
  process.removeAllListeners('uncaughtException');
  process.on('uncaughtException', (err) => {
    uncaught.push(summarizeError(err));
  });
  fs.writeFileSync(ctx.args.file, Buffer.alloc(ctx.args.statSize, 65));
  const stats = fs.lstatSync(ctx.args.file);
  fs.writeFileSync(ctx.args.file, Buffer.alloc(ctx.args.realSize, 66));
  const archive = ctx.create(ctx.args.format);
  // The end of the file destroys the pack, and with it the gzip stream (streamx index.js:529), while the
  // tar header is still inside the compressor: zlib.Gzip answers that write from the thread pool, so
  // upstream drops the 10 bytes of the gzip header whenever fs.open and fs.read are answered first
  // (issue #20). The file is opened only after the first chunk has left the archive, which leaves one
  // order: the header, then the error.
  const headerWritten = new Promise((resolve) => {
    archive.once('data', resolve);
  });
  const open = fs.open;
  fs.open = function (target, ...rest) {
    if (target !== ctx.args.file) {
      return open.call(this, target, ...rest);
    }
    const callback = rest.pop();
    return open.call(this, target, ...rest, (...answer) => {
      headerWritten.then(() => callback(...answer));
    });
  };
  archive.file(ctx.args.file, { name: 'changed.bin', date: DATE, stats });
  archive.append('after', { name: 'after.txt', date: DATE });
  ctx.watch('finalize', archive.finalize());
  // a starved child does not reach the error within SETTLE_MS: wait for both exceptions, then for a third
  const deadline = Date.now() + UNCAUGHT_WAIT_MS;
  while (uncaught.length < 2 && Date.now() < deadline) {
    await delay(10);
  }
  await delay(SETTLE_MS);
  fs.open = open;
  return { uncaught };
}

// PORTING.md 14.2 (helper of the test: how many descriptors of this process are open on the file, by inode)
function descriptorsOn(file) {
  const target = fs.statSync(file);
  let count = 0;
  for (let fd = 3; fd < MAX_FD; fd++) {
    let stats;
    try {
      stats = fs.fstatSync(fd);
    } catch {
      continue;
    }
    if (stats.ino === target.ino && stats.dev === target.dev) {
      count += 1;
    }
  }
  return count;
}

// node-archiver/lib/core.js:70-77, 457-459 (P30: destroy() is the one of the Transform; nothing reaches the
// engine or the lazily opened fs.ReadStream. abort() lets the entry in progress end, core.js:174-177)
export async function destroyedWhileReading(impl, ctx) {
  const kind = STREAMING[ctx.args.kind];
  const archive = ctx.create(kind.format, kind.options());
  archive.file(ctx.args.file, { name: 'big.bin', date: DATE });
  ctx.watch('finalize', archive.finalize());
  const started = Date.now();
  while (descriptorsOn(ctx.args.file) === 0 && Date.now() - started < CLOSE_WAIT_MS) {
    await immediate();
  }
  const whileReading = descriptorsOn(ctx.args.file);
  if (ctx.args.how === 'destroy') {
    archive.destroy();
    await delay(LEAK_WAIT_MS);
  } else {
    // the shutdown follows the end of the entry: 'close' is the last thing that happens
    const closed = once(archive, 'close');
    archive.abort();
    await Promise.race([closed, delay(CLOSE_WAIT_MS)]);
    // fs.close runs on the thread pool, so the descriptor can outlive 'close' by a few turns
    const closing = Date.now();
    while (descriptorsOn(ctx.args.file) !== 0 && Date.now() - closing < CLOSE_WAIT_MS) {
      await immediate();
    }
  }
  const engine = archive._module.engine;
  return {
    whileReading,
    afterwards: descriptorsOn(ctx.args.file),
    archiveDestroyed: archive.destroyed,
    engineDestroyed: engine.destroyed,
  };
}

// archiver-zip-encrypted/node_modules/archiver/index.js:20-78 (P31: `formats[format]` also finds what
// Object.prototype has)
async function prototypeKeysInTheRegistry(impl, ctx) {
  class Module {
    append() {}

    finalize() {}
  }
  const outcome = (call) => {
    try {
      const value = call();
      return { returned: typeof value };
    } catch (err) {
      return { thrown: summarizeError(err) };
    }
  };
  return ctx.args.keys.map((key) => ({
    key,
    isRegisteredFormat: outcome(() => impl.archiver.isRegisteredFormat(key)),
    isRegistered: impl.archiver.isRegisteredFormat(key),
    create: outcome(() => impl.archiver.create(key, {})),
    call: outcome(() => impl.archiver(key, {})),
    registerFormat: outcome(() => impl.archiver.registerFormat(key, Module)),
    isRegisteredAfterwards: impl.archiver.isRegisteredFormat(key),
  }));
}

// node-archiver/lib/core.js:70-77, 174-180, 208 (P32: _abort() finds the queue busy, and the task callback
// that would call _shutdown() was the one that already ran)
async function abortAfterTurns(impl, ctx) {
  const archive = ctx.create(ctx.args.format, ctx.args.options);
  archive.append('x', { name: 'x.txt', date: DATE });
  for (let i = 0; i < ctx.args.turns; i++) {
    await immediate();
  }
  const state = { ...archive._state };
  const returnsThis = archive.abort() === archive;
  return { state, returnsThis };
}

// PORTING.md 14.2 (helpers/events.mjs: own enumerable keys in order, which deepStrictEqual does not compare)
function ordered(value) {
  return JSON.stringify(value, (key, item) => (item === undefined ? '[undefined]' : item));
}

// PORTING.md 14.2 (events: for aes256 and zip20 the keys only the archiver 7 stack writes are ignored, V15)
function comparedEvents(kind, run) {
  const selected = selectEvents(run.events);
  return ENCRYPTED.includes(kind) ? omitV15Keys(selected) : selected;
}

// PORTING.md 14.2 (comparison rules: whole-archive byte equality, the event sequence and pointer())
function assertSameArchive(kind, { upstream, port }) {
  assert.equal(upstream.error, null, 'upstream: the scenario threw');
  assert.equal(port.error, null, 'port: the scenario threw');
  assert.deepStrictEqual(selectEvents(upstream.events, ['error', 'warning']), []);
  assert.deepStrictEqual(comparedEvents(kind, port), comparedEvents(kind, upstream));
  if (!ENCRYPTED.includes(kind)) {
    assert.equal(ordered(port.events), ordered(upstream.events), 'key order of the event payloads');
  }
  assert.equal(port.bytes.length, upstream.bytes.length, 'archive length');
  assert.ok(port.bytes.equals(upstream.bytes), 'the archives differ');
  assert.equal(port.pointer, upstream.pointer);
  assert.equal(port.pointer, port.bytes.length);
}

// PORTING.md 14.2 (helper of the test: the names of the 'entry' events, in order)
function entryNames(run) {
  return selectEvents(run.events, ['entry']).map((record) => record.payload.name);
}

// PORTING.md 14.2 (helper of the test: the names of the recorded events, in order)
function eventNames(run) {
  return run.events.map((record) => record.event);
}

// PORTING.md 17.1 (the 16-bit length fields of the first local header, of the first central header and of the
// end record, read at their offsets: a parser would follow the wrapped lengths)
function lengthFields(bytes, archiveCommentBytes) {
  const end = bytes.length - 22 - archiveCommentBytes;
  assert.equal(bytes.readUInt32LE(0), 0x04034b50, 'local header signature');
  assert.equal(bytes.readUInt32LE(end), 0x06054b50, 'end record signature');
  const central = bytes.readUInt32LE(end + 16);
  assert.equal(bytes.readUInt32LE(central), 0x02014b50, 'central header signature');
  return {
    localName: bytes.readUInt16LE(26),
    centralName: bytes.readUInt16LE(central + 28),
    centralComment: bytes.readUInt16LE(central + 32),
    archiveComment: bytes.readUInt16LE(end + 20),
  };
}

describe('differential: preserved defects (PORTING.md 14.2, D9 to D17)', function () {
  let root;

  before(async function () {
    await load('upstream');
    await load('port');
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'archiver-wasm-diff-defects-2-')));
  });

  after(function () {
    fs.rmSync(root, { recursive: true, force: true });
  });

  describe('D9: zip lengths over 65535 bytes are written modulo 65536, with every byte (P24)', function () {
    for (const kind of ['zip', 'aes256', 'zip20']) {
      for (const texts of P24_TEXTS) {
        it(`${kind}, stored: ${texts.label}`, async function () {
          const { label, ...args } = texts;
          const runs = await runBoth(longTexts, { args: { kind, ...args }, random: ZIP20_HEADER });
          assertSameArchive(kind, runs);
          assert.equal(entryNames(runs.upstream).length, 2);
          const bytesOf = (pair) => (pair === undefined ? 0 : Buffer.byteLength(text(pair)));
          const name = args.name === undefined ? 'first.txt'.length : bytesOf(args.name);
          const comment = bytesOf(args.comment);
          const archiveComment = bytesOf(args.archiveComment);
          const fields = lengthFields(runs.upstream.bytes, archiveComment);
          assert.deepStrictEqual(fields, {
            localName: name % 65536,
            centralName: name % 65536,
            centralComment: comment % 65536,
            archiveComment: archiveComment % 65536,
          });
          // no byte is dropped: the name twice, each comment once
          assert.ok(runs.upstream.bytes.length > 2 * name + comment + archiveComment);
          if (args.name !== undefined) {
            assert.deepStrictEqual(runs.upstream.bytes.subarray(30, 30 + name), Buffer.from(text(args.name)));
          }
          if (args.archiveComment !== undefined) {
            assert.deepStrictEqual(
              runs.upstream.bytes.subarray(runs.upstream.bytes.length - archiveComment),
              Buffer.from(text(args.archiveComment))
            );
          }
        });
      }
    }
  });

  describe('D10: a NUL character in a tar name or linkname is written into the ustar field (P25)', function () {
    it('tar: the fields hold the NUL, a reader sees the name cut there', async function () {
      const runs = await runBoth(nulInTarNames, { clock: CLOCK });
      assertSameArchive('tar', runs);
      assert.deepStrictEqual(entryNames(runs.upstream), ['a\0b.txt', 'dir/c.txt\0', 'link\0name', 'plain-link']);
      for (const run of [runs.upstream, runs.port]) {
        const tar = parseTar(run.bytes);
        assert.equal(tar.entries.length, 4);
        // no pax header: the names are ASCII and short
        assert.deepStrictEqual(tar.entries.map((entry) => entry.pax), [null, null, null, null]);
        const field = (index, name, length) => tar.entries[index].header.raw[name].subarray(0, length).toString('latin1');
        assert.equal(field(0, 'name', 9), 'a\0b.txt\0\0');
        assert.equal(field(1, 'name', 11), 'dir/c.txt\0\0');
        assert.equal(field(2, 'name', 10), 'link\0name\0');
        assert.equal(field(2, 'linkname', 8), 'tar\0get\0');
        assert.equal(field(3, 'linkname', 8), '\0hidden\0');
        // what a reader that stops at the first NUL takes them for
        assert.deepStrictEqual(tar.entries.map((entry) => entry.header.name), ['a', 'dir/c.txt', 'link', 'plain-link']);
        assert.deepStrictEqual(tar.entries.map((entry) => entry.header.linkname), ['', '', 'tar', '']);
        assert.deepStrictEqual(tar.entries.map((entry) => entry.header.checksumValid), [true, true, true, true]);
      }
    });
  });

  describe('D11: the tar name/prefix split takes one segment per iteration (P26)', function () {
    // the bounded instance: the loop is quadratic in the number of separators, 16000 of them take milliseconds
    const names = [
      // the split succeeds after 28 iterations: a prefix of 55 bytes, a name of 100
      { segments: ['a/', 28], last: 'x'.repeat(100) },
      // the prefix grows past 155 bytes before the rest fits: a pax header
      { segments: ['a/', 90], last: 'x'.repeat(100) },
      { segments: ['ab/', 2000], last: 'f.txt' },
      { segments: ['ab/', 16000], last: 'f.txt' },
      // no separator at all: the loop ends at once
      { segments: ['x', 300], last: '' },
    ];

    it('tar: names of up to 16000 segments give the same headers as upstream', async function () {
      const runs = await runBoth(manySeparators, { args: { names } });
      assertSameArchive('tar', runs);
      const tar = parseTar(runs.port.bytes);
      assert.equal(tar.entries.length, names.length);
      assert.equal(tar.entries[0].pax, null);
      assert.equal(tar.entries[0].header.prefix, 'a/'.repeat(28).slice(0, -1));
      assert.equal(tar.entries[0].header.name, 'x'.repeat(100));
      for (let i = 1; i < names.length; i++) {
        assert.notEqual(tar.entries[i].pax, null, `entry ${i}: pax header`);
        assert.equal(tar.entries[i].pax.values.path, text(names[i].segments) + names[i].last);
      }
    });
  });

  describe('D12: sanitizePath strips only what leads a name, symlink() strips nothing (P27)', function () {
    for (const kind of Object.keys(STORED)) {
      it(`${kind}: interior '..' segments, a drive letter behind a prefix, unsanitized links`, async function () {
        const runs = await runBoth(unsanitizedNames, { args: { kind }, clock: CLOCK, random: ZIP20_HEADER });
        const raw = P27_LINKS.map(([name]) => name.replace(/\\/g, '/'));
        const written = P27_LINKS.map(([, , , name]) => name);
        const appended = P27_NAMES.map(([, name]) => name);
        if (ENCRYPTED.includes(kind)) {
          // PORTING.md 3.2 V15 (a): zip-stream 6 writes its sanitized name onto the entry data
          // (archiver-zip-encrypted/node_modules/zip-stream/index.js:77), which archiver 7 then emits;
          // zip-stream 7 works on a copy, so port emits the name symlink() was given. The bytes are equal.
          assert.deepStrictEqual(entryNames(runs.upstream), [...appended, ...written]);
          assert.deepStrictEqual(entryNames(runs.port), [...appended, ...raw]);
          const events = runs.port.events.map((record) => {
            const isLink = record.event === 'entry' && record.payload.type === 'symlink';
            return isLink
              ? { event: record.event, payload: { ...record.payload, name: written[raw.indexOf(record.payload.name)] } }
              : record;
          });
          assertSameArchive(kind, { upstream: runs.upstream, port: { ...runs.port, events } });
        } else {
          assertSameArchive(kind, runs);
          assert.deepStrictEqual(entryNames(runs.upstream), [...appended, ...raw]);
          assert.deepStrictEqual(entryNames(runs.port), [...appended, ...raw]);
        }
        if (kind === 'zip') {
          // zip-stream sanitizes what archiver core did not: only the leading parts go
          const names = parseZip(runs.upstream.bytes).entries.map((entry) => entry.name);
          assert.deepStrictEqual(names, [...appended, ...written]);
        } else if (kind === 'tar') {
          const tar = parseTar(runs.upstream.bytes);
          assert.deepStrictEqual(tar.entries.map((entry) => entry.name), [...appended, ...raw]);
        } else if (kind === 'json') {
          const entries = JSON.parse(runs.upstream.bytes.toString('utf8'));
          assert.deepStrictEqual(entries.map((entry) => entry.name), [...appended, ...raw]);
        }
        const links = selectEvents(runs.upstream.events, ['entry'])
          .filter((record) => record.payload.type === 'symlink')
          .map((record) => record.payload.linkname);
        assert.deepStrictEqual(links, P27_LINKS.map(([, target]) => target.replace(/\\/g, '/')));
      });
    }
  });

  describe('D13: readdir-glob with follow: true has no visited set (P28)', function () {
    // the bounded instance: one link that points back into the tree is walked until the OS answers ELOOP,
    // which is linear; every further link doubles the walk
    let dir;

    before(function () {
      dir = path.join(root, 'd13');
      fs.mkdirSync(dir);
      fs.writeFileSync(path.join(dir, 'f.txt'), 'f');
      fs.symlinkSync('.', path.join(dir, 'loop'));
    });

    for (const [format, options] of [['zip', { store: true }], ['tar', {}], ['json', {}]]) {
      it(`${format}: a link to its own directory is descended into until ELOOP`, async function () {
        const runs = await runBoth(followedCycle, { args: { dir, format, options } });
        assert.equal(runs.upstream.error, null);
        assert.equal(runs.port.error, null);
        assert.deepStrictEqual(selectEvents(runs.upstream.events, ['error', 'warning']), []);
        assert.deepStrictEqual(selectEvents(runs.port.events), selectEvents(runs.upstream.events));
        assert.equal(ordered(runs.port.events), ordered(runs.upstream.events), 'key order of the event payloads');
        const names = entryNames(runs.upstream);
        // f.txt at every depth, a directory entry for every followed link, and the link the OS refused last
        const depth = (names.length - 2) / 2;
        assert.ok(Number.isInteger(depth) && depth >= 8, `depth of the walk: ${depth}`);
        const expected = [];
        for (let i = 0; i < depth; i++) {
          expected.push('loop/'.repeat(i) + 'f.txt', 'loop/'.repeat(i + 1));
        }
        expected.push('loop/'.repeat(depth) + 'f.txt', 'loop/'.repeat(depth) + 'loop');
        assert.deepStrictEqual(names, expected);
        assert.deepStrictEqual(entryNames(runs.port), expected);
        if (format !== 'json') {
          // the json plugin writes the access times of the stats
          assert.ok(runs.port.bytes.equals(runs.upstream.bytes), 'the archives differ');
        }
        assert.equal(runs.port.pointer, runs.upstream.pointer);
      });
    }
  });

  describe("D14: a file whose size differs from its lstat size in the tar-with-stats path (P29)", function () {
    this.timeout(TEST_TIMEOUT_MS);
    const SIZE_MISMATCH = { name: 'Error', code: undefined, message: 'Size mismatch', data: undefined };
    const cases = [
      ['shorter than its stats', 100, 40],
      ['longer than its stats', 40, 100],
      ['empty, with stats of 1000 bytes', 1000, 0],
      ['larger than a block, grown to twice the size', 70000, 140000],
    ];

    for (const format of ['tar', 'tar.gz']) {
      for (const [label, statSize, realSize] of cases) {
        it(`${format}: ${label}: 'error' twice, finalize() rejects, two uncaught exceptions`, async function () {
          const file = path.join(root, `d14-${format}-${statSize}-${realSize}.bin`);
          const runs = await runBothInChild(scenarioReference(import.meta.url, 'sizeMismatch'), {
            wait: 'none',
            timeout: CHILD_TIMEOUT_MS,
            args: { format, file, statSize, realSize },
          });
          const { upstream, port } = runs;
          for (const [name, run] of Object.entries(runs)) {
            assert.equal(run.code, 0, `${name}: exit code ${run.code}\n${run.stdout}${run.stderr}`);
            assert.equal(run.result.error, null, `${name}: the scenario threw`);
          }
          assert.deepStrictEqual(upstream.result.value.uncaught, [
            SIZE_MISMATCH,
            { name: 'Error', code: undefined, message: 'already finalized or destroyed', data: undefined },
          ]);
          assert.deepStrictEqual(upstream.result.settled, [{ label: 'finalize', state: 'rejected', error: SIZE_MISMATCH }]);
          const errors = selectEvents(upstream.result.events, ['error']).map((record) => record.payload);
          // the pack and the archive; with gzip the error also travels through the gzip stream
          assert.deepStrictEqual(errors, format === 'tar' ? [SIZE_MISMATCH, SIZE_MISMATCH] : [SIZE_MISMATCH, SIZE_MISMATCH, SIZE_MISMATCH]);
          assert.deepStrictEqual(selectEvents(upstream.result.events, ['entry', 'end']), []);

          assert.deepStrictEqual(port.result.value, upstream.result.value);
          assert.deepStrictEqual(port.result.events, upstream.result.events);
          assert.deepStrictEqual(port.result.settled, upstream.result.settled);
          if (format === 'tar') {
            // the header with the size of the stats, then the bytes that were read
            assert.ok(port.result.bytes.equals(upstream.result.bytes), 'the bytes written before the error differ');
            assert.equal(upstream.result.bytes.length, 512 + realSize);
          } else {
            // the gzip header: the scenario holds the file back until it has been written
            assert.equal(upstream.result.bytes.length, 10);
            assert.equal(port.result.bytes.length, upstream.result.bytes.length);
            assert.deepStrictEqual(splitGzipHeader(port.result.bytes), splitGzipHeader(upstream.result.bytes));
          }
        });
      }
    }
  });

  describe('D15: destroy() while a file entry is being read leaves its descriptor open, abort() does not (P30)', function () {
    this.timeout(TEST_TIMEOUT_MS);
    let file;

    before(function () {
      file = path.join(root, 'd15-big.bin');
      fs.writeFileSync(file, crypto.randomBytes(LEAK_FILE_SIZE));
    });

    for (const kind of Object.keys(STREAMING)) {
      it(`${kind}: destroy() destroys neither the engine nor the fs.ReadStream`, async function () {
        const runs = await runBothInChild(scenarioReference(import.meta.url, 'destroyedWhileReading'), {
          wait: 'none',
          timeout: CHILD_TIMEOUT_MS,
          args: { kind, file, how: 'destroy' },
        });
        for (const [name, run] of Object.entries(runs)) {
          assert.equal(run.crash, null, `${name}: uncaught ${JSON.stringify(run.crash)}`);
          assert.equal(run.code, 0, `${name}: exit code ${run.code}\n${run.stdout}${run.stderr}`);
        }
        assert.deepStrictEqual(runs.upstream.result.value, {
          whileReading: 1,
          afterwards: 1,
          archiveDestroyed: true,
          engineDestroyed: false,
        });
        assert.deepStrictEqual(runs.port.result.value, runs.upstream.result.value);
        assert.deepStrictEqual(eventNames(runs.upstream.result), ['close']);
        assert.deepStrictEqual(runs.port.result.events, runs.upstream.result.events);
        assert.deepStrictEqual(runs.upstream.result.settled, []);
        assert.deepStrictEqual(runs.port.result.settled, []);
      });

      it(`${kind}: abort() lets the entry end, and the file is closed`, async function () {
        const runs = await runBothInChild(scenarioReference(import.meta.url, 'destroyedWhileReading'), {
          wait: 'none',
          timeout: CHILD_TIMEOUT_MS,
          args: { kind, file, how: 'abort' },
        });
        for (const [name, run] of Object.entries(runs)) {
          assert.equal(run.crash, null, `${name}: uncaught ${JSON.stringify(run.crash)}`);
          assert.equal(run.code, 0, `${name}: exit code ${run.code}\n${run.stdout}${run.stderr}`);
        }
        assert.deepStrictEqual(runs.upstream.result.value, {
          whileReading: 1,
          afterwards: 0,
          archiveDestroyed: true,
          engineDestroyed: false,
        });
        assert.deepStrictEqual(runs.port.result.value, runs.upstream.result.value);
        assert.deepStrictEqual(eventNames(runs.upstream.result), ['end', 'close']);
        assert.deepStrictEqual(runs.port.result.events, runs.upstream.result.events);
        // P5: the promise of a finalize() that was still deferred never settles
        assert.deepStrictEqual(runs.upstream.result.settled, []);
        assert.deepStrictEqual(runs.port.result.settled, []);
      });
    }
  });

  describe('D16: Object.prototype keys count as registered formats (P31)', function () {
    it('isRegisteredFormat is true, create() throws a TypeError, registerFormat() is refused', async function () {
      const keys = ['constructor', 'toString', 'hasOwnProperty', 'valueOf', '__proto__', 'archiver-wasm-diff-not-registered'];
      const runs = await runBoth(prototypeKeysInTheRegistry, { wait: 'none', args: { keys } });
      assert.equal(runs.upstream.error, null);
      assert.equal(runs.port.error, null);
      const typeError = (message) => ({ thrown: { name: 'TypeError', code: undefined, message, data: undefined } });
      const error = (message) => ({ thrown: { name: 'Error', code: undefined, message, data: undefined } });
      const byKey = new Map(runs.upstream.value.map((row) => [row.key, row]));
      // `new Object(options)` is the options object, which setModule then treats as a stream
      assert.deepStrictEqual(byKey.get('constructor'), {
        key: 'constructor',
        isRegisteredFormat: { returned: 'boolean' },
        isRegistered: true,
        create: typeError('this._module.on is not a function'),
        call: typeError('this._module.on is not a function'),
        registerFormat: error('register(constructor): format already registered'),
        isRegisteredAfterwards: true,
      });
      for (const key of ['toString', 'hasOwnProperty', 'valueOf', '__proto__']) {
        assert.deepStrictEqual(byKey.get(key), {
          key,
          isRegisteredFormat: { returned: 'boolean' },
          isRegistered: true,
          create: typeError('formats[format] is not a constructor'),
          call: typeError('formats[format] is not a constructor'),
          registerFormat: error(`register(${key}): format already registered`),
          isRegisteredAfterwards: true,
        });
      }
      // the control: a name nothing has, which the scenario then registers
      assert.deepStrictEqual(byKey.get('archiver-wasm-diff-not-registered'), {
        key: 'archiver-wasm-diff-not-registered',
        isRegisteredFormat: { returned: 'boolean' },
        isRegistered: false,
        create: error('create(archiver-wasm-diff-not-registered): format not registered'),
        call: error('create(archiver-wasm-diff-not-registered): format not registered'),
        registerFormat: { returned: 'undefined' },
        isRegisteredAfterwards: true,
      });
      assert.deepStrictEqual(runs.port.value, runs.upstream.value);
      assert.deepStrictEqual(runs.port.events, runs.upstream.events);
    });
  });

  describe("D17: abort() between an entry's module callback and its deferred queue callback never shuts down (P32)", function () {
    const state = { aborted: false, finalize: false, finalizing: false, finalized: false, modulePiped: true };
    const expected = [
      // the queue worker has not started: the queue is idle, abort() shuts down
      ['end', 'close'],
      // one macrotask after append(): the entry is done, its setImmediate(callback) is pending
      ['entry', 'progress'],
      // the queue callback has run: the queue is idle again
      ['entry', 'progress', 'end', 'close'],
      ['entry', 'progress', 'end', 'close'],
    ];

    for (const [label, format, options] of [
      ['zip, stored', 'zip', { store: true }],
      ['aes256, stored', 'aes256', { password: PASSWORD, store: true }],
      ['json', 'json', {}],
    ]) {
      for (let turns = 0; turns < expected.length; turns++) {
        const hangs = turns === 1;
        it(`${label}: abort() ${turns} turns after append(): ${hangs ? "no 'end', no 'close'" : 'the archive ends'}`, async function () {
          const runs = await runBoth(abortAfterTurns, {
            hang: hangs ? HANG_QUIET_MS : 100,
            args: { format, options, turns },
            random: ZIP20_HEADER,
          });
          assert.equal(runs.upstream.error, null);
          assert.equal(runs.port.error, null);
          assert.deepStrictEqual(eventNames(runs.upstream), expected[turns]);
          assert.deepStrictEqual(eventNames(runs.port), expected[turns]);
          const kind = format === 'aes256' ? 'aes256' : format;
          assert.deepStrictEqual(comparedEvents(kind, runs.port), comparedEvents(kind, runs.upstream));
          assert.deepStrictEqual(runs.upstream.value, { state, returnsThis: true });
          assert.deepStrictEqual(runs.port.value, runs.upstream.value);
        });
      }
    }
  });
});

// PORTING.md 14.2 (comparison rules, tar.gz: the 10-byte header; the member was cut off by the error)
function splitGzipHeader(bytes) {
  return bytes.subarray(0, 10);
}
