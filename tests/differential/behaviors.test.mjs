// tests/differential/behaviors.test.mjs
// PORTING.md 14.2: rows of BEHAVIORS.tsv that no other differential case reaches. The constructor defaults
// (ARCHIVER-CORE-006), the stat queue (ARCHIVER-CORE-009), modes read from stats (ARCHIVER-CORE-033), the
// entry count after a failed lstat (ARCHIVER-CORE-047) and bytes written to the ZipCrypto engine while an
// entry is open (PORTING.md 7.5, ZIP-135). No upstream source.
import assert from 'node:assert/strict';
import { once } from 'node:events';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { entryData } from './helpers/decrypt.mjs';
import { omitV15Keys, selectEvents, summarizeError } from './helpers/events.mjs';
import { runBoth } from './helpers/run-both.mjs';
import { parseTar } from './helpers/tar-records.mjs';
import { parseZip } from './helpers/zip-records.mjs';

const DATE = new Date('2020-03-04T05:06:08.000Z');
const PASSWORD = '123';
const SALT = Buffer.from('000102030405060708090a0b0c0d0e0f', 'hex');
const ZIP20_HEADER = Buffer.from('a0a1a2a3a4a5a6a7a8a9aaab', 'hex');
const FORMATS = ['zip', 'tar', 'json', 'aes256', 'zip20'];
// node-archiver/lib/core.js:32-36
const HIGH_WATER_MARK = 1024 * 1024;
const STAT_CONCURRENCY = 4;

// PORTING.md 14.2 (determinism: stored entries, a fixed salt)
function optionsOf(format, options = {}) {
  switch (format) {
    case 'zip':
      return { store: true, ...options };
    case 'aes256':
      return { password: PASSWORD, salt: Buffer.from(SALT), store: true, ...options };
    case 'zip20':
      return { password: PASSWORD, store: true, ...options };
    default:
      return { ...options };
  }
}

// PORTING.md 14.2 (events: for aes256 and zip20 the keys only the archiver 7 stack writes are ignored, V15)
function comparedEvents(run) {
  return omitV15Keys(selectEvents(run.events));
}

// PORTING.md 14.2 (the entries.total and entries.processed of every 'progress', in order)
function progressOf(run) {
  return selectEvents(run.events, ['progress']).map((record) => [
    record.payload.entries.total,
    record.payload.entries.processed,
  ]);
}

// PORTING.md 14.2 (name and permission bits of every entry, sorted by name; 17.1, 17.3)
function modesOf(format, bytes) {
  let found;
  if (format === 'json') {
    found = JSON.parse(bytes.toString('utf8')).map((entry) => [entry.name, entry.mode]);
  } else if (format === 'tar') {
    found = parseTar(bytes).entries.map((entry) => [entry.name, entry.header.mode]);
  } else {
    found = parseZip(bytes).entries.map((entry) => {
      // version made by: the upper byte is the platform, 3 is unix
      assert.equal(entry.central.versionMadeBy >>> 8, 3, `${entry.name}: platform`);
      return [entry.name, (entry.central.externalAttributes >>> 16) & 0o7777];
    });
  }
  return found.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
}

// PORTING.md 14.2 (the constructor of each surface: the archiver 8 classes and the archiver 7 vending function)
const SURFACES = {
  ZipArchive: (impl, options) => new impl.ZipArchive(options),
  TarArchive: (impl, options) => new impl.TarArchive(options),
  JsonArchive: (impl, options) => new impl.JsonArchive(options),
  "archiver('zip')": (impl, options) => impl.archiver('zip', options),
  "archiver.create('tar')": (impl, options) => impl.archiver.create('tar', options),
  "archiver.create('zip-encrypted')": (impl, options) =>
    impl.archiver.create('zip-encrypted', { password: PASSWORD, encryptionMethod: 'aes256', ...options }),
};

// PORTING.md 14.2 (scenario: what the constructor made of its options)
async function constructed(impl, ctx) {
  const found = {};
  for (const [surface, make] of Object.entries(SURFACES)) {
    let archive;
    try {
      archive = make(impl, ctx.args.options === null ? undefined : { ...ctx.args.options });
    } catch (err) {
      found[surface] = { threw: summarizeError(err) };
      continue;
    }
    found[surface] = {
      readableHighWaterMark: archive.readableHighWaterMark,
      writableHighWaterMark: archive.writableHighWaterMark,
      highWaterMark: archive.options.highWaterMark,
      statConcurrency: archive.options.statConcurrency,
      statQueue: archive._statQueue.concurrency,
      queue: archive._queue.concurrency,
    };
    archive.on('error', () => {});
    archive.destroy();
  }
  return found;
}

// PORTING.md 14.2 (scenario: `count` file() calls; the largest number of fs.lstat calls that were open at once)
async function lstatsInFlight(impl, ctx) {
  const lstat = fs.lstat;
  let open = 0;
  let most = 0;
  let calls = 0;
  fs.lstat = function (file, ...rest) {
    const callback = rest.pop();
    calls += 1;
    open += 1;
    most = Math.max(most, open);
    return lstat.call(this, file, ...rest, function (...args) {
      open -= 1;
      return callback.apply(this, args);
    });
  };
  // node-archiver/lib/core.js:1 binds lstat by name
  syncBuiltinESMExports();
  try {
    const archive = ctx.create(ctx.args.format, optionsOf(ctx.args.format, ctx.args.options));
    for (let i = 0; i < ctx.args.count; i++) {
      archive.file(i % 5 === 3 ? ctx.args.missing : ctx.args.file, { name: `f${String(i).padStart(2, '0')}.txt`, date: DATE });
    }
    await archive.finalize();
    return { most, calls };
  } finally {
    fs.lstat = lstat;
    syncBuiltinESMExports();
  }
}

// PORTING.md 14.2 (scenario: one fs source whose mode comes from its stats)
async function statModes(impl, ctx) {
  const { format, source, root } = ctx.args;
  const archive = ctx.create(format, optionsOf(format));
  const suid = path.join(root, 'suid.bin');
  switch (source) {
    case 'file':
      archive.file(suid, { name: 'suid.bin' });
      break;
    case 'file with stats':
      archive.file(suid, { name: 'suid.bin', stats: fs.lstatSync(suid) });
      break;
    case 'file with mode null':
      archive.file(suid, { name: 'suid.bin', mode: null });
      break;
    case 'append with stats':
      archive.append(Buffer.from('appended'), { name: 'suid.bin', date: DATE, stats: fs.lstatSync(suid) });
      break;
    case 'directory':
      archive.directory(path.join(root, 'tree'), 'd');
      break;
    case 'glob':
      archive.glob('**/*', { cwd: path.join(root, 'tree') }, { prefix: 'g' });
      break;
    default:
      throw new Error(`behaviors: unknown source ${source}`);
  }
  await archive.finalize();
}

// node-archiver/lib/core.js:399-408 (scenario: lstat fails, then two entries)
async function missingFirst(impl, ctx) {
  const archive = ctx.create(ctx.args.format, optionsOf(ctx.args.format));
  archive.file(ctx.args.missing, { name: 'missing.txt' });
  await once(archive, 'warning');
  archive.append('one', { name: 'a.txt', date: DATE });
  archive.append('two', { name: 'b.txt', date: DATE });
  await archive.finalize();
}

// node-archiver/lib/core.js:399-408 (scenario: one entry, then lstat fails, then one entry)
async function missingBetween(impl, ctx) {
  const archive = ctx.create(ctx.args.format, optionsOf(ctx.args.format));
  archive.append('one', { name: 'a.txt', date: DATE });
  await once(archive, 'progress');
  archive.file(ctx.args.missing, { name: 'missing.txt' });
  await once(archive, 'warning');
  archive.append('two', { name: 'b.txt', date: DATE });
  await archive.finalize();
}

// node-archiver/lib/core.js:399-408 (scenario: every lstat of three fails, one after the other, then a file and a buffer)
async function missingThree(impl, ctx) {
  const archive = ctx.create(ctx.args.format, optionsOf(ctx.args.format, { statConcurrency: 1 }));
  let warnings = 0;
  const warned = new Promise((resolve) => {
    archive.on('warning', () => {
      warnings += 1;
      if (warnings === 3) {
        resolve();
      }
    });
  });
  for (const name of ['m1.txt', 'm2.txt', 'm3.txt']) {
    archive.file(ctx.args.missing, { name });
  }
  await warned;
  archive.file(ctx.args.file, { name: 'file.txt', date: DATE });
  await once(archive, 'progress');
  archive.append('two', { name: 'b.txt', date: DATE });
  await archive.finalize();
}

// PORTING.md 7.5 (scenario: bytes written to the ZipCrypto engine while the source of an entry is open)
async function writeInsideEntry(impl, ctx) {
  const archive = ctx.create('zip20', optionsOf('zip20', ctx.args.options));
  let pulled;
  const pulling = new Promise((resolve) => {
    pulled = resolve;
  });
  const source = new Readable({
    read() {
      pulled();
    },
  });
  archive.append(source, { name: 's.txt', date: DATE });
  // the entry is open once its source is read
  await pulling;
  source.push('hello');
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve, reject) => {
    archive._module.engine.write(Buffer.from('JUNKJUNK'), (err) => (err ? reject(err) : resolve()));
  });
  source.push('world');
  source.push(null);
  archive.append('x', { name: 'b.txt', date: DATE });
  await archive.finalize();
}

describe('differential: behaviors no other case reaches (BEHAVIORS.tsv)', function () {
  let root;
  let args;

  before(function () {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ykk-diff-behaviors-')));
    const write = (rel, data, mode) => {
      const target = path.join(root, rel);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, data);
      fs.chmodSync(target, mode);
    };
    write('file.txt', 'this is a text file', 0o644);
    // set-user-ID on a file and the sticky bit on a directory: the bits above 0777 an owner may set
    write('suid.bin', 'set-user-ID', 0o4755);
    write('tree/plain.txt', 'plain', 0o640);
    write('tree/suid.bin', 'set-user-ID', 0o4711);
    write('tree/sticky/in.txt', 'in', 0o600);
    fs.chmodSync(path.join(root, 'tree/sticky'), 0o1755);
    fs.chmodSync(path.join(root, 'tree'), 0o755);
    for (const rel of ['file.txt', 'suid.bin', 'tree/plain.txt', 'tree/suid.bin', 'tree/sticky/in.txt', 'tree/sticky', 'tree']) {
      fs.utimesSync(path.join(root, rel), DATE, DATE);
    }
    // the file system must keep the bits, or the cases below would compare 0755 with 0755
    assert.equal(fs.statSync(path.join(root, 'suid.bin')).mode & 0o7777, 0o4755);
    assert.equal(fs.statSync(path.join(root, 'tree/suid.bin')).mode & 0o7777, 0o4711);
    assert.equal(fs.statSync(path.join(root, 'tree/sticky')).mode & 0o7777, 0o1755);
    args = { root, file: path.join(root, 'file.txt'), missing: path.join(root, 'missing.txt') };
  });

  after(function () {
    fs.rmSync(root, { recursive: true, force: true });
  });

  describe('B1 constructor defaults (ARCHIVER-CORE-006, ARCHIVER-CORE-009; node-archiver/lib/core.js:31-53)', function () {
    const cases = [
      ['no options', null, HIGH_WATER_MARK, STAT_CONCURRENCY, STAT_CONCURRENCY],
      ['an empty options object', {}, HIGH_WATER_MARK, STAT_CONCURRENCY, STAT_CONCURRENCY],
      ['statConcurrency 7', { statConcurrency: 7 }, HIGH_WATER_MARK, 7, 7],
      ['statConcurrency 1', { statConcurrency: 1 }, HIGH_WATER_MARK, 1, 1],
      ['highWaterMark 4096', { highWaterMark: 4096 }, 4096, STAT_CONCURRENCY, STAT_CONCURRENCY],
      ['highWaterMark 65536 and statConcurrency 2', { highWaterMark: 65536, statConcurrency: 2 }, 65536, 2, 2],
      // async/dist/async.js:1459-1465 (a concurrency of null means 1)
      ['statConcurrency null', { statConcurrency: null }, HIGH_WATER_MARK, null, 1],
    ];

    for (const [title, options, highWaterMark, statConcurrency, statQueue] of cases) {
      it(title, async function () {
        const { upstream, ykk } = await runBoth(constructed, { args: { options }, wait: 'none' });
        assert.equal(ykk.error, null);
        assert.deepStrictEqual(ykk.value, upstream.value);
        assert.deepStrictEqual(Object.keys(ykk.value), Object.keys(SURFACES));
        for (const surface of Object.keys(SURFACES)) {
          assert.deepStrictEqual(
            ykk.value[surface],
            {
              readableHighWaterMark: highWaterMark,
              writableHighWaterMark: highWaterMark,
              highWaterMark,
              statConcurrency,
              statQueue,
              // node-archiver/lib/core.js:46
              queue: 1,
            },
            surface
          );
        }
      });
    }

    it('statConcurrency 0 throws (async/dist/async.js:1463-1464)', async function () {
      const { upstream, ykk } = await runBoth(constructed, { args: { options: { statConcurrency: 0 } }, wait: 'none' });
      assert.deepStrictEqual(ykk.value, upstream.value);
      for (const surface of Object.keys(SURFACES)) {
        assert.equal(ykk.value[surface].threw.name, 'RangeError', surface);
        assert.equal(ykk.value[surface].threw.message, 'Concurrency must not be zero', surface);
      }
    });
  });

  describe('B2 statConcurrency lstat calls at once (ARCHIVER-CORE-009; node-archiver/lib/core.js:49-53, 392)', function () {
    const cases = [
      ['the default: 4', undefined, 12, 4],
      ['statConcurrency 1', { statConcurrency: 1 }, 12, 1],
      ['statConcurrency 2', { statConcurrency: 2 }, 12, 2],
      ['statConcurrency 7', { statConcurrency: 7 }, 12, 7],
      ['statConcurrency 7 and 3 files', { statConcurrency: 7 }, 3, 3],
    ];

    for (const format of ['json', 'zip', 'aes256']) {
      for (const [title, options, count, most] of cases) {
        it(`${format}: ${title}`, async function () {
          const { upstream, ykk } = await runBoth(lstatsInFlight, { args: { ...args, format, options, count } });
          assert.equal(ykk.error, null);
          assert.equal(upstream.error, null);
          assert.deepStrictEqual(ykk.value, upstream.value);
          assert.deepStrictEqual(ykk.value, { most, calls: count });
          // the scenario put fs.lstat back
          assert.equal(fs.lstat.name, 'lstat');
        });
      }
    }
  });

  describe('B3 mode from stats keeps the bits above 0777 (ARCHIVER-CORE-033; node-archiver/lib/core.js:291-300)', function () {
    const file = [['suid.bin', 0o4755]];
    const tree = (prefix) => [
      [`${prefix}/plain.txt`, 0o640],
      [`${prefix}/sticky/`, 0o1755],
      [`${prefix}/sticky/in.txt`, 0o600],
      [`${prefix}/suid.bin`, 0o4711],
    ];
    const cases = [
      ['file', FORMATS, file],
      ['file with stats', FORMATS, file],
      ['file with mode null', FORMATS, file],
      ['append with stats', FORMATS, file],
      // the ZipCrypto engine takes no directory entry (C1)
      ['directory', ['zip', 'tar', 'json', 'aes256'], tree('d')],
      ['glob', ['zip', 'tar', 'json', 'aes256'], tree('g')],
    ];

    for (const [source, formats, expected] of cases) {
      for (const format of formats) {
        it(`${source}: ${format}`, async function () {
          if (process.platform === 'win32') {
            // node-archiver/lib/core.js:293-294 (win32 masks with 0777)
            this.skip();
          }
          const { upstream, ykk } = await runBoth(statModes, { args: { ...args, format, source }, random: ZIP20_HEADER });
          assert.equal(ykk.error, null);
          assert.equal(upstream.error, null);
          assert.deepStrictEqual(modesOf(format, ykk.bytes), modesOf(format, upstream.bytes));
          assert.deepStrictEqual(modesOf(format, ykk.bytes), expected);
          assert.deepStrictEqual(comparedEvents(ykk), comparedEvents(upstream));
        });
      }
    }
  });

  describe('B4 a failed lstat takes its entry out of entries.total (ARCHIVER-CORE-047; node-archiver/lib/core.js:399-408)', function () {
    const cases = [
      ['file() of a missing path, then two entries', missingFirst, [[2, 1], [2, 2]], 1],
      ['an entry, file() of a missing path, an entry', missingBetween, [[1, 1], [2, 2]], 1],
      ['three missing paths, then a file and a buffer', missingThree, [[1, 1], [2, 2]], 3],
    ];

    for (const format of FORMATS) {
      for (const [title, scenario, progress, warnings] of cases) {
        it(`${format}: ${title}`, async function () {
          const { upstream, ykk } = await runBoth(scenario, { args: { ...args, format }, random: ZIP20_HEADER });
          assert.equal(ykk.error, null);
          assert.equal(upstream.error, null);
          assert.deepStrictEqual(comparedEvents(ykk), comparedEvents(upstream));
          assert.deepStrictEqual(progressOf(ykk), progress);
          const warned = selectEvents(ykk.events, ['warning']);
          assert.equal(warned.length, warnings);
          for (const record of warned) {
            // the raw fs error, not an ArchiverError
            assert.equal(record.payload.code, 'ENOENT');
          }
          assert.equal(selectEvents(ykk.events, ['error']).length, 0);
          assert.equal(ykk.pointer, upstream.pointer);
          // json writes the stats of file.txt, and reading the file may change its atime (14.2, comparison rules)
          if (format !== 'json') {
            assert.equal(ykk.bytes.equals(upstream.bytes), true, 'archive bytes');
          }
        });
      }
    }
  });

  describe('B5 bytes written to the ZipCrypto engine inside an entry (PORTING.md 7.5, ZIP-135)', function () {
    for (const [title, options] of [['stored', { store: true }], ['forceZip64', { store: true, forceZip64: true }]]) {
      it(`${title}: the local header offsets are the real positions`, async function () {
        const { upstream, ykk } = await runBoth(writeInsideEntry, { args: { options }, random: ZIP20_HEADER });
        assert.equal(ykk.error, null);
        assert.equal(upstream.error, null);
        assert.equal(ykk.bytes.equals(upstream.bytes), true, 'archive bytes');
        assert.deepStrictEqual(comparedEvents(ykk), comparedEvents(upstream));
        for (const run of [upstream, ykk]) {
          // parseZip reads every local header at the offset its central header names
          const zip = parseZip(run.bytes);
          assert.deepStrictEqual(zip.prefix, Buffer.from('JUNKJUNK'));
          assert.deepStrictEqual(zip.entries.map((entry) => entry.name), ['s.txt', 'b.txt']);
          assert.equal(zip.entries[0].central.effective.localHeaderOffset, 8);
          assert.equal(zip.entries[0].local.offset, 8);
          assert.equal(run.bytes.readUInt32LE(zip.entries[1].central.effective.localHeaderOffset), 0x04034b50);
          assert.deepStrictEqual(await entryData(zip.entries[0], PASSWORD), Buffer.from('helloworld'));
          assert.deepStrictEqual(await entryData(zip.entries[1], PASSWORD), Buffer.from('x'));
        }
      });
    }
  });
});
