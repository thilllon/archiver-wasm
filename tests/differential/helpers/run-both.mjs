// tests/differential/helpers/run-both.mjs
// Scenario runner of the differential tests (PORTING.md 14.2).
//
//   runBoth(scenario, options)          -> { upstream, ykk }, run in this process, upstream first
//   runOne(name, scenario, options)     -> { bytes, events, error, pointer, pointerAtEnd, settled, value }
//   runBothInChild(reference, options)  -> { upstream, ykk }, each
//                                          { code, signal, stdout, stderr, crash, unsettled, result }
//   scenarioReference(moduleUrl, exportName)   the <scenario> argument of `--child <impl> <scenario>`
//   load(name)                          -> the implementation object a scenario receives
//
// A scenario is `async (impl, ctx) => { ... }`. It is called once per implementation.
//
//   impl.name                                         'upstream' or 'ykk'
//   impl.Archiver, ZipArchive, TarArchive, JsonArchive, ArchiverError     the archiver 8 surface
//   impl.archiver                                     the archiver 7 vending function, 'zip-encrypted' registered
//   impl.ZipEncrypted, ZipAesStream, ZipCryptoStream, AesHmacEtmStream, CryptoStream, DecryptoStream, CryptoCipher
//
//   ctx.create(format, options, trackOptions)   'zip' | 'tar' | 'tar.gz' | 'json' | 'aes256' | 'zip20', tracked
//   ctx.track(emitter, { events, data })        record its events and collect its output bytes
//   ctx.watch(label, promise)                   note in `settled` when the promise settles
//   ctx.callback(label)                         a callback that notes in `settled` when it is called
//   ctx.zip20Header                             options.random as a Buffer, for an engine built by hand
//   ctx.args                                    options.args
//
// ctx.create('aes256' | 'zip20', options) hands the implementation a copy of `options` with
// `encryptionMethod` (and for ykk `zip20Header`) added. A case about the caller's options object itself
// (V15 (a), case A4) calls impl.archiver.create with its own object and passes the archive to ctx.track.
//
// result:
//   pointer        pointer() of the first tracked archive when the scenario returned (a scenario that awaits
//                  finalize(): at finalize resolution); with `hang`, the same value as pointerAtEnd
//   pointerAtEnd   pointer() after the wait, taken together with bytes, events and settled
//
// options:
//   clock    milliseconds or a Date: `new Date()` and `Date.now()` answer it during both runs
//   random   12 bytes (Buffer or hex): every crypto.randomBytes(12) of the upstream run returns them,
//            and ctx.create('zip20') passes them to ykk as zip20Header (V10)
//   wait     'end' (default: until every tracked stream ended), 'none', or milliseconds
//   endTimeout   milliseconds: bound of the 'end' wait; past it the tracked streams are destroyed and the
//            run rejects. Without it the wait is unbounded (the slow cases run with --timeout 0).
//   hang     milliseconds: wait that long after the scenario returned, take the result, then destroy
//            every tracked stream (the hang cases)
//   args     passed to the scenario as ctx.args (JSON in a child process)
//   cwd, timeout    child process only; the child is killed after `timeout` (default 10000 ms, longer
//            than mocha's default test timeout: pass one below the timeout of the test)
//
// A child prints its result as one JSON line (undefined, NaN and the infinities survive the round trip),
// then exits with code 0 once its event loop is empty, or HANG_QUIET_MS later if a handle is still open.
// An uncaught exception prints { name, code, message } and exits with CRASH_EXIT_CODE, also after the
// result line. An event loop that empties before the run settled prints { unsettled: true } and exits
// with UNSETTLED_EXIT_CODE. runChild rejects when a child exits with code 0 and no result line.

import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { EVENTS, recordEvents, summarize, summarizeError } from './events.mjs';

const require = createRequire(import.meta.url);
const SELF = fileURLToPath(import.meta.url);

const ROOT = path.resolve(path.dirname(SELF), '../../..');
const IMPLEMENTATIONS = ['upstream', 'ykk'];
export const CRASH_EXIT_CODE = 7;
const UNSETTLED_EXIT_CODE = 8;
export const HANG_QUIET_MS = 500;

const ZIP20_HEADER_LENGTH = 12;
const JSON_TAG = '$run-both';
const MOCHA_GLOBALS = ['describe', 'context', 'it', 'specify', 'before', 'after', 'beforeEach', 'afterEach'];

const loaded = new Map();
let installed = null;

// the oracle of PORTING.md 14.2: archiver 8.0.0, and the archiver 7.0.0 that archiver-zip-encrypted
// 2.0.0 resolves, with the format registered as archiver-zip-encrypted/test/zip-aes.js:13-19 does
async function loadUpstream() {
  const entry = require.resolve('archiver');
  const ns = await import(pathToFileURL(entry).href);
  const error = await import(pathToFileURL(path.join(path.dirname(entry), 'lib/error.js')).href);
  const encrypted = createRequire(require.resolve('archiver-zip-encrypted'));
  const archiver = encrypted('archiver');
  const ZipEncrypted = require('archiver-zip-encrypted');
  if (!archiver.isRegisteredFormat('zip-encrypted')) {
    archiver.registerFormat('zip-encrypted', ZipEncrypted);
  }
  return {
    name: 'upstream',
    Archiver: ns.Archiver,
    ZipArchive: ns.ZipArchive,
    TarArchive: ns.TarArchive,
    JsonArchive: ns.JsonArchive,
    ArchiverError: error.ArchiverError,
    archiver,
    ZipEncrypted,
    ZipAesStream: encrypted('./lib/aes/zip-aes-stream.js'),
    ZipCryptoStream: encrypted('./lib/zip20/zip-crypto-stream.js'),
    AesHmacEtmStream: encrypted('./lib/aes/aes-hmac-etm-stream.js'),
    CryptoStream: encrypted('./lib/zip20/crypto-stream.js'),
    DecryptoStream: encrypted('./lib/zip20/decrypto-stream.js'),
    CryptoCipher: encrypted('./lib/zip20/CryptoCipher.js'),
  };
}

// the published package: the ESM entry for the archiver 8 surface, the CommonJS entry for the archiver 7
// surface, as the two upstream suites use them (PORTING.md 14.1). The two bundles share one
// format registry and one wasm instance (15.4).
async function loadYkk() {
  const ns = await import(pathToFileURL(path.join(ROOT, 'dist/index.mjs')).href);
  const archiver = require(path.join(ROOT, 'dist/index.cjs'));
  if (!archiver.isRegisteredFormat('zip-encrypted')) {
    archiver.registerFormat('zip-encrypted', archiver.ZipEncrypted);
  }
  return {
    name: 'ykk',
    Archiver: ns.Archiver,
    ZipArchive: ns.ZipArchive,
    TarArchive: ns.TarArchive,
    JsonArchive: ns.JsonArchive,
    ArchiverError: ns.ArchiverError,
    archiver,
    ZipEncrypted: archiver.ZipEncrypted,
    ZipAesStream: archiver.ZipAesStream,
    ZipCryptoStream: archiver.ZipCryptoStream,
    AesHmacEtmStream: archiver.AesHmacEtmStream,
    CryptoStream: archiver.CryptoStream,
    DecryptoStream: archiver.DecryptoStream,
    CryptoCipher: archiver.CryptoCipher,
  };
}

export function load(name) {
  if (!IMPLEMENTATIONS.includes(name)) {
    throw new Error(`run-both: unknown implementation ${JSON.stringify(name)}`);
  }
  if (!loaded.has(name)) {
    loaded.set(name, name === 'upstream' ? loadUpstream() : loadYkk());
  }
  return loaded.get(name);
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function immediate() {
  return new Promise((resolve) => setImmediate(resolve));
}

function randomOption(random) {
  if (random === undefined || random === null) {
    return undefined;
  }
  const bytes = Buffer.isBuffer(random) ? random : Buffer.from(random, 'hex');
  if (bytes.length !== ZIP20_HEADER_LENGTH) {
    throw new Error(`run-both: options.random must be ${ZIP20_HEADER_LENGTH} bytes, found ${bytes.length}`);
  }
  return bytes;
}

function clockOption(clock) {
  if (clock === undefined || clock === null) {
    return undefined;
  }
  const now = typeof clock === 'number' ? clock : clock.getTime();
  if (Number.isNaN(now)) {
    throw new Error('run-both: options.clock is not a valid time');
  }
  return now;
}

function installClock(now) {
  const RealDate = globalThis.Date;
  class FixedDate extends RealDate {
    constructor(...args) {
      if (args.length === 0) {
        super(now);
      } else {
        super(...args);
      }
    }

    static now() {
      return now;
    }

    static [Symbol.hasInstance](value) {
      return value instanceof RealDate;
    }
  }
  Object.defineProperty(FixedDate, 'name', { value: 'Date' });
  globalThis.Date = FixedDate;
  return () => {
    globalThis.Date = RealDate;
  };
}

// the stub answers by length only, never by call count or order (V10)
function installRandom(bytes) {
  const randomBytes = crypto.randomBytes;
  crypto.randomBytes = function (size, callback) {
    if (size !== ZIP20_HEADER_LENGTH) {
      return randomBytes.call(this, size, callback);
    }
    const header = Buffer.from(bytes);
    if (typeof callback === 'function') {
      process.nextTick(callback, null, header);
      return undefined;
    }
    return header;
  };
  return () => {
    crypto.randomBytes = randomBytes;
  };
}

function install(name, options) {
  // a run that mocha abandoned at its timeout never reached its restore
  if (installed !== null) {
    installed();
  }
  const restores = [];
  const now = clockOption(options.clock);
  if (now !== undefined) {
    restores.push(installClock(now));
  }
  const random = randomOption(options.random);
  if (random !== undefined && name === 'upstream') {
    restores.push(installRandom(random));
  }
  const restoreAll = () => {
    if (installed !== restoreAll) {
      return;
    }
    installed = null;
    for (const restore of restores.reverse()) {
      restore();
    }
  };
  installed = restoreAll;
  return restoreAll;
}

function createArchive(impl, format, options, zip20Header) {
  switch (format) {
    case 'zip':
      return new impl.ZipArchive(options);
    case 'tar':
      return new impl.TarArchive(options);
    case 'tar.gz':
      return new impl.TarArchive({ gzip: true, ...options });
    case 'json':
      return new impl.JsonArchive(options);
    case 'aes256':
      return impl.archiver.create('zip-encrypted', { ...options, encryptionMethod: 'aes256' });
    case 'zip20':
      return impl.archiver.create(
        'zip-encrypted',
        impl.name === 'ykk' && zip20Header !== undefined
          ? { zip20Header: Buffer.from(zip20Header), ...options, encryptionMethod: 'zip20' }
          : { ...options, encryptionMethod: 'zip20' }
      );
    default:
      throw new Error(`run-both: unknown format ${JSON.stringify(format)}`);
  }
}

function pointerOf(tracked) {
  const first = tracked.find((item) => typeof item.emitter.pointer === 'function');
  if (first === undefined) {
    return null;
  }
  try {
    return first.emitter.pointer();
  } catch (err) {
    return { threw: summarizeError(err) };
  }
}

function destroyTracked(tracked) {
  for (const item of tracked) {
    if (typeof item.emitter.destroy === 'function') {
      item.emitter.destroy();
    }
  }
}

async function waitForEnd(tracked, timeout) {
  const ended = Promise.all(tracked.map((item) => item.done));
  if (timeout === undefined) {
    await ended;
    return;
  }
  let timer;
  const late = new Promise((resolve, reject) => {
    timer = setTimeout(() => {
      const open = tracked.filter((item) => !item.ended).length;
      destroyTracked(tracked);
      reject(new Error(`run-both: ${open} of ${tracked.length} tracked streams did not end within ${timeout} ms`));
    }, timeout);
  });
  try {
    await Promise.race([ended, late]);
  } finally {
    clearTimeout(timer);
  }
}

export async function runOne(name, scenario, options = {}) {
  const impl = await load(name);
  const tracked = [];
  const chunks = [];
  const events = [];
  const settled = [];
  const zip20Header = randomOption(options.random);

  const ctx = {
    args: options.args,
    zip20Header,
    track(emitter, { events: names = EVENTS, data = true } = {}) {
      const item = { emitter, ended: false };
      item.done = new Promise((resolve) => {
        const finish = () => {
          item.ended = true;
          resolve();
        };
        emitter.once('end', finish);
        emitter.once('close', finish);
      });
      tracked.push(item);
      recordEvents(emitter, { events: names, into: events });
      if (data) {
        emitter.on('data', (chunk) => {
          chunks.push(chunk);
        });
      }
      return emitter;
    },
    create(format, archiveOptions, trackOptions) {
      return ctx.track(createArchive(impl, format, archiveOptions, zip20Header), trackOptions);
    },
    watch(label, promise) {
      return Promise.resolve(promise).then(
        (value) => {
          settled.push({ label, state: 'fulfilled' });
          return value;
        },
        (err) => {
          settled.push({ label, state: 'rejected', error: summarizeError(err) });
        }
      );
    },
    callback(label) {
      return (...args) => {
        settled.push({ label, state: 'called', args: summarize(args) });
      };
    },
  };

  const restore = install(name, options);
  let value;
  let thrown;
  let error = null;
  let pointer = null;
  let result;
  try {
    try {
      value = await scenario(impl, ctx);
    } catch (err) {
      thrown = err;
      error = summarizeError(err);
    }
    pointer = pointerOf(tracked);

    if (options.hang !== undefined) {
      await delay(options.hang);
    } else if (thrown !== undefined) {
      await immediate();
    } else if (typeof options.wait === 'number') {
      await delay(options.wait);
    } else if (options.wait === undefined || options.wait === 'end') {
      await waitForEnd(tracked, options.endTimeout);
      await immediate();
    } else if (options.wait !== 'none') {
      throw new Error(`run-both: unknown options.wait ${JSON.stringify(options.wait)}`);
    }

    const pointerAtEnd = pointerOf(tracked);
    result = {
      bytes: Buffer.concat(chunks),
      events: events.slice(),
      error,
      pointer: options.hang !== undefined ? pointerAtEnd : pointer,
      pointerAtEnd,
      settled: settled.slice(),
      value,
    };

    if (options.hang !== undefined) {
      destroyTracked(tracked);
      await immediate();
    }
  } finally {
    restore();
  }
  return result;
}

export async function runBoth(scenario, options = {}) {
  const upstream = await runOne('upstream', scenario, options);
  const ykk = await runOne('ykk', scenario, options);
  return { upstream, ykk };
}

export function scenarioReference(moduleUrl, exportName) {
  return `${moduleUrl}#${exportName}`;
}

function childOptions(options) {
  const random = randomOption(options.random);
  return {
    clock: clockOption(options.clock),
    random: random === undefined ? undefined : random.toString('hex'),
    wait: options.wait,
    endTimeout: options.endTimeout,
    hang: options.hang,
    args: options.args,
  };
}

// JSON.stringify drops a key whose value is undefined and writes null for NaN and the infinities
function encodeJson(key, value) {
  if (value === undefined) {
    return { [JSON_TAG]: 'undefined' };
  }
  if (typeof value === 'number' && !Number.isFinite(value)) {
    return { [JSON_TAG]: String(value) };
  }
  return value;
}

function decodeJson(value) {
  if (value === null || typeof value !== 'object') {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map(decodeJson);
  }
  if (Object.hasOwn(value, JSON_TAG)) {
    return value[JSON_TAG] === 'undefined' ? undefined : Number(value[JSON_TAG]);
  }
  const decoded = {};
  for (const key of Object.keys(value)) {
    decoded[key] = decodeJson(value[key]);
  }
  return decoded;
}

function printedLines(stdout) {
  return stdout
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    });
}

function isResultLine(line) {
  return line !== null && typeof line === 'object' && !Array.isArray(line) && Object.hasOwn(line, 'result');
}

function runChild(name, reference, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [SELF, '--child', name, reference, JSON.stringify(childOptions(options))],
      {
        cwd: options.cwd === undefined ? process.cwd() : options.cwd,
        stdio: ['ignore', 'pipe', 'pipe'],
      }
    );
    const stdout = [];
    const stderr = [];
    child.stdout.on('data', (chunk) => stdout.push(chunk));
    child.stderr.on('data', (chunk) => stderr.push(chunk));
    const timer = setTimeout(() => child.kill('SIGKILL'), options.timeout === undefined ? 10000 : options.timeout);
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      const out = Buffer.concat(stdout).toString('utf8');
      const err = Buffer.concat(stderr).toString('utf8');
      const lines = printedLines(out);
      const last = lines.length === 0 ? null : lines[lines.length - 1];
      const printed = lines.findLast(isResultLine);
      let result = null;
      if (printed !== undefined) {
        const decoded = decodeJson(printed.result);
        result = { ...decoded, bytes: Buffer.from(decoded.bytes, 'base64') };
      } else if (code === 0) {
        reject(new Error(`run-both: the ${name} child exited with code 0 and printed no result\n${out}${err}`));
        return;
      }
      resolve({
        code,
        signal,
        stdout: out,
        stderr: err,
        crash: code === CRASH_EXIT_CODE ? last : null,
        unsettled: code === UNSETTLED_EXIT_CODE,
        result,
      });
    });
  });
}

export async function runBothInChild(reference, options = {}) {
  const upstream = await runChild('upstream', reference, options);
  const ykk = await runChild('ykk', reference, options);
  return { upstream, ykk };
}

async function importScenario(reference) {
  const hash = reference.lastIndexOf('#');
  if (hash === -1) {
    throw new Error(`run-both: scenario ${JSON.stringify(reference)} is not <module>#<export>`);
  }
  const specifier = reference.slice(0, hash);
  const exportName = reference.slice(hash + 1);
  // a test file registers its cases when it is imported; outside mocha that must do nothing
  for (const key of MOCHA_GLOBALS) {
    if (globalThis[key] === undefined) {
      globalThis[key] = () => {};
    }
  }
  const url = specifier.startsWith('file:') ? specifier : pathToFileURL(path.resolve(specifier)).href;
  const module = await import(url);
  if (typeof module[exportName] !== 'function') {
    throw new Error(`run-both: ${specifier} has no exported function ${JSON.stringify(exportName)}`);
  }
  return module[exportName];
}

// one write to a pipe takes at most what the pipe has room for and answers the count
function writeLine(text) {
  const line = Buffer.from(text + '\n');
  const pause = new Int32Array(new SharedArrayBuffer(4));
  let offset = 0;
  while (offset < line.length) {
    try {
      offset += fs.writeSync(1, line, offset);
    } catch (err) {
      if (err.code !== 'EAGAIN') {
        throw err;
      }
      Atomics.wait(pause, 0, 0, 1);
    }
  }
}

async function child(name, reference, json) {
  const options = json === undefined ? {} : JSON.parse(json);
  const scenario = await importScenario(reference);
  await load(name);
  let printedResult = false;
  process.on('uncaughtException', (err) => {
    const printed = err === null || typeof err !== 'object' ? { message: String(err) } : err;
    writeLine(JSON.stringify({ name: printed.name, code: printed.code, message: printed.message }));
    process.exit(CRASH_EXIT_CODE);
  });
  process.on('beforeExit', () => {
    if (!printedResult) {
      writeLine(JSON.stringify({ unsettled: true }));
      process.exit(UNSETTLED_EXIT_CODE);
    }
  });
  const result = await runOne(name, scenario, options);
  writeLine(
    JSON.stringify(
      {
        result: {
          bytes: result.bytes.toString('base64'),
          events: result.events,
          error: result.error,
          pointer: result.pointer,
          pointerAtEnd: result.pointerAtEnd,
          settled: result.settled,
          value: summarize(result.value),
        },
      },
      encodeJson
    )
  );
  printedResult = true;
  // unreferenced: an empty event loop ends the child at once, an open handle cannot keep it alive
  setTimeout(() => process.exit(0), HANG_QUIET_MS).unref();
}

if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === SELF && process.argv[2] === '--child') {
  // not awaited: a scenario module imports this file, which must have finished evaluating by then
  child(process.argv[3], process.argv[4], process.argv[5]).catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
