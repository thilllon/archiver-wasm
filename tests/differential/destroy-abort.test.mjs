// PORTING.md 14.2: cases R1 to R5 (regressions of the pre-release review: an engine destroyed by an
// AbortSignal, V17; a comment that is not a string, V14; names and comments beyond the 16-bit length field
// and beyond the wasm limit, P24 and V16 (d); the timing of a deflated buffer entry, V3). No upstream source.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { once } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { omitV15Keys, selectEvents, summarizeError } from './helpers/events.mjs';
import {
  CRASH_EXIT_CODE,
  HANG_QUIET_MS,
  load,
  runBoth,
  runBothInChild,
  scenarioReference,
} from './helpers/run-both.mjs';
import { parseZip } from './helpers/zip-records.mjs';

const DATE = new Date('2013-01-03T14:26:38.000Z');
const PASSWORD = '123';
const SALT_HEX = '000102030405060708090a0b0c0d0e0f';
const ZIP20_HEADER = Buffer.from('a0a1a2a3a4a5a6a7a8a9aaab', 'hex');
// what follows the abort (the queued tasks archiver core still runs, core.js:177-180) happens within this
const SETTLE_MS = 300;
// the child is killed after this; below the timeout of its test
const CHILD_TIMEOUT_MS = 30000;
const TEST_TIMEOUT_MS = 2 * CHILD_TIMEOUT_MS + 5000;
const FILE_COUNT = 8;
const FILE_SIZE = 200000;
// PORTING.md 3.2 V16 (d): MAX_TEXT, the largest name or entry comment that enters wasm
const MAX_TEXT = 64 * 1024 * 1024;
// PORTING.md 3.3 P24: more than the 16-bit length field holds
const LONG_NAME_BYTES = 70000;

const ABORT_ERROR = { name: 'AbortError', code: 'ABORT_ERR', message: 'The operation was aborted', data: undefined };
const ABORT_CRASH = { name: 'AbortError', code: 'ABORT_ERR', message: 'The operation was aborted' };
// deps/tar-stream/pack.js:138 (Pack.entry on a destroyed pack; inherited, the same in both)
const TAR_CRASH = { name: 'Error', code: undefined, message: 'already finalized or destroyed' };

// PORTING.md 14.2 (formats; a child process receives its arguments as JSON, so the options are built here)
const KINDS = {
  'zip, deflated': { format: 'zip', options: () => ({}) },
  'zip, stored': { format: 'zip', options: () => ({ store: true }) },
  aes256: { format: 'aes256', options: () => ({ password: PASSWORD, salt: Buffer.from(SALT_HEX, 'hex') }) },
  zip20: { format: 'zip20', options: () => ({ password: PASSWORD }) },
  'aes256, stored': {
    format: 'aes256',
    options: () => ({ password: PASSWORD, salt: Buffer.from(SALT_HEX, 'hex'), store: true }),
  },
  'zip20, stored': { format: 'zip20', options: () => ({ password: PASSWORD, store: true }) },
  tar: { format: 'tar', options: () => ({}) },
  'tar.gz': { format: 'tar.gz', options: () => ({}) },
  json: { format: 'json', options: () => ({}) },
};
const ZIP_KINDS = ['zip, deflated', 'zip, stored', 'aes256', 'zip20'];
const ENCRYPTED_KINDS = ['aes256', 'zip20', 'aes256, stored', 'zip20, stored'];
const STORED_KINDS = ['zip, stored', 'aes256, stored', 'zip20, stored'];

// PORTING.md 14.2 (helper of the test: the archive of one kind, with more options)
function createKind(ctx, kind, options, trackOptions) {
  return ctx.create(KINDS[kind].format, { ...KINDS[kind].options(), ...options }, trackOptions);
}

// PORTING.md 14.2 (helper of the test: one turn of the event loop)
function immediate() {
  return new Promise((resolve) => setImmediate(resolve));
}

// PORTING.md 14.2 (helper of the test: what follows a call that leaves no promise to await)
function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// node-archiver/lib/core.js:177-180 (the 'error' of the destroyed engine is emitted, then the next queued task
// runs: Zip.append -> ZipStream.entry on the destroyed engine, PORTING.md V17)
export async function signalAbortedAtSecondEntry(impl, ctx) {
  const controller = new AbortController();
  const archive = createKind(ctx, ctx.args.kind, { signal: controller.signal, statConcurrency: 1 });
  let entries = 0;
  archive.on('entry', () => {
    entries += 1;
    if (entries === 2) {
      controller.abort();
    }
  });
  for (let i = 0; i < ctx.args.files.length; i++) {
    archive.file(ctx.args.files[i], { name: `file-${i}.bin`, date: DATE });
  }
  await ctx.watch('finalize', archive.finalize());
  return { destroyed: archive.destroyed, entries };
}

// deps/compress-commons/lib/archivers/zip/zip-archive-output-stream.js:147-166 (the smart stream of the entry
// in progress is still written to after the engine was destroyed, PORTING.md V17)
export async function signalAbortedInsideAStream(impl, ctx) {
  const controller = new AbortController();
  const archive = createKind(ctx, ctx.args.kind, { signal: controller.signal });
  const pushed = [0, 0, 0];
  for (let i = 0; i < pushed.length; i++) {
    const source = new Readable({
      read() {
        setImmediate(() => {
          pushed[i] += 1;
          if (i === 0 && pushed[i] === 3) {
            controller.abort();
          }
          this.push(pushed[i] <= 6 ? Buffer.alloc(1000, 65 + i) : null);
        });
      },
    });
    archive.append(source, { name: `stream-${i}.bin`, date: DATE });
  }
  await ctx.watch('finalize', archive.finalize());
  return { destroyed: archive.destroyed };
}

// node:stream (a signal that is already aborted destroys the stream inside its constructor, before the
// engine has an encoder: PORTING.md V17, last sentence)
export async function signalAbortedBeforeConstruction(impl, ctx) {
  const controller = new AbortController();
  controller.abort();
  const archive = createKind(ctx, ctx.args.kind, { signal: controller.signal });
  if (ctx.args.append) {
    archive.append('x', { name: 'x.txt', date: DATE });
  }
  await ctx.watch('finalize', archive.finalize());
  return { destroyed: archive.destroyed };
}

// deps/zip-stream/index.js:44-46 (a comment with `.length > 0` is set; PORTING.md V14: port throws here)
export async function bufferArchiveComment(impl, ctx) {
  let archive;
  try {
    archive = createKind(ctx, ctx.args.kind, { comment: Buffer.from('zz') });
  } catch (err) {
    return { thrown: summarizeError(err) };
  }
  archive.append('x', { name: 'n.txt', date: DATE });
  ctx.watch('finalize', archive.finalize());
  return { thrown: null };
}

// deps/zip-stream/index.js:134-136 (PORTING.md V14: port delivers a TypeError through the entry callback)
export async function bufferEntryComment(impl, ctx) {
  const archive = createKind(ctx, ctx.args.kind, {});
  let thrown = null;
  try {
    archive.append('x', { name: 'n.txt', date: DATE, comment: Buffer.from('x') });
  } catch (err) {
    thrown = summarizeError(err);
  }
  archive.append('y', { name: 'm.txt', date: DATE });
  ctx.watch('finalize', archive.finalize());
  return { thrown };
}

// deps/compress-commons/lib/archivers/zip/zip-archive-output-stream.js:345 (the name length is written
// modulo 65536 and every byte of the name follows, P24)
export async function longName(impl, ctx) {
  const archive = createKind(ctx, ctx.args.kind, {});
  archive.append('hi', { name: ctx.args.unit.repeat(ctx.args.count), date: DATE });
  archive.append('yo', { name: 'second.txt', date: DATE });
  await ctx.watch('finalize', archive.finalize());
}

// PORTING.md 3.2 V16 (d) (the archive is too large to print from a child: its length and digest are returned)
export async function hugeText(impl, ctx) {
  const archive = createKind(ctx, ctx.args.kind, {}, { data: false });
  const hash = crypto.createHash('sha256');
  let length = 0;
  archive.on('data', (chunk) => {
    hash.update(chunk);
    length += chunk.length;
  });
  const data = { name: 'n.txt', date: DATE };
  data[ctx.args.field] = 'a'.repeat(ctx.args.size);
  const failed = once(archive, 'error').then(() => 'error');
  archive.append('hi', data);
  const outcome = await Promise.race([ctx.watch('finalize', archive.finalize()).then(() => 'finalized'), failed]);
  await delay(ctx.args.settle);
  return { outcome, length, sha256: hash.digest('hex') };
}

// node-archiver/lib/core.js:398-408 (the ENOENT 'warning' of the stat queue) against core.js:194-208 (the
// 'entry' and 'progress' of an entry that needed no file): PORTING.md V3
async function missingFileThenBuffer(impl, ctx) {
  const archive = ctx.create('zip', ctx.args.options);
  archive.file(ctx.args.missing, { name: 'missing.txt' });
  archive.append('x', { name: 'x.txt', date: DATE });
  await archive.finalize();
}

// node-archiver/lib/core.js:70-77, 174-180 (abort() between an entry's completion and its deferred queue
// callback never shuts down, P32; where that window falls depends on when the entry completes, V3)
async function abortAfterTurns(impl, ctx) {
  const archive = ctx.create('zip', ctx.args.options);
  archive.append('x', { name: 'x.txt', date: DATE });
  for (let i = 0; i < ctx.args.turns; i++) {
    await immediate();
  }
  archive.abort();
}

// PORTING.md 14.2 (events: for aes256 and zip20 the keys only the archiver 7 stack writes are ignored, V15).
// node-archiver/lib/core.js:204, 412: `fs.totalBytes` of a 'progress' counts the lstat answers that have
// arrived, which is a race between the stat queue and the entry queue in upstream itself, so it is left out.
function comparedEvents(kind, events, names) {
  const selected = selectEvents(events, names).map((record) =>
    record.event === 'progress'
      ? { event: record.event, payload: { ...record.payload, fs: { ...record.payload.fs, totalBytes: null } } }
      : record
  );
  return ENCRYPTED_KINDS.includes(kind) ? omitV15Keys(selected) : selected;
}

// PORTING.md 14.2 (helper of the test: the names of the recorded events, in order)
function eventNames(run) {
  return run.events.map((record) => record.event);
}

// PORTING.md 14.2 (helper of the test: the payloads of the recorded 'error' events)
function errorsOf(run) {
  return selectEvents(run.events, ['error']).map((record) => record.payload);
}

// PORTING.md 14.2 (crashes: exit code 7 and the printed { name, code, message } are compared)
function assertSameCrash(runs, expected) {
  assert.equal(runs.upstream.code, CRASH_EXIT_CODE, `upstream did not crash: ${runs.upstream.stdout}${runs.upstream.stderr}`);
  assert.equal(runs.upstream.crash.name, expected.name);
  assert.equal(runs.upstream.crash.code, expected.code);
  assert.equal(runs.upstream.crash.message, expected.message);
  assert.equal(runs.port.code, runs.upstream.code, `port did not crash: ${runs.port.stdout}${runs.port.stderr}`);
  assert.deepStrictEqual(runs.port.crash, runs.upstream.crash);
}

// PORTING.md 14.2 (helper of the test: neither child died of an uncaught exception, and both printed a result)
function assertNoCrash(runs) {
  for (const name of ['upstream', 'port']) {
    const run = runs[name];
    assert.equal(run.crash, null, `${name}: uncaught ${JSON.stringify(run.crash)}`);
    assert.equal(run.code, 0, `${name}: exit code ${run.code}, signal ${run.signal}\n${run.stdout}${run.stderr}`);
    assert.equal(run.result.error, null, `${name}: the scenario threw`);
  }
}

// PORTING.md 14.2 (events: the recorded sequence with payload summaries, the outcome of finalize(), the value)
function assertSameRun(kind, runs) {
  const { upstream, port } = runs;
  assert.deepStrictEqual(eventNames(port.result), eventNames(upstream.result));
  assert.deepStrictEqual(
    comparedEvents(kind, port.result.events, ['entry', 'progress', 'warning', 'error']),
    comparedEvents(kind, upstream.result.events, ['entry', 'progress', 'warning', 'error'])
  );
  assert.deepStrictEqual(port.result.settled, upstream.result.settled);
  assert.deepStrictEqual(port.result.value, upstream.result.value);
}

// PORTING.md 3.2 V17 (an abort is an AbortError twice, from the engine and from the archive itself, and the
// rejection of finalize(): never the glue's `null pointer passed to rust`, never a TypeError)
function assertAborted(run, label) {
  assert.deepStrictEqual(errorsOf(run), [ABORT_ERROR, ABORT_ERROR], `${label}: 'error' events`);
  assert.deepStrictEqual(
    run.settled,
    [{ label: 'finalize', state: 'rejected', error: ABORT_ERROR }],
    `${label}: finalize()`
  );
  assert.equal(run.value.destroyed, true, `${label}: destroyed`);
  assert.deepStrictEqual(selectEvents(run.events, ['end']), [], `${label}: 'end'`);
  assert.equal(selectEvents(run.events, ['close']).length, 1, `${label}: 'close'`);
}

// PORTING.md 17.1 (the 16-bit length fields of the first local header, of the first central header and of the
// end record, read at their offsets: a parser would follow the wrapped lengths, P24)
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

describe('differential: destroyed engines, comments and names out of contract, V3 timing (PORTING.md 14.2, R1 to R5)', function () {
  let root;
  let files;

  before(async function () {
    await load('upstream');
    await load('port');
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'archiver-wasm-diff-destroy-')));
    files = [];
    for (let i = 0; i < FILE_COUNT; i++) {
      const file = path.join(root, `file-${i}.bin`);
      fs.writeFileSync(file, Buffer.alloc(FILE_SIZE, i + 1));
      files.push(file);
    }
  });

  after(function () {
    fs.rmSync(root, { recursive: true, force: true });
  });

  // PORTING.md 14.2 (crashes: each implementation runs the scenario in a child process)
  function inChild(name, args, options = {}) {
    return runBothInChild(scenarioReference(import.meta.url, name), {
      wait: SETTLE_MS,
      timeout: CHILD_TIMEOUT_MS,
      random: ZIP20_HEADER,
      args,
      ...options,
    });
  }

  describe('R1: an AbortSignal aborted in the middle of an archive (V17)', function () {
    // Compares the order of events that race an fs call against a compressor in each
    // implementation. On a loaded runner the race occasionally resolves the other way
    // (issue #20), so a failed case is run again before it counts.
    this.retries(2);
    this.timeout(TEST_TIMEOUT_MS);

    for (const kind of ZIP_KINDS) {
      it(`${kind}: aborted at the second 'entry', the queued entries reach a destroyed engine`, async function () {
        const runs = await inChild('signalAbortedAtSecondEntry', { kind, files });
        assertNoCrash(runs);
        assertAborted(runs.upstream.result, 'upstream');
        assertAborted(runs.port.result, 'port');
        assertSameRun(kind, runs);
        assert.deepStrictEqual(
          selectEvents(runs.upstream.result.events, ['entry']).map((record) => record.payload.name),
          ['file-0.bin', 'file-1.bin']
        );
        assert.deepStrictEqual(runs.upstream.result.value, { destroyed: true, entries: 2 });
        if (kind === 'zip, stored') {
          assert.ok(runs.port.result.bytes.equals(runs.upstream.result.bytes), 'the bytes written before the abort differ');
        }
      });

      it(`${kind}: aborted while a stream entry is being written`, async function () {
        const runs = await inChild('signalAbortedInsideAStream', { kind });
        assertNoCrash(runs);
        assertAborted(runs.upstream.result, 'upstream');
        assertAborted(runs.port.result, 'port');
        assertSameRun(kind, runs);
        // no 'entry', and none of the errors of an encoder that was freed
        assert.deepStrictEqual(eventNames(runs.upstream.result), ['error', 'close', 'error']);
      });
    }

    for (const kind of ['tar', 'tar.gz']) {
      it(`${kind}: the next queued entry throws out of Pack.entry in both (inherited)`, async function () {
        assertSameCrash(await inChild('signalAbortedAtSecondEntry', { kind, files }), TAR_CRASH);
        assertSameCrash(await inChild('signalAbortedInsideAStream', { kind }), TAR_CRASH);
      });
    }

    it('json: the queued entries are still collected after the abort', async function () {
      for (const name of ['signalAbortedAtSecondEntry', 'signalAbortedInsideAStream']) {
        const runs = await inChild(name, { kind: 'json', files });
        assertNoCrash(runs);
        assertAborted(runs.upstream.result, 'upstream');
        assertAborted(runs.port.result, 'port');
        assertSameRun('json', runs);
      }
    });
  });

  describe('R2: an AbortSignal that is already aborted when the archive is constructed (V17)', function () {
    this.timeout(TEST_TIMEOUT_MS);

    for (const kind of ['zip, deflated', 'zip, stored']) {
      for (const append of [false, true]) {
        it(`${kind}${append ? ', one entry' : ''}: AbortError twice, finalize() rejects with it`, async function () {
          const runs = await inChild('signalAbortedBeforeConstruction', { kind, append });
          assertNoCrash(runs);
          assertAborted(runs.upstream.result, 'upstream');
          assertAborted(runs.port.result, 'port');
          assertSameRun(kind, runs);
          assert.equal(runs.upstream.result.bytes.length, 0);
          assert.equal(runs.port.result.bytes.length, 0);
        });
      }
    }

    for (const kind of ['aes256', 'zip20']) {
      for (const append of [false, true]) {
        it(`${kind}${append ? ', one entry' : ''}: the uncaught exception is the AbortError in both`, async function () {
          assertSameCrash(await inChild('signalAbortedBeforeConstruction', { kind, append }), ABORT_CRASH);
        });
      }
    }

    for (const kind of ['tar', 'tar.gz', 'json']) {
      it(`${kind}: the same events and the same outcome of finalize()`, async function () {
        for (const append of [false, true]) {
          const runs = await inChild('signalAbortedBeforeConstruction', { kind, append });
          assertNoCrash(runs);
          assertSameRun(kind, runs);
          assert.deepStrictEqual(errorsOf(runs.port.result)[0], ABORT_ERROR);
          assert.equal(runs.port.result.value.destroyed, true);
        }
      });
    }
  });

  describe('R3: a Buffer as comment (V14)', function () {
    this.timeout(TEST_TIMEOUT_MS);

    for (const kind of ZIP_KINDS) {
      it(`${kind}: archive option, port throws a TypeError from the constructor, upstream writes it`, async function () {
        const runs = await inChild('bufferArchiveComment', { kind });
        assertNoCrash(runs);
        const { upstream, port } = runs;
        assert.deepStrictEqual(upstream.result.value, { thrown: null });
        assert.deepStrictEqual(upstream.result.settled, [{ label: 'finalize', state: 'fulfilled' }]);
        assert.deepStrictEqual(selectEvents(upstream.result.events, ['error', 'warning']), []);
        const parsed = parseZip(upstream.result.bytes);
        assert.deepStrictEqual(parsed.end.comment, Buffer.from('zz'));
        assert.deepStrictEqual(parsed.entries.map((entry) => entry.name), ['n.txt']);

        assert.deepStrictEqual(port.result.value, {
          thrown: { name: 'TypeError', code: undefined, message: 'expected a string', data: undefined },
        });
        assert.deepStrictEqual(port.result.events, []);
        assert.deepStrictEqual(port.result.settled, []);
        assert.equal(port.result.bytes.length, 0);
      });

      it(`${kind}: entry data, port emits a TypeError as 'error', upstream writes it`, async function () {
        const runs = await inChild('bufferEntryComment', { kind });
        assertNoCrash(runs);
        const { upstream, port } = runs;
        assert.deepStrictEqual(upstream.result.value, { thrown: null });
        assert.deepStrictEqual(upstream.result.settled, [{ label: 'finalize', state: 'fulfilled' }]);
        assert.deepStrictEqual(selectEvents(upstream.result.events, ['error', 'warning']), []);
        const parsed = parseZip(upstream.result.bytes);
        assert.deepStrictEqual(parsed.entries.map((entry) => entry.name), ['n.txt', 'm.txt']);
        assert.deepStrictEqual(parsed.entries[0].central.comment, Buffer.from('x'));

        assert.deepStrictEqual(port.result.value, { thrown: null });
        assert.deepStrictEqual(errorsOf(port.result), [
          { name: 'TypeError', code: undefined, message: 'expected a string', data: undefined },
        ]);
        // the first event: the entry itself is never written
        assert.equal(port.result.events[0].event, 'error');
        assert.deepStrictEqual(
          selectEvents(port.result.events, ['entry']).map((record) => record.payload.name),
          ['m.txt']
        );
        // an emitted 'error' unpipes the module from the archive, as for every entry error: nothing ends
        assert.deepStrictEqual(port.result.settled, []);
        assert.deepStrictEqual(selectEvents(port.result.events, ['end', 'close']), []);
      });
    }
  });

  describe('R4: names and comments beyond the length field and beyond the wasm limit (P24, V16 (d))', function () {
    this.timeout(TEST_TIMEOUT_MS);

    for (const kind of [...ZIP_KINDS, ...STORED_KINDS.slice(1)]) {
      for (const [label, unit] of [['ASCII', 'a'], ['non-ASCII', '€é']]) {
        const count = LONG_NAME_BYTES / Buffer.byteLength(unit);
        it(`${kind}: a ${label} name of ${LONG_NAME_BYTES} bytes completes as upstream`, async function () {
          const runs = await inChild('longName', { kind, unit, count });
          assertNoCrash(runs);
          const { upstream, port } = runs;
          assert.deepStrictEqual(upstream.result.settled, [{ label: 'finalize', state: 'fulfilled' }]);
          assert.deepStrictEqual(selectEvents(upstream.result.events, ['error', 'warning']), []);
          assertSameRun(kind, runs);
          for (const run of [upstream, port]) {
            const fields = lengthFields(run.result.bytes, 0);
            assert.equal(fields.localName, LONG_NAME_BYTES % 65536);
            assert.equal(fields.centralName, LONG_NAME_BYTES % 65536);
            assert.ok(run.result.bytes.length > 2 * LONG_NAME_BYTES, 'every byte of the name is written twice');
          }
          const name = Buffer.from(unit.repeat(count));
          assert.equal(name.length, LONG_NAME_BYTES);
          const localHeader = 30 + LONG_NAME_BYTES;
          assert.deepStrictEqual(upstream.result.bytes.subarray(30, localHeader), name);
          assert.ok(
            port.result.bytes.subarray(0, localHeader).equals(upstream.result.bytes.subarray(0, localHeader)),
            'the local header differs'
          );
          if (STORED_KINDS.includes(kind)) {
            assert.ok(port.result.bytes.equals(upstream.result.bytes), 'the archives differ');
            assert.equal(port.result.pointer, upstream.result.pointer);
          }
        });
      }
    }

    // PORTING.md 14.2 (R4): 64 MiB of text takes minutes on Node 18 and 20, so these cases are
    // registered only by destroy-abort-huge.slow.mjs.
    if (process.env.ARCHIVER_WASM_SLOW === '1') {
      it(`zip, stored: a name of exactly ${MAX_TEXT} bytes is written as upstream writes it`, async function () {
        const runs = await inChild('hugeText', { kind: 'zip, stored', field: 'name', size: MAX_TEXT, settle: 0 }, { wait: 'none' });
        assertNoCrash(runs);
        assert.equal(runs.upstream.result.value.outcome, 'finalized');
        assert.equal(runs.upstream.result.value.length, 2 * MAX_TEXT + 30 + 2 + 46 + 22);
        assert.deepStrictEqual(runs.port.result.value, runs.upstream.result.value);
        assert.deepStrictEqual(eventNames(runs.port.result), eventNames(runs.upstream.result));
      });

      for (const kind of ['zip, stored', 'aes256', 'zip20']) {
        for (const field of ['name', 'comment']) {
          it(`${kind}: a ${field} of ${MAX_TEXT + 1} bytes is an 'error' in port, never a wasm trap; upstream writes it`, async function () {
            const runs = await inChild('hugeText', { kind, field, size: MAX_TEXT + 1, settle: SETTLE_MS }, { wait: 'none' });
            assertNoCrash(runs);
            const { upstream, port } = runs;
            assert.equal(upstream.result.value.outcome, 'finalized');
            assert.deepStrictEqual(selectEvents(upstream.result.events, ['error', 'warning']), []);
            assert.ok(upstream.result.value.length > (field === 'name' ? 2 : 1) * MAX_TEXT);

            assert.equal(port.result.value.outcome, 'error');
            assert.equal(port.result.value.length, 0);
            assert.deepStrictEqual(errorsOf(port.result), [
              { name: 'Error', code: undefined, message: `entry ${field} too large`, data: undefined },
            ]);
            assert.deepStrictEqual(selectEvents(port.result.events, ['entry']), []);
            assert.deepStrictEqual(port.result.settled, []);
          });
        }
      }
    }
  });

  describe('R5: a deflated buffer entry completes at least one turn before upstream (V3)', function () {
    // Compares the order of events that race an fs call against a compressor in each
    // implementation. On a loaded runner the race occasionally resolves the other way
    // (issue #20), so a failed case is run again before it counts.
    this.retries(2);
    const missing = () => path.join(root, 'no-such-dir', 'missing.txt');

    it("zip, deflated: port emits 'entry' and 'progress' before the ENOENT 'warning', upstream after it", async function () {
      const { upstream, port } = await runBoth(missingFileThenBuffer, { args: { options: {}, missing: missing() } });
      assert.equal(upstream.error, null);
      assert.equal(port.error, null);
      const summary = (run) =>
        selectEvents(run.events).map((record) =>
          record.event === 'progress'
            ? { event: 'progress', entries: record.payload.entries }
            : { event: record.event, name: record.payload.name, code: record.payload.code }
        );
      assert.deepStrictEqual(summary(upstream), [
        { event: 'warning', name: 'Error', code: 'ENOENT' },
        { event: 'entry', name: 'x.txt', code: undefined },
        { event: 'progress', entries: { total: 1, processed: 1 } },
      ]);
      assert.deepStrictEqual(summary(port), [
        { event: 'entry', name: 'x.txt', code: undefined },
        { event: 'progress', entries: { total: 2, processed: 1 } },
        { event: 'warning', name: 'Error', code: 'ENOENT' },
      ]);
      // the same events, in another order: the payloads other than the total are equal
      const sorted = (run) =>
        selectEvents(run.events, ['entry', 'warning'])
          .map((record) => JSON.stringify(record, (key, value) => (value === undefined ? '[undefined]' : value)))
          .sort();
      assert.deepStrictEqual(sorted(port), sorted(upstream));
      // bytes are unaffected: one entry, the same records apart from the deflated payload (V1)
      const u = parseZip(upstream.bytes);
      const y = parseZip(port.bytes);
      assert.deepStrictEqual(y.entries.map((entry) => entry.name), ['x.txt']);
      assert.deepStrictEqual(u.entries.map((entry) => entry.name), ['x.txt']);
      assert.deepStrictEqual(y.entries[0].local.bytes, u.entries[0].local.bytes);
    });

    it('zip, stored: the same scenario is equal in both', async function () {
      const { upstream, port } = await runBoth(missingFileThenBuffer, {
        args: { options: { store: true }, missing: missing() },
      });
      assert.equal(upstream.error, null);
      assert.equal(port.error, null);
      assert.deepStrictEqual(port.events, upstream.events);
      assert.deepStrictEqual(eventNames(upstream), ['entry', 'progress', 'warning', 'end', 'close']);
      assert.ok(port.bytes.equals(upstream.bytes), 'the archives differ');
    });

    it('zip, deflated: abort() one turn after append() never ends in port and ends upstream (the window of P32)', async function () {
      const { upstream, port } = await runBoth(abortAfterTurns, { hang: HANG_QUIET_MS, args: { options: {}, turns: 1 } });
      assert.equal(upstream.error, null);
      assert.equal(port.error, null);
      // upstream: the entry has not completed, abort() waits for it and shuts down
      assert.deepStrictEqual(eventNames(upstream), ['end', 'close']);
      // port: the entry completed in the turn its queue worker started, abort() falls into the window of P32
      assert.deepStrictEqual(eventNames(port), ['entry', 'progress']);
    });

    it('zip, deflated: abort() two turns after append() ends in port; upstream depends on the thread pool', async function () {
      const { upstream, port } = await runBoth(abortAfterTurns, { hang: HANG_QUIET_MS, args: { options: {}, turns: 2 } });
      assert.equal(upstream.error, null);
      assert.equal(port.error, null);
      assert.deepStrictEqual(eventNames(port), ['entry', 'progress', 'end', 'close']);
      // zlib has answered (the window of P32: never ends) or has not yet (abort() shuts down): both are upstream
      const names = eventNames(upstream);
      assert.ok(
        ['entry,progress', 'end,close'].includes(names.join()),
        `upstream: ${JSON.stringify(names)}`
      );
    });

    for (const turns of [0, 1, 2]) {
      it(`zip, stored: abort() ${turns} turns after append() is equal in both`, async function () {
        const { upstream, port } = await runBoth(abortAfterTurns, {
          hang: HANG_QUIET_MS,
          args: { options: { store: true }, turns },
        });
        assert.equal(upstream.error, null);
        assert.equal(port.error, null);
        assert.deepStrictEqual(port.events, upstream.events);
        assert.deepStrictEqual(
          eventNames(upstream),
          [['end', 'close'], ['entry', 'progress'], ['entry', 'progress', 'end', 'close']][turns]
        );
      });
    }
  });
});
