// tests/differential/tar.test.mjs
// Differential cases T1 to T6 of PORTING.md 14.2: tar archives of the upstream oracle and of ykk.
// The scenarios are exported so that a child process and the extraction checks (14.4) can run them;
// each takes the fixture tree of makeTree() as ctx.args.root.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';

import { selectEvents, sortEvents } from './helpers/events.mjs';
import { runBoth } from './helpers/run-both.mjs';
import { parseTar } from './helpers/tar-records.mjs';

const require = createRequire(import.meta.url);
const lazystream = require('lazystream');

const DATE = new Date('2013-01-03T14:26:38.000Z');
const CLOCK = new Date('2021-07-04T09:08:07.000Z');
const SEGMENT = 'abcdefghij';

// PORTING.md 14.2 (n bytes, byte i is i & 255)
function binaryBuffer(n) {
  const buffer = Buffer.alloc(n);
  for (let i = 0; i < n; i++) {
    buffer[i] = i & 255;
  }
  return buffer;
}

// PORTING.md 14.2 (a stream source, made once per implementation, written in the given chunks)
function streamOf(chunks) {
  const stream = new PassThrough();
  for (const chunk of chunks) {
    stream.write(chunk);
  }
  stream.end();
  return stream;
}

// PORTING.md 14.2 (determinism: modes are set by chmod, times by lutimes)
export function makeTree() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ykk-diff-tar-')));
  const write = (rel, data, mode) => {
    const target = path.join(root, rel);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, data);
    fs.chmodSync(target, mode);
  };
  write('a.txt', 'this is a test file', 0o644);
  write('b.bin', Buffer.alloc(600, 0x62), 0o600);
  write('sub/c.txt', Buffer.alloc(512, 0x63), 0o640);
  write('sub/empty.txt', '', 0o644);
  write('sub/deep/d.txt', 'deep', 0o755);
  fs.symlinkSync('a.txt', path.join(root, 'link-a'));
  fs.symlinkSync('sub', path.join(root, 'link-sub'));
  fs.chmodSync(path.join(root, 'sub/deep'), 0o700);
  fs.chmodSync(path.join(root, 'sub'), 0o755);
  for (const rel of ['sub/deep/d.txt', 'sub/deep', 'sub/c.txt', 'sub/empty.txt', 'sub', 'a.txt', 'b.bin', 'link-a', 'link-sub', '.']) {
    fs.lutimesSync(path.join(root, rel), DATE, DATE);
  }
  return root;
}

// PORTING.md 14.2
export function removeTree(root) {
  fs.rmSync(root, { recursive: true, force: true });
}

// PORTING.md 14.2 (case T1: the sources of Z1 and Z2; sizes that are and are not multiples of 512)
export async function t1(impl, ctx) {
  const archive = ctx.create('tar');
  archive.append(Buffer.alloc(0), { name: 'empty-buffer.txt', date: DATE });
  archive.append(streamOf([]), { name: 'empty-stream.txt', date: DATE });
  archive.append(null, { name: 'null-source.txt', date: DATE });
  archive.append('string', { name: 'string.txt', date: DATE });
  archive.append(binaryBuffer(1), { name: 'buffer-1.bin', date: DATE });
  archive.append(binaryBuffer(511), { name: 'buffer-511.bin', date: DATE });
  archive.append(binaryBuffer(512), { name: 'buffer-512.bin', date: DATE });
  archive.append(binaryBuffer(513), { name: 'buffer-513.bin', date: DATE });
  archive.append(binaryBuffer(1024), { name: 'buffer-1024.bin', date: DATE });
  archive.append(binaryBuffer(16384), { name: 'buffer-16384.bin', date: DATE });
  archive.append(streamOf([binaryBuffer(512)]), { name: 'stream-512.bin', date: DATE });
  archive.append(streamOf([binaryBuffer(300), binaryBuffer(700)]), { name: 'stream-1000.bin', date: DATE });
  archive.append(
    new lazystream.Readable(function () {
      return fs.createReadStream(path.join(ctx.args.root, 'b.bin'));
    }),
    { name: 'lazy-600.bin', date: DATE }
  );
  await archive.finalize();
}

// PORTING.md 14.2 (case T2: directories by append(), symlink() under the fixed clock, P10)
export async function t2Appended(impl, ctx) {
  const archive = ctx.create('tar');
  archive.append(null, { name: 'dir/', date: DATE });
  archive.append(null, { name: 'typed-dir', type: 'directory', date: DATE });
  archive.append(null, { name: 'dir/mode/', date: DATE, mode: 0o700 });
  archive.symlink('link', 'target/file.txt');
  archive.symlink('dir/link-with-mode', 'a\\b', 0o777);
  archive.append('x', { name: 'dir/file.txt', date: DATE });
  await archive.finalize();
}

// PORTING.md 14.2 (case T2: one directory() over a tree with sub-directories and symlinks on disk)
export async function t2Directory(impl, ctx) {
  const archive = ctx.create('tar');
  archive.directory(ctx.args.root, 'tree');
  await archive.finalize();
}

// PORTING.md 14.2 (case T2: one file() on what ctx.args.rel names: a directory or a symlink)
export async function t2File(impl, ctx) {
  const archive = ctx.create('tar');
  archive.file(path.join(ctx.args.root, ctx.args.rel), { name: ctx.args.name });
  await archive.finalize();
}

// PORTING.md 14.2 (case T3: names of 100, 101, 155+100 and 256+ bytes; non-ASCII names; P13)
export async function t3(impl, ctx) {
  const archive = ctx.create('tar');
  archive.append('x', { name: 'a'.repeat(100), date: DATE });
  archive.append('x', { name: 'a'.repeat(101), date: DATE });
  archive.append('x', { name: 'p'.repeat(155) + '/' + 'n'.repeat(100), date: DATE });
  archive.append('x', { name: 'p'.repeat(156) + '/' + 'n'.repeat(100), date: DATE });
  archive.append('x', { name: 'p'.repeat(155) + '/' + 'n'.repeat(101), date: DATE });
  archive.append('x', {
    name: [1, 2, 3, 4].map((i) => String(i) + SEGMENT.repeat(5).slice(1)).join('/'),
    date: DATE,
  });
  archive.append('x', {
    name: [1, 2, 3, 4, 5].map((i) => String(i) + SEGMENT.repeat(6).slice(1)).join('/'),
    date: DATE,
  });
  archive.append(null, { name: 'd'.repeat(120) + '/', date: DATE });
  archive.append('x', { name: 'grüße/日本語.txt', date: DATE });
  archive.append(null, { name: 'été/', date: DATE });
  archive.symlink('long-target', 't'.repeat(101));
  archive.symlink('exact-target', 't'.repeat(100));
  archive.symlink('non-ascii-target', 'ü'.repeat(50));
  archive.symlink('l'.repeat(101), 'target');
  await archive.finalize();
}

// PORTING.md 14.2 (case T4: mtime 2038, 2107, before 1970, Invalid Date; P11)
export async function t4(impl, ctx) {
  const archive = ctx.create('tar');
  archive.append('x', { name: 'last-31-bit', date: new Date('2038-01-19T03:14:07Z') });
  archive.append('x', { name: 'first-wrapped', date: new Date('2038-01-19T03:14:08Z') });
  archive.append('x', { name: 'year-2080', date: new Date('2080-01-01T00:00:00Z') });
  archive.append('x', { name: 'year-2107', date: new Date('2107-06-01T00:00:00Z') });
  archive.append('x', { name: 'before-1970', date: new Date('1969-12-31T23:59:59Z') });
  archive.append('x', { name: 'minus-500-ms', date: new Date(-500) });
  archive.append('x', { name: 'year-1901', date: new Date('1901-12-13T20:45:52Z') });
  archive.append('x', { name: 'invalid-date', date: new Date(NaN) });
  archive.append('x', { name: 'milliseconds', date: new Date('2013-01-03T14:26:38.999Z') });
  archive.append('x', { name: 'date-string', date: '2013-01-03T14:26:38.000Z' });
  await archive.finalize();
}

// PORTING.md 14.2 (case T5: uid, gid, uname, gname (also over-long), devmajor, caller pax, mode 0 and null; P12)
export async function t5(impl, ctx) {
  const archive = ctx.create('tar');
  archive.append('x', { name: 'ids', date: DATE, uid: 1000, gid: 20, uname: 'user', gname: 'staff' });
  archive.append('x', {
    name: 'over-long',
    date: DATE,
    uid: 262144,
    gid: 0o7777777,
    uname: 'u'.repeat(40),
    gname: 'g'.repeat(40),
  });
  archive.append('x', { name: 'exact', date: DATE, uid: 0o777777, uname: 'u'.repeat(32), gname: 'g'.repeat(32) });
  archive.append('x', { name: 'device', date: DATE, devmajor: 8, devminor: 1 });
  archive.append('x', { name: 'pax', date: DATE, pax: { comment: 'hello', 'SCHILY.xattr.user.key': 'välue' } });
  archive.append('x', { name: 'pax-empty', date: DATE, pax: {} });
  archive.append('x', { name: 'mode-0', date: DATE, mode: 0 });
  archive.append('x', { name: 'mode-null', date: DATE, mode: null });
  archive.append(null, { name: 'dir-mode-0/', date: DATE, mode: 0 });
  archive.append(null, { name: 'dir-mode-null/', date: DATE, mode: null });
  archive.append('x', { name: 'mode-777', date: DATE, mode: 0o777 });
  archive.append('x', { name: 'mode-with-type-bits', date: DATE, mode: 0o104755 });
  await archive.finalize();
}

// PORTING.md 14.2 (case T6: several fs sources, class N)
export async function t6(impl, ctx) {
  const root = ctx.args.root;
  const archive = ctx.create('tar');
  archive.file(path.join(root, 'a.txt'), { name: 'a.txt' });
  archive.file(path.join(root, 'b.bin'), { name: 'b.bin' });
  archive.file(path.join(root, 'missing.txt'), { name: 'missing.txt' });
  archive.file(path.join(root, 'link-a'), { name: 'link-a' });
  archive.directory(path.join(root, 'sub'), 'one');
  archive.directory(path.join(root, 'sub'), 'two');
  archive.glob('*.txt', { cwd: root }, { prefix: 'globbed' });
  archive.append('x', { name: 'appended.txt', date: DATE });
  await archive.finalize();
}

// PORTING.md 14.2 (comparison rules, tar: whole-archive byte equality)
function assertSameBytes(ykk, upstream) {
  let at = 0;
  while (at < ykk.length && at < upstream.length && ykk[at] === upstream[at]) {
    at++;
  }
  assert.ok(ykk.equals(upstream), `archives differ at byte ${at} (ykk ${ykk.length} bytes, upstream ${upstream.length} bytes)`);
}

// PORTING.md 14.2 (class D: whole archives, exact event sequences, pointer() at finalize resolution)
function assertSameRun({ upstream, ykk }) {
  assert.strictEqual(upstream.error, null);
  assert.deepStrictEqual(ykk.error, upstream.error);
  assertSameBytes(ykk.bytes, upstream.bytes);
  assert.deepStrictEqual(selectEvents(ykk.events), selectEvents(upstream.events));
  assert.strictEqual(ykk.pointer, upstream.pointer);
  assert.strictEqual(ykk.pointer, ykk.bytes.length);
}

// PORTING.md 14.2 (17.3: every header checksum holds, the archive ends with 1024 zero bytes)
function assertTarShape(bytes, count) {
  const tar = parseTar(bytes);
  assert.strictEqual(tar.entries.length, count);
  for (const entry of tar.entries) {
    assert.ok(entry.header.checksumValid, `checksum of ${entry.name}`);
    assert.strictEqual(entry.padding.length, (512 - (entry.header.size & 511)) & 511);
  }
  assert.strictEqual(bytes.length % 512, 0);
  assert.ok(tar.trailer.equals(Buffer.alloc(1024)));
  return tar;
}

// PORTING.md 14.2 (the raw bytes of a header field as text)
function field(entry, name) {
  return entry.header.raw[name].toString('latin1');
}

// PORTING.md 14.2 (class N: entries keyed by name)
function entriesByName(bytes) {
  const byName = new Map();
  for (const entry of parseTar(bytes).entries) {
    assert.ok(!byName.has(entry.name), `entry name ${entry.name} is used twice`);
    byName.set(entry.name, entry);
  }
  return byName;
}

describe('differential: tar', function () {
  let root;

  before(function () {
    root = makeTree();
  });

  after(function () {
    removeTree(root);
  });

  it('T1: buffer, string, stream and lazy file sources, empty sources, sizes around multiples of 512', async function () {
    const result = await runBoth(t1, { args: { root } });
    assertSameRun(result);
    const sizes = [0, 0, 0, 6, 1, 511, 512, 513, 1024, 16384, 512, 1000, 600];
    for (const bytes of [result.upstream.bytes, result.ykk.bytes]) {
      const tar = assertTarShape(bytes, sizes.length);
      assert.deepStrictEqual(
        tar.entries.map((entry) => entry.header.size),
        sizes
      );
      assert.deepStrictEqual(
        tar.entries.map((entry) => entry.body.length),
        sizes
      );
      assert.ok(tar.entries[9].body.equals(binaryBuffer(16384)));
      assert.ok(tar.entries[12].body.equals(Buffer.alloc(600, 0x62)));
    }
  });

  it('T2: directories by append(), symlink() entries take the clock as mtime and mode 0644 (P10)', async function () {
    const result = await runBoth(t2Appended, { clock: CLOCK, args: { root } });
    assertSameRun(result);
    for (const bytes of [result.upstream.bytes, result.ykk.bytes]) {
      const tar = assertTarShape(bytes, 6);
      assert.deepStrictEqual(
        tar.entries.map((entry) => [entry.name, entry.header.typeflag, entry.header.mode]),
        [
          ['dir/', '5', 0o755],
          ['typed-dir/', '5', 0o755],
          ['dir/mode/', '5', 0o700],
          ['link', '2', 0o644],
          ['dir/link-with-mode', '2', 0o777],
          ['dir/file.txt', '0', 0o644],
        ]
      );
      assert.strictEqual(tar.entries[3].header.mtime, CLOCK.getTime() / 1000);
      assert.strictEqual(tar.entries[4].header.mtime, CLOCK.getTime() / 1000);
      assert.strictEqual(tar.entries[3].header.linkname, 'target/file.txt');
      assert.strictEqual(tar.entries[4].header.linkname, 'a/b');
      assert.strictEqual(tar.entries[0].header.mtime, DATE.getTime() / 1000);
    }
  });

  it('T2: one directory() over sub-directories and symlinks on disk', async function () {
    const result = await runBoth(t2Directory, { args: { root } });
    assertSameRun(result);
    for (const bytes of [result.upstream.bytes, result.ykk.bytes]) {
      const tar = assertTarShape(bytes, 9);
      const byName = entriesByName(bytes);
      assert.deepStrictEqual(
        tar.entries.map((entry) => entry.name).sort(),
        [
          'tree/a.txt',
          'tree/b.bin',
          'tree/link-a',
          'tree/link-sub',
          'tree/sub/',
          'tree/sub/c.txt',
          'tree/sub/deep/',
          'tree/sub/deep/d.txt',
          'tree/sub/empty.txt',
        ]
      );
      assert.strictEqual(byName.get('tree/sub/').header.typeflag, '5');
      assert.strictEqual(byName.get('tree/sub/deep/').header.mode, 0o700);
      assert.strictEqual(byName.get('tree/link-a').header.typeflag, '2');
      assert.strictEqual(byName.get('tree/link-a').header.linkname, 'a.txt');
      assert.strictEqual(byName.get('tree/link-sub').header.linkname, 'sub');
      assert.strictEqual(byName.get('tree/b.bin').header.mode, 0o600);
      assert.strictEqual(byName.get('tree/a.txt').header.mtime, DATE.getTime() / 1000);
      assert.strictEqual(byName.get('tree/a.txt').body.toString(), 'this is a test file');
    }
  });

  it('T2: file() on a directory', async function () {
    const result = await runBoth(t2File, { args: { root, rel: 'sub', name: 'from-disk' } });
    assertSameRun(result);
    for (const bytes of [result.upstream.bytes, result.ykk.bytes]) {
      const tar = assertTarShape(bytes, 1);
      assert.strictEqual(tar.entries[0].name, 'from-disk/');
      assert.strictEqual(tar.entries[0].header.typeflag, '5');
    }
  });

  it('T2: file() on a symlink to a file and on a symlink to a directory', async function () {
    for (const [rel, linkname] of [
      ['link-a', 'a.txt'],
      ['link-sub', 'sub'],
    ]) {
      const result = await runBoth(t2File, { args: { root, rel, name: 'from-disk' } });
      assertSameRun(result);
      for (const bytes of [result.upstream.bytes, result.ykk.bytes]) {
        const tar = assertTarShape(bytes, 1);
        assert.strictEqual(tar.entries[0].name, 'from-disk');
        assert.strictEqual(tar.entries[0].header.typeflag, '2');
        assert.strictEqual(tar.entries[0].header.linkname, linkname);
        assert.strictEqual(tar.entries[0].header.size, 0);
      }
    }
  });

  it('T3: names of 100, 101, 155+100 and 256+ bytes, non-ASCII names, both pax headers named PaxHeader (P13)', async function () {
    const result = await runBoth(t3, { clock: CLOCK, args: { root } });
    assertSameRun(result);
    // true: the entry needs the pax fallback
    const expected = [
      ['a'.repeat(100), false],
      ['a'.repeat(101), true],
      ['p'.repeat(155) + '/' + 'n'.repeat(100), false],
      ['p'.repeat(156) + '/' + 'n'.repeat(100), true],
      ['p'.repeat(155) + '/' + 'n'.repeat(101), true],
      [[1, 2, 3, 4].map((i) => String(i) + SEGMENT.repeat(5).slice(1)).join('/'), false],
      [[1, 2, 3, 4, 5].map((i) => String(i) + SEGMENT.repeat(6).slice(1)).join('/'), true],
      ['d'.repeat(120) + '/', false],
      ['grüße/日本語.txt', true],
      ['été/', true],
      ['long-target', true],
      ['exact-target', false],
      ['non-ascii-target', false],
      ['l'.repeat(101), true],
    ];
    for (const bytes of [result.upstream.bytes, result.ykk.bytes]) {
      const tar = assertTarShape(bytes, expected.length);
      assert.deepStrictEqual(
        tar.entries.map((entry) => [entry.name, entry.pax !== null]),
        expected
      );
      for (const entry of tar.entries) {
        if (entry.pax !== null) {
          assert.strictEqual(entry.pax.header.name, 'PaxHeader');
          assert.strictEqual(entry.header.name, 'PaxHeader');
          assert.ok(entry.pax.header.checksumValid);
        }
      }
      assert.strictEqual(tar.entries[2].header.prefix, 'p'.repeat(155));
      assert.strictEqual(tar.entries[2].header.name, 'n'.repeat(100));
      assert.strictEqual(tar.entries[5].header.name, '4' + SEGMENT.repeat(5).slice(1));
      assert.strictEqual(tar.entries[7].header.name, '');
      assert.strictEqual(tar.entries[7].header.prefix, 'd'.repeat(120));
      assert.strictEqual(tar.entries[10].pax.values.linkpath, 't'.repeat(101));
      assert.strictEqual(tar.entries[10].pax.header.linkname, 'PaxHeader');
      assert.strictEqual(tar.entries[10].header.linkname, 'PaxHeader');
      assert.strictEqual(tar.entries[11].header.linkname, 't'.repeat(100));
      assert.strictEqual(tar.entries[12].header.linkname, 'ü'.repeat(50));
    }
  });

  it('T4: mtime 2038, 2080, 2107, before 1970 and Invalid Date (P11)', async function () {
    const result = await runBoth(t4, { args: { root } });
    assertSameRun(result);
    for (const bytes of [result.upstream.bytes, result.ykk.bytes]) {
      const tar = assertTarShape(bytes, 10);
      assert.deepStrictEqual(
        tar.entries.map((entry) => [entry.name, field(entry, 'mtime')]),
        [
          ['last-31-bit', '17777777777 '],
          ['first-wrapped', '77777777777 '],
          ['year-2080', '-6106043200 '],
          ['year-2107', '00235621600 '],
          ['before-1970', '000000000-1 '],
          ['minus-500-ms', '00000000000 '],
          ['year-1901', '77777777777 '],
          ['invalid-date', '00000000000 '],
          ['milliseconds', '12071312436 '],
          ['date-string', '12071312436 '],
        ]
      );
    }
  });

  it('T5: uid, gid, uname, gname without a length limit (P12), devmajor, caller pax, mode 0 and null', async function () {
    const result = await runBoth(t5, { args: { root } });
    assertSameRun(result);
    for (const bytes of [result.upstream.bytes, result.ykk.bytes]) {
      const tar = assertTarShape(bytes, 12);
      const byName = entriesByName(bytes);
      assert.strictEqual(field(byName.get('ids'), 'uid'), '001750 \0');
      assert.strictEqual(field(byName.get('ids'), 'gid'), '000024 \0');
      assert.strictEqual(byName.get('ids').header.uname, 'user');
      assert.strictEqual(byName.get('ids').header.gname, 'staff');
      assert.strictEqual(field(byName.get('over-long'), 'uid'), '777777 \0');
      assert.strictEqual(field(byName.get('over-long'), 'gid'), '777777 \0');
      assert.strictEqual(field(byName.get('over-long'), 'uname'), 'u'.repeat(32));
      assert.strictEqual(field(byName.get('over-long'), 'gname'), 'g'.repeat(32));
      assert.strictEqual(field(byName.get('over-long'), 'devmajor'), '000000 g');
      assert.strictEqual(field(byName.get('over-long'), 'devminor'), '000000 \0');
      assert.strictEqual(field(byName.get('exact'), 'uid'), '777777 \0');
      assert.strictEqual(field(byName.get('exact'), 'uname'), 'u'.repeat(32));
      assert.strictEqual(field(byName.get('exact'), 'devmajor'), '000000 \0');
      assert.strictEqual(field(byName.get('device'), 'devmajor'), '000010 \0');
      assert.strictEqual(field(byName.get('device'), 'devminor'), '000001 \0');
      assert.deepStrictEqual(
        byName.get('pax').pax.records.map((record) => record.bytes.toString('utf8')),
        ['12 path=pax\n', '17 comment=hello\n', '32 SCHILY.xattr.user.key=välue\n']
      );
      assert.strictEqual(byName.get('pax').header.name, 'PaxHeader');
      assert.deepStrictEqual(
        byName.get('pax-empty').pax.records.map((record) => record.bytes.toString('utf8')),
        ['18 path=pax-empty\n']
      );
      assert.strictEqual(field(byName.get('mode-0'), 'mode'), '000644 \0');
      assert.strictEqual(field(byName.get('mode-null'), 'mode'), '000644 \0');
      assert.strictEqual(field(byName.get('dir-mode-0/'), 'mode'), '000755 \0');
      assert.strictEqual(field(byName.get('dir-mode-null/'), 'mode'), '000755 \0');
      assert.strictEqual(field(byName.get('mode-777'), 'mode'), '000777 \0');
      assert.strictEqual(field(byName.get('mode-with-type-bits'), 'mode'), '004755 \0');
      assert.strictEqual(tar.entries.length, byName.size);
    }
  });

  it('T6: several fs sources, compared per entry (class N)', async function () {
    const { upstream, ykk } = await runBoth(t6, { args: { root } });
    assert.strictEqual(upstream.error, null);
    assert.deepStrictEqual(ykk.error, upstream.error);
    const expected = entriesByName(upstream.bytes);
    const actual = entriesByName(ykk.bytes);
    assert.deepStrictEqual([...actual.keys()].sort(), [...expected.keys()].sort());
    assert.strictEqual(expected.size, 13);
    for (const [name, entry] of expected) {
      assert.ok(actual.get(name).bytes.equals(entry.bytes), `header and body of ${name}`);
    }
    assert.strictEqual(ykk.bytes.length, upstream.bytes.length);
    assert.ok(parseTar(ykk.bytes).trailer.equals(parseTar(upstream.bytes).trailer));
    assert.deepStrictEqual(
      sortEvents(selectEvents(ykk.events, ['entry', 'warning', 'error'])),
      sortEvents(selectEvents(upstream.events, ['entry', 'warning', 'error']))
    );
    assert.strictEqual(selectEvents(upstream.events, ['warning']).length, 1);
    assert.strictEqual(selectEvents(ykk.events, ['progress']).length, selectEvents(upstream.events, ['progress']).length);
  });
});
