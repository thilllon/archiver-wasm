// PORTING.md 14.2: cases D1 to D8 (the preserved upstream defects of 3.3 and the throws of 13.3). No upstream source.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { selectEvents, summarize, summarizeError } from './helpers/events.mjs';
import {
  CRASH_EXIT_CODE,
  HANG_QUIET_MS,
  load,
  runBoth,
  runBothInChild,
  scenarioReference,
} from './helpers/run-both.mjs';

const DATE = new Date('2013-01-03T14:26:38.000Z');
// the plugin calls of D6 are made on archives that are never finalized: wait, take the result, destroy
const SETTLE_MS = 50;
// long enough for one lstat of the thread pool to finish while the main thread is blocked
const LSTAT_MS = 200;

// PORTING.md 14.2 (helper of the test: one turn of the event loop)
function immediate() {
  return new Promise((resolve) => setImmediate(resolve));
}

// PORTING.md 14.2 (helper of the test: the link of D8 is removed by every run, so every run makes it again)
function freshLink(dir) {
  const link = path.join(dir, 'link');
  fs.rmSync(link, { force: true });
  fs.symlinkSync('target.txt', link);
  return link;
}

// node-archiver/lib/core.js:613-625 (P1: the walker is paused, the function throws, nothing resumes it)
const DATA_FUNCTIONS = {
  throws: () => {
    throw new Error('data function failed');
  },
  'returns a number': () => 5,
};

// node-archiver/lib/core.js:603-630 (P1)
async function directoryDataFunction(impl, ctx) {
  const archive = ctx.create('zip');
  archive.directory(ctx.args.dir, 'walked', DATA_FUNCTIONS[ctx.args.kind]);
  ctx.watch('finalize', archive.finalize());
}

// node-archiver/lib/core.js:97-105, 399-408, 486-491 (P2, P3 and P4: an unsupported type, a failing lstat, a globber 'error')
async function directoryWalk(impl, ctx) {
  const archive = ctx.create('zip');
  archive.directory(ctx.args.dir, 'walked');
  ctx.watch('finalize', archive.finalize());
}

// node-archiver/lib/core.js:507-513, 725-737 (P5: the module never ends, so the promise never settles)
async function abortWhileFinalizeIsDeferred(impl, ctx) {
  const archive = ctx.create('json');
  archive.file(ctx.args.file, { name: 'file.txt' });
  ctx.watch('finalize', archive.finalize());
  const state = { ...archive._state };
  const returnsThis = archive.abort() === archive;
  return { state, returnsThis };
}

// node-archiver/lib/utils.js:9-26, node-archiver/lib/plugins/tar.js:62-72, node-archiver/lib/plugins/json.js:64-68 (P21)
async function pluginAppend(impl, ctx) {
  const archive = ctx.create(ctx.args.format);
  const source = new PassThrough();
  const data = { ...archive._normalizeEntryData({ name: 'late.txt', date: DATE }), sourceType: 'stream' };
  archive._module.append(source, data, ctx.callback('collectStream'));
  source.write('abc');
  source.emit('error', new Error('source failed'));
  source.end('def');
  await once(source, 'end');
  await immediate();
  const odd = { ...archive._normalizeEntryData({ name: 'odd.txt', date: DATE }), sourceType: 'other' };
  try {
    return { returned: summarize(archive._module.append(Buffer.from('x'), odd, ctx.callback('unknown sourceType'))) };
  } catch (err) {
    return { thrown: summarizeError(err) };
  }
}

// node-archiver/lib/plugins/tar.js:64-69 (P22: source.pipe(entry) with no 'error' listener on the lazy stream)
export async function lazyOpenFailure(impl, ctx) {
  const archive = ctx.create('tar');
  archive.file(ctx.args.file, { name: 'locked.txt' });
  ctx.watch('finalize', archive.finalize());
}

// node-archiver/lib/core.js:97-99, 467 (13.3: thrown out of file() itself, after _entriesCount was incremented)
async function readlinkFailureInFile(impl, ctx) {
  const link = freshLink(ctx.args.dir);
  const stats = fs.lstatSync(link);
  fs.unlinkSync(link);
  const archive = ctx.create('zip');
  let thrown = null;
  try {
    archive.file(link, { name: 'link', stats });
  } catch (err) {
    thrown = summarizeError(err);
  }
  return { thrown, entriesCount: archive._entriesCount };
}

// node-archiver/lib/core.js:398-412, 467 (13.3: thrown inside the lstat callback of the stat queue)
export async function readlinkFailureInStatQueue(impl, ctx) {
  const link = freshLink(ctx.args.dir);
  const archive = ctx.create('zip');
  archive.file(link, { name: 'link' });
  // the stat queue starts its worker in a microtask (R3), so the lstat is in the thread pool after these
  for (let i = 0; i < 4; i++) {
    await null;
  }
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, LSTAT_MS);
  fs.unlinkSync(link);
}

// node-archiver/lib/core.js:467, 600-602, 630 (13.3: thrown inside the 'match' listener, a globber 'error'; then P4)
async function readlinkFailureInDirectory(impl, ctx) {
  const link = freshLink(ctx.args.dir);
  const archive = ctx.create('zip');
  archive.directory(ctx.args.dir, 'walked', (data) => {
    fs.unlinkSync(link);
    return data;
  });
  ctx.watch('finalize', archive.finalize());
}

// PORTING.md 14.2 (helpers/events.mjs: own enumerable keys in order, which deepStrictEqual does not compare)
function ordered(value) {
  return JSON.stringify(value, (key, item) => (item === undefined ? '[undefined]' : item));
}

// PORTING.md 14.2 (helper of the test: the scenario function itself returned on both implementations)
function assertRan({ upstream, ykk }) {
  assert.equal(upstream.error, null, 'upstream: the scenario threw');
  assert.equal(ykk.error, null, 'ykk: the scenario threw');
}

// PORTING.md 14.2 (hangs: the quiet time is over and neither has settled the promise; the events are equal)
function assertHang(runs) {
  assertRan(runs);
  assert.deepStrictEqual(runs.upstream.settled, [], 'upstream settled the finalize() promise');
  assert.deepStrictEqual(runs.ykk.settled, [], 'ykk settled the finalize() promise');
  assert.deepStrictEqual(runs.ykk.events, runs.upstream.events);
  assert.equal(ordered(runs.ykk.events), ordered(runs.upstream.events), 'key order of the event payloads');
}

// PORTING.md 14.2 (hangs: neither has emitted `end` / `close`)
function assertNeverEnded(runs) {
  assert.deepStrictEqual(selectEvents(runs.upstream.events, ['end', 'close']), []);
  assert.deepStrictEqual(selectEvents(runs.ykk.events, ['end', 'close']), []);
}

// PORTING.md 14.2 (crashes: exit code 7 and the printed { name, code, message } are compared)
function assertSameCrash(runs, expected) {
  assert.equal(runs.upstream.code, CRASH_EXIT_CODE, `upstream did not crash: ${runs.upstream.stdout}${runs.upstream.stderr}`);
  assert.equal(runs.upstream.crash.name, expected.name);
  assert.equal(runs.upstream.crash.code, expected.code);
  assert.equal(runs.upstream.crash.message, expected.message);
  assert.equal(runs.ykk.code, runs.upstream.code, `ykk did not crash: ${runs.ykk.stdout}${runs.ykk.stderr}`);
  assert.deepStrictEqual(runs.ykk.crash, runs.upstream.crash);
}

describe('differential: preserved defects (PORTING.md 14.2, D1 to D8)', () => {
  let root;
  const restore = [];

  // PORTING.md 14.2 (determinism: one entry per walked directory, so readdir order cannot matter)
  function directoryOf(name, fill) {
    const dir = path.join(root, name);
    fs.mkdirSync(dir);
    if (fill !== undefined) {
      fill(dir);
    }
    return dir;
  }

  // PORTING.md 14.2 (D3, D4, D7: chmod denies nothing to root, and 14.6 allows no skip)
  function lock(target, mode) {
    assert.notEqual(process.getuid(), 0, 'D3, D4 and D7 need an unprivileged user: chmod does not deny access to root');
    fs.chmodSync(target, mode);
    restore.push(target);
  }

  before(async () => {
    await load('upstream');
    await load('ykk');
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ykk-diff-defects-')));
  });

  after(() => {
    for (const target of restore) {
      fs.chmodSync(target, 0o700);
    }
    fs.rmSync(root, { recursive: true, force: true });
  });

  describe('D1: a directory() data function that does not return an object (P1)', () => {
    for (const kind of Object.keys(DATA_FUNCTIONS)) {
      it(`${kind}: 'error', then finalize() never completes`, async () => {
        const dir = directoryOf(`d1-${kind.replace(/ /g, '-')}`, (target) => {
          fs.writeFileSync(path.join(target, 'one.txt'), 'one');
        });
        const runs = await runBoth(directoryDataFunction, { hang: HANG_QUIET_MS, args: { dir, kind } });
        assertHang(runs);
        assertNeverEnded(runs);
        const expected =
          kind === 'throws'
            ? { name: 'Error', code: undefined, message: 'data function failed', data: undefined }
            : {
                name: 'Error',
                code: 'DIRECTORYFUNCTIONINVALIDDATA',
                message: 'invalid data returned by directory custom data function',
                data: { dirpath: dir },
              };
        assert.deepStrictEqual(runs.upstream.events, [{ event: 'error', payload: expected }]);
      });
    }
  });

  describe('D2: a FIFO inside a walked directory (P2)', () => {
    it("'warning' ENTRYNOTSUPPORTED, then finalize() never completes", async () => {
      const dir = directoryOf('d2', (target) => {
        execFileSync('mkfifo', [path.join(target, 'pipe.fifo')]);
      });
      const runs = await runBoth(directoryWalk, { hang: HANG_QUIET_MS, args: { dir } });
      assertHang(runs);
      assertNeverEnded(runs);
      assert.equal(runs.upstream.events.length, 1);
      const [{ event, payload }] = runs.upstream.events;
      assert.equal(event, 'warning');
      assert.equal(payload.code, 'ENTRYNOTSUPPORTED');
      assert.equal(payload.message, 'entry not supported');
      assert.equal(payload.data.name, 'pipe.fifo');
      assert.equal(payload.data.prefix, 'walked');
      assert.equal(payload.data.sourcePath, path.join(dir, 'pipe.fifo'));
      assert.deepStrictEqual(payload.data.stats, { size: 0, type: 'fifo' });
    });
  });

  describe('D3: a walked directory with read but no search permission (P3)', () => {
    it("readdir succeeds, the lstat fails: 'warning', then finalize() never completes", async () => {
      const dir = directoryOf('d3', (target) => {
        fs.writeFileSync(path.join(target, 'one.txt'), 'one');
      });
      lock(dir, 0o400);
      const runs = await runBoth(directoryWalk, { hang: HANG_QUIET_MS, args: { dir } });
      assertHang(runs);
      assertNeverEnded(runs);
      assert.equal(runs.upstream.events.length, 1);
      const [{ event, payload }] = runs.upstream.events;
      assert.equal(event, 'warning');
      assert.equal(payload.code, 'EACCES');
      assert.equal(payload.message, `EACCES: permission denied, lstat '${path.join(dir, 'one.txt')}'`);
    });
  });

  describe('D4: a walk over an unreadable sub-directory (P4)', () => {
    it("the globber 'error' is emitted, then finalize() never completes", async () => {
      const dir = directoryOf('d4', (target) => {
        fs.mkdirSync(path.join(target, 'sub'));
        fs.writeFileSync(path.join(target, 'sub', 'one.txt'), 'one');
      });
      lock(path.join(dir, 'sub'), 0o000);
      const runs = await runBoth(directoryWalk, { hang: HANG_QUIET_MS, args: { dir } });
      assertHang(runs);
      assertNeverEnded(runs);
      const events = runs.upstream.events;
      assert.deepStrictEqual(
        events.map((record) => record.event),
        ['entry', 'progress', 'error']
      );
      assert.equal(events[0].payload.name, 'walked/sub/');
      assert.equal(events[0].payload.type, 'directory');
      assert.equal(events[2].payload.code, 'EACCES');
      assert.equal(events[2].payload.message, `EACCES: permission denied, scandir '${path.join(dir, 'sub')}'`);
      assert.ok(runs.ykk.bytes.equals(runs.upstream.bytes), 'the bytes written before the hang differ');
    });
  });

  describe('D5: abort() while finalize() is deferred (P5)', () => {
    it('json: the archive ends, the finalize() promise never settles', async () => {
      const file = path.join(root, 'd5.txt');
      fs.writeFileSync(file, 'file on disk');
      const runs = await runBoth(abortWhileFinalizeIsDeferred, { hang: HANG_QUIET_MS, args: { file } });
      assertHang(runs);
      assert.deepStrictEqual(runs.upstream.value, {
        state: { aborted: false, finalize: true, finalizing: false, finalized: false, modulePiped: true },
        returnsThis: true,
      });
      assert.deepStrictEqual(
        runs.upstream.events.map((record) => record.event),
        ['end', 'close']
      );
      assert.equal(runs.upstream.bytes.length, 0);
      assert.deepStrictEqual(runs.ykk.value, runs.upstream.value);
      assert.equal(runs.ykk.bytes.length, 0);
    });
  });

  describe('D6: collectStream calls back twice, and an unknown sourceType is a silent no-op (P21)', () => {
    for (const format of ['tar', 'json']) {
      it(`${format}: plugin append`, async () => {
        const runs = await runBoth(pluginAppend, { hang: SETTLE_MS, args: { format } });
        assertRan(runs);
        const settled = runs.upstream.settled;
        assert.deepStrictEqual(
          settled.map((record) => record.label),
          ['collectStream', 'collectStream']
        );
        assert.equal(settled[0].args.length, 1);
        assert.equal(settled[0].args[0].message, 'source failed');
        assert.equal(settled[1].args[0], null);
        assert.equal(settled[1].args[1].name, 'late.txt');
        assert.equal(settled[1].args[1].size, 6);
        assert.deepStrictEqual(runs.upstream.value, { returned: undefined });
        assert.deepStrictEqual(runs.upstream.events, []);
        assert.deepStrictEqual(runs.ykk.settled, runs.upstream.settled);
        assert.equal(ordered(runs.ykk.settled), ordered(runs.upstream.settled), `${format}: key order of the callback arguments`);
        assert.deepStrictEqual(runs.ykk.value, runs.upstream.value);
        assert.deepStrictEqual(runs.ykk.events, runs.upstream.events);
        assert.ok(runs.ykk.bytes.equals(runs.upstream.bytes), `${format}: the bytes written by the plugin differ`);
      });
    }
  });

  describe('D7: a lazily opened file that fails to open in the tar-with-stats path (P22)', () => {
    it("tar: the open error is an unhandled 'error' event", async () => {
      const file = path.join(root, 'd7-locked.txt');
      fs.writeFileSync(file, 'locked');
      lock(file, 0o000);
      const runs = await runBothInChild(scenarioReference(import.meta.url, 'lazyOpenFailure'), {
        wait: HANG_QUIET_MS,
        args: { file },
      });
      assertSameCrash(runs, {
        name: 'Error',
        code: 'EACCES',
        message: `EACCES: permission denied, open '${file}'`,
      });
    });
  });

  describe('D8: a dangling path whose readlinkSync throws (PORTING.md 13.3)', () => {
    it('file(path, { stats }): thrown synchronously, after the entry was counted', async () => {
      const dir = directoryOf('d8-file');
      const runs = await runBoth(readlinkFailureInFile, { hang: 0, args: { dir } });
      assertRan(runs);
      const link = path.join(dir, 'link');
      assert.equal(runs.upstream.value.thrown.name, 'Error');
      assert.equal(runs.upstream.value.thrown.code, 'ENOENT');
      assert.equal(runs.upstream.value.thrown.message, `ENOENT: no such file or directory, readlink '${link}'`);
      assert.equal(runs.upstream.value.entriesCount, 1);
      assert.deepStrictEqual(runs.upstream.events, []);
      assert.deepStrictEqual(runs.ykk.value, runs.upstream.value);
      assert.deepStrictEqual(runs.ykk.events, runs.upstream.events);
    });

    it('the stat queue: an uncaught exception out of the lstat callback', async () => {
      const dir = directoryOf('d8-stat-queue');
      const runs = await runBothInChild(scenarioReference(import.meta.url, 'readlinkFailureInStatQueue'), {
        wait: HANG_QUIET_MS,
        args: { dir },
      });
      assertSameCrash(runs, {
        name: 'Error',
        code: 'ENOENT',
        message: `ENOENT: no such file or directory, readlink '${path.join(dir, 'link')}'`,
      });
    });

    it("directory(): a globber 'error', then finalize() never completes (P4)", async () => {
      const dir = directoryOf('d8-directory');
      const runs = await runBoth(readlinkFailureInDirectory, { hang: HANG_QUIET_MS, args: { dir } });
      assertHang(runs);
      assertNeverEnded(runs);
      assert.deepStrictEqual(runs.upstream.events, [
        {
          event: 'error',
          payload: {
            name: 'Error',
            code: 'ENOENT',
            message: `ENOENT: no such file or directory, readlink '${path.join(dir, 'link')}'`,
            data: undefined,
          },
        },
      ]);
    });
  });
});
