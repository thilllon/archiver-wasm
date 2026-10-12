// PORTING.md 14.2: cases E1 to E4 (errors and events, every format). No upstream source.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { omitV15Keys, recordEvents, summarizeError } from './helpers/events.mjs';
import { CRASH_EXIT_CODE, load, runBoth, runBothInChild, scenarioReference } from './helpers/run-both.mjs';
import { splitGzip } from './helpers/tar-records.mjs';

const DATE = new Date('2013-01-03T14:26:38.000Z');
const CLOCK = new Date('2021-07-04T09:08:07.000Z');
const PASSWORD = '123';
const SALT = Buffer.from('000102030405060708090a0b0c0d0e0f', 'hex');
const ZIP20_HEADER = Buffer.from('0102030405060708090a0b0c', 'hex');
const FORMATS = ['zip', 'tar', 'tar.gz', 'json', 'aes256', 'zip20'];
const ENCRYPTED = ['aes256', 'zip20'];
// PORTING.md 3.2 V15 (a): the archiver 7 surface runs the archiver 8 core, which writes the keys of an entry in another order
const SAME_KEY_ORDER = ['zip', 'tar', 'tar.gz', 'json'];
// an emitted 'error' breaks the pipe from the module, so these archives never end: the scenario
// waits this long for what follows the call, the runner then takes the result and destroys them
const SETTLE_MS = 50;
// the child of the P9 case waits this long for the exception; an implementation that does not throw then exits with code 0
const CRASH_WAIT_MS = 500;
const BARE_FORMAT = 'archiver-wasm-diff-bare';
const NO_END_FORMAT = 'archiver-wasm-diff-no-end';
const UNREGISTERED_FORMAT = 'archiver-wasm-diff-unregistered';
const TAR_UNPIPE_MESSAGE = "Cannot read properties of undefined (reading 'apply')";

// node-archiver/lib/error.js:3-26
const ERROR_CODES = {
  ABORTED: 'archive was aborted',
  DIRECTORYDIRPATHREQUIRED: 'diretory dirpath argument must be a non-empty string value',
  DIRECTORYFUNCTIONINVALIDDATA: 'invalid data returned by directory custom data function',
  ENTRYNAMEREQUIRED: 'entry name must be a non-empty string value',
  FILEFILEPATHREQUIRED: 'file filepath argument must be a non-empty string value',
  FINALIZING: 'archive already finalizing',
  QUEUECLOSED: 'queue closed',
  NOENDMETHOD: 'no suitable finalize/end method defined by module',
  DIRECTORYNOTSUPPORTED: 'support for directory entries not defined by module',
  FORMATSET: 'archive format already set',
  INPUTSTEAMBUFFERREQUIRED: 'input source must be valid Stream or Buffer instance',
  MODULESET: 'module already set',
  SYMLINKNOTSUPPORTED: 'support for symlink entries not defined by module',
  SYMLINKFILEPATHREQUIRED: 'symlink filepath argument must be a non-empty string value',
  SYMLINKTARGETREQUIRED: 'symlink target argument must be a non-empty string value',
  ENTRYNOTSUPPORTED: 'entry not supported',
};

// PORTING.md 14.2 (helper of the test: a module without `supports`, so directories and symlinks are refused)
class BareModule extends PassThrough {
  append(source, data, callback) {
    callback(null, data);
  }

  finalize() {
    this.end();
  }
}

// PORTING.md 14.2 (helper of the test: an instance with neither `finalize` nor `end`, node-archiver/lib/core.js:219-225)
class NoEndModule extends BareModule {
  constructor(options) {
    super(options);
    this.finalize = undefined;
    this.end = undefined;
  }
}

// PORTING.md 14.2 (helper of the test: what follows a call that leaves no promise to await)
function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// PORTING.md 14.2 (helper of the test: one turn of the event loop)
function immediate() {
  return new Promise((resolve) => setImmediate(resolve));
}

// PORTING.md 14.2 (helper of the test: a fresh stream per implementation, written in the given chunks)
function streamOf(chunks) {
  const stream = new PassThrough();
  for (const chunk of chunks) {
    stream.write(chunk);
  }
  stream.end();
  return stream;
}

// PORTING.md 14.2 (options of one archive per format; stored, so that zip output is byte-equal)
function optionsOf(format) {
  switch (format) {
    case 'zip':
      return { store: true };
    case 'aes256':
      return { password: PASSWORD, salt: Buffer.from(SALT), store: true };
    case 'zip20':
      return { password: PASSWORD, store: true };
    default:
      return {};
  }
}

// PORTING.md 13.1 (channel and return value of one call: `this`, or what it threw)
function attempt(call, archive) {
  try {
    return { returnsThis: call() === archive };
  } catch (err) {
    return { thrown: summarizeError(err) };
  }
}

// PORTING.md 13.1 (the summary helpers/events.mjs makes of `new ArchiverError(code, data)`)
function archiverError(code, data) {
  return { name: 'Error', code, message: ERROR_CODES[code], data };
}

// PORTING.md 14.2 (helper of the test: the payloads of the recorded 'error' events)
function errorsOf(events) {
  return events.filter((record) => record.event === 'error').map((record) => record.payload);
}

// PORTING.md 14.2 (helper of the test: the recorded sequence of event names)
function namesOf(events) {
  return events.map((record) => record.event);
}

// PORTING.md 14.2 (helpers/events.mjs: own enumerable keys in order, which deepStrictEqual does not compare)
function ordered(value) {
  return JSON.stringify(value, (key, item) => (item === undefined ? '[undefined]' : item));
}

// PORTING.md 14.2 (events: for aes256 and zip20 the keys only the archiver 7 stack writes are ignored, V15)
function comparedEvents(format, events) {
  return ENCRYPTED.includes(format) ? omitV15Keys(events) : events;
}

// PORTING.md 14.2 (helper of the test: the scenario function itself returned on both implementations)
function assertRan({ upstream, port }) {
  assert.equal(upstream.error, null, 'upstream: the scenario threw');
  assert.equal(port.error, null, 'port: the scenario threw');
}

// PORTING.md 14.2 (events: the sequences are equal; byte-equal cases also agree on pointer() and bytes)
function assertSameRun(format, { upstream, port }) {
  assert.deepStrictEqual(comparedEvents(format, port.events), comparedEvents(format, upstream.events));
  assert.deepStrictEqual(port.settled, upstream.settled);
  assert.deepStrictEqual(port.value, upstream.value);
  if (SAME_KEY_ORDER.includes(format)) {
    assert.equal(ordered(port.events), ordered(upstream.events), `${format}: key order of the event payloads`);
    assert.equal(ordered(port.settled), ordered(upstream.settled), `${format}: key order of what settled`);
    assert.equal(ordered(port.value), ordered(upstream.value), `${format}: key order of the returned value`);
  }
}

// PORTING.md 3.2 V1 (a gzip member differs in its deflate stream only)
function assertSameBytes(format, { upstream, port }) {
  if (format === 'tar.gz') {
    const u = splitGzip(upstream.bytes);
    const y = splitGzip(port.bytes);
    assert.deepStrictEqual(y.header, u.header);
    assert.deepStrictEqual(y.payload, u.payload);
    assert.deepStrictEqual(y.trailer, u.trailer);
    return;
  }
  assert.equal(port.bytes.length, upstream.bytes.length);
  assert.ok(port.bytes.equals(upstream.bytes), `${format}: archive bytes differ`);
}

// node-archiver/lib/core.js:525-556, 570-578, 651-659, 749-771 (one call per row, each on a fresh archive)
const ARGUMENT_STEPS = [
  { title: "directory('')", code: 'DIRECTORYDIRPATHREQUIRED', run: (archive) => archive.directory('') },
  { title: 'directory(5)', code: 'DIRECTORYDIRPATHREQUIRED', run: (archive) => archive.directory(5) },
  { title: "append('x', {})", code: 'ENTRYNAMEREQUIRED', run: (archive) => archive.append('x', {}) },
  { title: "append('x', { name: '' })", code: 'ENTRYNAMEREQUIRED', run: (archive) => archive.append('x', { name: '' }) },
  { title: "append('x')", code: 'ENTRYNAMEREQUIRED', run: (archive) => archive.append('x') },
  { title: "file('')", code: 'FILEFILEPATHREQUIRED', run: (archive) => archive.file('') },
  { title: 'file(null)', code: 'FILEFILEPATHREQUIRED', run: (archive) => archive.file(null) },
  {
    title: "append(5, { name: 'n.txt' })",
    code: 'INPUTSTEAMBUFFERREQUIRED',
    data: { name: 'n.txt' },
    run: (archive) => archive.append(5, { name: 'n.txt' }),
  },
  {
    title: "append({}, { name: 'o.txt' })",
    code: 'INPUTSTEAMBUFFERREQUIRED',
    data: { name: 'o.txt' },
    run: (archive) => archive.append({}, { name: 'o.txt' }),
  },
  { title: "symlink('', 't')", code: 'SYMLINKFILEPATHREQUIRED', run: (archive) => archive.symlink('', 't') },
  { title: "symlink(5, 't')", code: 'SYMLINKFILEPATHREQUIRED', run: (archive) => archive.symlink(5, 't') },
  {
    title: "symlink('l', '')",
    code: 'SYMLINKTARGETREQUIRED',
    data: { filepath: 'l' },
    run: (archive) => archive.symlink('l', ''),
  },
  // PORTING.md 13.3: normalize-path, reached from sanitizePath
  {
    title: "append('x', { name: 5 })",
    thrown: { name: 'TypeError', message: 'expected path to be a string' },
    run: (archive) => archive.append('x', { name: 5 }),
  },
];

// node-archiver/lib/core.js:526-529, 571-574, 652-655, 750-753 (not glob: core.js:672-673, P6)
const CLOSED_STEPS = [
  { title: 'append', run: (archive) => archive.append('late', { name: 'late.txt', date: DATE }) },
  { title: 'file', run: (archive, args) => archive.file(args.file, { name: 'late.txt' }) },
  { title: 'directory', run: (archive, args) => archive.directory(args.walk, 'late') },
  { title: 'symlink', run: (archive) => archive.symlink('late-link', 'late.txt') },
];

// node-archiver/lib/core.js:525-556, 570-578, 651-659, 749-771
async function argumentErrors(impl, ctx) {
  const steps = [];
  for (const step of ARGUMENT_STEPS) {
    const archive = ctx.create(ctx.args.format, optionsOf(ctx.args.format));
    const events = recordEvents(archive);
    steps.push({ title: step.title, call: attempt(() => step.run(archive), archive), events });
  }
  await delay(SETTLE_MS);
  return steps.map((step) => ({ ...step, events: step.events.slice() }));
}

// node-archiver/lib/core.js:526-529, 571-574, 652-655, 750-753 (after finalize() and after abort())
async function queueClosed(impl, ctx) {
  const steps = [];
  const watched = [];
  for (const closedBy of ['finalize', 'abort']) {
    for (const step of CLOSED_STEPS) {
      const title = `${step.title} after ${closedBy}`;
      const archive = ctx.create(ctx.args.format, optionsOf(ctx.args.format));
      const events = recordEvents(archive);
      let closing = null;
      if (closedBy === 'finalize') {
        watched.push(ctx.watch(title, archive.finalize()));
      } else {
        closing = attempt(() => archive.abort(), archive);
      }
      steps.push({ title, closing, call: attempt(() => step.run(archive, ctx.args), archive), events });
    }
  }
  await Promise.all(watched);
  await delay(SETTLE_MS);
  return steps.map((step) => ({ ...step, events: step.events.slice() }));
}

// node-archiver/lib/core.js:672-707 (P6: glob() has no QUEUECLOSED check)
async function globAfterFinalize(impl, ctx) {
  const archive = ctx.create(ctx.args.format, optionsOf(ctx.args.format));
  const finalized = ctx.watch('finalize', archive.finalize());
  const call = attempt(() => archive.glob('*.txt', { cwd: ctx.args.walk }), archive);
  const pendingAfterCall = archive._pending;
  const deadline = Date.now() + 1000;
  while (archive._pending !== 0 && Date.now() < deadline) {
    await delay(5);
  }
  await finalized;
  return { call, pendingAfterCall, pending: archive._pending, entriesCount: archive._entriesCount };
}

// node-archiver/lib/core.js:605-625 (P1 is case D1; here only the code, its event and its payload)
async function directoryFunctionInvalidData(impl, ctx) {
  const archive = ctx.create(ctx.args.format, optionsOf(ctx.args.format));
  const call = attempt(() => archive.directory(ctx.args.walk, 'walked', () => 5), archive);
  await once(archive, 'error');
  return { call };
}

// node-archiver/lib/core.js:399-408, 487-490 (fs path: 'warning', and the archive still completes)
async function fsWarnings(impl, ctx) {
  const archive = ctx.create(ctx.args.format, optionsOf(ctx.args.format));
  archive.file(ctx.args.fifo, { name: 'pipe.fifo' });
  await once(archive, 'warning');
  archive.file(ctx.args.missing, { name: 'missing.txt' });
  await once(archive, 'warning');
  await ctx.watch('finalize', archive.finalize());
}

// archiver-zip-encrypted/node_modules/archiver/index.js:29-64 (the registry is per implementation and per process)
function registerModules(impl) {
  if (!impl.archiver.isRegisteredFormat(BARE_FORMAT)) {
    impl.archiver.registerFormat(BARE_FORMAT, BareModule);
  }
  if (!impl.archiver.isRegisteredFormat(NO_END_FORMAT)) {
    impl.archiver.registerFormat(NO_END_FORMAT, NoEndModule);
  }
}

// node-archiver/lib/core.js:218-226, 534-541, 765-771; archiver-zip-encrypted/node_modules/archiver/lib/core.js:813-845
const MODULE_STEPS = [
  {
    title: "append(null, { name: 'd/' })",
    code: 'DIRECTORYNOTSUPPORTED',
    data: { name: 'd/' },
    run: (archive) => attempt(() => archive.append(null, { name: 'd/' }), archive),
  },
  {
    title: "symlink('l', 't')",
    code: 'SYMLINKNOTSUPPORTED',
    data: { filepath: 'l' },
    run: (archive) => attempt(() => archive.symlink('l', 't'), archive),
  },
  {
    title: 'setFormat twice',
    code: 'FORMATSET',
    run: (archive) => ({ ...attempt(() => archive.setFormat('again'), archive), format: archive._format }),
  },
  {
    // P23: `_state.module` is never set, so MODULESET is never raised
    title: 'setModule twice',
    code: null,
    run: (archive) => {
      const second = new BareModule();
      return { ...attempt(() => archive.setModule(second), archive), replaced: archive._module === second };
    },
  },
  {
    title: 'setModule after abort',
    code: 'ABORTED',
    run: (archive) => {
      const aborting = attempt(() => archive.abort(), archive);
      return { aborting, ...attempt(() => archive.setModule(new BareModule()), archive) };
    },
  },
  {
    title: 'finalize without finalize or end',
    format: NO_END_FORMAT,
    code: 'NOENDMETHOD',
    run: (archive, ctx) => {
      ctx.watch('finalize without finalize or end', archive.finalize());
      return { state: { ...archive._state } };
    },
  },
];

// node-archiver/lib/core.js:218-226, 534-541, 765-771; archiver-zip-encrypted/node_modules/archiver/lib/core.js:813-845
async function moduleErrors(impl, ctx) {
  registerModules(impl);
  const steps = [];
  for (const step of MODULE_STEPS) {
    const archive = ctx.track(impl.archiver.create(step.format === undefined ? BARE_FORMAT : step.format));
    const events = recordEvents(archive);
    steps.push({ title: step.title, call: step.run(archive, ctx), events });
  }
  await delay(SETTLE_MS);
  return steps.map((step) => ({ ...step, events: step.events.slice() }));
}

// node-archiver/lib/core.js:476-490 (fs path of a module without directory and symlink support: 'warning')
async function moduleWarnings(impl, ctx) {
  registerModules(impl);
  const archive = ctx.track(impl.archiver(BARE_FORMAT));
  archive.file(ctx.args.walk, { name: 'sub' });
  await once(archive, 'warning');
  archive.file(ctx.args.link, { name: 'ln' });
  await once(archive, 'warning');
  await ctx.watch('finalize', archive.finalize());
}

// archiver-zip-encrypted/node_modules/archiver/index.js:29-64; archiver-zip-encrypted/lib/zip-encrypted.js:24-41
const CONSTRUCTION_STEPS = [
  {
    title: 'create: format not registered',
    message: `create(${UNREGISTERED_FORMAT}): format not registered`,
    run: (impl) => impl.archiver.create(UNREGISTERED_FORMAT),
  },
  {
    title: 'vending function: format not registered',
    message: `create(${UNREGISTERED_FORMAT}): format not registered`,
    run: (impl) => impl.archiver(UNREGISTERED_FORMAT),
  },
  {
    title: 'registerFormat: already registered',
    message: 'register(zip): format already registered',
    run: (impl) => impl.archiver.registerFormat('zip', BareModule),
  },
  {
    title: 'registerFormat: zip-encrypted already registered',
    message: 'register(zip-encrypted): format already registered',
    run: (impl) => impl.archiver.registerFormat('zip-encrypted', impl.ZipEncrypted),
  },
  {
    title: 'registerFormat: module invalid',
    message: 'register(archiver-wasm-diff-invalid): format module invalid',
    run: (impl) => impl.archiver.registerFormat('archiver-wasm-diff-invalid', {}),
  },
  {
    title: 'registerFormat: module missing methods',
    message: 'register(archiver-wasm-diff-missing): format module missing methods',
    run: (impl) =>
      impl.archiver.registerFormat(
        'archiver-wasm-diff-missing',
        class {
          append(source, data, callback) {
            callback(null, data);
          }
        }
      ),
  },
  {
    title: 'ZipEncrypted: no password',
    message: 'options.password is required',
    run: (impl) => new impl.ZipEncrypted({}),
  },
  {
    title: 'ZipEncrypted: no options',
    message: 'options.password is required',
    run: (impl) => new impl.ZipEncrypted(),
  },
  {
    title: 'ZipEncrypted: the password is checked first',
    message: 'options.password is required',
    run: (impl) => new impl.ZipEncrypted({ encryptionMethod: 'bogus' }),
  },
  {
    title: 'ZipEncrypted: unsupported method',
    message: "Unsupported encryption method: 'bogus'. Please use either 'aes256' or 'zip20'.",
    run: (impl) => new impl.ZipEncrypted({ password: PASSWORD, encryptionMethod: 'bogus' }),
  },
  {
    title: 'ZipEncrypted: no method',
    message: "Unsupported encryption method: 'undefined'. Please use either 'aes256' or 'zip20'.",
    run: (impl) => new impl.ZipEncrypted({ password: PASSWORD }),
  },
  {
    title: 'create zip-encrypted: no password',
    message: 'options.password is required',
    run: (impl) => impl.archiver.create('zip-encrypted', { encryptionMethod: 'aes256' }),
  },
];

// archiver-zip-encrypted/node_modules/archiver/index.js:29-73; archiver-zip-encrypted/lib/zip-encrypted.js:24-41
async function constructionErrors(impl) {
  const steps = CONSTRUCTION_STEPS.map((step) => {
    try {
      step.run(impl);
      return { title: step.title, thrown: null };
    } catch (err) {
      return { title: step.title, thrown: summarizeError(err) };
    }
  });
  const registered = {};
  for (const format of ['zip', 'tar', 'json', 'zip-encrypted', UNREGISTERED_FORMAT, 'archiver-wasm-diff-invalid', 'archiver-wasm-diff-missing']) {
    registered[format] = impl.archiver.isRegisteredFormat(format);
  }
  return { steps, registered };
}

// node-archiver/lib/core.js:70-77, 507-513 (nothing queued: _abort shuts down at once)
async function abortBeforeAnyEntry(impl, ctx) {
  const archive = ctx.create(ctx.args.format, optionsOf(ctx.args.format));
  const call = attempt(() => archive.abort(), archive);
  if (call.thrown === undefined) {
    await once(archive, 'close');
  }
  return { call, state: { ...archive._state } };
}

// node-archiver/lib/core.js:70-77, 170-178 (the queue is busy: the shutdown waits for the module's callback)
async function abortDuringEntry(impl, ctx) {
  const archive = ctx.create(ctx.args.format, optionsOf(ctx.args.format));
  const source = new PassThrough();
  source.write('abc');
  archive.append(source, { name: 'stream.txt', date: DATE });
  await immediate();
  const call = attempt(() => archive.abort(), archive);
  source.end('def');
  await once(archive, 'close');
  return { call, state: { ...archive._state } };
}

// node-archiver/lib/core.js:170-177, node-archiver/lib/plugins/tar.js:115 (P9: thrown inside the module callback, so 'close' never comes)
export async function abortDuringTarEntry(impl, ctx) {
  const archive = ctx.create('tar');
  const source = new PassThrough();
  source.write('abc');
  archive.append(source, { name: 'stream.txt', date: DATE });
  await immediate();
  const call = attempt(() => archive.abort(), archive);
  source.end('def');
  return { call };
}

// node-archiver/lib/core.js:507-510 (P5, the resolving half: finalized, so abort() is a no-op)
async function abortAfterSynchronousFinalize(impl, ctx) {
  const archive = ctx.create(ctx.args.format, optionsOf(ctx.args.format));
  const finalized = ctx.watch('finalize', archive.finalize());
  const state = { ...archive._state };
  const call = attempt(() => archive.abort(), archive);
  await finalized;
  return { call, state };
}

// PORTING.md 13.1 (ABORTED and FINALIZING: the emitted error is the rejection; R13: own enumerable keys)
async function rejectedFinalize(archive, ctx, label) {
  let emitted;
  archive.once('error', (err) => {
    emitted = err;
  });
  let rejected;
  const promise = archive.finalize();
  await ctx.watch(
    label,
    promise.catch((err) => {
      rejected = err;
      throw err;
    })
  );
  return {
    sameError: emitted !== undefined && emitted === rejected,
    isError: emitted instanceof Error,
    name: emitted === undefined ? undefined : emitted.name,
    keys: emitted === undefined ? undefined : Object.keys(emitted),
  };
}

// node-archiver/lib/core.js:716-720
async function finalizeTwice(impl, ctx) {
  const archive = ctx.create(ctx.args.format, optionsOf(ctx.args.format));
  const first = ctx.watch('first', archive.finalize());
  const second = await rejectedFinalize(archive, ctx, 'second');
  await first;
  return second;
}

// node-archiver/lib/core.js:711-715
async function finalizeAfterAbort(impl, ctx) {
  const archive = ctx.create(ctx.args.format, optionsOf(ctx.args.format));
  const aborting = attempt(() => archive.abort(), archive);
  return { aborting, ...(await rejectedFinalize(archive, ctx, 'finalize')) };
}

// node-archiver/lib/core.js:164-209 ('entry' and 'progress' per entry), 792-794 (pointer)
async function fullSequence(impl, ctx) {
  const archive = ctx.create(ctx.args.format, optionsOf(ctx.args.format));
  archive.append(Buffer.from('buffer source'), { name: 'buffer.txt', date: DATE, mode: 0o644 });
  archive.append('string source', { name: 'string.txt', date: DATE, prefix: 'prefix' });
  archive.append(streamOf(['stream ', 'source']), { name: 'stream.txt', date: DATE });
  archive.append(null, { name: 'dir/', date: DATE });
  archive.file(ctx.args.file, { name: 'file.txt', date: DATE, mode: 0o600, stats: ctx.args.stats });
  archive.symlink('link.txt', 'buffer.txt', 0o777);
  const pointerBefore = archive.pointer();
  await archive.finalize();
  return { pointerBefore };
}

describe('differential: errors and events (PORTING.md 14.2, E1 to E4)', () => {
  let root;
  let args;

  before(async () => {
    await load('upstream');
    await load('port');
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'archiver-wasm-diff-errors-')));
    const walk = path.join(root, 'walk');
    fs.mkdirSync(walk);
    fs.writeFileSync(path.join(walk, 'one.txt'), 'one');
    const file = path.join(root, 'file.txt');
    fs.writeFileSync(file, 'file on disk');
    fs.chmodSync(file, 0o640);
    fs.lutimesSync(file, DATE, DATE);
    const fifo = path.join(root, 'pipe.fifo');
    execFileSync('mkfifo', [fifo]);
    const link = path.join(root, 'link');
    fs.symlinkSync('file.txt', link);
    args = { walk, file, fifo, link, missing: path.join(root, 'missing.txt'), stats: fs.lstatSync(file) };
  });

  after(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  describe('E1: every ArchiverError code with its event, payload and return value', () => {
    for (const format of FORMATS) {
      it(`${format}: argument errors are emitted as 'error' and the call returns this`, async () => {
        const runs = await runBoth(argumentErrors, { hang: 0, args: { format } });
        assertRan(runs);
        for (const [index, step] of ARGUMENT_STEPS.entries()) {
          const observed = runs.upstream.value[index];
          if (step.thrown !== undefined) {
            assert.deepStrictEqual(
              { name: observed.call.thrown.name, message: observed.call.thrown.message },
              step.thrown,
              step.title
            );
            assert.deepStrictEqual(observed.events, [], step.title);
          } else {
            assert.deepStrictEqual(observed.call, { returnsThis: true }, step.title);
            assert.deepStrictEqual(observed.events[0], { event: 'error', payload: archiverError(step.code, step.data) }, step.title);
            assert.ok(errorsOf(observed.events).every((error) => error.code === step.code), step.title);
          }
        }
        assertSameRun(format, runs);
      });

      it(`${format}: QUEUECLOSED after finalize() and after abort()`, async () => {
        const runs = await runBoth(queueClosed, { hang: 0, args: { format, ...args } });
        assertRan(runs);
        for (const observed of runs.upstream.value) {
          assert.deepStrictEqual(observed.call, { returnsThis: true }, observed.title);
          assert.deepStrictEqual(errorsOf(observed.events)[0], archiverError('QUEUECLOSED', undefined), observed.title);
          assert.ok(errorsOf(observed.events).every((error) => error.code === 'QUEUECLOSED'), observed.title);
        }
        assertSameRun(format, runs);
      });

      it(`${format}: glob() after finalize() raises nothing (P6)`, async () => {
        const runs = await runBoth(globAfterFinalize, { args: { format, ...args } });
        assertRan(runs);
        assert.deepStrictEqual(runs.upstream.value, {
          call: { returnsThis: true },
          pendingAfterCall: 1,
          pending: 0,
          entriesCount: 1,
        });
        assert.deepStrictEqual(namesOf(runs.upstream.events), ['end', 'close']);
        assert.deepStrictEqual(runs.upstream.settled, [{ label: 'finalize', state: 'fulfilled' }]);
        assertSameRun(format, runs);
        assertSameBytes(format, runs);
      });

      it(`${format}: DIRECTORYFUNCTIONINVALIDDATA carries { dirpath }`, async () => {
        const runs = await runBoth(directoryFunctionInvalidData, { hang: SETTLE_MS, args: { format, ...args } });
        assertRan(runs);
        assert.deepStrictEqual(runs.upstream.value, { call: { returnsThis: true } });
        assert.deepStrictEqual(runs.upstream.events[0], {
          event: 'error',
          payload: archiverError('DIRECTORYFUNCTIONINVALIDDATA', { dirpath: args.walk }),
        });
        assertSameRun(format, runs);
      });

      it(`${format}: ENTRYNOTSUPPORTED and an lstat failure are warnings`, async () => {
        const runs = await runBoth(fsWarnings, { args: { format, ...args } });
        assertRan(runs);
        const events = runs.upstream.events;
        assert.deepStrictEqual(namesOf(events), ['warning', 'warning', 'end', 'close']);
        assert.deepStrictEqual(
          events[0].payload,
          archiverError('ENTRYNOTSUPPORTED', { name: 'pipe.fifo', sourcePath: args.fifo })
        );
        assert.equal(events[1].payload.code, 'ENOENT');
        assert.equal(events[1].payload.data, undefined);
        assert.deepStrictEqual(runs.upstream.settled, [{ label: 'finalize', state: 'fulfilled' }]);
        assertSameRun(format, runs);
        assertSameBytes(format, runs);
      });
    }

    it('a module without support: DIRECTORYNOTSUPPORTED, SYMLINKNOTSUPPORTED, FORMATSET, ABORTED, NOENDMETHOD; never MODULESET (P23)', async () => {
      const runs = await runBoth(moduleErrors, { hang: 0 });
      assertRan(runs);
      for (const [index, step] of MODULE_STEPS.entries()) {
        const observed = runs.upstream.value[index];
        if (step.code === null) {
          assert.deepStrictEqual(observed.call, { returnsThis: true, replaced: true }, step.title);
          assert.deepStrictEqual(errorsOf(observed.events), [], step.title);
        } else {
          assert.deepStrictEqual(errorsOf(observed.events), [archiverError(step.code, step.data)], step.title);
        }
      }
      const [directory, symlink, setFormat, , setModuleAfterAbort, noEnd] = runs.upstream.value;
      assert.deepStrictEqual(directory.call, { returnsThis: true });
      assert.deepStrictEqual(symlink.call, { returnsThis: true });
      assert.deepStrictEqual(setFormat.call, { returnsThis: true, format: BARE_FORMAT });
      assert.deepStrictEqual(setModuleAfterAbort.call, { aborting: { returnsThis: true }, returnsThis: true });
      assert.equal(noEnd.call.state.finalized, true);
      assert.deepStrictEqual(runs.upstream.settled, []);
      assertSameRun('module', runs);
    });

    it('a module without support: directories and symlinks from the file system are warnings', async () => {
      const runs = await runBoth(moduleWarnings, { args });
      assertRan(runs);
      const events = runs.upstream.events;
      assert.deepStrictEqual(namesOf(events), ['warning', 'warning', 'end', 'close']);
      assert.deepStrictEqual(events[0].payload, archiverError('DIRECTORYNOTSUPPORTED', { name: 'sub', sourcePath: args.walk }));
      assert.deepStrictEqual(events[1].payload, archiverError('SYMLINKNOTSUPPORTED', { name: 'ln', sourcePath: args.link }));
      assert.deepStrictEqual(runs.upstream.settled, [{ label: 'finalize', state: 'fulfilled' }]);
      assertSameRun('module', runs);
    });

    it('registerFormat, create and the ZipEncrypted constructor throw', async () => {
      const runs = await runBoth(constructionErrors);
      assertRan(runs);
      for (const [index, step] of CONSTRUCTION_STEPS.entries()) {
        const observed = runs.upstream.value.steps[index];
        assert.notEqual(observed.thrown, null, step.title);
        assert.equal(observed.thrown.name, 'Error', step.title);
        assert.equal(observed.thrown.message, step.message, step.title);
      }
      assert.deepStrictEqual(runs.upstream.value.registered, {
        zip: true,
        tar: true,
        json: true,
        'zip-encrypted': true,
        [UNREGISTERED_FORMAT]: false,
        'archiver-wasm-diff-invalid': false,
        'archiver-wasm-diff-missing': false,
      });
      assert.deepStrictEqual(runs.port.value, runs.upstream.value);
    });
  });

  describe('E2: abort()', () => {
    for (const format of FORMATS) {
      it(`${format}: before any entry`, async () => {
        const runs = await runBoth(abortBeforeAnyEntry, { hang: 0, args: { format } });
        assertRan(runs);
        if (format === 'tar') {
          // P9: Tar.unpipe without gzip (node-archiver/lib/plugins/tar.js:115)
          assert.equal(runs.upstream.value.call.thrown.name, 'TypeError');
          assert.equal(runs.upstream.value.call.thrown.message, TAR_UNPIPE_MESSAGE);
          assert.deepStrictEqual(runs.upstream.events, []);
        } else {
          assert.deepStrictEqual(runs.upstream.value.call, { returnsThis: true });
          assert.deepStrictEqual(namesOf(runs.upstream.events), ['end', 'close']);
        }
        assert.equal(runs.upstream.value.state.aborted, true);
        assertSameRun(format, runs);
      });

      if (format === 'tar') {
        it('tar: during an entry (P9: the shutdown throws inside the module callback)', async () => {
          const runs = await runBothInChild(scenarioReference(import.meta.url, 'abortDuringTarEntry'), {
            wait: CRASH_WAIT_MS,
          });
          assert.equal(runs.upstream.code, CRASH_EXIT_CODE, runs.upstream.stderr);
          assert.deepStrictEqual(runs.upstream.crash, { name: 'TypeError', message: TAR_UNPIPE_MESSAGE });
          assert.equal(runs.port.code, runs.upstream.code, runs.port.stderr);
          assert.deepStrictEqual(runs.port.crash, runs.upstream.crash);
        });
      } else {
        it(`${format}: during an entry`, async () => {
          const runs = await runBoth(abortDuringEntry, { hang: 0, args: { format } });
          assertRan(runs);
          assert.deepStrictEqual(runs.upstream.value.call, { returnsThis: true });
          assert.deepStrictEqual(namesOf(runs.upstream.events), ['end', 'close']);
          assertSameRun(format, runs);
        });
      }

      it(`${format}: after a synchronous finalize() it is a no-op and the promise resolves (P5)`, async () => {
        const runs = await runBoth(abortAfterSynchronousFinalize, { args: { format } });
        assertRan(runs);
        assert.deepStrictEqual(runs.upstream.value.call, { returnsThis: true });
        assert.equal(runs.upstream.value.state.finalized, true);
        assert.deepStrictEqual(namesOf(runs.upstream.events), ['end', 'close']);
        assert.deepStrictEqual(runs.upstream.settled, [{ label: 'finalize', state: 'fulfilled' }]);
        assertSameRun(format, runs);
        assertSameBytes(format, runs);
        if (format !== 'tar.gz') {
          assert.equal(runs.port.pointer, runs.upstream.pointer);
        }
      });
    }
  });

  describe('E3: finalize() twice, and finalize() after abort()', () => {
    for (const format of FORMATS) {
      it(`${format}: the second finalize() emits FINALIZING and rejects with the same error`, async () => {
        const runs = await runBoth(finalizeTwice, { hang: SETTLE_MS, args: { format } });
        assertRan(runs);
        assert.deepStrictEqual(runs.upstream.value, {
          sameError: true,
          isError: true,
          name: 'Error',
          keys: ['message', 'code', 'data'],
        });
        assert.deepStrictEqual(errorsOf(runs.upstream.events)[0], archiverError('FINALIZING', undefined));
        assert.deepStrictEqual(
          runs.upstream.settled.find((record) => record.label === 'second'),
          { label: 'second', state: 'rejected', error: archiverError('FINALIZING', undefined) }
        );
        assertSameRun(format, runs);
      });

      it(`${format}: finalize() after abort() emits ABORTED and rejects with the same error`, async () => {
        const runs = await runBoth(finalizeAfterAbort, { hang: SETTLE_MS, args: { format } });
        assertRan(runs);
        assert.equal(runs.upstream.value.sameError, true);
        assert.deepStrictEqual(runs.upstream.value.keys, ['message', 'code', 'data']);
        assert.deepStrictEqual(errorsOf(runs.upstream.events)[0], archiverError('ABORTED', undefined));
        assert.deepStrictEqual(runs.upstream.settled, [
          { label: 'finalize', state: 'rejected', error: archiverError('ABORTED', undefined) },
        ]);
        assertSameRun(format, runs);
      });
    }
  });

  describe('E4: full event sequence and pointer()', () => {
    for (const format of FORMATS) {
      it(`${format}: entry and progress per entry, then end and close`, async () => {
        const runs = await runBoth(fullSequence, { clock: CLOCK, random: ZIP20_HEADER, args: { format, ...args } });
        assertRan(runs);
        const events = runs.upstream.events;
        assert.deepStrictEqual(namesOf(events), [
          ...Array.from({ length: 6 }, () => ['entry', 'progress']).flat(),
          'end',
          'close',
        ]);
        assert.deepStrictEqual(
          events.filter((record) => record.event === 'entry').map((record) => record.payload.name),
          ['buffer.txt', 'prefix/string.txt', 'stream.txt', 'dir/', 'file.txt', 'link.txt']
        );
        assert.deepStrictEqual(events[events.length - 3].payload, {
          entries: { total: 6, processed: 6 },
          fs: { totalBytes: args.stats.size, processedBytes: args.stats.size },
        });
        assert.deepStrictEqual(runs.upstream.value, { pointerBefore: 0 });
        assertSameRun(format, runs);
        assertSameBytes(format, runs);
        if (format !== 'tar.gz') {
          assert.equal(runs.upstream.pointer, runs.upstream.bytes.length);
          assert.equal(runs.port.pointer, runs.upstream.pointer);
        }
      });
    }
  });
});
