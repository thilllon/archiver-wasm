// tests/differential/glob-options.test.mjs
// Differential cases of glob(): every option of deps/readdir-glob/src/index.ts:107-175 that
// node-archiver/lib/core.js:672-699 passes through (nodir, mark, skip, follow, nocase, matchBase,
// noglobstar, dot, ignore, absolute, stat, an array pattern) and cwd, on the fixture tree of makeTree().
// The scenario is exported so that a child process can run it: a case about the working directory
// (cwd absent or relative) needs a process that stands in the tree.
//
// Each case compares ykk with upstream (the json document with its entry objects in order, the events,
// and for two cases the bytes of a stored zip and of a tar) and with the list written in the case, so
// that an option both stacks ignore still fails.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { selectEvents } from './helpers/events.mjs';
import { runBoth, runBothInChild, scenarioReference } from './helpers/run-both.mjs';
import { parseTar } from './helpers/tar-records.mjs';
import { parseZip } from './helpers/zip-records.mjs';

const DATE = new Date('2013-01-03T14:26:38.000Z');
// PORTING.md 14.2 (comparison rules, json: the stats fields that reading a file or a later chmod changes)
const VOLATILE_STATS_KEYS = ['atime', 'atimeMs', 'ctime', 'ctimeMs'];
// `new Date()` of both runs: an entry without stats takes its date from the clock (core.js:300-302)
const CLOCK = new Date('2021-07-04T09:08:06.000Z');
// a walk that never ends rejects instead of running into the timeout of the test
const END_TIMEOUT = 5000;

let root;

// PORTING.md 14.2 (determinism: modes are set by chmod, times by lutimes). Three links and no cycle:
// link-file -> a.txt, link-dir -> sub/deep (a directory that holds no link), broken -> missing.txt.
// No two names differ by case only, so the tree is the same on a case-insensitive file system.
function makeTree() {
  const tree = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ykk-diff-glob-')));
  const write = (rel, data, mode) => {
    const target = path.join(tree, rel);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, data);
    fs.chmodSync(target, mode);
  };
  write('a.txt', 'this is a test file', 0o644);
  write('B.TXT', 'upper case', 0o644);
  write('c.md', '# c', 0o600);
  write('.hidden.txt', 'hidden', 0o644);
  write('sub/d.txt', Buffer.alloc(600, 0x64), 0o640);
  write('sub/E.TXT', 'upper case in sub', 0o644);
  write('sub/.dot/f.txt', 'in a dot directory', 0o644);
  write('sub/deep/g.txt', 'deep', 0o755);
  write('sub/deep/h.md', '# h', 0o644);
  write('other/i.txt', 'other', 0o644);
  fs.mkdirSync(path.join(tree, 'empty'));
  fs.symlinkSync('a.txt', path.join(tree, 'link-file'));
  fs.symlinkSync('sub/deep', path.join(tree, 'link-dir'));
  fs.symlinkSync('missing.txt', path.join(tree, 'broken'));
  for (const rel of ['sub/.dot', 'sub/deep', 'sub', 'other', 'empty']) {
    fs.chmodSync(path.join(tree, rel), 0o755);
  }
  for (const rel of [
    'sub/.dot/f.txt', 'sub/.dot', 'sub/deep/g.txt', 'sub/deep/h.md', 'sub/deep', 'sub/d.txt', 'sub/E.TXT', 'sub',
    'other/i.txt', 'other', 'empty', 'a.txt', 'B.TXT', 'c.md', '.hidden.txt', 'link-file', 'link-dir', 'broken', '.',
  ]) {
    fs.lutimesSync(path.join(tree, rel), DATE, DATE);
  }
  return tree;
}

// PORTING.md 14.2
function removeTree(tree) {
  fs.rmSync(tree, { recursive: true, force: true });
}

// node-archiver/lib/core.js:672 (one glob(); ctx.args: format, pattern, options, data. An absent
// `options` or `data` is not passed, and `cwd` is the caller's: absent, relative or absolute.)
export async function globOnce(impl, ctx) {
  const { format, pattern, options, data } = ctx.args;
  const archive = ctx.create(format, format === 'zip' ? { store: true } : {});
  if (data !== undefined) {
    archive.glob(pattern, options, data);
  } else if (options !== undefined) {
    archive.glob(pattern, options);
  } else {
    archive.glob(pattern);
  }
  await archive.finalize();
}

// PORTING.md 14.2 (comparison rules, json: equal after replacing the volatile stats fields)
function parseFiles(bytes) {
  const files = JSON.parse(bytes.toString('utf8'));
  assert.ok(Array.isArray(files));
  for (const file of files) {
    if (file.stats !== null && typeof file.stats === 'object') {
      for (const key of VOLATILE_STATS_KEYS) {
        if (key in file.stats) {
          file.stats[key] = 0;
        }
      }
    }
  }
  return files;
}

// PORTING.md 14.2 (comparison rules, json: the serialized document with the volatile stats fields replaced)
function maskVolatile(bytes) {
  return bytes
    .toString('utf8')
    .replace(/"(atimeMs|ctimeMs)":[0-9.e+-]+/g, '"$1":0')
    .replace(/"(atime|ctime)":"[^"]*"/g, '"$1":0');
}

// PORTING.md 14.2 (class D with stats: the document, the entry objects in order, key order included, and exact event sequences)
function assertSameFiles({ upstream, ykk }) {
  assert.strictEqual(upstream.error, null);
  assert.deepStrictEqual(ykk.error, upstream.error);
  const expected = parseFiles(upstream.bytes);
  const actual = parseFiles(ykk.bytes);
  assert.deepStrictEqual(
    actual.map((file) => JSON.stringify(file)),
    expected.map((file) => JSON.stringify(file))
  );
  assert.strictEqual(maskVolatile(ykk.bytes), maskVolatile(upstream.bytes));
  assert.deepStrictEqual(selectEvents(ykk.events), selectEvents(upstream.events));
  assert.strictEqual(upstream.pointer, upstream.bytes.length);
  assert.strictEqual(ykk.pointer, ykk.bytes.length);
  return actual;
}

// the entries a case names: '<name> <type>', sorted (readdir order is the file system's)
function listed(files) {
  return files.map((file) => `${file.name} ${file.type}`).sort();
}

// one glob() into a json archive, in this process
async function globJson(pattern, options, data) {
  const runs = await runBoth(globOnce, { args: { format: 'json', pattern, options, data }, clock: CLOCK, endTimeout: END_TIMEOUT });
  return assertSameFiles(runs);
}

// one glob() into a json archive, in a child process that stands in `cwd`
async function globJsonIn(cwd, pattern, options) {
  const { upstream, ykk } = await runBothInChild(scenarioReference(import.meta.url, 'globOnce'), {
    cwd,
    args: { format: 'json', pattern, options },
    clock: CLOCK, endTimeout: END_TIMEOUT,
    timeout: 8000,
  });
  for (const child of [upstream, ykk]) {
    assert.strictEqual(child.code, 0, child.stderr);
    assert.strictEqual(child.crash, null);
    assert.strictEqual(child.unsettled, false);
  }
  return assertSameFiles({ upstream: upstream.result, ykk: ykk.result });
}

// the source path of every entry, relative to the tree
function sources(files) {
  return files.map((file) => `${file.name} <- ${path.relative(root, file.sourcePath)}`).sort();
}

const d = (name) => `${name} directory`;
const f = (name) => `${name} file`;
const l = (name) => `${name} symlink`;

// '**' without options: no name that starts with a period, links as links, the linked directory not walked
const ALL = [
  f('B.TXT'), f('a.txt'), l('broken'), f('c.md'), d('empty/'), l('link-dir'), l('link-file'), d('other/'),
  f('other/i.txt'), d('sub/'), f('sub/E.TXT'), f('sub/d.txt'), d('sub/deep/'), f('sub/deep/g.txt'), f('sub/deep/h.md'),
];
const DOTTED = [f('.hidden.txt'), d('sub/.dot/'), f('sub/.dot/f.txt')];
// follow: the link to a file is a file, the link to a directory is a directory and is walked, the broken
// link stays a link (deps/readdir-glob/src/index.ts:42-45)
const FOLLOWED = [
  ...ALL.filter((entry) => entry !== l('link-dir') && entry !== l('link-file')),
  d('link-dir/'), f('link-dir/g.txt'), f('link-dir/h.md'), f('link-file'),
].sort();
// follow without stat: the matches carry no stats, archiver's own lstat (core.js:392) sees the links
const FOLLOWED_NOSTAT = [...ALL, f('link-dir/g.txt'), f('link-dir/h.md')].sort();

describe('differential: glob() options', function () {
  this.timeout(20000);

  before(function () {
    root = makeTree();
  });

  after(function () {
    removeTree(root);
  });

  describe('pattern', function () {
    it("'**' without options", async function () {
      assert.deepStrictEqual(listed(await globJson('**', { cwd: root })), ALL.slice().sort());
    });

    it('an array of patterns', async function () {
      assert.deepStrictEqual(listed(await globJson(['*.txt', '**/*.md'], { cwd: root })), [
        f('a.txt'), f('c.md'), f('sub/deep/h.md'),
      ]);
    });

    it('entry data', async function () {
      const files = await globJson('sub/*', { cwd: root }, { prefix: 'globbed', date: DATE, caller: true });
      assert.deepStrictEqual(listed(files), [
        f('globbed/sub/E.TXT'), f('globbed/sub/d.txt'), d('globbed/sub/deep/'),
      ]);
      assert.deepStrictEqual(files.map((file) => file.caller), [true, true, true]);
    });
  });

  describe('nodir', function () {
    it("'**'", async function () {
      const files = await globJson('**', { cwd: root, nodir: true });
      assert.deepStrictEqual(listed(files), ALL.filter((entry) => !entry.endsWith(' directory')).sort());
    });

    it('false', async function () {
      assert.deepStrictEqual(listed(await globJson('**', { cwd: root, nodir: false })), ALL.slice().sort());
    });
  });

  // node-archiver/lib/core.js:95, 278-280: archiver writes the name and the source path of a directory with
  // one trailing slash itself, so the option changes nothing an archive shows; the cases pin that
  describe('mark', function () {
    it("'**'", async function () {
      const files = await globJson('**', { cwd: root, mark: true });
      assert.deepStrictEqual(listed(files), ALL.slice().sort());
    });

    it('with nodir', async function () {
      const files = await globJson('sub/**', { cwd: root, mark: true, nodir: true });
      assert.deepStrictEqual(listed(files), [f('sub/E.TXT'), f('sub/d.txt'), f('sub/deep/g.txt'), f('sub/deep/h.md')]);
    });
  });

  describe('skip', function () {
    it('a string', async function () {
      const files = await globJson('**', { cwd: root, skip: 'sub' });
      assert.deepStrictEqual(listed(files), ALL.filter((entry) => !entry.startsWith('sub/')).sort());
    });

    it('an array', async function () {
      const files = await globJson('**', { cwd: root, skip: ['sub/deep', 'other'] });
      assert.deepStrictEqual(
        listed(files),
        ALL.filter((entry) => !entry.startsWith('sub/deep/') && !entry.startsWith('other/')).sort()
      );
    });

    it('a pattern, matched with dot', async function () {
      const files = await globJson('**', { cwd: root, dot: true, skip: 'sub/*' });
      assert.deepStrictEqual(
        listed(files),
        [...ALL, f('.hidden.txt')].filter((entry) => !entry.startsWith('sub/deep/')).sort()
      );
    });

    it('a pattern that names the period', async function () {
      const files = await globJson('**', { cwd: root, dot: true, skip: '**/.*' });
      assert.deepStrictEqual(listed(files), [...ALL, f('.hidden.txt')].sort());
    });

    it('a file is not skipped', async function () {
      const files = await globJson('*.txt', { cwd: root, skip: 'a.txt' });
      assert.deepStrictEqual(listed(files), [f('a.txt')]);
    });
  });

  describe('follow', function () {
    it("'**'", async function () {
      const files = await globJson('**', { cwd: root, follow: true });
      assert.deepStrictEqual(listed(files), FOLLOWED);
    });

    it('with nodir and a pattern below the linked directory', async function () {
      const files = await globJson('link-*/**', { cwd: root, follow: true, nodir: true });
      assert.deepStrictEqual(listed(files), [f('link-dir/g.txt'), f('link-dir/h.md')]);
      assert.deepStrictEqual(sources(files), ['link-dir/g.txt <- link-dir/g.txt', 'link-dir/h.md <- link-dir/h.md']);
    });

    it('false', async function () {
      assert.deepStrictEqual(listed(await globJson('**', { cwd: root, follow: false })), ALL.slice().sort());
    });
  });

  describe('nocase', function () {
    it("'*.txt'", async function () {
      assert.deepStrictEqual(listed(await globJson('*.txt', { cwd: root, nocase: true })), [f('B.TXT'), f('a.txt')]);
    });

    it("'*.txt' without it", async function () {
      assert.deepStrictEqual(listed(await globJson('*.txt', { cwd: root })), [f('a.txt')]);
    });

    it('a directory part in the other case', async function () {
      assert.deepStrictEqual(listed(await globJson('SUB/*.Txt', { cwd: root, nocase: true })), [
        f('sub/E.TXT'), f('sub/d.txt'),
      ]);
    });
  });

  describe('matchBase', function () {
    it("'*.txt'", async function () {
      // the base name alone is matched: the period of the directory sub/.dot does not count
      assert.deepStrictEqual(listed(await globJson('*.txt', { cwd: root, matchBase: true })), [
        f('a.txt'), f('other/i.txt'), f('sub/.dot/f.txt'), f('sub/d.txt'), f('sub/deep/g.txt'),
      ]);
    });

    it('a pattern with a slash', async function () {
      assert.deepStrictEqual(listed(await globJson('sub/*.txt', { cwd: root, matchBase: true })), [f('sub/d.txt')]);
    });

    it('with nocase and dot', async function () {
      const files = await globJson('*.txt', { cwd: root, matchBase: true, nocase: true, dot: true });
      assert.deepStrictEqual(listed(files), [
        f('.hidden.txt'), f('B.TXT'), f('a.txt'), f('other/i.txt'), f('sub/.dot/f.txt'), f('sub/E.TXT'), f('sub/d.txt'),
        f('sub/deep/g.txt'),
      ]);
    });
  });

  describe('noglobstar', function () {
    it("'**/*.txt'", async function () {
      assert.deepStrictEqual(listed(await globJson('**/*.txt', { cwd: root, noglobstar: true })), [
        f('other/i.txt'), f('sub/d.txt'),
      ]);
    });

    it("'**/*.txt' without it", async function () {
      assert.deepStrictEqual(listed(await globJson('**/*.txt', { cwd: root })), [
        f('a.txt'), f('other/i.txt'), f('sub/d.txt'), f('sub/deep/g.txt'),
      ]);
    });

    it("'**'", async function () {
      const files = await globJson('**', { cwd: root, noglobstar: true });
      assert.deepStrictEqual(listed(files), [
        f('B.TXT'), f('a.txt'), l('broken'), f('c.md'), d('empty/'), l('link-dir'), l('link-file'), d('other/'),
        d('sub/'),
      ]);
    });
  });

  describe('dot', function () {
    it("'**'", async function () {
      assert.deepStrictEqual(listed(await globJson('**', { cwd: root, dot: true })), [...ALL, ...DOTTED].sort());
    });

    it("'*.txt'", async function () {
      assert.deepStrictEqual(listed(await globJson('*.txt', { cwd: root, dot: true })), [f('.hidden.txt'), f('a.txt')]);
    });

    it('a pattern that names the period', async function () {
      assert.deepStrictEqual(listed(await globJson('**/.*/*', { cwd: root })), [f('sub/.dot/f.txt')]);
    });
  });

  describe('ignore', function () {
    it('a string', async function () {
      const files = await globJson('**', { cwd: root, ignore: 'sub/**' });
      assert.deepStrictEqual(listed(files), ALL.filter((entry) => !entry.startsWith('sub/')).sort());
    });

    it('an array; the content of an ignored directory stays', async function () {
      const files = await globJson('**', { cwd: root, ignore: ['**/*.md', 'sub/deep/'] });
      assert.deepStrictEqual(
        listed(files),
        ALL.filter((entry) => !entry.endsWith('.md file') && entry !== d('sub/deep/')).sort()
      );
    });

    it('matched with dot', async function () {
      const files = await globJson('**', { cwd: root, dot: true, ignore: '**/*.txt' });
      assert.deepStrictEqual(
        listed(files),
        [...ALL, ...DOTTED].filter((entry) => !entry.endsWith('.txt file')).sort()
      );
    });
  });

  describe('cwd', function () {
    it('a directory below the tree', async function () {
      const files = await globJson('**', { cwd: path.join(root, 'sub') });
      assert.deepStrictEqual(listed(files), [f('E.TXT'), f('d.txt'), d('deep/'), f('deep/g.txt'), f('deep/h.md')]);
      assert.deepStrictEqual(sources(files), [
        'E.TXT <- sub/E.TXT', 'd.txt <- sub/d.txt', 'deep/ <- sub/deep', 'deep/g.txt <- sub/deep/g.txt',
        'deep/h.md <- sub/deep/h.md',
      ]);
    });

    it('a link to a directory', async function () {
      const files = await globJson('**', { cwd: path.join(root, 'link-dir') });
      assert.deepStrictEqual(listed(files), [f('g.txt'), f('h.md')]);
      assert.deepStrictEqual(sources(files), ['g.txt <- link-dir/g.txt', 'h.md <- link-dir/h.md']);
    });

    it('a directory that does not exist', async function () {
      assert.deepStrictEqual(listed(await globJson('**', { cwd: path.join(root, 'missing') })), []);
    });

    it('absent: the working directory', async function () {
      const files = await globJsonIn(root, '**/*.txt');
      assert.deepStrictEqual(listed(files), [f('a.txt'), f('other/i.txt'), f('sub/d.txt'), f('sub/deep/g.txt')]);
      assert.deepStrictEqual(sources(files), [
        'a.txt <- a.txt', 'other/i.txt <- other/i.txt', 'sub/d.txt <- sub/d.txt', 'sub/deep/g.txt <- sub/deep/g.txt',
      ]);
    });

    it('relative to the working directory', async function () {
      const files = await globJsonIn(root, '**', { cwd: 'sub/deep', nodir: true });
      assert.deepStrictEqual(listed(files), [f('g.txt'), f('h.md')]);
      assert.deepStrictEqual(sources(files), ['g.txt <- sub/deep/g.txt', 'h.md <- sub/deep/h.md']);
    });
  });

  describe('absolute', function () {
    it("'**': the entry names stay relative", async function () {
      const files = await globJson('**', { cwd: root, absolute: true });
      assert.deepStrictEqual(listed(files), ALL.slice().sort());
    });
  });

  describe('stat', function () {
    it('false: the matches carry no stats', async function () {
      const files = await globJson('**', { cwd: root, stat: false });
      assert.deepStrictEqual(listed(files), ALL.slice().sort());
      // the match carries no stats: the mode of sub/d.txt (0640 on disk) is the default, its date the clock
      const entry = files.find((file) => file.name === 'sub/d.txt');
      assert.deepStrictEqual([entry.mode, entry.date, 'stats' in entry], [0o644, CLOCK.toISOString(), false]);
    });

    it('false with follow: the walk follows, the entries are links', async function () {
      const files = await globJson('**', { cwd: root, stat: false, follow: true });
      assert.deepStrictEqual(listed(files), FOLLOWED_NOSTAT);
    });

    it('true', async function () {
      const files = await globJson('**', { cwd: root, stat: true });
      assert.deepStrictEqual(listed(files), ALL.slice().sort());
      const entry = files.find((file) => file.name === 'sub/d.txt');
      assert.deepStrictEqual([entry.mode, entry.date, entry.stats.size], [0o640, DATE.toISOString(), 600]);
    });
  });

  describe('several options, other formats', function () {
    const pattern = ['**/*.txt', '**/*.md', '**/'];
    const options = () => ({
      cwd: root, dot: true, nocase: true, follow: true, skip: ['other'], ignore: ['**/h.md', 'sub/'], mark: true,
    });
    const expected = [
      '.hidden.txt', 'B.TXT', 'a.txt', 'c.md', 'empty/', 'link-dir/', 'link-dir/g.txt', 'sub/.dot/', 'sub/.dot/f.txt',
      'sub/E.TXT', 'sub/d.txt', 'sub/deep/', 'sub/deep/g.txt',
    ];

    it('json', async function () {
      const files = await globJson(pattern, options());
      assert.deepStrictEqual(files.map((file) => file.name).sort(), expected);
    });

    it('stored zip', async function () {
      const { upstream, ykk } = await runBoth(globOnce, {
        args: { format: 'zip', pattern, options: options(), data: { date: DATE } },
        clock: CLOCK, endTimeout: END_TIMEOUT,
      });
      assert.strictEqual(upstream.error, null);
      assert.deepStrictEqual(ykk.error, upstream.error);
      assert.deepStrictEqual(ykk.bytes, upstream.bytes);
      assert.deepStrictEqual(selectEvents(ykk.events), selectEvents(upstream.events));
      assert.deepStrictEqual(parseZip(ykk.bytes).entries.map((entry) => entry.name).sort(), expected);
    });

    it('tar', async function () {
      const { upstream, ykk } = await runBoth(globOnce, {
        args: { format: 'tar', pattern, options: options() },
        clock: CLOCK, endTimeout: END_TIMEOUT,
      });
      assert.strictEqual(upstream.error, null);
      assert.deepStrictEqual(ykk.error, upstream.error);
      assert.deepStrictEqual(ykk.bytes, upstream.bytes);
      assert.deepStrictEqual(selectEvents(ykk.events), selectEvents(upstream.events));
      assert.deepStrictEqual(parseTar(ykk.bytes).entries.map((entry) => entry.name).sort(), expected);
    });
  });
});
