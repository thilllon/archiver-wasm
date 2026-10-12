# PORTING.md

The porting guide for **archiver-wasm**: an all-at-once, mechanical port of
node-archiver 8.0.0 to Rust compiled to WebAssembly for Node.js, with
archiver-zip-encrypted 2.0.0 (ZipCrypto and WinZip AES-256) built in.

Every implementer, reviewer and fixer is handed this file. It is written before any code.
Companion files, both normative:

- `BEHAVIORS.tsv`: one row per observable upstream behavior, with the exact target file and
  item that must reproduce it. A unit is not done until every row whose target lies in the
  unit is implemented and reviewed.
- `PORTMAP.tsv`: one row per upstream file (split files have one row per layer), grouped into
  units. A unit is the amount of work one implementer ports in one sitting.

Upstream evidence is cited as `path:line` relative to `.upstream/` (gitignored; recreate with
`scripts/fetch-upstream.sh`, which clones the two repositories at their pinned commits,
restores their `node_modules` from their own lockfiles with `npm ci --ignore-scripts`, and
unpacks the eight pinned dependency tarballs into `.upstream/deps/`; several ported files
are cited from those `node_modules` trees). Precedence when sources disagree: the upstream source code,
then this file, then `BEHAVIORS.tsv`, then `PORTMAP.tsv`. If this file is wrong about
upstream, fix this file first (section 2, rule M8), then the code.

Section map: 1 goals, 2 method (2.1 compile-fix and test-fix, 2.2 toolchain gate, 2.3 what the trial run changed and the checks it added), 3 decisions (conflicts, deviations, preserved defects,
non-ports), 4 layout, 5 layer boundary and the wasm API, 6 pinned Rust interfaces, 7 pinned
TypeScript interfaces, 8 JS to Rust patterns, 9 JS to TypeScript patterns, 10 numeric
semantics, 11 semantic traps, 12 dependency policy, 13 error model, 14 test strategy,
15 build and packaging, 16 definition of done, 17 byte layout reference.

---

## 1. Goals and non-goals

### 1.1 Goals

1. `archiver-wasm` is a drop-in replacement for `archiver@8.0.0`: the same four named exports
   (`Archiver`, `ZipArchive`, `TarArchive`, `JsonArchive`, node-archiver/index.js:6-39), the
   same methods, events, option names, defaults, error codes, private member names that the
   upstream tests touch (`_state`, `_normalizeEntryData`), and the same entry ordering rules.
2. It also provides what archiver-zip-encrypted 2.0.0 needs and offers: the archiver 7
   vending function (`archiver(format, options)`, `create`, `registerFormat`,
   `isRegisteredFormat`, archiver-zip-encrypted/node_modules/archiver/index.js:20-84) and the
   classes `ZipEncrypted`, `ZipAesStream`, `ZipCryptoStream`, `AesHmacEtmStream`,
   `CryptoStream`, `DecryptoStream`, `CryptoCipher`.
3. Every byte of an archive container is computed in Rust (`crates/archiver-core`), exposed through
   a thin wasm-bindgen layer (`crates/archiver-wasm`). Given the same inputs, dates, options and
   injected random bytes, archiver-wasm output equals upstream output byte for byte, with one allowed
   exception: the compressed payload produced by deflate (and therefore every size and offset
   derived from it).
4. The two upstream test suites (52 tests: 40 node-archiver, 12 archiver-zip-encrypted) run
   against archiver-wasm with zero tests skipped, deleted or weakened, and with zero edits to the test
   files (section 14).
5. The package ships ESM, CJS, `.d.ts` and the `.wasm` file, loads the wasm synchronously at
   import time, and runs on Node >= 18.

### 1.2 Non-goals (for the port phase)

- Idiomatic Rust or idiomatic TypeScript. The port must look like the original was
  transpiled. Cleanup is a later, separate phase.
- Fixing upstream bugs. Known upstream defects are reproduced (section 3.3).
- New features or new public API, with exactly these additions: the options
  `zip20Header` and `header` (section 3.2 V10) for injecting the ZipCrypto random header in
  tests, the archiver 7 members needed by the encrypted suite (section 3.1 R19), and the
  extra exports of the package entry listed in section 7.2 (`ArchiverError`, the encrypted
  classes, `create`, `registerFormat`, `isRegisteredFormat`).
- Byte-identical deflate or gzip payloads. Only the container is byte-identical.
- A general-purpose Rust archiving crate. `archiver-core` is the byte engine of the Node package;
  entry sequencing that upstream implements with streams and callbacks lives in TypeScript.
- Browsers, Deno, Bun, wasm threads, streaming instantiation, async wasm init.
- Bundled Node applications. The wasm glue is loaded with `createRequire` relative to the
  installed package (15.3), which esbuild, webpack and similar tools do not follow.
  Applications that bundle their dependencies must mark `archiver-wasm` as external in this
  phase (upstream, being pure JavaScript, can be bundled).
- Windows as a tested platform. The code keeps every upstream `win32` branch, but CI runs
  on Linux and macOS only (R14, 14.1).
- Reading or extracting archives. Reader-side upstream code is not ported (section 3.4).
- Performance work. Every input chunk is copied into wasm memory and every output chunk is
  copied out. That is accepted for now.

---

## 2. The method

This project imitates the method described in the blog post "Rewriting Bun in Rust".

M1. **Port everything at once, not incrementally.** There is never a build in which half the
    archive bytes come from the old JavaScript and half from Rust. All units in `PORTMAP.tsv`
    are written in parallel from this guide. Nothing is expected to compile or pass until all
    units exist. Then come a compile-fix phase and a test-fix phase, whose procedure is
    section 2.1. The only thing that is built before the units start is the toolchain gate
    of section 2.2, which contains no port code.

M2. **The port looks like the original was transpiled.** Same file boundaries (one target
    file per upstream file, section 4), same function order inside a file, same names
    (camelCase kept in TypeScript, snake_case in Rust, leading underscores kept: upstream
    `_writeLocalFileHeader` is Rust `_write_local_file_header`), same statement order, same
    branch order, same constants with the same names. Upstream code that nothing in the
    package calls or reads is left out, and V21 lists it. A reviewer who
    knows the upstream file must be able to read the port side by side with it. Every ported
    function carries a one-line comment with its upstream `path:line`. The reference comes
    first and is complete: the path as this guide cites it, relative to `.upstream/`
    (`// deps/crc32-stream/lib/deflate-crc32-stream.js:18-24`, never a bare
    `// deflate-crc32-stream.js:18`), then the line or range. Anything else (which part of
    the line, a section of this guide) follows it in parentheses. A helper that has no
    upstream function of its own but stands in for an upstream statement (the deflate loop,
    the gzip header, `validateZlibOptions`) cites that statement in the same form:
    `// node-archiver/lib/plugins/tar.js:28 (the 10-byte header zlib.createGzip writes, PORTING.md 6.4)`.
    Only a function that stands in for nothing upstream (`resolveLevel`, `wasmString`)
    carries `// PORTING.md <section>` instead. The listings and skeletons of sections 5 to
    7 shorten the path to save room (`// :62-72`, `// crc32-stream.js:5-10`); the files
    spell it out. A file that a section marks "verbatim" is the exception: it carries
    exactly the comments of its listing.

M3. **The upstream JavaScript test suites are the language-independent oracle.** They are
    vendored verbatim and run unmodified (section 14.1). No test is skipped, deleted or
    weakened. New tests are added next to them, never instead of them.

M4. **PORTING.md is written before any code** and maps source patterns to target patterns
    (sections 8 and 9). When an implementer meets a pattern that the tables do not cover, the
    answer is to add a row to the table (rule M8), not to improvise.

M5. **Every unit is written by 1 implementer, checked by 2 adversarial reviewers in separate
    contexts, then 1 fixer applies.** The implementer does not review. Reviewers do not
    implement; their only job is to find reasons the unit does not match upstream or this
    guide. Reviewer A compares against the upstream source line by line (fidelity). Reviewer B
    compares against sections 5 to 13 and the `BEHAVIORS.tsv` rows of the unit (conformance,
    interfaces, traps). The fixer verifies each finding against upstream before applying it.

M6. **Never stub a function to make it compile.** No `todo!()`, `unimplemented!()`,
    `unreachable!()` standing in for logic, empty bodies, `// TODO port later`, `as any`,
    `@ts-ignore`, or commented-out calls. If a callee does not exist yet, the unit is still
    written against the signature pinned in sections 5 to 7 and left not compiling. The only
    empty method bodies allowed are the ones upstream has (the "scaffold only" hooks at
    deps/compress-commons/lib/archivers/archive-output-stream.js:19-39) and the ones section 7
    marks as "performed in Rust".

M7. **If you need a paragraph-long comment to justify a workaround, the code is wrong. Fix
    the code.** Reviewers reject long explanatory comments that defend a divergence. A
    divergence is either listed in section 3 (then the comment is one line: `// PORTING.md
    V7`) or it is a bug.

M8. **When something goes wrong, fix the guide or the loop, not just the code.** If two
    units disagree on an interface, section 6 or 7 is wrong or ambiguous: fix it there, then
    re-run the affected units. If a class of bug appears twice, add a row to section 8, 9 or
    11 and a reviewer check. Hand-fixing one file while leaving the guide wrong is a defect.

M9. **No test is skipped, deleted or weakened.** No `.skip`, no `--grep` exclusions, no
    raised timeouts inside test files, no loosened assertions, no deleting a fixture. The
    test count ledger (section 14.5) is checked in CI. The single upstream-conditional skip
    (`this.skip()` on win32, node-archiver/test/plugins.js:123-125) stays as upstream wrote
    it.

M10. **Minimal behavior changes.** Every deliberate difference from upstream is listed in
    section 3.2 with a V number. Anything not listed there must behave like upstream,
    including error message typos, entry ordering, tick-level scheduling primitives, and
    hangs.

Unit loop, per `PORTMAP.tsv` unit:

1. Implementer receives: this file, the unit's `PORTMAP.tsv` rows, the `BEHAVIORS.tsv` rows
   whose target is in the unit, and read access to `.upstream/`. Writes the target files
   and, for every Rust file, its `#[cfg(test)]` module with the vectors that the table of
   section 14.3 assigns to that file, under the test names pinned there. Hands in, with the
   files, a list of every place where this guide left a choice open or contradicted itself
   or upstream (a helper without a pinned signature, a loop without a pinned exit, a
   counter without a pinned width, a spelling that does not type-check). The implementer
   decides nothing of that kind silently.
2. Reviewer A (fidelity) and reviewer B (conformance) each produce findings with evidence.
   Reviewer B also checks that every vector assigned to the unit in 14.3 is present. Both
   run the checks of the table in 2.3 that carry their letter.
3. Fixer verifies and applies. Rejected findings are answered with upstream evidence.
4. A finding that reveals a guide problem, and every entry of the implementer's list of
   step 1, is applied to this file first (M8), together with the stale rows of
   `PORTMAP.tsv` and `BEHAVIORS.tsv` it touches.

### 2.1 After the unit loop: compile-fix and test-fix

Units are left not compiling (M6) and each unit owns its files exclusively (4.1), so the
phases after the loop need their own rule for who edits what and who reviews it.

1. Compile-fix runs stage by stage, in this order: (a) `archiver-core` as a whole (a Rust crate
   is one compilation unit, so all `rs-*` core units are fixed together and the
   `depends_on` column of `PORTMAP.tsv` gives no order inside it); (b) `archiver-wasm`;
   (c) `scripts/build-wasm.sh` and `scripts/check-wasm-types.mjs`; (d) `tsc --noEmit`;
   (e) `tsdown`, after which `scripts/build-wasm.sh` is run again, because tsdown cleans
   `dist/` and the wasm output lives in `dist/wasm/` (15.4). One fixer per stage. That
   fixer may edit any file of the stage. Stages (a)
   and (b) are closed with `cargo fmt --check` and `cargo clippy --workspace -- -D warnings`
   clean. A lint that fires on an upstream spelling is settled by RS-40 (the list of 15.1),
   never by rewriting the expression or by an attribute on the item.
2. Every compile-fix edit is recorded as (file, upstream `path:line` of the statement it
   touches, reason) in the pull request description. An edit that changes only types,
   imports, visibility, lifetimes or borrow plumbing needs no further review. Any other
   edit (a changed expression, order, constant or branch) reopens the owning unit for that
   function: reviewer A re-reads it against upstream before the stage is closed.
3. An interface mismatch between two units is a guide defect. Sections 5 to 7 are corrected
   first (M8), then both files.
4. Test-fix: each failing test is mapped to its `BEHAVIORS.tsv` row and to the unit that
   owns the row's target. The fix is made in that unit's file and goes through reviewer A
   for the changed function. A failure that no row explains gets a row first.
5. No stage is closed with a stub (M6) or by weakening a test (M9).

### 2.2 Toolchain gate (step 0, before any unit is written)

Owned jointly by rs-scaffold and ts-scaffold. It proves the build chain end to end before
twenty units are written against it, because otherwise the first real build happens only
after every unit exists (M1).

1. In a temporary directory outside the repository, create a throwaway crate (not port
   code, so M6 does not apply; it is deleted when the gate has passed) that depends on
   `wasm-bindgen` with the pin of 12.1 and exports one `#[wasm_bindgen]` class with a
   constructor, one method taking `&[u8]`, `&str`, `Option<String>`, `f64`, `u32` and
   returning `Result<Vec<u8>, JsError>`, one `#[wasm_bindgen(getter)]`, and one free
   function.
2. Build it with the exact command line and release profile of `scripts/build-wasm.sh`
   (15.1, 15.2), including the renames.
3. `require()` the result under Node 18 (the lowest supported major) and under Node 24,
   call every export, check that the `Err` arm arrives as a thrown `Error`, that a string
   passed where `&[u8]` is expected is coerced as 5.6 describes, and that the process exits
   by itself.
4. Record the versions that passed and pin them: the exact Rust version in
   `rust-toolchain.toml`, the exact `wasm-pack` version in 12.3, the `wasm-bindgen` pin of
   12.1 (if that release does not build with the pinned Rust, the gate raises the pin to
   the newest release that does and records it in 12.1), whether `wasm-opt` runs (15.2),
   and the exact versions of `typescript`, `tsdown`, `tsx` and `@types/node` in
   `package.json`. `Cargo.lock` and `package-lock.json` are committed.
5. If no combination loads under Node 18, that is a blocker for goal 1.1 item 5 and is
   raised before the units start, not after.

**Gate record.** The gate ran on 2026-10-12 (macOS, Darwin 25.6.0, aarch64) and passed. The values
below replace the provisional ones this guide was written with. The gate is run again only
when one of them changes.

| Pin | Value | Recorded in |
|---|---|---|
| Rust | `1.99.0`, target `wasm32-unknown-unknown`, components `rustfmt` and `clippy` | `rust-toolchain.toml`, 12.3 |
| `wasm-pack` | `0.15.0` | 12.3, both workflow files |
| `wasm-bindgen` | `=0.2.100` (it builds with Rust 1.99.0, so the pin was not raised) | 12.1 |
| `wasm-opt` | off | 12.1, 15.2 |
| `typescript` | `5.9.3` | `package.json`, 12.2 |
| `tsdown` | `0.23.1` (not a gate value: the gate ran with `tsup` `8.5.1`, which tsdown replaced afterwards; see below) | `package.json`, 12.2 |
| `tsx` | `4.23.15` | `package.json`, 12.2 |
| `@types/node` | `18.19.130` | `package.json`, 12.2 |

What was executed: the throwaway crate of step 1, and a second throwaway crate that exports
the whole listing of 5.3 with placeholder bodies and links the seven crates of 12.1. Both
were built with the script of 15.2 and required under Node 18.0.0, 18.20.8, 20.20.2,
22.22.0 and 24.21.0: every export was called, the `Err` arm of a constructor and of a
method arrived as a plain `Error` with the `Display` text as `message`, and the process
exited by itself with wasm objects left to the `FinalizationRegistry`. On wasm32 the crates
of 12.1 reproduced the check values of 14.3 for CRC-32, PBKDF2, AES-CTR with a
little-endian counter and HMAC-SHA1. The whole chain of `npm run build`, `npm pack` and
`scripts/check-tarball.mjs` (with stand-ins for the unit files of `src/`) passed under Node
18.20.8, 20.20.2, 22.22.0 and 24.21.0.

That chain was the one of the gate: the bundler was tsup 8.5.1, the wasm output was in
a top-level directory of its own, and the two published entries were hand-written files. The build has been migrated
since (15.4): tsdown 0.23.1 is the bundler, the wasm output is in `dist/wasm/`, and no
entry is written by hand. tsdown declares `node: ^22.18.0 || ^24.11.0 || >=26.0.0`, so the
build no longer runs under Node 18 or 20; the package still supports Node 18 and newer,
and the tests still run under every supported major (15.5). The gate has not been run
again with tsdown. Where a finding below was made with tsup, it says so.

What the gate found, and where this guide changed because of it:

- A non-string at a `&str` or `Option<String>` parameter is not coerced by the glue. A
  number, boolean, plain object, symbol or bigint traps (`WebAssembly.RuntimeError: memory
  access out of bounds`; on Node 18.0.0 and 18.12.0 on darwin-arm64 the process is killed
  by SIGBUS). The claim that the glue coerces string parameters was wrong: 5.6 and V14 are
  corrected, `src/wasm.ts` gained `wasmString` (15.3), and the call sites of 7.5 and 7.8
  use it.
- At a `&[u8]` parameter a typed array that is not a `Uint8Array` is copied element by
  element, and an `ArrayBuffer` or `DataView` arrives as zero bytes (5.6, 7.9).
- The declarations generated for the listing of 5.3 satisfy `ArchiverWasm`;
  `scripts/check-wasm-types.mjs` rejects a changed return type, a missing method and an
  added required parameter.
- `typescript` is pinned at 5.9.3. With tsup's `dts` build the gate could use neither
  7.0.2 (the package no longer exports the JavaScript compiler API) nor 6.0.3 (`TS5101`,
  tsup passed `baseUrl`). Neither version has been tried with tsdown's `dts` build; the
  pin is unchanged.
- `src/wasm.ts` passes `__filename` to `createRequire` where it exists, which is in the
  CommonJS bundle, and `import.meta.url` otherwise (15.3). The gate found the reason with
  tsup: its `import.meta.url` shim for CommonJS lost everything after a `#` or `?` in the
  install path and decoded `%XX`, and the package then could not find its wasm.
  `tsdown.config.ts` sets no shim option, and the spelling of `src/wasm.ts` does not depend
  on one.
- `wasm-pack` also writes `archiver_wasm_bg.wasm.d.ts` next to the glue; the build script
  removes it (15.2).
- `rustup` with the `minimal` profile installs neither `rustfmt` nor `clippy` for the
  pinned toolchain; `rust-toolchain.toml` lists both components (12.3).
- With `wasm-opt` enabled, `wasm-pack` 0.15.0 runs whichever `wasm-opt` it finds on `PATH`
  (binaryen 133 on the gate machine: the result loads under Node 18 and shrinks the
  placeholder module from 155 KiB to 131 KiB). The published binary would then depend on
  an unpinned tool, so it stays off.
- `npm pack --json` prints the output of the `prepack` script on the same stdout, before
  the JSON report. `scripts/check-tarball.mjs` now packs with `--ignore-scripts` and still
  reads the report from the end of stdout (15.5).
- The `overrides` block this guide first pinned (one nested object per oracle package) does
  not work with npm 10: `zip-stream` 7.0.5 resolves the 6.0.0 versions of its two
  dependencies, and `npm ci` rejects the lockfile. It was replaced by a flat block keyed by package and major range, with which
  npm 10.8.2, 10.9.4 and 11.19.0 all install the oracle tree of 14.2 and accept each
  other's lockfile (15.4).
- `brace-expansion` 5.0.12, which `minimatch` 10.2.6 depends on, declares
  `node: 20 || >=22`. On Node 18 `npm install` prints an `EBADENGINE` warning for it; it
  loads and expands braces under Node 18.0.0 and 18.20.8. `minimatch` itself declares
  `18 || 20 || >=22`.
- The declaration of the CommonJS entry, which was a hand-written file at the time of the
  gate, compiled, and both TypeScript smoke files of section 16 item 4 compiled against
  the packed tarball. That declaration is now `dist/index.d.cts`, generated from
  `src/commonjs.ts`; tsdown runs attw on it at level `error` in every build (15.4).
- The package loads under Node 18.0.0. The test tooling needs Node 18.18 or newer
  (`mocha` 11.7.5 declares it, and `mocha -n import=tsx` needs `node --import`), which the
  Node 18 job of CI satisfies (12.3).

### 2.3 What the trial run changed, and the checks it added

Three units (rs-crc-deflate, rs-zip-util, ts-helpers) were written, reviewed and fixed
before the others, to test this guide rather than the code. Every problem their
implementers and fixers reported was checked against upstream and against the written
files and then fixed here first (M8); the files of the three units agree with the guide as
it stands now. The table lists each class of problem, where it is pinned now, and what a
reviewer of every remaining unit checks because of it (A: the fidelity reviewer, B: the
conformance reviewer).

| # | Class of problem | Pinned in | Reviewer check |
|---|---|---|---|
| K1 | A loop around a C-style codec call (separate counts for input consumed and output produced) that stops when the input is consumed, although the codec still holds output behind a full buffer. | 6.4, 11.11 | A: the loop goes on while the call filled the output buffer. The crate has one such loop (`crc32_stream::deflate`); no unit writes a second one. |
| K2 | A pinned loop without an exit for "consumed nothing, produced nothing". A status such as flate2's `Status::BufError` arrives as `Ok`, so mapping `Err` alone does not end the loop. | 6.4, 6.2, 13.4, 11.11 | B: every loop whose progress depends on a third-party call has a no-progress exit with a pinned error text. |
| K3 | The upstream reference comment of a helper drifts into prose with a bare file name. | M2 | A: every function comment starts with the full `path:line`, relative to `.upstream/`. |
| K4 | A note in this guide describes the implementation for one value of a flag only (`strip_trailing`); a porter who follows the note instead of upstream drops the other branch. | 6 (rules), 6.6 | A: for every parameter that selects a branch, each branch is ported from the cited upstream lines. B: the `#[cfg(test)]` module exercises every value of the flag. |
| K5 | A JS coercion idiom (`\| 0`, then an unsigned Buffer write) carries a range check that throws; the Rust mapping has no such check. | 10.2 (domain column) | A: a throw outside the stated domain is not a finding; a different result inside it is. |
| K6 | An item-level `#[allow(...)]` added because an upstream spelling was expected to trip a lint (`1 << 0` and `clippy::identity_op`: clippy exempts exactly that spelling). | RS-40, 15.1 | B: no `#[allow]` that this guide does not print; no expression rewritten to please a lint. |
| K7 | A pinned TypeScript spelling that does not type-check against the pinned `@types/node` (`new zlib.DeflateRaw(...)`: `DeflateRaw` is only an interface in 18.x). | 7 (rules), 7.7, TS-41 | B: the unit's files were run through `tsc --noEmit` (the only errors left name an import of a unit that does not exist yet); an assertion that TS-41 does not list was reported, not improvised. |
| K8 | A pinned spelling that departs from the upstream expression (`._read` where upstream has `[method]`). | 7 (rules), TS-41 | A: a type assertion wraps the upstream expression and changes nothing else. |
| K9 | A base class replaced by another implementation (readable-stream 2 by `node:stream`) and treated as neutral, although the lifecycle defaults differ (`autoDestroy`, `emitClose`, what `pipe` and `read` do with an error). | V9, 7.4, 11.12 | A: every class whose base differs from upstream's passes the constructor options that V9 lists for it. |
| K10 | An `Object.defineProperties` block folded into an object literal, which changes `writable`, `enumerable` and `configurable`. | TS-42, 7.3 | A: property descriptors are ported as descriptors. |
| K11 | State, widths and out-of-order behavior that a pinned struct or signature leaves open (the name of a shared helper, the type of a counter, a second `finish`, a parameter the body does not read). | 6 (rules), 6.4, 6.6 | B: nothing of that kind was decided silently; the implementer's list names each case (unit loop step 1). |
| K12 | A stale row: a `depends_on` that misses an import, a `BEHAVIORS.tsv` target naming an item that the pinned call path does not reach, a note that assigns another unit's test to this one. | 3.5 | B: `depends_on` lists every file of another unit that a target file imports; every target item exists and is reached. |

Rules for whoever changes a pin in this guide (they are how the rows above were fixed):

1. A TypeScript snippet is compiled with the pinned `typescript` and `@types/node` before
   it is pinned. A statement that a lint fires, or stays silent, is checked with the pinned
   `clippy` first.
2. A pin keeps the upstream expression and adds only the type or the assertion.
3. A note under a signature with a flag covers every value of the flag, or cites the
   upstream line range and adds nothing.
4. A pinned loop lists all of its exits. A pinned struct lists all of its state.
5. Where a base class or a library is substituted, the behavior of both sides is observed
   by running them, on the lowest and the highest supported Node, and recorded in 3.2. It
   is never assumed to be the same.

---

## 3. Decisions

### 3.1 Conflicts between the inventories, and their resolution

The six inventories (core, zip, tar+json, encrypted, glob+fs, tests) disagreed or left a
choice open in the places below. The resolution is binding.

| # | Conflict | Resolution |
|---|---|---|
| R1 | Stream base class: readable-stream v4 (what core.js:12, utils.js:2, json.js:1 and archive-output-stream.js:3 import) or `node:stream` (glob-fs and tests inventories). | `node:stream` everywhere in `src/` (Node >= 18). readable-stream v4 is a snapshot of Node 18 streams, the oracle passes either way, and one stream implementation avoids mixed pipes. lazystream stood on readable-stream 2, which has a different lifecycle; what the port does about it is V9 and 7.4. `readable-stream@^4` stays a devDependency because the unmodified test helper imports it (node-archiver/test/helpers/index.js:5). Exception: the tar engine (`Pack`, `Sink`) keeps extending `streamx` classes exactly as deps/tar-stream/pack.js:1 does (R2). |
| R2 | Tar engine streams: emulate streamx hooks (`_open`, `_predestroy`, `eagerOpen`) on Node streams, or keep streamx. | Keep `streamx` as a runtime dependency. `src/tar-stream/pack.ts` is then a literal port of pack.js. Consequence: `Tar.unpipe` without gzip still throws the upstream TypeError (TAR-JSON-016/104, section 3.3 P9). |
| R3 | Task queue: keep `async` or port a minimal queue. One inventory said processing starts "on a later macrotask". | Port to `src/queue.ts` (section 7.3). Processing is scheduled with `queueMicrotask` (node-archiver/node_modules/async/internal/setImmediate.js:24-25), not a macrotask. |
| R4 | JSON format: the fixed architecture puts "json plugin format" in `archiver-core`; the tar-json and tests inventories show the output is `JSON.stringify` of live JS objects (user keys, `Date`, `fs.Stats`). | Refinement: Rust computes only what is derived from bytes, the CRC-32 (`archiver_core::json::append`). `src/plugins/json.ts` keeps the `files` array and calls `JSON.stringify` exactly like json.js:39-42. |
| R5 | Rust override seams for the encrypted engines: an `EntryCodec` trait (zip inventory) or one writer with an `Encryption` enum and match arms (encrypted inventory). | Enum and a dispatch table (section 6.9). The subclasses override control flow (ZipCrypto writes the local header last), not only a byte transform, so a codec trait does not fit. |
| R6 | `sanitizePath` and `normalizePath`: `rust-core` (zip inventory) or `ts` (core and glob-fs inventories). | Both layers have a copy, because upstream calls them from both kinds of code. TypeScript: `src/normalize-path.ts`, `src/utils.ts#sanitizePath` (core), `src/zip-stream/utils.ts#sanitizePath` (ZipStream). Rust: `zip/utils.rs`, used only by `ZipArchiveEntry::set_name`. The sanitizer is not idempotent and upstream applies it three times on the archiver zip path (core.js:276, zip-stream/index.js:71, zip-archive-entry.js:288); archiver-wasm applies it at the same three places. One shared vector file tests all copies (section 14.3). |
| R7 | DOS time: who handles the time zone and Invalid Date. | TypeScript picks the getter family (`getUTC*` or local, zip/util.js:3-16) and passes six numbers as f64. Rust packs them with ECMAScript `ToInt32` on each operand. `NaN` fields (Invalid Date) therefore yield 0 with no special case (ZIP-086). |
| R8 | CRC-32: hand-port slice-by-16 (crc-32/crc32.js:70-82) or use a crate. | `crc32fast` for `crc32::buf`. The ZipCrypto key schedule needs the raw table update without inversion and keeps its own 18-line port (`zip/encrypted/crc.rs`). |
| R9 | 64-bit sizes across wasm: f64 or BigInt. | f64 in every wasm signature, converted to `u64` inside the wasm layer. No `bigint` anywhere in TypeScript types. |
| R10 | AES "is deflate" decision: read back from the extra field (zip-aes-stream.js:160) or keep a separate field. | Literal: read the i16 at offset 9 of the entry extra, with a bounds check that returns `ZipError::ExtraTooShort` instead of panicking. |
| R11 | `getBytesWritten()` after a non-ASCII archive comment (ZIP-101: upstream counts UTF-16 units). | Byte-accurate count (V5). |
| R12 | Tar mtime: one inventory wrote `Math.floor(ms / 1000)`. | Wrong. Upstream is `(mtime.getTime() / 1000) \| 0` (deps/tar-stream/headers.js:74): truncation toward zero, then 32-bit wrap. Section 10.6. |
| R13 | `ArchiverError`: ES class (glob-fs inventory) or function constructor (core inventory). | Function constructor with `util.inherits`, as lib/error.js:28-35, because `message`, `code`, `data` must be own enumerable properties and `name` must stay `'Error'` (ARCHIVER-CORE-099). |
| R14 | Gzip header OS byte: pin 3, or follow the platform like Node's zlib. | Follow the platform so that output equals upstream on the same machine: TypeScript passes 19 on darwin, 10 on win32, 3 elsewhere. Only the darwin value was observed by execution. The linux value is asserted by the tar.gz differential test (14.2) on the Linux CI job. Windows is not a tested platform in this phase (14.1): the win32 value 10 is taken from zlib's `zutil.h` and is unverified. |
| R15 | zlib option bags (`zlib`, `gzipOptions`): the zip inventory assigned passthrough to the wasm layer. | Only `level` (and `strategy`, for the gzip XFL byte) reach Rust. Validation of the whole bag is done in TypeScript by constructing and immediately closing the Node zlib object upstream would have constructed, at the same point (section 7.7). No archive byte is produced by Node zlib. |
| R16 | Which base zip writer do the encrypted engines sit on: archiver-zip-encrypted 2.0.0 runs on zip-stream 6.0.0 / compress-commons 6.0.0, the pinned sources are 7.0.5 / 7.0.1. | The 7.x port. The byte-producing output-stream code of 6.x and 7.x is line-for-line equivalent (checked: archiver-zip-encrypted/node_modules/compress-commons/lib/archivers/zip/zip-archive-output-stream.js). The archiver 7 stack differs from the code archiver-wasm ports in three semantic ways that archiver-wasm does not reproduce: lodash `defaults` mutating the caller's objects in place, the defaulting of keys explicitly set to `undefined`, and `instanceof Stream` source detection. They are listed as V15 and have `BEHAVIORS.tsv` rows ENCRYPTED-113 to ENCRYPTED-116. The single place where archiver-wasm does reproduce the lodash semantics is the `ZipEncrypted` constructor (7.9). |
| R17 | Entry callback payload of the zip engines (upstream passes the live `ZipArchiveEntry`). | The TypeScript `ZipArchiveEntry` object, filled from a snapshot when the entry completes (V6). |
| R18 | Callable constructors (`ZipEncrypted(opts)`, `AesHmacEtmStream(opts)`, `CryptoStream(opts)` without `new`). | ES classes wrapped by `callable()` (a `Proxy` with an `apply` trap, section 7.9). |
| R19 | archiver 8 removed `create` / `registerFormat`; the encrypted suite needs them. | archiver-wasm ships both surfaces (section 7.2). `Archiver` additionally gets the archiver 7 members `setFormat`, `setModule`, `_moduleSupports`, and the plugins get the archiver 7 `supports` property. |
| R20 | Mocha or vitest for the upstream suites. | Mocha, unmodified test files (section 14.1). |

### 3.2 Deliberate deviations from upstream

This table is the complete list of allowed differences. A code comment refers to them by
number.

| # | Deviation | Why |
|---|---|---|
| V1 | Deflate and gzip compressed payload bytes differ from zlib; `csize`, offsets and descriptors follow the actual compressed length. The compressed size differs too. At zlib level 1, which is the zip default (zip-archive-output-stream.js:113-114), miniz_oxide output is larger than zlib's: measured archives of one deflated entry were 9 to 19 percent larger than upstream's (15.4 MB of JavaScript source: 3499632 bytes upstream, 4127264 bytes archiver-wasm). At levels 2, 6 and 9 the sizes were within about 1 percent of zlib's or smaller. Level 1 is passed to miniz_oxide as 1 (`zlib_level`, 6.4) and is not remapped to 2: the gzip header XFL byte is derived from the same value (`Gzip::new`). | Allowed by the project rules; miniz_oxide is not zlib. Its level 1 is one probe with greedy parsing, a faster and weaker mode than zlib's `deflate_fast`. Every output inflates to the input. |
| V2 | zlib options other than `level` (and `strategy` for the gzip header XFL byte) are validated (R15) but have no effect: `memLevel`, `windowBits`, `chunkSize`, `dictionary`, `flush`, `finishFlush`, `maxOutputLength`, `info`. | miniz_oxide has no equivalent; they only influence the payload. |
| V3 | Completion callbacks that upstream fires from zlib thread-pool completion fire from stream events of the per-entry `SmartStream` instead. They are still asynchronous. The ZipCrypto promise chain (zip-crypto-stream.js:69-73, 119-138) is not reproduced; the buffered chunks are encrypted in one synchronous loop. | No thread pool in wasm. For zip a deflated buffer entry completes in the turn its queue worker started, at least one turn of the event loop before upstream (whose turn depends on the input size and on the thread pool: 1 turn for 1 byte, 45 for 70 kB). Archiver core's `setImmediate` (core.js:180, 208) does not hide that: with `file()` of a missing path followed by `append()`, archiver-wasm emits `'entry'` and `'progress'` (`entries.total` 2) before the ENOENT `'warning'`, upstream the warning first (`entries.total` 1); and upstream's hang of `abort()` between an entry's completion and its deferred queue callback (P32) falls one turn earlier: `abort()` after one `setImmediate` never ends in archiver-wasm and ends upstream. After two, archiver-wasm ends and upstream is not stable: it hung in about 10 of 15 runs and ended in the others, depending on the thread pool. Only the one-turn case and the warning-order case are pinned for upstream (case R5). Stored entries are equal in both, and bytes are unaffected. For tar.gz `Gzip` (7.7) keeps zlib's order with `setImmediate`: each `_transform` / `_flush` pushes and calls back on a later turn of the event loop, and the last chunk of an ended stream ends the member, so `_flush` pushes nothing (node lib/zlib.js `_transform`, `_flush`, `processCallback`). `pointer()` when `finalize()` resolves and the place of `'close'` among a destination's events then match upstream, except where the thread pool answers before a pending `setImmediate` (a tar.gz of only directory entries: `pointer()` is 0 where upstream has 10, and `'close'` follows a `setImmediate`-deferred destination's `'finish'`) and where the deflate output is cut into different chunks (`level: 0`). |
| V4 | Output chunk boundaries differ: upstream writes each header field as its own chunk (zip-archive-output-stream.js:325-351) and tar pushes header, pax block and padding separately; archiver-wasm emits what one wasm call produced as one chunk. | Byte stream identical; only the number of `'data'` events changes. |
| V5 | `ZipArchiveOutputStream.getBytesWritten()` counts bytes for a non-ASCII archive comment (upstream adds `comment.length` in UTF-16 units, zip-archive-output-stream.js:193 with archive-output-stream.js:94). | Rust tracks byte offsets. Nothing reads the value after the comment is written. |
| V6 | The second argument of a zip engine entry callback is the TypeScript `ZipArchiveEntry` record filled from a snapshot taken when the entry completes. Mutations the central directory pass makes later (zip64 extra, version 45) are not reflected on it. | The live entry is owned by Rust. Archiver core ignores the argument (core.js:172). |
| V7 | `ZipArchiveEntry` setter errors that depend on negative numbers or wrong classes are unrepresentable in Rust and not ported there: `'invalid entry compressed size'`, `'invalid entry size'`, `'invalid entry crc32'`, `'invalid entry GeneralPurposeBit'` (zip-archive-entry.js:218-261). `'invalid entry compression method'` and `'invalid entry time'` survive on the TypeScript `ZipArchiveEntry` (section 7.6). | Unsigned types. No archiver-wasm code path can trigger them. |
| V8 | A zlib processor error that never emits `'end'` (ZIP-053) cannot happen; the ZipCrypto unhandled-rejection hang (ENCRYPTED-047) cannot happen. Where the archiver-wasm engine itself fails in the middle of an entry (`ZipError::Deflate`), the error is not stored and lost as upstream's processor error is: it is delivered through the entry callback (13.4). | The failing component no longer exists; a failure of its replacement must be visible. |
| V9 | `node:stream` replaces readable-stream v4 (core, utils, json, zip engine) and readable-stream v2 (lazystream). The v4 classes pass no extra constructor options: v4 is a snapshot of the Node 18 streams and has the same lifecycle defaults (`autoDestroy` and `emitClose` on). readable-stream 2.3.8 has neither option: upstream's lazy stream is never destroyed by its own end or by an error, and never emits `'close'`. `lazystream.Readable` is therefore constructed with `autoDestroy: false, emitClose: false` (7.4), which restores both, also on the path with no `'error'` listener (P22): the error handler of `pipe` then emits again synchronously instead of destroying the stream. Two differences remain on the lazy stream itself: it emits `'end'` before `'finish'` (v2: `'finish'` first), and a factory `fn` that throws arrives as an `'error'` event where v2 lets the exception escape from `read()`. | R1. For the v4 classes the differences are limited to default buffering thresholds on newer Node versions and to the errors the stream implementation raises itself: a chunk that is neither a string nor a Buffer from an objectMode source (`append(Readable.from([1]))`) is `ERR_INVALID_ARG_TYPE` in both, with the same `name`, event count, bytes written and `finalize()` outcome for zip, tar and tar.gz, but it is Node's own `TypeError` with wording that depends on the Node version (`Buffer, TypedArray, or DataView` on Node 24) where readable-stream has its `NodeError` (`Buffer or Uint8Array`, writable.js:270). For lazystream: no archiver-wasm engine listens for `'finish'` or `'close'` on a source, and archiver's factory is `createReadStream(task.filepath)` after an `lstat` of the same path succeeded (core.js:457-459). Observed by running lazystream 1.0.1 and the port side by side on Node 18.0, 18.20, 20, 22 and 24: with the two options the events and the `destroyed` flag are equal for a file read to its end, for an open error with a listener and for one without; with the `node:stream` defaults the port also emits `'close'` and ends up destroyed. GLOB-FS-092, GLOB-FS-095. |
| V10 | New option `zip20Header` (12 bytes) on `ZipCryptoStream` / `ZipEncrypted` options and `header` on `CryptoStream` options: when present it replaces `crypto.randomBytes(12)` (crypto-stream.js:33). Bytes 10 and 11 are still overwritten with the CRC check bytes. The option must be a `Buffer` of exactly 12 bytes; anything else throws a `TypeError` in TypeScript (7.9). archiver-wasm also draws the per-entry random bytes at a different time than upstream: once at the start of every entry, before the local header, also for entries with no payload. Upstream draws the 12 ZipCrypto bytes inside the first `CryptoStream._transform` (crypto-stream.js:32-33), so only for entries with at least one payload byte and after the entry was compressed, and the AES salt in `_smartStream` after the local header (zip-aes-stream.js:151-153, 162). The number and order of `crypto.randomBytes` calls is therefore not part of the contract (ENCRYPTED-117); tests inject through `options.salt` / `zip20Header` / `header` and never through a stub that depends on the call count. | Project rule: random salts and IVs must be injectable. Upstream has an injection point only for the AES salt (`options.salt`, zip-aes-stream.js:162). The bytes are an argument of the one wasm call that starts the entry (5.3). |
| V11 | The `Archiver` constructor also accepts the archiver 7 form `(format, options)`: if the first argument is a string it is ignored and the second is the options object. | R19. In archiver 8 a string first argument would be spread into characters, which nobody relies on. |
| V12 | `Zip`, `Tar` and `Json` plugin instances carry `supports = { directory: true, symlink: true }` as in archiver 7 (archiver-zip-encrypted/node_modules/archiver/lib/plugins/zip.js:33). | Needed by `setModule` (R19). Not serialized, not otherwise read. |
| V13 | wasm panics are bugs, never behavior. Where upstream would throw a JS `RangeError` or `TypeError` from a Buffer read on a short buffer in a path archiver-wasm cannot reach, Rust returns an `Err` with its own message. | Section 5.5. |
| V14 | Values whose JS type is outside the published TypeScript types (a number as `comment`, an object as `uid`, a Buffer as archive comment) are out of contract unless a `BEHAVIORS.tsv` row covers the case. They must not trap the wasm instance; message parity is not required. For number parameters the JS-to-wasm call coerces (5.6). For string parameters (`&str`, `Option<String>`) the glue does not coerce and most non-strings trap: every argument at one is a string by construction or goes through `wasmString`, which throws a `TypeError` first (5.6, 15.3). For byte parameters (`&[u8]`) the glue does not validate and does not throw: every value that reaches one must be converted to a `Buffer` or rejected in TypeScript before the wasm call (5.6, 7.9). A `comment` that is not a string and that upstream would write (`.length > 0`, zip-stream/index.js:44, 134) is rejected with `TypeError('expected a string')` where the caller can see it: the archive option is thrown by the `ZipStream` constructor, the entry option is delivered through the entry callback (archiver emits `'error'`). Upstream writes a Buffer comment. | The wasm-bindgen glue has its own coercion rules. |
| V15 | On the archiver 7 surface (the vending function and `ZipEncrypted`) archiver-wasm runs the archiver 8 core and the zip-stream 7 port, not archiver 7.0.0 / zip-stream 6.0.0 / compress-commons 6.0.0 / archiver-utils 5.0.1. Consequences: (a) options and entry data are copied with object spread, not defaulted in place with lodash `defaults`: the caller's options object does not gain `highWaterMark` / `statConcurrency` (so the encrypting engine keeps Node's default `highWaterMark` instead of 1 MiB), the caller's entry data object is not mutated, and the `'entry'` payload lacks the keys `namePrependSlash`, `linkname`, `store`, `comment` (for `symlink()` also `date`, `mode`, `store`) that zip-stream 6 wrote onto it. For `symlink()` on aes256 and zip20, upstream's `'entry'` payload carries the sanitized name (`evil-link` for `../../evil-link`), because zip-stream 6 writes it onto the entry data (archiver-zip-encrypted/node_modules/zip-stream/index.js:77). archiver-wasm emits the name as given. The archive bytes are equal (case D12); (b) a key explicitly set to `undefined` is not defaulted (`mode: undefined` gives platform FAT and external attributes 0 where the archiver 7 stack writes version-made-by `0x032D` and `0x81A40020`); (c) sources are detected with is-stream duck typing, not `instanceof Stream` (a duck-typed `{ readable: true, pipe }` object is accepted where archiver 7 emits `INPUTSTEAMBUFFERREQUIRED`). | R16, R19. One core for both surfaces; evidence: archiver-zip-encrypted/node_modules/archiver-utils/index.js:59-68, archiver/lib/core.js:35, 288, 580, zip-stream/index.js:62. ENCRYPTED-113 to ENCRYPTED-116. |
| V16 | wasm32 memory limits. (a) No wasm call carries more than `MAX_CHUNK` = 1 MiB of payload; TypeScript slices (5.4). (b) The payload of a stored buffer entry of the plain engine never enters wasm: TypeScript computes its CRC in slices and writes the bytes itself, as upstream's `this.write(source)` (zip-archive-output-stream.js:86). (c) ZipCrypto buffers the compressed entry until it ends in the JS heap, as upstream (zip-crypto-stream.js:46-54), not in linear memory, which never shrinks: `writeData` hands the compressed bytes out, `SmartStream` keeps them in `_bufferedData`, and after `endData()` wrote the local header it passes them back through `encryptData` in slices (7.5). wasm holds the pipeline state, one slice and what the final flush of the deflate stream produced. (d) A name and an entry comment enter wasm whole and are copied several times there: one of more than 64 MiB of UTF-8 fails with `Error('entry name too large')` or `Error('entry comment too large')` delivered through the entry callback (archiver emits it as `'error'`), where upstream writes it (with the length field of P24). After this error each later entry of the same archive emits `already processing an entry` (13.4). No test pins that: case R4 uses a single entry. | A wasm32 slice cannot exceed 2 GiB and linear memory is 4 GiB in total; without the rule a large Buffer would abort the instance, and a name of 900 MB did (`rust_oom`). ZIP-137, ENCRYPTED-118. |
| V17 | The wasm encoder of an engine stream is freed when the stream is destroyed (5.4). `isZip64()` called after that throws the glue's `Error` (`null pointer passed to rust`) where upstream would still answer from JS state. `entry()` and `finish()` on a destroyed stream (archiver core reaches both after a `signal` abort) do not touch the encoder and do what upstream's writes to a destroyed stream amount to: a stored or empty buffer entry of the plain engine completes and calls back, every other entry never calls back (upstream's smart stream piped into a destroyed stream never ends), `finish()` writes nothing. A stream whose `signal` was already aborted is destroyed inside `super()`, before the encoder exists; the constructor frees the encoder it then creates. | Linear memory is not garbage collected in step with the JS heap; waiting for `FinalizationRegistry` alone lets it grow without bound. |
| V18 | The encrypted constructors (`ZipEncrypted`, `ZipAesStream`, `ZipCryptoStream`, `CryptoStream`, `DecryptoStream`, `AesHmacEtmStream`) called as `X.call(this, options)` from a `util.inherits` subclass return a new instance and leave `this` uninitialised; upstream initialises `this` (zip-encrypted.js:31-35). `class extends X`, `X(options)` and `new X(options)` behave as upstream, and `X.name` and `instance.constructor` are upstream's. | R18: an ES class cannot be applied to an existing `this`. |
| V19 | archiver 7's `Archiver.prototype.use(plugin)` (archiver-zip-encrypted/node_modules/archiver/lib/core.js:913-916) is not ported; calling it throws a `TypeError`. | It is `@private` and "yet to be fully implemented": it pushes into `_streams`, which nothing reads. archiver 8 removed it. |
| V20 | The package ships one bundle per module format (`dist/index.mjs` for `import`, `dist/index.cjs` for `require`; 15.4). A process that loads both has two sets of classes, so `instanceof` does not hold across the two module formats: an archive made by `require('archiver-wasm')('zip')` is not an instance of the imported `Archiver`, and an error created by one bundle is not an instance of the other's `ArchiverError`. Within one format everything is as upstream. Two things are shared: the format registry of `src/vending.ts`, which is kept on `globalThis[Symbol.for('archiver-wasm.formats')]` (the bundle that loads first registers `zip`, `tar` and `json`, the other finds the registry and registers nothing, so a format registered through `require` is visible to `import` and the reverse), and the wasm instance (both bundles `require` the same `dist/wasm/archiver_wasm.cjs`). Upstream ships one module format per major, so it has one set of classes per installed copy. | No entry is written by hand: tsdown builds each format from `src/`, and publint and attw check the result (15.4). One set of classes for both formats needed a hand-written CommonJS entry, a hand-written declaration of it and a hand-written ESM entry that re-exported it. |
| V21 | Upstream code that nothing in the package calls or reads is not ported. Rust: buffer-crc32 `unsigned`; `CRC32Stream.hex` and `DeflateCRC32Stream.hex`; archive-entry.js (the `ArchiveEntry` marker class) and every constant of unix-stat.js; in constants.js `WORD`, `DWORD`, `SHORT`, `LONG`, `SHORT_MASK`, the four `ZLIB_*`, `DEFAULT_FILE_MODE`, `DEFAULT_DIR_MODE`, `EXT_FILE_ATTR_DIR`, `EXT_FILE_ATTR_FILE`, `S_IFMT`, `S_IFIFO`, `S_IFCHR`, `S_IFBLK`, `S_IFLNK`, `S_IFSOCK`, `S_DOS_V`, `S_DOS_S`, `S_DOS_H`, `S_DOS_R`; in zip/util.js `fromDosTime`, `getShortBytesValue`, `getLongBytesValue`; in general-purpose-bit.js `parse`, `setNumberOfShannonFanoTrees`, `getNumberOfShannonFanoTrees`, `setSlidingDictionarySize`, `getSlidingDictionarySize`, `usesEncryption`, `useStrongEncryption`, `usesStrongEncryption`, `usesUTF8ForNames` with their three fields and three flag constants; in zip-archive-entry.js `getLastModifiedDate`, `getUnixMode`, `setGeneralPurposeBit`, `setInternalAttributes`, `setPlatform`, `isUnixSymlink`; `ArchiveOutputStream.getBytesWritten` and `ZipStream.finalize` (both stay in TypeScript, and wasm does not export `getBytesWritten`); the stored `key` of `CryptoStream` and `DecryptoStream`; `SALT_LENGTH` of aes-hmac-etm-stream.js; the tar-stream header constants `GNU_MAGIC` and `GNU_VER`, which only the reader side (N3) reads. TypeScript: the `DoublyLinkedList` members `insertBefore`, `unshift`, `pop`, `toArray`, the iterator and `remove`; the `stripTrailing` parameter of `normalizePath`; the `checkOpen` option of `isStream`; the `options` parameter of `lazystream.Readable`; the callback form of readdir-glob; the default export and the `ArchiveEntry` and `ArchiveOutputStream` re-exports of compress-commons.js and the default export of compress-commons util/index.js; the fallback object of tar-stream constants.js and the statement `if (sink._isVoid) { return sink }` of `Pack.entry`; `COMPOSITE_KEY_LENGTH` and `PBKDF2_ITERATION_COUNT` in `aes-hmac-etm-stream.ts` and `HEADER_LENGTH` in `decrypto-stream.ts`, whose uses are in Rust (6.11). | The package has no dead code. None of these is on a write path or on the published surface (7.2), so no output byte, event or exported name changes. Sections 6.1, 6.4 to 6.8, 6.10, 6.11, 7.3, 7.4 and 7.8 name each item where it would stand. N2, N3 and N5 list what was left out from the start. |

### 3.3 Upstream defects that are preserved

Do not fix these in the port phase. Each has `BEHAVIORS.tsv` rows.

| # | Defect | Rows |
|---|---|---|
| P1 | A `directory()` data function that throws or returns a non-object leaves the walker paused forever; `finalize()` never completes. | ARCHIVER-CORE-084/085, GLOB-FS-116 |
| P2 | An unsupported fs entry type found by `directory()`/`glob()` (socket, FIFO, device) leaves the walker paused forever. | GLOB-FS-062, ARCHIVER-CORE-043 |
| P3 | An lstat failure for a glob-originated task never resumes the walker. | ARCHIVER-CORE-047 |
| P4 | A globber `'error'` does not decrement `_pending`. | ARCHIVER-CORE-088/092 |
| P5 | `abort()` while a requested `finalize()` is still deferred (entries or walkers pending) leaves the finalize promise pending forever. After a `finalize()` that finalized synchronously (`_state.finalized` is true), `abort()` is a no-op (core.js:507-510) and the promise resolves. | ARCHIVER-CORE-072 |
| P6 | `glob()` has no `QUEUECLOSED` check. | ARCHIVER-CORE-090 |
| P7 | `dateify` turns numeric timestamps into "now". | ARCHIVER-CORE-036, ZIP-015 |
| P8 | Error code `INPUTSTEAMBUFFERREQUIRED` and message word `diretory` are misspelled. | ARCHIVER-CORE-098 |
| P9 | `TarArchive.abort()` without gzip throws `TypeError: Cannot read properties of undefined (reading 'apply')`. | TAR-JSON-016/104 |
| P10 | `archive.symlink()` entries get mtime "now" and mode 0644 in tar. | TAR-JSON-007/021/029 |
| P11 | Tar mtime wraps at 2^31 seconds and writes `000000000-1 ` style fields for pre-1970 dates. | TAR-JSON-078..080 |
| P12 | Tar `uname`/`gname` have no length limit and overflow into the following fields. With a name of 100 bytes or less nothing overwrites the ustar prefix field (offset 345), so an over-long `gname` (or `uname` when `gname` is empty) can put a `../` path there and readers prepend it to the sanitized entry name. | TAR-JSON-087/088 |
| P13 | Tar pax fallback names both headers `PaxHeader`. | TAR-JSON-058 |
| P14 | Zip: an empty buffer with the default method is written as method 0 with bit 3, version 20 and a zero data descriptor. | ZIP-044 |
| P15 | Zip: no ZIP64 extra field in local headers; `forceZip64` only changes the archive trailer. | ZIP-058, ZIP-094 |
| P16 | Zip: a source stream error still records the partial entry in the central directory. | ZIP-050 |
| P17 | ZipCrypto: a stored entry with zero data bytes (every directory) declares `csize` 12 but is followed by no encryption header at all. | ENCRYPTED-050 |
| P18 | ZipCrypto and AES version-needed quirks (never raised to 20 for traditional encryption; 51 lowered to 45 for zip64). | ENCRYPTED-055/091/094 |
| P19 | AES is always AE-1 with the real CRC; the AES central header keeps the real 32-bit offset unless the offset itself overflows. | ENCRYPTED-073/095 |
| P20 | `forceUTC` plugin default is vestigial; only `forceLocalTime` works. | ZIP-001/129 |
| P21 | `collectStream` can call back twice; `Tar.append` and `Json.append` silently do nothing for an unknown `sourceType`. | ARCHIVER-CORE-040, TAR-JSON-012/115 |
| P22 | An open or read error of a lazily opened file in the tar-with-stats path is an unhandled `'error'` event. | GLOB-FS-095 |
| P23 | archiver 7 `setModule` tests `this._state.module`, which is never set, so `MODULESET` is never raised. | ARCHIVER-CORE-118 |
| P24 | Zip: name, extra, entry comment and archive comment lengths over 65535 bytes are written modulo 65536 by `getShortBytes` (util.js:45-49) while all the bytes are still emitted, so readers parse the surplus as archive structure. No error is raised. | ZIP-062, ZIP-089, ZIP-100 |
| P25 | Tar: a NUL character in a name or linkname is ASCII, so it is written verbatim into the ustar field (headers.js:57, 69, 78) and readers truncate the name at it. | TAR-JSON-068, TAR-JSON-073, TAR-JSON-085 |
| P26 | Tar: the name/prefix split strips one segment per iteration and copies the rest of the name each time (headers.js:59-64), so it is quadratic in the number of `/` separators and blocks the event loop for very long names. | TAR-JSON-069 |
| P27 | `sanitizePath` strips only a leading `\w+:` and a leading run of `../` or `/` (utils.js:58-62): interior `..` segments stay, and a drive letter after a non-empty prefix stays. `symlink()` does not sanitize its name at all and no method checks a link target (core.js:772-779). | ARCHIVER-CORE-029/030/037, ARCHIVER-CORE-096 |
| P28 | readdir-glob with `follow: true` has no visited set (index.ts:83-90): a symlink cycle is walked until the OS returns `ELOOP` or `ENAMETOOLONG`, which is exponential in the number of links that point back into the tree. | GLOB-FS-016 |
| P29 | Tar-with-stats path: a file whose size differs from its `lstat` size fails with `Size mismatch`: `'error'` is emitted twice, `finalize()` rejects, and the sink error and then `already finalized or destroyed` are uncaught. | TAR-JSON-009, TAR-JSON-044, TAR-JSON-050 |
| P30 | `archive.destroy()` (or a module error) while a file entry is being read does not destroy the engine or the lazily opened `fs.ReadStream`; its file descriptor stays open. `abort()` does not leak. | ARCHIVER-CORE-049, GLOB-FS-094 |
| P31 | The archiver 7 format registry is a plain object tested with `formats[format]` (archiver 7 index.js:20-78): `Object.prototype` keys such as `constructor` and `toString` count as registered, `create()` with one throws a `TypeError` and `registerFormat()` with one is refused. | ARCHIVER-CORE-115..117 |
| P32 | `abort()` called after an entry's module callback has run but before its deferred `setImmediate(callback)` (core.js:180, 208), for example one macrotask after `append()` returned, never calls `_shutdown()`: no `'end'`, no `'close'`. | ARCHIVER-CORE-059, ARCHIVER-CORE-062, ARCHIVER-CORE-077 |

### 3.4 Intentional non-ports

Upstream code that is deliberately not ported. Nothing else may be omitted, except the
unused code that V21 lists.

| # | Not ported | Reason |
|---|---|---|
| N1 | `toDosTime` (deps/compress-commons/lib/archivers/zip/util.js:61-63). | It references an undefined identifier and throws `ReferenceError` if called (ZIP-088). |
| N2 | crc-32 `bstr`, `str`, `table`, `version` (deps/crc-32/crc32.js). | Not on any write path (ZIP-121). |
| N3 | tar-stream reader side: `decode`, `decodePax`, `decodeLongPath`, `decodeOct`, `parse256`, `decodeStr`, `toType`, `indexOf`, `clamp` in headers.js, and all of extract.js. | archiver-wasm writes archives. Tests read them with independent tools (TAR-JSON-095..100). |
| N4 | streamx and b4a sources. | streamx stays an npm dependency (R2); b4a calls become `Buffer` calls. |
| N5 | `lazystream.Writable`, and the guard that makes `lazystream.Readable` callable without `new` (lazystream.js:24-25); is-stream predicates other than `isStream`; async.queue members other than those in section 7.3, which names what is left out (among it the per-task callback and the promise that `push` returns); the `wrap` closure around the defer of async/internal/setImmediate.js:18-20, 34; `deps/readdir-glob/src/cjs.ts`. | Unused by archiver: it constructs the lazy stream with `new` (core.js:457), pushes without a callback and ignores what `push` returns (core.js:104, 107, 414, 555, 781). The port of `lazystream.Readable` is an ES class (7.4), which cannot be called without `new`. |
| N6 | archiver-zip-encrypted `support/issue-*.js`, its `eslint .` pretest, nyc. | Manual repro scripts and style tooling, not tests (TESTS-100/101). |
| N7 | The global monkey patch of `aes-js` (aes-hmac-etm-stream.js:16-25). | The Rust CTR implementation has a little-endian counter natively. The patch lives only in the test shim (section 14.1) so the unmodified test's own decryptor keeps working. |

### 3.5 Conventions of `BEHAVIORS.tsv` and `PORTMAP.tsv`

`BEHAVIORS.tsv` (665 rows: 656 from 737 inventory rows, plus 9 rows added by the review of
this guide, which have no inventory source: ZIP-135 to ZIP-137 and ENCRYPTED-113 to
ENCRYPTED-118; columns `id`, `upstream`, `symbol`, `layer`, `target`, `behavior`, `hazard`):

- `target` lists every place that must implement or preserve the behavior, separated by
  ` ; `, each as `path#item`. An item is one that the pinned call path really reaches:
  where that path goes through `json::append` into `crc32::buf`, the target is `buf`. The
  same-valued `unsigned` is not ported: nothing in the package calls it (V21,
  TAR-JSON-112). Rust items use
  `::`, TypeScript items use `.`. An item in
  parentheses (`#(module: every pub const of PORTING.md 6.5)`) names a group that the cited
  section of this guide enumerates. A target without `#` is the whole file. A target that
  starts with `NOT PORTED` points at a row of section 3.4 or 3.2. A target starting with
  `tests/` is the test that exercises the behavior. `npm:streamx` marks behavior supplied by
  the kept dependency.
- `layer` is derived from the targets: `ts`, `wasm`, `rust-core`, a combination joined with
  `+` when the behavior is split across the boundary, or `tests` for rows about test
  infrastructure only. Where it differs from the layer an inventory proposed, section 3.1
  explains why.
- A hazard ending in `[PORTING.md ...]` carries the decision of this guide for that row.
  Where the text before the tag (advice written by an inventory before this guide existed)
  disagrees with the tag, the tag wins. Every hazard that gives advice about Rust, wasm or
  the port carries such a tag.
- Duplicates between inventories were merged, never dropped: the text of a merged row is
  kept verbatim inside `[merged <id> (...): ...]` in the surviving row. The complete list:

| Surviving row | Rows merged into it |
|---|---|
| ARCHIVER-CORE-003 | TAR-JSON-017 |
| ARCHIVER-CORE-004 | TAR-JSON-018 |
| ARCHIVER-CORE-005 | GLOB-FS-135 |
| ARCHIVER-CORE-006 | GLOB-FS-053 |
| ARCHIVER-CORE-008 | GLOB-FS-054 |
| ARCHIVER-CORE-009 | GLOB-FS-055 |
| ARCHIVER-CORE-011 | GLOB-FS-056 |
| ARCHIVER-CORE-013 | GLOB-FS-057 |
| ARCHIVER-CORE-014 | GLOB-FS-058 |
| ARCHIVER-CORE-017 | GLOB-FS-123 |
| ARCHIVER-CORE-018 | GLOB-FS-124 |
| ARCHIVER-CORE-019 | GLOB-FS-128 |
| ARCHIVER-CORE-020 | GLOB-FS-130 |
| ARCHIVER-CORE-022 | GLOB-FS-125 |
| ARCHIVER-CORE-024 | GLOB-FS-126 |
| ARCHIVER-CORE-025 | GLOB-FS-129 |
| ARCHIVER-CORE-026 | GLOB-FS-127 |
| ARCHIVER-CORE-027 | GLOB-FS-076 |
| ARCHIVER-CORE-029 | GLOB-FS-077 |
| ARCHIVER-CORE-031 | GLOB-FS-078 |
| ARCHIVER-CORE-032 | GLOB-FS-079, ZIP-125 |
| ARCHIVER-CORE-033 | GLOB-FS-080 |
| ARCHIVER-CORE-034 | GLOB-FS-081 |
| ARCHIVER-CORE-035 | GLOB-FS-082 |
| ARCHIVER-CORE-036 | GLOB-FS-083 |
| ARCHIVER-CORE-037 | GLOB-FS-084 |
| ARCHIVER-CORE-038 | GLOB-FS-085 |
| ARCHIVER-CORE-039 | GLOB-FS-086 |
| ARCHIVER-CORE-040 | GLOB-FS-134, TAR-JSON-019, TAR-JSON-020 |
| ARCHIVER-CORE-041 | GLOB-FS-087 |
| ARCHIVER-CORE-042 | GLOB-FS-059 |
| ARCHIVER-CORE-043 | GLOB-FS-060 |
| ARCHIVER-CORE-044 | GLOB-FS-061 |
| ARCHIVER-CORE-045 | GLOB-FS-063 |
| ARCHIVER-CORE-046 | GLOB-FS-064, GLOB-FS-065 |
| ARCHIVER-CORE-047 | GLOB-FS-066 |
| ARCHIVER-CORE-048 | GLOB-FS-067 |
| ARCHIVER-CORE-049 | GLOB-FS-069 |
| ARCHIVER-CORE-050 | GLOB-FS-070 |
| ARCHIVER-CORE-051 | GLOB-FS-071 |
| ARCHIVER-CORE-052 | GLOB-FS-074 |
| ARCHIVER-CORE-053 | GLOB-FS-075 |
| ARCHIVER-CORE-054 | GLOB-FS-090 |
| ARCHIVER-CORE-059 | GLOB-FS-091 |
| ARCHIVER-CORE-067 | GLOB-FS-133 |
| ARCHIVER-CORE-071 | GLOB-FS-121 |
| ARCHIVER-CORE-077 | GLOB-FS-122 |
| ARCHIVER-CORE-079 | GLOB-FS-109 |
| ARCHIVER-CORE-080 | GLOB-FS-110 |
| ARCHIVER-CORE-081 | GLOB-FS-111 |
| ARCHIVER-CORE-082 | GLOB-FS-112 |
| ARCHIVER-CORE-083 | GLOB-FS-113 |
| ARCHIVER-CORE-085 | GLOB-FS-115 |
| ARCHIVER-CORE-086 | GLOB-FS-114 |
| ARCHIVER-CORE-087 | GLOB-FS-118 |
| ARCHIVER-CORE-090 | GLOB-FS-098, GLOB-FS-099, GLOB-FS-100 |
| ARCHIVER-CORE-091 | GLOB-FS-101 |
| ARCHIVER-CORE-092 | GLOB-FS-104, GLOB-FS-105 |
| ARCHIVER-CORE-104 | GLOB-FS-052 |
| ARCHIVER-CORE-116 | ENCRYPTED-002 |
| GLOB-FS-028 | ARCHIVER-CORE-093 |
| GLOB-FS-041 | ARCHIVER-CORE-094 |
| TESTS-023 | ARCHIVER-CORE-112 |
| TESTS-026 | ARCHIVER-CORE-111 |
| TESTS-033 | ARCHIVER-CORE-113, GLOB-FS-136 |
| TESTS-039 | ARCHIVER-CORE-110 |
| TESTS-040 | GLOB-FS-137 |
| TESTS-041 | ARCHIVER-CORE-114 |
| TESTS-050 | TAR-JSON-122 |
| TESTS-059 | ZIP-134 |
| TESTS-077 | ENCRYPTED-109 |
| TESTS-084 | ENCRYPTED-110 |
| TESTS-089 | ENCRYPTED-108 |

`PORTMAP.tsv` (columns `upstream_file`, `lines`, `target_files`, `layer`, `depends_on`,
`unit`, `notes`): a file that is split between layers has one row per target unit. `lines`
is the number of upstream lines that row ports (the note says "about N of M" when that is
less than the whole file); for the two fixture rows it is the file count, and for a
`not-ported` row whose path is a glob it is 0. `depends_on` lists the target files whose
pinned interfaces the row is written against: every file outside the row's own targets
that a target imports, scaffold files included (`numeric.rs`, `error.rs`, `src/wasm.ts`,
`src/types.ts`). It is informational: all non-test units are
written in parallel, and the Rust units of one crate compile together (2.1). A note that
mentions a test names the unit that owns it; the tests a unit writes itself are the
`#[cfg(test)]` modules of its own files (4.1, 14.3).
Rows with unit `not-ported` exist so that every upstream file is accounted for. "Every
upstream file" means: every source file of the two repositories (`index.js`, `lib/**`,
`test/**`, `support/**`, `examples/**`, `benchmark/**`), every source file of the eight
packages under `.upstream/deps/` (not their type declarations, READMEs or tool
configuration), and every file inside a `node_modules` tree that this guide cites as the
origin of ported code. The dependency tree that archiver-zip-encrypted 2.0.0 really runs on
(archiver 7.0.0, zip-stream 6.0.0, compress-commons 6.0.0, crc32-stream 6.0.0) has
`not-ported` rows except for the few lines listed in R19, V12 and 7.9.

---

## 4. Repository layout

All paths are relative to the repository root. One target file per upstream file; a file
that is split between layers has one target per layer. Files marked (pinned) have their full
content or signature fixed by this guide so that units can be written in parallel.

```
Cargo.toml                                   workspace: members crates/archiver-core, crates/archiver-wasm (pinned, 15.1)
rust-toolchain.toml                          channel = "1.99.0" (fixed by the toolchain gate, 2.2), targets = ["wasm32-unknown-unknown"], components = ["rustfmt", "clippy"]
crates/archiver-core/Cargo.toml                   (pinned, 12.1)
crates/archiver-core/src/lib.rs                   module list (pinned, 6.1)
crates/archiver-core/src/error.rs                 ZipError, DeflateError (pinned, 6.2)
crates/archiver-core/src/numeric.rs               to_int32, to_uint32, i64_to_string_radix8, utf16_len, truthy_str, write_at (pinned, 6.3)
crates/archiver-core/src/crc32.rs                 deps/crc-32/crc32.js (buf)
crates/archiver-core/src/crc32_stream.rs          deps/crc32-stream/lib/{crc32-stream,deflate-crc32-stream,index}.js
crates/archiver-core/src/gzip.rs                  gzip member writer (replaces zlib.createGzip, node-archiver/lib/plugins/tar.js:28)
crates/archiver-core/src/json.rs                  byte-derived part of node-archiver/lib/plugins/json.js:59-60
crates/archiver-core/src/zip/mod.rs               deps/compress-commons/lib/compress-commons.js (barrel)
crates/archiver-core/src/zip/constants.rs         deps/compress-commons/lib/archivers/zip/constants.js
crates/archiver-core/src/zip/util.rs              deps/compress-commons/lib/archivers/zip/util.js
crates/archiver-core/src/zip/general_purpose_bit.rs   .../zip/general-purpose-bit.js
crates/archiver-core/src/zip/zip_archive_entry.rs .../zip/zip-archive-entry.js
crates/archiver-core/src/zip/utils.rs             normalize-path/index.js + sanitizePath (deps/zip-stream/utils.js:17-21)
crates/archiver-core/src/zip/archive_output_stream.rs     Rust part of .../archivers/archive-output-stream.js
crates/archiver-core/src/zip/zip_archive_output_stream.rs Rust part of .../zip/zip-archive-output-stream.js
crates/archiver-core/src/zip/zip_stream.rs        Rust part of deps/zip-stream/index.js
crates/archiver-core/src/zip/encrypted/mod.rs     (pinned, 6.1)
crates/archiver-core/src/zip/encrypted/crc.rs                 archiver-zip-encrypted/lib/zip20/crc.js
crates/archiver-core/src/zip/encrypted/crypto_cipher.rs       .../lib/zip20/CryptoCipher.js
crates/archiver-core/src/zip/encrypted/crypto_stream.rs       .../lib/zip20/crypto-stream.js
crates/archiver-core/src/zip/encrypted/decrypto_stream.rs     .../lib/zip20/decrypto-stream.js
crates/archiver-core/src/zip/encrypted/zip_crypto_stream.rs   Rust part of .../lib/zip20/zip-crypto-stream.js
crates/archiver-core/src/zip/encrypted/aes_hmac_etm_stream.rs .../lib/aes/aes-hmac-etm-stream.js
crates/archiver-core/src/zip/encrypted/zip_aes_stream.rs      Rust part of .../lib/aes/zip-aes-stream.js
crates/archiver-core/src/tar/mod.rs               deps/tar-stream/index.js (barrel)
crates/archiver-core/src/tar/headers.rs           deps/tar-stream/headers.js (writer side)
crates/archiver-core/src/tar/pack.rs              Rust part of deps/tar-stream/pack.js
crates/archiver-core/tests/golden.rs              golden byte tests and the sanitizer vector test (14.3)
crates/archiver-core/tests/golden/                *.bin captured from upstream, scenarios.rs and sanitize_path_vectors.rs (generated Rust tables, 14.3)
crates/archiver-core/tests/LEDGER.tsv             required cargo test names (14.3, 14.5)
crates/archiver-wasm/Cargo.toml                   (pinned, 12.1)
crates/archiver-wasm/src/lib.rs                   wasm-bindgen classes (pinned signatures, 5.3)

package.json  package-lock.json  tsconfig.json  tsdown.config.ts  .gitattributes   (pinned, 15; there is deliberately no .mocharc file, 14.1)
.github/workflows/ci.yml                     Linux and macOS, Node 18/20/22/24: build under Node 24, the whole test matrix under each (15.5)
.github/workflows/release.yml                publish to npm from a version tag through the trusted publisher (15.5)
src/index.ts                                 node-archiver/index.js + package entry (the ESM bundle is built from it)
src/commonjs.ts                              CommonJS entry: the vending function merged with a namespace of every export (pinned, 15.4)
src/core.ts                                  node-archiver/lib/core.js (+ archiver 7 setFormat/setModule/_moduleSupports)
src/error.ts                                 node-archiver/lib/error.js
src/utils.ts                                 node-archiver/lib/utils.js
src/vending.ts                               archiver-zip-encrypted/node_modules/archiver/index.js (archiver 7.0.0)
src/queue.ts                                 node-archiver/node_modules/async/internal/queue.js (subset, 7.3) + DoublyLinkedList.js
src/lazystream.ts                            node-archiver/node_modules/lazystream/lib/lazystream.js (Readable; pinned, 7.4)
src/is-stream.ts                             node-archiver/node_modules/is-stream/index.js (isStream)
src/normalize-path.ts                        node-archiver/node_modules/normalize-path/index.js
src/readdir-glob.ts                          deps/readdir-glob/src/index.ts
src/types.ts                                 shared TypeScript interfaces (pinned, 7.1)
src/wasm.ts                                  synchronous wasm loader + typed handle, MAX_CHUNK, toBuffer, wasmString (pinned, 15.3)
src/wasm-types.ts                            hand-written TypeScript view of the wasm surface of 5.3 (pinned, 15.3)
src/callable.ts                              callable() helper (pinned, 7.9)
src/zlib-options.ts                          validateZlibOptions, resolveLevel (pinned, 7.7)
src/gzip.ts                                  Gzip Transform over WasmGzip (replaces zlib.createGzip)
src/plugins/zip.ts                           node-archiver/lib/plugins/zip.js
src/plugins/tar.ts                           node-archiver/lib/plugins/tar.js
src/plugins/json.ts                          node-archiver/lib/plugins/json.js
src/zip-stream/index.ts                      TS part of deps/zip-stream/index.js
src/zip-stream/utils.ts                      deps/zip-stream/utils.js
src/compress-commons/index.ts                deps/compress-commons/lib/compress-commons.js (the two named exports that are imported, V21)
src/compress-commons/util.ts                 deps/compress-commons/lib/util/index.js
src/compress-commons/archive-entry.ts        .../archivers/archive-entry.js
src/compress-commons/archive-output-stream.ts        TS part of .../archivers/archive-output-stream.js
src/compress-commons/zip-archive-entry.ts    recording entry + result snapshot (7.6)
src/compress-commons/zip-archive-output-stream.ts    TS part of .../zip/zip-archive-output-stream.js
src/tar-stream/index.ts                      deps/tar-stream/index.js
src/tar-stream/constants.ts                  deps/tar-stream/constants.js
src/tar-stream/pack.ts                       TS part of deps/tar-stream/pack.js
src/encrypted/zip-encrypted.ts               archiver-zip-encrypted/lib/zip-encrypted.js (+ index.js)
src/encrypted/aes/aes-hmac-etm-stream.ts     TS part of .../lib/aes/aes-hmac-etm-stream.js
src/encrypted/aes/zip-aes-stream.ts          TS part of .../lib/aes/zip-aes-stream.js
src/encrypted/zip20/crypto-cipher.ts         TS part of .../lib/zip20/CryptoCipher.js
src/encrypted/zip20/crypto-stream.ts         TS part of .../lib/zip20/crypto-stream.js
src/encrypted/zip20/decrypto-stream.ts       TS part of .../lib/zip20/decrypto-stream.js
src/encrypted/zip20/zip-crypto-stream.ts     TS part of .../lib/zip20/zip-crypto-stream.js

dist/                                        tsdown output: index.mjs, index.d.mts, index.cjs, index.d.cts and the two source maps (15.4) (build output, gitignored)
dist/wasm/                                   wasm-pack output: archiver_wasm.cjs, archiver_wasm_bg.wasm, archiver_wasm.d.cts (15.2) (build output, gitignored with dist)

scripts/fetch-upstream.sh                    exists; restores .upstream/ including both node_modules trees (header of this file)
scripts/build-wasm.sh                        (pinned, 15.2)
scripts/check-wasm-types.mjs                 fails the build if the generated dist/wasm/archiver_wasm.d.cts does not satisfy src/wasm-types.ts (15.3)
scripts/check-tarball.mjs                    packs the built dist/, checks the file list, installs the tarball into an empty project, runs the smoke checks (15.5)
scripts/vendor-upstream-tests.mjs            copies the upstream test trees into tests/upstream/ and writes SHA256SUMS
scripts/verify-upstream-tests.mjs            fails if a vendored test file differs from SHA256SUMS
scripts/verify-oracle-versions.mjs           fails unless the installed upstream packages have the versions of the oracle table (14.2)
scripts/check-test-ledger.mjs                compares both mocha suites with tests/upstream/LEDGER.tsv and `cargo test -- --list` with crates/archiver-core/tests/LEDGER.tsv (14.5)
scripts/capture-golden.mjs                   runs the real upstream engines with fixed inputs, writes crates/archiver-core/tests/golden/ and tests/vectors/ (14.3)
tests/upstream/node-archiver/package.json    {"type":"module"}
tests/upstream/node-archiver/index.js        one-line shim: export * from "../../../dist/index.mjs" (the published ESM bundle)
tests/upstream/node-archiver/test/**         verbatim copy of .upstream/node-archiver/test (archiver.js, plugins.js, helpers/, fixtures/)
tests/upstream/archiver-zip-encrypted/package.json   {"type":"commonjs"}
tests/upstream/archiver-zip-encrypted/index.js       shim (14.1)
tests/upstream/archiver-zip-encrypted/lib/**         shims (14.1)
tests/upstream/archiver-zip-encrypted/test/**        verbatim copy incl. test/resources
tests/upstream/alias-archiver.cjs            mocha --require hook: resolves 'archiver' to dist/index.cjs
tests/upstream/SHA256SUMS  tests/upstream/LEDGER.tsv  tests/upstream/LICENSE.node-archiver  tests/upstream/LICENSE.archiver-zip-encrypted
tests/differential/helpers/run-both.mjs      runs one scenario against upstream and against archiver-wasm, in process or in a child process (14.2)
tests/differential/helpers/zip-records.mjs   zip record parser (local header, descriptor, central header, end records)
tests/differential/helpers/tar-records.mjs   tar block parser (ustar header fields, pax records, padding)
tests/differential/helpers/decrypt.mjs       ZipCrypto and WinZip AES payload decryption built from upstream's own code (14.2)
tests/differential/helpers/events.mjs        event recorder and payload summaries
tests/differential/zip-plain.test.mjs  tar.test.mjs  targz.test.mjs  json.test.mjs  aes.test.mjs  zip20.test.mjs
tests/differential/errors-events.test.mjs  preserved-defects.test.mjs  extraction.test.mjs
tests/differential/large.test.mjs  crypto-streams.test.mjs  glob-options.test.mjs  behaviors.test.mjs
tests/differential/destroy-abort.test.mjs  preserved-defects-2.test.mjs
tests/differential/zip-large.slow.mjs        entries above 4 GiB and buffers above 1 GiB; run on demand (14.2)
src/**/*.test.ts                           the shared vectors against the three TypeScript sanitizer copies, one test beside each (14.3)
tests/vectors/sanitize-path.json             shared vectors for all sanitizePath/normalizePath copies (generated, 14.3)
```

`.gitignore` additions (scaffold unit): `tests/upstream/**/tmp`, `tests/upstream/**/target`.
`dist` is already ignored, and `dist/wasm` with it.

### 4.1 Units

`PORTMAP.tsv` groups the files into these units. Every non-test unit can be written at the
same time as all the others: whatever it needs from another unit is pinned in sections 5 to
7 and 15. A unit owns its files exclusively; during the unit loop no unit edits a file of
another unit (the phases after the loop follow 2.1).

| Unit | Layer | Files it owns |
|---|---|---|
| rs-scaffold | rust-core | `Cargo.toml`, `rust-toolchain.toml`, `crates/archiver-core/Cargo.toml`, `crates/archiver-core/src/{lib,error,numeric}.rs`, `crates/archiver-wasm/Cargo.toml` |
| rs-crc-deflate | rust-core | `crc32.rs`, `crc32_stream.rs`, `gzip.rs`, `json.rs` |
| rs-zip-util | rust-core | `zip/{constants,util,general_purpose_bit,utils}.rs` |
| rs-zip-entry | rust-core | `zip/{mod,zip_archive_entry,zip_stream}.rs` |
| rs-zip-writer | rust-core | `zip/{archive_output_stream,zip_archive_output_stream}.rs` |
| rs-zip20 | rust-core | `zip/encrypted/{mod,crc,crypto_cipher,crypto_stream,decrypto_stream,zip_crypto_stream}.rs` |
| rs-aes | rust-core | `zip/encrypted/{aes_hmac_etm_stream,zip_aes_stream}.rs` |
| rs-tar | rust-core | `tar/{mod,headers,pack}.rs` |
| rs-wasm | wasm | `crates/archiver-wasm/src/lib.rs` |
| ts-scaffold | ts | `package.json`, `package-lock.json`, `tsconfig.json`, `tsdown.config.ts`, `.gitattributes`, `.gitignore` additions, `src/{types,wasm,wasm-types,callable,commonjs}.ts`, `scripts/{build-wasm.sh,check-wasm-types.mjs,check-tarball.mjs}`, `.github/workflows/{ci,release}.yml`; with rs-scaffold, the toolchain gate (2.2) |
| ts-core | ts | `src/core.ts` (one class, 851 raw upstream lines, about 480 without JSDoc; deliberately not split) |
| ts-entry | ts | `src/{index,error,vending}.ts`, `src/plugins/json.ts` |
| ts-helpers | ts | `src/{utils,queue,lazystream,is-stream,normalize-path,zlib-options}.ts` |
| ts-glob | ts | `src/readdir-glob.ts` |
| ts-zip-stream | ts | `src/plugins/zip.ts`, `src/zip-stream/{index,utils}.ts` |
| ts-zip-engine | ts | `src/compress-commons/*.ts` |
| ts-tar | ts | `src/plugins/tar.ts`, `src/tar-stream/*.ts`, `src/gzip.ts` |
| ts-encrypted | ts | `src/encrypted/**` |
| tests-upstream | tests | `tests/upstream/**` (including the two upstream license files), `scripts/{vendor-upstream-tests,verify-upstream-tests,check-test-ledger}.mjs` |
| tests-diff-helpers | tests | `tests/differential/helpers/*.mjs`, `scripts/verify-oracle-versions.mjs` |
| tests-diff-zip | tests | `tests/differential/{zip-plain,aes,zip20,large,crypto-streams}.test.mjs`, `tests/differential/zip-large.slow.mjs` |
| tests-diff-tar-json | tests | `tests/differential/{tar,targz,json}.test.mjs` |
| tests-diff-behavior | tests | `tests/differential/{errors-events,preserved-defects,extraction,glob-options,behaviors,destroy-abort,preserved-defects-2}.test.mjs` |
| tests-golden | tests | `scripts/capture-golden.mjs`, `crates/archiver-core/tests/**`, `tests/vectors/**`, `src/normalize-path.test.ts`, `src/utils.test.ts`, `src/zip-stream/utils.test.ts` |

The `#[cfg(test)]` module inside a Rust source file belongs to the unit that owns the file
(section 2, unit loop step 1); only the integration tests under `crates/archiver-core/tests/`
belong to tests-golden.

---

## 5. The layer boundary

### 5.1 The rule

- **Rust (`archiver-core`)**: every function whose result is bytes of an archive, or a number
  that is written into an archive (CRC-32, sizes, offsets, DOS time, octal fields, check
  bytes, keys, MACs). No clock, no time zone, no randomness, no platform checks, no I/O, no
  callbacks, no JS types. Deterministic: same inputs, same bytes.
- **wasm (`archiver-wasm`)**: marshalling only. One exported class per core encoder. No branches
  other than converting arguments and mapping `Err` to a thrown JS `Error`.
- **TypeScript (`src/`)**: everything that touches Node streams, `fs`, timers, events,
  callbacks, `process.platform`, `Date`, `crypto.randomBytes`, dynamic option bags, JS
  truthiness and JS string conversion of user values. TypeScript decides **when** something
  happens and on which channel an error is reported; Rust decides **which bytes**.

A JS expression whose result depends on JS value semantics (truthiness, `typeof`,
`toString(8)` of an arbitrary value, `for...in` order, string concatenation of arbitrary
values, `Date` getters) is evaluated in TypeScript, and its result crosses the boundary as a
plain number, boolean, string or byte slice.

### 5.2 Files that are split between layers

| Upstream file | TypeScript keeps | Rust takes |
|---|---|---|
| deps/zip-stream/index.js | constructor option handling (23-47), `_normalizeFileData` (56-84), the three validations and callback default (101-125), symlink mode and payload (137-143, 146-148), `finalize` (158-160). `entry` builds a recording `ZipArchiveEntry` with the same statements as 126-145 (7.6). | `ZipStream::entry`: construction order of the real entry (126-136, 144) and the hand-off (149). |
| deps/compress-commons/lib/archivers/archive-output-stream.js | whole file literally: Transform, `entry` guards and dispatch (45-78), `finish` (80-86), `write` offset override (92-97). This `offset` is the one authoritative archive position: it counts every write into the engine, including bytes a caller writes directly (ZIP-135). | `entry` guards again (for native callers), `finish`, `write` with a `u64` offset, and `set_offset`, with which TypeScript hands its count to Rust before every call that records an offset (7.5). |
| .../zip/zip-archive-output-stream.js | `_defaults` (28-41), constructor state (44-60), stream choreography of `_appendBuffer`, `_appendStream`, `_smartStream`, `_afterAppend`, `_finish` (7.5), the `this.write(source)` of a stored buffer payload (86; V16), `getComment`/`setComment`. | every byte except the payload of a stored buffer: `_normalize_entry`, `_append_buffer`, `_append_stream`, `_smart_stream`, `_after_append`, `_finish`, all `_write*` methods, `is_zip64`. |
| archiver-zip-encrypted/lib/aes/zip-aes-stream.js, lib/zip20/zip-crypto-stream.js | the class, its constructor (key normalization), per-entry key and random bytes. | all overridden methods, as match arms (6.9). |
| .../lib/aes/aes-hmac-etm-stream.js, lib/zip20/crypto-stream.js, decrypto-stream.js, CryptoCipher.js | the Transform / class shell, option handling, default randomness, `deriveKey` result shape. | key derivation, ciphers, MAC, framing. |
| deps/tar-stream/pack.js | `Sink` and `Pack` classes on streamx, literally: defaults (147-152), queueing, open/continue, size check, callbacks, destroy, drain, `modeToType`, `mapWritable`. Body bytes are pushed by TypeScript without entering wasm. | `Pack::_encode` (194-203), `Pack::_encode_pax` (205-234), `overflow` (280-283), the end-of-archive block (10, 181). |
| deps/tar-stream/headers.js | the JS stringification steps hoisted to the call site: `value.toString(8)` (242-243, 257) and pax record concatenation (24-26). | `encode`, `encode_pax`, `encode_oct`, `encode_size`, `encode_size_bin`, `cksum`, `to_typeflag`, `add_length`. |
| node-archiver/lib/plugins/json.js | whole file. | the CRC-32 of line 60, fed in slices (5.4). |
| node-archiver/lib/plugins/tar.js | whole file. | the gzip member that `zlib.createGzip` (28) produced. |

Everything in node-archiver/lib/core.js, lib/utils.js, lib/error.js, index.js,
deps/readdir-glob and the small helpers is TypeScript only.

### 5.3 The wasm-bindgen API surface (pinned)

`crates/archiver-wasm/src/lib.rs` exports exactly the items below. Rust struct names are the JS
class names. Method names are camelCase in JS through `js_name`. The TypeScript view of this
surface is the hand-written interface `ArchiverWasm` in `src/wasm-types.ts`, pinned verbatim in
15.3. TypeScript units are type-checked against that file, so they need neither the Rust
crates nor a wasm build; `scripts/check-wasm-types.mjs` fails the build when the
declarations wasm-pack generated stop satisfying it. A change to one of the two listings is
a change to both (M8).

```rust
use wasm_bindgen::prelude::*;

fn to_js_error<E: std::fmt::Display>(e: E) -> JsError { JsError::new(&e.to_string()) }

// ---------------------------------------------------------------- zip
#[wasm_bindgen]
pub struct WasmZipStream { inner: archiver_core::zip::ZipStream }

#[wasm_bindgen]
impl WasmZipStream {
    /// encryption: 0 = none, 1 = ZipCrypto ("zip20"), 2 = WinZip AES-256 ("aes256").
    #[wasm_bindgen(constructor)]
    pub fn new(force_zip64: bool, encryption: u8) -> Result<WasmZipStream, JsError>;

    #[wasm_bindgen(js_name = setComment)]
    pub fn set_comment(&mut self, comment: &str);

    /// Overwrites the writer's offset with ArchiveOutputStream.offset as TypeScript counts
    /// it (archive-output-stream.js:92-97). Called immediately before entry(), before
    /// finish() and, for ZipCrypto, before endData() (7.5).
    #[wasm_bindgen(js_name = setOffset)]
    pub fn set_offset(&mut self, offset: f64);

    /// Starts one entry. Returns 0 = stored buffer of the plain engine: the local header is
    /// written, the caller emits the `source_len` payload bytes itself and then calls
    /// completeStored() (upstream called back synchronously here);
    /// 1 = open, payload pipeline is CRC only (stored), 2 = open, payload pipeline deflates.
    /// `is_buffer`: Buffer.isBuffer(source). `source_len` and `source_crc`: length and
    /// CRC-32 (crc32Update over the slices) of the buffer; both 0 when `is_buffer` is false.
    /// The payload itself is never an argument of this call (5.4).
    /// `key`: password bytes (empty for encryption 0). `random`: AES salt, or the 12
    /// ZipCrypto header bytes, or empty for encryption 0.
    #[allow(clippy::too_many_arguments)]
    pub fn entry(
        &mut self,
        name: &str,
        year: f64, month: f64, date: f64, hours: f64, minutes: f64, seconds: f64,
        name_prepend_slash: bool,
        store: bool,
        comment: &str,
        has_mode: bool, mode: i32,
        level: i32,
        key: &[u8],
        random: &[u8],
        is_buffer: bool, source_len: f64, source_crc: u32,
    ) -> Result<u8, JsError>;

    /// Ends an entry for which entry() returned 0, after the caller wrote the payload.
    #[wasm_bindgen(js_name = completeStored)]
    pub fn complete_stored(&mut self) -> Result<(), JsError>;
    /// One payload slice of an open entry (at most MAX_CHUNK bytes, 5.4).
    #[wasm_bindgen(js_name = writeData)]
    pub fn write_data(&mut self, chunk: &[u8]) -> Result<(), JsError>;
    #[wasm_bindgen(js_name = endData)]
    pub fn end_data(&mut self) -> Result<(), JsError>;
    /// ZipCrypto only: one slice of the compressed bytes that writeData() handed out,
    /// after endData() wrote the local header (V16).
    #[wasm_bindgen(js_name = encryptData)]
    pub fn encrypt_data(&mut self, chunk: &[u8]) -> Result<(), JsError>;
    #[wasm_bindgen(js_name = encryptEnd)]
    pub fn encrypt_end(&mut self) -> Result<(), JsError>;
    pub fn finish(&mut self);
    #[wasm_bindgen(js_name = takeOutput)]
    pub fn take_output(&mut self) -> Vec<u8>;
    #[wasm_bindgen(js_name = isZip64)]
    pub fn is_zip64(&self) -> bool;
    #[wasm_bindgen(js_name = centralOffset)]
    pub fn central_offset(&self) -> f64;
    #[wasm_bindgen(js_name = centralLength)]
    pub fn central_length(&self) -> f64;
    /// Snapshot of the most recently completed entry (`_entries.last()`), or undefined.
    #[wasm_bindgen(js_name = lastEntry)]
    pub fn last_entry(&self) -> Option<WasmZipEntryInfo>;
}

#[wasm_bindgen]
pub struct WasmZipEntryInfo { /* owned copies of the fields below */ }

#[wasm_bindgen]
impl WasmZipEntryInfo {            // every item is #[wasm_bindgen(getter)], read-only
    pub fn name(&self) -> String;              // "" when the entry has no name
    pub fn size(&self) -> f64;
    pub fn csize(&self) -> f64;
    pub fn crc(&self) -> u32;
    pub fn method(&self) -> i32;               // -1 when unset
    pub fn time(&self) -> u32;                 // getTimeDos(): 0 when unset
    pub fn minver(&self) -> u16;
    pub fn platform(&self) -> u8;
    pub fn exattr(&self) -> u32;
    pub fn inattr(&self) -> u16;
    pub fn gpb(&self) -> u16;                  // GeneralPurposeBit::encode() as a little-endian u16
    pub fn extra(&self) -> Vec<u8>;
    pub fn comment(&self) -> String;
    #[wasm_bindgen(getter, js_name = offsetFile)]     pub fn offset_file(&self) -> f64;
    #[wasm_bindgen(getter, js_name = offsetData)]     pub fn offset_data(&self) -> f64;
    #[wasm_bindgen(getter, js_name = offsetContents)] pub fn offset_contents(&self) -> f64;
}

// ---------------------------------------------------------------- tar
#[wasm_bindgen]
pub struct WasmPack { inner: archiver_core::tar::Pack, pax: Vec<String> }

#[wasm_bindgen]
impl WasmPack {
    #[wasm_bindgen(constructor)]
    pub fn new() -> WasmPack;
    /// Queues one pax record body (' key=value\n', already concatenated in JS) for the
    /// next encode() call. encode() consumes and clears the queue.
    #[wasm_bindgen(js_name = paxRecord)]
    pub fn pax_record(&mut self, body: &str);
    /// Pack._encode(header). `force_pax` is `!!header.pax`. The `*_oct` arguments are
    /// `value.toString(8)` computed in JS. `mtime` is `header.mtime.getTime()`.
    /// `linkname`, `uname`, `gname` are undefined when the JS value is falsy.
    #[allow(clippy::too_many_arguments)]
    pub fn encode(
        &mut self,
        name: &str, typeflag_is_5: bool, mode: i32,
        uid_oct: &str, gid_oct: &str,
        size: f64, size_oct: &str,
        mtime: f64,
        type_: &str,
        linkname: Option<String>, uname: Option<String>, gname: Option<String>,
        devmajor_oct: &str, devminor_oct: &str,
        force_pax: bool,
    );
    /// overflow(pack, size): zero padding to the next 512-byte boundary.
    pub fn overflow(&mut self, size: f64);
    /// Appends END_OF_TAR (1024 zero bytes) once.
    pub fn finalize(&mut self);
    #[wasm_bindgen(js_name = takeOutput)]
    pub fn take_output(&mut self) -> Vec<u8>;
}

// ---------------------------------------------------------------- gzip, json
#[wasm_bindgen]
pub struct WasmGzip { inner: archiver_core::gzip::Gzip }

#[wasm_bindgen]
impl WasmGzip {
    #[wasm_bindgen(constructor)]
    pub fn new(level: i32, strategy: i32, os: u8) -> WasmGzip;
    pub fn write(&mut self, chunk: &[u8]) -> Result<Vec<u8>, JsError>;
    pub fn finish(&mut self) -> Result<Vec<u8>, JsError>;
}

/// buffer-crc32 `crc32.unsigned(source)` for the json plugin (json.js:60), fed in slices:
/// `seed` is the result for the previous slices, 0 for the first.
#[wasm_bindgen(js_name = jsonAppend)]
pub fn json_append(seed: u32, chunk: &[u8]) -> u32;

/// crc-32 `buf(chunk, seed) >>> 0` (archiver_core::crc32::buf): the CRC of a zip buffer source,
/// fed in slices by TypeScript before entry() (7.5).
#[wasm_bindgen(js_name = crc32Update)]
pub fn crc32_update(seed: u32, chunk: &[u8]) -> u32;

// ---------------------------------------------------------------- encryption primitives
#[wasm_bindgen]
pub struct WasmCryptoCipher { inner: archiver_core::zip::encrypted::CryptoCipher }
#[wasm_bindgen]
impl WasmCryptoCipher {
    #[wasm_bindgen(constructor)]
    pub fn new(key: &[u8]) -> WasmCryptoCipher;
    pub fn encrypt(&mut self, data: &[u8]) -> Vec<u8>;
    pub fn decrypt(&mut self, data: &[u8]) -> Vec<u8>;
}

#[wasm_bindgen]
pub struct WasmCryptoStream { inner: archiver_core::zip::encrypted::CryptoStream }
#[wasm_bindgen]
impl WasmCryptoStream {
    /// crc: `options.crc.readUInt16BE(0)` computed in JS. header: exactly 12 bytes.
    #[wasm_bindgen(constructor)]
    pub fn new(key: &[u8], crc: u16, header: &[u8]) -> Result<WasmCryptoStream, JsError>;
    pub fn transform(&mut self, data: &[u8]) -> Vec<u8>;
}

#[wasm_bindgen]
pub struct WasmDecryptoStream { inner: archiver_core::zip::encrypted::DecryptoStream }
#[wasm_bindgen]
impl WasmDecryptoStream {
    #[wasm_bindgen(constructor)]
    pub fn new(key: &[u8]) -> WasmDecryptoStream;
    pub fn transform(&mut self, data: &[u8]) -> Vec<u8>;
    #[wasm_bindgen(js_name = getTotalSize)]
    pub fn get_total_size(&self) -> f64;
}

#[wasm_bindgen]
pub struct WasmAesHmacEtmStream { inner: archiver_core::zip::encrypted::AesHmacEtmStream }
#[wasm_bindgen]
impl WasmAesHmacEtmStream {
    /// Takes the already derived key parts (what deriveKey returned) and the salt.
    #[wasm_bindgen(constructor)]
    pub fn new(aes_key: &[u8], hmac_key: &[u8], password_verifier: &[u8], salt: &[u8])
        -> Result<WasmAesHmacEtmStream, JsError>;
    /// PBKDF2-HMAC-SHA1(key, salt, 1000, 66). Returns 66 bytes: aesKey | hmacKey | verifier.
    #[wasm_bindgen(js_name = deriveKey)]
    pub fn derive_key(salt: &[u8], key: &[u8]) -> Vec<u8>;
    pub fn transform(&mut self, data: &[u8]) -> Vec<u8>;
    pub fn flush(&mut self) -> Vec<u8>;
    #[wasm_bindgen(js_name = getTotalSize)]
    pub fn get_total_size(&self) -> f64;
}
```

Nothing else is exported. No `start` function, no imports from JS (the wasm module imports
only the wasm-bindgen intrinsics), no callbacks into JS, no `js-sys`, no `serde`.

### 5.4 Who owns buffers, and how output is drained

- **Input** (`&[u8]`, `&str`): the wasm-bindgen glue copies the JS bytes into wasm linear
  memory, calls the export, and frees the copy on return. Rust never keeps a pointer to an
  input. A `Buffer` is a `Uint8Array` and is passed as is. Strings are encoded to UTF-8 by
  the glue; lone surrogates become U+FFFD, the same result as `Buffer.from(str)`. The glue
  converts nothing: the argument must already be a JS string, or a `Uint8Array` (5.6).
- **Bounded payload** (V16): no wasm call receives more than `MAX_CHUNK` = `1024 * 1024`
  bytes of payload (the constant is exported by `src/wasm.ts`). Every TypeScript shell that
  forwards caller data loops `for (let i = 0; i < chunk.length; i += MAX_CHUNK)` over
  `chunk.subarray(i, i + MAX_CHUNK)` and forwards the output of one slice before it passes
  the next: `SmartStream._transform` (7.5), `Gzip._transform` (7.7), `AesHmacEtmStream`,
  `CryptoStream`, `DecryptoStream`, `CryptoCipher.encrypt` / `decrypt` (7.9), the CRC of a
  zip buffer source (`crc32Update`, 7.5) and of a json entry (`jsonAppend`, 7.10). A
  zero-length chunk makes no call. The payload of a stored buffer entry of the plain zip
  engine (7.5) and every tar entry body (7.8) never enter wasm at all. Keys, salts,
  headers, names, comments and pax records are passed whole (they are small by nature).
- **Output** (`Vec<u8>`, `String`): the glue copies the bytes out of linear memory into a
  fresh JS-owned `Uint8Array` and frees the Rust allocation. No view into wasm memory ever
  reaches TypeScript, so memory growth cannot invalidate anything.
- **Wrapping**: TypeScript turns every returned `Uint8Array` into a `Buffer` without
  copying, with `Buffer.from(u8.buffer, u8.byteOffset, u8.byteLength)`, before it is pushed
  into a stream or handed to user code. Tests compare outputs with Buffers (TESTS-078).
- **Draining**: `WasmZipStream` and `WasmPack` accumulate output in an internal `Vec<u8>`.
  After every mutating call TypeScript calls `takeOutput()` (which swaps the vector for an
  empty one, `std::mem::take`) and forwards a non-empty result to the Node stream. The
  encoder never holds more than the output of one call (bounded by the slice rule above).
  For ZipCrypto the compressed bytes of the current entry are buffered by TypeScript
  (ENCRYPTED-041): `takeOutput()` after `writeData` returns them, and `encryptData` takes
  them back in slices after `endData()`. No allocation in wasm grows with the payload of an
  entry (V16, 6.9). (The retained
  entries and the central directory that `finish()` emits grow with the number of entries,
  roughly 100 bytes plus the name per entry.) The other classes return their output
  directly from each call.
- **Lifetime**: wasm objects are freed deterministically where their owner has a defined
  end, and by the glue's `FinalizationRegistry` otherwise.
  (a) A `WasmZipEntryInfo` snapshot is freed by `ZipArchiveEntry._setInfo` right after its
  getters were copied into plain fields (7.6); no snapshot outlives that call.
  (b) The encoder owned by a stream (`WasmZipStream` in `ZipArchiveOutputStream`,
  `WasmPack` in `Pack`, `WasmGzip` in `Gzip`, and the wasm object inside
  `AesHmacEtmStream`, `CryptoStream`, `DecryptoStream`) is freed in that stream's
  `_destroy` hook, which calls `free()` once (if the object exists) and then passes the
  error it received to its callback. `free()` is called nowhere else, except by the
  constructor of `ZipArchiveOutputStream` when `super()` already destroyed the stream (a
  `signal` that was aborted: the hook ran before the encoder existed, V17). Node and streamx run
  the hook after a normal end (auto destroy) and after an error. A call that needs the
  encoder after that throws the glue's null-pointer `Error` and does not trap (V17).
  (c) A stream that is never ended or destroyed, and a `CryptoCipher`, fall back to the
  `FinalizationRegistry`.
  Nothing registers timers or handles, so an archive that is created and never finalized
  does not keep the process alive (TESTS-015).
- **Reentrancy**: the wasm module imports no JS functions, so no JS runs during a wasm
  call and a `&mut self` method can never be re-entered.

### 5.5 How errors cross the boundary

- Core functions that can fail return `Result<T, ZipError>` or `Result<T, DeflateError>`
  (6.2). The tar functions cannot fail and there is no `TarError`. The `Display` text of
  each variant marked "upstream" in 6.2 is the upstream message, character for character;
  the variants marked "archiver-wasm" have their own text.
- The wasm layer maps `Err(e)` to `JsError::new(&e.to_string())`, which the glue throws as a
  plain JS `Error` whose `message` is that text. No `code` property is added.
- TypeScript catches at the call site and routes the error to the channel upstream used at
  that site: `callback(err)`, a synchronous `throw`, or `emit('error', err)`. The channel
  per site is listed in section 13 and in `BEHAVIORS.tsv`.
- `ArchiverError` and its codes exist only in TypeScript. Rust never produces them.
- A panic is a bug. The wasm crate is built with `panic = "abort"`; a panic surfaces in JS
  as `WebAssembly.RuntimeError: unreachable` and the instance must be considered dead.
  Therefore no reachable Rust code may index, slice, `unwrap`, `expect` or do unchecked
  arithmetic on a value derived from input (section 11). An allocation failure is also an
  abort; the slice rule (5.4) removes every allocation whose size the
  payload of an entry can choose. A trap is never caught and swallowed: the only `try`/`catch` around wasm
  calls is in `SmartStream`, and it delivers what it catches through the entry callback
  (13.4). archiver-wasm does not try to fence or re-create a trapped instance.

### 5.6 Marshalling rules

| JS value | wasm parameter | Conversion (done by the JS-to-wasm call itself unless noted) |
|---|---|---|
| number used by upstream with `&`, `\|`, `<<` (modes) | `i32` | ECMAScript `ToInt32`: NaN to 0, fraction truncated, wraps modulo 2^32. `undefined` becomes 0. |
| number used arithmetically (sizes, milliseconds, calendar fields) | `f64` | `ToNumber`. NaN and fractions are passed through and handled in Rust with `numeric::to_int32`. |
| CRC, DOS time, attributes (out of Rust) | `u32` | the glue applies `>>> 0`; always a non-negative JS number. |
| sizes and offsets (out of Rust) | `f64` | `u64 as f64`; exact below 2^53. |
| boolean decided by JS truthiness | `bool` | TypeScript writes `!!x` or the literal upstream comparison. The call itself applies `ToInt32`, not truthiness: a non-numeric string would arrive as `false`. |
| optional string decided by truthiness (`if (opts.linkname)`) | `Option<String>` | TypeScript passes `x ? wasmString(x) : undefined`. `undefined` and `null` are `None`; `''` is `Some("")`. `Pack._encode` passes `'' + header.linkname` when `header.pax` is set, where upstream only concatenates it (headers.js:21). |
| value formatted by upstream with `toString(8)` | `&str` | TypeScript calls `.toString(8)` and passes `'' + result` for uid, gid, devmajor and devminor, which upstream only concatenates (headers.js:244), and the result through `wasmString` for size (10.4). |
| any other value at a `&str` or `Option<String>` parameter | `&str` | Never allowed to happen. The release glue does not coerce and does not validate: it reads `arg.length` and `arg.charCodeAt`. `undefined` or `null` at a `&str`, an array and a `Buffer` throw a `TypeError` from the glue; a number, boolean, plain object, symbol or bigint reaches the allocator with a `NaN` length and traps (`WebAssembly.RuntimeError: memory access out of bounds`; SIGBUS on Node 18.0 to 18.12 on darwin-arm64). Observed by the toolchain gate (2.2). Every argument at such a parameter is therefore either a string by construction (a string literal, a `+` concatenation with a string literal, a value under a `typeof x === 'string'` test) or is written `wasmString(x)` (15.3), which returns a string unchanged and throws `new TypeError('expected a string')` for anything else. It never converts (ZIP-026). |
| `Date` | `f64` milliseconds, or six `f64` calendar fields | TypeScript calls `getTime()` or the getter family (R7). |
| `Buffer` / `Uint8Array` | `&[u8]` | copied by the glue. At most `MAX_CHUNK` bytes of payload per call (5.4). |
| any other value at a `&[u8]` parameter | `&[u8]` | Never allowed to happen. The release glue does not validate: it copies with `Uint8Array.prototype.set`, so a string is copied character by character through `ToNumber` (`'123'` becomes the bytes `01 02 03`, any non-digit becomes `00`) and nothing is thrown; a typed array that is not a `Uint8Array` is copied element by element (a `Uint16Array` loses the high byte of every element), and an `ArrayBuffer` or a `DataView` has no `length` and arrives as zero bytes. TypeScript converts with `Buffer.from(x)` where upstream accepts a string (keys, passwords, salts) or throws a `TypeError` first (V14, 7.9). |
| zlib level | `i32` | TypeScript passes `resolveLevel(options)` (7.7), so NaN never reaches the `ToInt32` conversion, which would turn it into level 0. |
| optional number (`typeof mode === 'number'`) | `bool` + `i32` | never `Option<i32>`. |

---

## 6. Pinned Rust interfaces (`crates/archiver-core`)

Units are written in parallel, so everything one unit calls in another is fixed here.
Signatures in this section are binding. Private helpers inside a file are free, provided
they keep the upstream name when upstream has one. Rules for all of `archiver-core`:

- `#![forbid(unsafe_code)]`. No `std::time`, `std::fs`, `std::env`, `rand`, threads.
- `self.write(...)` appends to `self.out` and advances `self.offset`, so that each upstream
  `this.write(x)` line is one Rust line.
- A method that upstream defines on a class is an inherent method with the snake_case name.
  A module-level upstream function is a module-level `pub fn`.
- Output parameters are `out: &mut Vec<u8>`; bytes are appended, never replaced.
- A parameter that a pinned signature has and the body does not read is written with a
  leading underscore (`_compressed` in `CRC32Stream::size`). The name is not part of the
  signature; rustc warns on an unused parameter and warnings fail the clippy gate.
- A note under a listing never replaces the upstream lines it cites. Where a function has a
  parameter that selects a branch (`strip_trailing`), every branch is ported from those
  lines, also a branch that no caller in archiver-wasm takes, and the file's tests exercise every
  value. A note that describes one value only is a defect of this guide (2.3, K4).
- What a sans-IO method does when it is called out of order is stated with the method (6.4,
  6.8). Such a call gets no flag and no error variant that this guide does not list:
  upstream has no such state. Where nothing is stated, the unit reports it (unit loop
  step 1) and does not invent a guard.
- Lints: RS-40. No `#[allow(...)]` attribute other than the ones printed in this guide.

### 6.1 Module tree (pinned text; `lib.rs` belongs to the scaffold unit, each `mod.rs` to the unit named in its comment)

```rust
// crates/archiver-core/src/lib.rs
#![forbid(unsafe_code)]
pub mod crc32;
pub mod crc32_stream;
pub mod error;
pub mod gzip;
pub mod json;
pub mod numeric;
pub mod tar;
pub mod zip;

// crates/archiver-core/src/zip/mod.rs   (port of compress-commons.js barrel; written by unit rs-zip-entry)
pub mod archive_output_stream;
pub mod constants;
pub mod encrypted;
pub mod general_purpose_bit;
pub mod util;
pub mod utils;
pub mod zip_archive_entry;
pub mod zip_archive_output_stream;
pub mod zip_stream;
pub use util::DateFields;
pub use zip_archive_entry::ZipArchiveEntry;
pub use zip_archive_output_stream::{Encryption, EntryOptions, EntryStatus, Source};
pub use zip_stream::{ZipEntryData, ZipStream};

// crates/archiver-core/src/zip/encrypted/mod.rs   (written by unit rs-zip20)
pub mod aes_hmac_etm_stream;
pub mod crc;
pub mod crypto_cipher;
pub mod crypto_stream;
pub mod decrypto_stream;
pub mod zip_aes_stream;
pub mod zip_crypto_stream;
pub use aes_hmac_etm_stream::{derive_key, AesHmacEtmStream};
pub use crypto_cipher::CryptoCipher;
pub use crypto_stream::CryptoStream;
pub use decrypto_stream::DecryptoStream;

// crates/archiver-core/src/tar/mod.rs   (written by unit rs-tar)
pub mod headers;
pub mod pack;
pub use headers::Header;
pub use pack::{overflow, Pack};
```

A `mod.rs` re-exports only what another module of the package imports through it. The
other public items are reached by their module path: `GeneralPurposeBit`, `Offsets`,
`Archive`, `ZipArchiveOutputStream`, `CompositeKey` and `END_OF_TAR` stay `pub` in the
file that defines them. `zip/archive_entry.rs` and `zip/unix_stat.rs` do not exist: the
upstream files archive-entry.js and unix-stat.js are not ported, because nothing in the
package uses them (V21).

### 6.2 `error.rs` (scaffold unit, verbatim)

`Display` strings are part of the contract. "upstream" strings are copied from the cited
line. "archiver-wasm" variants guard misuse of the sans-IO API and cannot be reached from TypeScript
when section 7 is followed, with one exception that depends on the data: `Deflate`. How
TypeScript reports it is pinned in 13.4. No variant depends on the size of an entry: the
buffered ZipCrypto entry is kept by TypeScript (V16).

```rust
use std::fmt;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DeflateError(pub String);                     // "deflate error: {0}"            archiver-wasm

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ZipError {
    EntryAfterFinish,        // "unacceptable entry after finish"                 upstream archive-output-stream.js:55
    AlreadyProcessing,       // "already processing an entry"                     upstream archive-output-stream.js:59
    MethodNotImplemented(i32), // "compression method {0} not implemented"        upstream zip-archive-output-stream.js:94
    EntryNameRequired,       // "entry name must be a non-empty string value"     upstream zip-stream/index.js:115
    NoEntryOpen,             // "no entry is being processed"                     archiver-wasm (write_data / end_data without an open entry)
    ExtraTooShort,           // "entry extra field is shorter than 11 bytes"      archiver-wasm (stands in for readInt16LE RangeError, zip-aes-stream.js:160)
    InvalidRandomLength { expected: usize, actual: usize }, // "expected {expected} random bytes, got {actual}"  archiver-wasm
    InvalidKeyLength { expected: usize, actual: usize },    // "expected a {expected} byte key, got {actual}"    archiver-wasm
    InvalidEncryption(u8),   // "unknown encryption method {0}"                   archiver-wasm
    Deflate(String),         // "deflate error: {0}"                              archiver-wasm
}
impl fmt::Display for DeflateError { /* as above */ }
impl fmt::Display for ZipError { /* as above */ }
impl From<DeflateError> for ZipError { fn from(e: DeflateError) -> Self { ZipError::Deflate(e.0) } }
```

Neither type implements `std::error::Error`: every caller reads the `Display` string
(`to_js_error`, 5.3) and nothing in the package needs the trait.

`DeflateError.0` is one of two texts, both produced by the deflate loop of 6.4 and by
nothing else: the `Display` of flate2's `CompressError` when `compress_vec` returns `Err`
(`deflate compression error`), or `no progress`. They surface as
`deflate error: deflate compression error` and `deflate error: no progress` (13.4).

There is no `TarError`: the Rust tar functions cannot fail (`headers::encode` returns
`Option`). All tar error messages (`'Size mismatch'`, `'No body allowed for this entry'`,
`'already finalized or destroyed'`, ...) are raised by the TypeScript `Sink` / `Pack`.

### 6.3 `numeric.rs` (scaffold unit, verbatim behavior)

```rust
/// ECMAScript ToInt32: NaN and infinities give 0; otherwise truncate toward zero, reduce
/// modulo 2^32, reinterpret as i32. Never use `as i32` on an f64 for this (it saturates).
pub fn to_int32(v: f64) -> i32;
/// ECMAScript ToUint32.
pub fn to_uint32(v: f64) -> u32;
/// JS `Number.prototype.toString(8)` for an integer: sign followed by magnitude
/// (-1 gives "-1", not "37777777777").
pub fn i64_to_string_radix8(v: i64) -> String;
/// JS `str.length` (UTF-16 code units).
pub fn utf16_len(s: &str) -> usize;
/// JS truthiness of an optional string: `Some("")` and `None` are both falsy.
pub fn truthy_str(s: &Option<String>) -> Option<&str>;
/// `Buffer.write(string, offset)`: copies the longest prefix of `s` that fits before the end
/// of `buf` and ends on a UTF-8 character boundary. Never panics, never grows `buf`.
pub fn write_at(buf: &mut [u8], s: &str, offset: usize);
```

### 6.4 `crc32.rs`, `crc32_stream.rs`, `gzip.rs`, `json.rs` (unit rs-crc-deflate)

```rust
// crc32.rs
/// crc-32 `buf(B, seed) >>> 0` (deps/crc-32/crc32.js:70-82). `seed` is the previous result,
/// 0 for the first chunk. Implemented with crc32fast::Hasher::new_with_initial(seed).
pub fn buf(b: &[u8], seed: u32) -> u32;
// buffer-crc32 `crc32.unsigned(buf)` (json.js:60, zip-aes-stream.js:149) is not ported:
// nothing in the package calls it (V21). It equals `buf(b, 0)`, and the wasm path feeds
// slices through `buf` with a seed (5.4).

// crc32_stream.rs
/// zlib level as given by JS to a flate2 level: -1 gives 6; values below -1 give 6;
/// values above 9 give 9. (Out-of-range values never reach here: TypeScript validates, 7.7.
/// NaN never reaches here either: TypeScript passes resolveLevel(), which turns it into -1,
/// as Node's zlib does, ZIP-136.)
pub fn zlib_level(level: i32) -> flate2::Compression;

/// The write loop of zlib, which Node runs natively behind zlib.DeflateRaw and
/// zlib.createGzip. The only caller of compress_vec in the crate; `_transform`, `_flush` and
/// gzip.rs go through it. Appends to `out`. Body and exits are pinned below the listing.
pub(crate) fn deflate(compress: &mut flate2::Compress, input: &[u8], out: &mut Vec<u8>, flush: flate2::FlushCompress)
    -> Result<(), DeflateError>;

pub struct CRC32Stream { pub checksum: u32, pub raw_size: u64 }
impl CRC32Stream {
    pub fn new() -> Self;                                            // crc32-stream.js:5-10
    pub fn _transform(&mut self, chunk: &[u8], out: &mut Vec<u8>);   // :11-17, appends chunk unchanged
    pub fn digest(&self) -> [u8; 4];                                 // :18-22, BIG-endian
    // hex (:23-25): not ported, nothing in the package calls it (V21)
    pub fn size(&self, compressed: bool) -> u64;                     // :26-28, ignores the argument (written `_compressed`)
}

pub struct DeflateCRC32Stream { /* flate2::Compress (raw, no zlib header), */ pub checksum: u32, pub raw_size: u64, pub compressed_size: u64 }
impl DeflateCRC32Stream {
    pub fn new(level: i32) -> Self;                                  // deflate-crc32-stream.js:5-11; Compress::new(zlib_level(level), false)
    pub fn _transform(&mut self, chunk: &[u8], out: &mut Vec<u8>) -> Result<(), DeflateError>; // :18-24
    pub fn _flush(&mut self, out: &mut Vec<u8>) -> Result<(), DeflateError>; // zlib end: FlushCompress::Finish until StreamEnd
    pub fn digest(&self) -> [u8; 4];                                 // :25-29
    // hex (:30-32): not ported, nothing in the package calls it (V21)
    pub fn size(&self, compressed: bool) -> u64;                     // :33-39
}
// `push` override (:12-17): a private `fn push(&mut self, chunk: &[u8])` that adds chunk.len() to
// compressed_size. _transform and _flush call it once, with the bytes `deflate` appended to `out`,
// before they return the result of `deflate`: bytes appended by a call that then fails are counted too.

// gzip.rs
pub struct Gzip {
    /* compress: flate2::Compress (raw), crc: u32, input_length: u32, header_sent: bool,
       xfl: u8, os: u8 (both fixed by new() and kept until the header is emitted) */
}
impl Gzip {
    /// level and strategy as JS gave them (defaults -1 and 0). os: the header OS byte (R14).
    pub fn new(level: i32, strategy: i32, os: u8) -> Self;
    pub fn write(&mut self, chunk: &[u8], out: &mut Vec<u8>) -> Result<(), DeflateError>;
    pub fn finish(&mut self, out: &mut Vec<u8>) -> Result<(), DeflateError>;
}

// json.rs
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct JsonEntry { pub crc32: u32, pub size: u64 }
/// json.js:59-60: size and unsigned CRC-32 of the entry content, accumulated over slices.
/// `entry` is the result for the content so far (`JsonEntry::default()` before the first
/// slice): crc32 = crc32::buf(chunk, entry.crc32), size = entry.size + chunk.len().
/// For a whole buffer: `append(JsonEntry::default(), source)`.
pub fn append(entry: JsonEntry, chunk: &[u8]) -> JsonEntry;
```

Gzip member layout (what Node's `zlib.createGzip` writes, TAR-JSON-005): 10-byte header
`1f 8b 08 00 00 00 00 00 XFL OS` (FLG 0, MTIME 0), then the raw deflate stream, then CRC-32
of the input little-endian, then input length modulo 2^32 little-endian. With `l` the
resolved level (-1 gives 6): `XFL = 2` if `l == 9`, else `4` if `strategy >= 2 || l < 2`,
else `0`. The header is hand-written (not `flate2::GzBuilder`), emitted with the first
`write` (also a zero-length one) or with `finish` if there was no write. An empty input
still produces a full member. `write` updates the CRC and the length before it deflates.
The input length is a `u32` advanced with `wrapping_add(chunk.len() as u32)`; that is the
"modulo 2^32" of the trailer.

**The deflate loop** (`crc32_stream::deflate`, the listing above). Each iteration:
`out.reserve(32 * 1024)`; note `compress.total_in()` and `out.len()`;
`let status = compress.compress_vec(input, out, flush)`, where an `Err(e)` returns
`Err(DeflateError(e.to_string()))`; advance `input` by the growth of `total_in()`. Then,
in this order:

1. **Done.** `input` is empty and the call has ended: return `Ok(())`. For
   `FlushCompress::Finish` "ended" means `status == Status::StreamEnd`. For every other
   flush it means the call left spare capacity, `out.len() < out.capacity()`.
2. **No progress.** The call consumed no input and appended no output: return
   `Err(DeflateError("no progress".to_string()))`.
3. Otherwise go round again.

Exit 1 looks at the output buffer because miniz_oxide returns as soon as the output slice
is full, before it looks at its input (`if next_out.is_empty() { break Ok(MZStatus::Ok) }`
in miniz_oxide 0.9.1 `src/deflate/stream.rs`): it can have taken all the input while it
still holds compressed bytes. Node's zlib repeats its write for the same reason, while
`availOutAfter === 0`. A loop that stops at "all input consumed" leaves those bytes inside
until the next call. Exit 2 exists because the rust backend of flate2 reports "nothing
could be done" as `Ok(Status::BufError)`, not as `Err`; without it the loop never ends
when a caller writes after the stream was finished. A zero-length `input` with
`FlushCompress::None` is such a `BufError` call and leaves through exit 1 (the reserve
guarantees spare capacity), so an empty chunk is a no-op and not an error.

Calls out of order. None of them is reachable from TypeScript: the shells of 7.5 and 7.7
call `_flush` / `finish` once, from the `_flush` hook of a Node stream, and Node writes
nothing after it. The outcomes are pinned so that no unit adds a "finished" flag:

| Call | Outcome |
|---|---|
| `DeflateCRC32Stream::_transform` or `Gzip::write` with a non-empty chunk after `_flush` / `finish` | `checksum` and `raw_size` (gzip: the CRC and the length) are updated first, as upstream's statement order has it; then `Err(DeflateError("no progress"))`; nothing is appended |
| the same with an empty chunk | `Ok(())`, nothing appended |
| a second `DeflateCRC32Stream::_flush` | `Ok(())`, nothing appended |
| a second `Gzip::finish` | `Ok(())`; the 8-byte trailer is appended again |

### 6.5 `zip/constants.rs` (unit rs-zip-util)

The upstream constants that the package uses are ported with the same name. The others are
not ported, because nothing in the package uses them (V21, ZIP-122/123): `WORD`, `DWORD`,
`SHORT`, `LONG`, `SHORT_MASK`, `ZLIB_NO_COMPRESSION`, `ZLIB_BEST_SPEED`,
`ZLIB_BEST_COMPRESSION`, `ZLIB_DEFAULT_COMPRESSION`, `DEFAULT_FILE_MODE`,
`DEFAULT_DIR_MODE`, `EXT_FILE_ATTR_DIR`, `EXT_FILE_ATTR_FILE`, `S_IFMT`, `S_IFIFO`,
`S_IFCHR`, `S_IFBLK`, `S_IFLNK`, `S_IFSOCK`, `S_DOS_V`, `S_DOS_S`, `S_DOS_H`, `S_DOS_R`,
and every constant of unix-stat.js, so there is no `zip/unix_stat.rs`.
Types: `EMPTY: &[u8] = &[]`; `SHORT_ZERO: [u8; 2]`,
`LONG_ZERO: [u8; 4]`; `SHORT_SHIFT: u32 = 16`;
`MIN_VERSION_INITIAL = 10`, `MIN_VERSION_DATA_DESCRIPTOR = 20`, `MIN_VERSION_ZIP64 = 45`,
`VERSION_MADEBY = 45`: `u16`; `METHOD_STORED = 0`, `METHOD_DEFLATED = 8`: `i32`;
`PLATFORM_UNIX = 3`, `PLATFORM_FAT = 0`: `u8`; `SIG_LFH = 0x04034b50`, `SIG_DD = 0x08074b50`,
`SIG_CFH = 0x02014b50`, `SIG_EOCD = 0x06054b50`, `SIG_ZIP64_EOCD = 0x06064b50`,
`SIG_ZIP64_EOCD_LOC = 0x07064b50`: `u32`; `ZIP64_MAGIC_SHORT = 0xffff`,
`ZIP64_MAGIC = 0xffffffff`: `u64`; `ZIP64_EXTRA_ID = 0x0001`: `u16`;
`MODE_MASK = 0xfff`, `S_IFDIR = 16384`, `S_IFREG = 32768`, `S_DOS_A = 32`,
`S_DOS_D = 16`: `i32`.

### 6.6 `zip/util.rs`, `zip/utils.rs`, `zip/general_purpose_bit.rs` (unit rs-zip-util)

```rust
// util.rs  (compress-commons zip/util.js)
/// Calendar fields read from a JS Date by TypeScript with the UTC or the local getter
/// family. NaN in every field for an Invalid Date.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct DateFields { pub year: f64, pub month: f64, pub date: f64, pub hours: f64, pub minutes: f64, pub seconds: f64 }

pub fn date_to_dos(d: &DateFields) -> u32;                 // util.js:1-25 (forceLocalTime already applied by the caller)
pub fn dos_to_date(dos: u32) -> DateFields;                // :26-35, fields for a LOCAL-time Date constructor; not range-checked (below)
// fromDosTime (:36-38): not ported, nothing in the package calls it (V21).
pub fn get_eight_bytes(v: u64) -> [u8; 8];                 // :39-44
pub fn get_short_bytes(v: u64) -> [u8; 2];                 // :45-49  (v as u16, wrapping)
// getShortBytesValue (:50-52): not ported, nothing in the package calls it (V21).
pub fn get_long_bytes(v: u64) -> [u8; 4];                  // :53-57  (v as u32, wrapping)
// getLongBytesValue (:58-60): not ported, nothing in the package calls it (V21).
// toDosTime (:61-63): not ported, N1.

// utils.rs
pub fn normalize_path(path: &str, strip_trailing: bool) -> String;   // normalize-path/index.js:8-35; strip_trailing is `stripTrailing !== false`
pub fn sanitize_path(filepath: &str) -> String;                      // zip-stream/utils.js:17-21 == zip-archive-entry.js:288-290

// general_purpose_bit.rs
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GeneralPurposeBit {
    pub descriptor: bool, pub encryption: bool, pub utf8: bool,
}
impl GeneralPurposeBit {
    pub fn new() -> Self;
    pub fn encode(&self) -> [u8; 2];
    pub fn use_data_descriptor(&mut self, b: bool);
    pub fn uses_data_descriptor(&self) -> bool;
    pub fn use_encryption(&mut self, b: bool);
    pub fn use_utf8_for_names(&mut self, b: bool);
}
```

Not ported from general-purpose-bit.js, because nothing in the package calls them (V21):
`parse`, `setNumberOfShannonFanoTrees`, `getNumberOfShannonFanoTrees`,
`setSlidingDictionarySize`, `getSlidingDictionarySize`, `usesEncryption`,
`useStrongEncryption`, `usesStrongEncryption`, `usesUTF8ForNames`, with the three fields
and the three flag constants only they touch (`numberOfShannonFanoTrees`,
`strongEncryption`, `slidingDictionarySize`). `encode` therefore has no strong-encryption
operand; upstream's operand is always 0 on a write path. Code that needs the encryption or
the UTF-8 flag reads the `pub` field.

`date_to_dos` is a literal port (section 10.5). `dos_to_date` is one too and validates
nothing: it returns the six numbers upstream hands to the `Date` constructor, and they can
lie outside the calendar (`dos_to_date(0)` has month `-1.0` and date `0.0`; `0xFFFFFFFF`
gives year 2107, month 14, date 31, hours 31, minutes 63, seconds 62). The JS `Date`
constructor would normalize them; a Rust caller must not assume valid ranges. No write
path calls it.

`get_short_bytes`, `get_long_bytes` and `get_eight_bytes` take `u64` whatever the integer
type at the call site is; the call site widens with `as u64` and the function truncates,
which is upstream's mask (10.1 has the types per quantity, RS-10 and RS-38 the call
sites).

`normalize_path` operates on a Rust `&str`; the JS code indexes UTF-16 units, but every
index it inspects (`path[2]`, `path[3]`, `path.slice(0, 2)`) is only meaningful when the
first four characters are ASCII, where byte index and unit index coincide. `len` is
`numeric::utf16_len(path)`, because index.js:15-16 and 22 compare `path.length`. Lines
30-34 are ported as written, with both values of the flag: split at every maximal run of
`/` or `\` into `segs` (a leading or a trailing run leaves an empty first or last segment);
`if strip_trailing && segs.last() == Some(&"") { segs.pop(); }`; join with `/`. With
`strip_trailing = false` the result is "every run replaced by one `/`", so a trailing run
survives as one `/` (`'a/b/'` stays, `'//'` gives `'/'`). With `true` the trailing run is
dropped (`'a/b/'` gives `'a/b'`, `'//'` gives `''`). Every upstream call site passes `false`
(zip-stream/utils.js:18, zip-archive-entry.js:288), and so do `sanitize_path` and
`set_name`; the `true` branch is ported and tested all the same (14.3).

### 6.7 `zip/zip_archive_entry.rs` (unit rs-zip-entry)

```rust
// archive-entry.js (the instanceof marker class) is not ported to Rust: nothing in the
// package uses it there (V21). The TypeScript class of 7.5 keeps it.

// zip_archive_entry.rs
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Offsets { pub file: u64, pub data: u64, pub contents: u64 }

#[derive(Debug, Clone)]
pub struct ZipArchiveEntry {
    pub platform: u8,                 // PLATFORM_FAT
    pub method: Option<u16>,          // upstream -1 is None
    pub name: Option<String>,         // upstream null
    pub size: u64,
    pub csize: u64,
    pub gpb: GeneralPurposeBit,
    pub crc: u32,
    pub time: Option<u32>,            // upstream -1 is None
    pub minver: u16,                  // MIN_VERSION_INITIAL
    pub mode: Option<u32>,            // upstream -1 is None; value is mode & MODE_MASK
    pub extra: Option<Vec<u8>>,       // upstream null
    pub exattr: u32,
    pub inattr: u16,
    pub comment: Option<String>,      // upstream null
    pub _offsets: Offsets,            // upstream ad hoc property set by _normalizeEntry (:140-144)
}
impl ZipArchiveEntry {
    pub fn new(name: Option<&str>) -> Self;              // :23-42; set_name only if name is Some and non-empty
    pub fn get_central_directory_extra(&self) -> &[u8];
    pub fn get_comment(&self) -> &str;                   // "" when None
    pub fn get_compressed_size(&self) -> u64;
    pub fn get_crc(&self) -> u32;
    pub fn get_external_attributes(&self) -> u32;
    pub fn get_extra(&self) -> &[u8];                    // EMPTY when None
    pub fn get_general_purpose_bit(&self) -> &GeneralPurposeBit;
    pub fn get_general_purpose_bit_mut(&mut self) -> &mut GeneralPurposeBit;
    pub fn get_internal_attributes(&self) -> u16;
    pub fn get_local_file_data_extra(&self) -> &[u8];
    pub fn get_method(&self) -> i32;                     // -1 when None
    pub fn get_name(&self) -> Option<&str>;
    pub fn get_platform(&self) -> u8;
    pub fn get_size(&self) -> u64;
    pub fn get_time(&self) -> Option<DateFields>;        // None stands for upstream -1
    pub fn get_time_dos(&self) -> u32;                   // 0 when None
    pub fn get_version_needed_to_extract(&self) -> u16;
    pub fn set_comment(&mut self, comment: &str);
    pub fn set_compressed_size(&mut self, size: u64);    // V7: no error
    pub fn set_crc(&mut self, crc: u32);                 // V7
    pub fn set_external_attributes(&mut self, attr: u32);
    pub fn set_extra(&mut self, extra: Vec<u8>);
    pub fn set_method(&mut self, method: u16);           // V7
    pub fn set_name(&mut self, name: &str, prepend_slash: bool);
    pub fn set_size(&mut self, size: u64);               // V7
    pub fn set_time(&mut self, time: &DateFields);       // dateToDos(time, forceLocalTime); getter family chosen by the caller
    pub fn set_unix_mode(&mut self, mode: i32);
    pub fn set_version_needed_to_extract(&mut self, minver: u16);
    pub fn is_directory(&self) -> bool;                  // name ends with '/'; false when name is None (upstream TypeError, unreachable: ZipStream::entry rejects empty names first)
    pub fn is_zip64(&self) -> bool;
}
```

Not ported from zip-archive-entry.js, because nothing in the package calls them (V21):
`getLastModifiedDate`, `getUnixMode`, `setGeneralPurposeBit`, `setInternalAttributes`,
`setPlatform`, `isUnixSymlink`. `set_unix_mode` assigns `self.platform = PLATFORM_UNIX`
where upstream calls `setPlatform` (10.3), and `inattr` keeps its initial 0.

UTF-8 flag predicate (`Buffer.byteLength(s) !== s.length`, zip-archive-entry.js:208, 294) is
`!s.is_ascii()`. `set_unix_mode` is pinned in section 10.3.

### 6.8 `zip/zip_archive_output_stream.rs` and `zip/archive_output_stream.rs` (unit rs-zip-writer)

One struct holds the state of the whole upstream class chain `ArchiveOutputStream` (base),
`ZipArchiveOutputStream`, and the encrypted subclasses. `archive_output_stream.rs` contains
only an `impl ZipArchiveOutputStream` block with the base-class methods (`entry`, `finish`,
`write`) and `set_offset`. `getBytesWritten` (archive-output-stream.js:88-90) is not ported
to Rust: nothing in the package calls it there (V21), and the `offset` field is `pub`.

```rust
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Encryption { None, ZipCrypto, Aes256 }       // which subclass this writer "is"

/// Buffer.isBuffer(source) vs isStream(source). A buffer source is described by its length
/// and its CRC-32 (crc32::buf over the whole buffer); the payload is fed separately (5.4).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Source { Buffer { len: u64, crc: u32 }, Stream }

/// Values upstream reads from `this` at entry time (they may change between entries).
#[derive(Debug, Clone, Default)]
pub struct EntryOptions {
    pub level: i32,        // resolveLevel(this.options.zlib) (7.7)
    pub key: Vec<u8>,      // this.key (password bytes); empty for Encryption::None
    pub random: Vec<u8>,   // Aes256: the salt (this.options.salt or 16 random bytes, any length accepted)
                           // ZipCrypto: exactly 12 header bytes; None: empty
}

#[repr(u8)]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EntryStatus { StoredBuffer = 0, OpenStored = 1, OpenDeflated = 2 }

#[derive(Debug, Clone)]
pub struct Archive {                                   // this._archive
    pub central_length: u64, pub central_offset: u64, pub comment: String,
    pub finish: bool, pub finished: bool, pub processing: bool, pub force_zip64: bool,
}

pub(crate) enum Process { Crc32(CRC32Stream), Deflate(DeflateCRC32Stream) }

/// The per-entry pipeline that upstream builds in `_smartStream`.
pub(crate) struct SmartStream {
    pub process: Process,
    pub encryption_stream: Option<AesHmacEtmStream>,   // Aes256 only
    pub buffered_data: Vec<u8>,                        // ZipCrypto only: what the final _flush of the process produced; the chunks before it are kept by the caller (V16)
    pub encrypt: Option<CryptoStream>,                 // ZipCrypto only: Some between end_data and encrypt_end
    pub key: Vec<u8>,                                  // ZipCrypto only
    pub random: Vec<u8>,                               // ZipCrypto only: the 12 header bytes
}

pub struct ZipArchiveOutputStream {
    pub offset: u64,                                   // ArchiveOutputStream.offset
    pub(crate) out: Vec<u8>,
    pub encryption: Encryption,
    pub _entry: Option<ZipArchiveEntry>,               // the entry being processed (open stream/deferred entries)
    pub _entries: Vec<ZipArchiveEntry>,
    pub _archive: Archive,
    pub(crate) _smart: Option<SmartStream>,
}

impl ZipArchiveOutputStream {
    pub fn new(force_zip64: bool, encryption: Encryption) -> Self;       // zip-archive-output-stream.js:44-60

    // ---- archive_output_stream.rs (base class) ----
    /// archive-output-stream.js:45-78. Returns StoredBuffer where upstream wrote the source
    /// and invoked the callback synchronously inside _appendBuffer (:85-88): the local
    /// header is in `out`, the entry stays in `_entry`, and the caller must emit exactly
    /// `len` payload bytes itself and then call complete_stored(). Otherwise the entry
    /// stays open with a pipeline in `_smart`, and the caller must feed the payload with
    /// write_data() (any number of slices; for a buffer source this is upstream's
    /// `_smartStream(ae, callback).end(source)`) and then call end_data().
    pub fn entry(&mut self, ae: ZipArchiveEntry, source: Source, opts: &EntryOptions, now: &DateFields)
        -> Result<EntryStatus, ZipError>;
    pub fn finish(&mut self);                                            // :80-86
    pub fn write(&mut self, chunk: &[u8]);                               // :92-97
    /// Overwrites `self.offset`. Upstream has one offset, advanced by every write() into
    /// the Transform, including bytes a caller writes directly (:92-97). The stream layer
    /// owns that count and hands it over before entry(), finish() and (ZipCrypto) end_data()
    /// (7.5). A native caller that drains everything it is given never needs to call it.
    pub fn set_offset(&mut self, offset: u64);

    // ---- sans-IO replacements for the stream plumbing of _smartStream ----
    pub fn write_data(&mut self, chunk: &[u8]) -> Result<(), ZipError>;  // smart.write(chunk)
    pub fn end_data(&mut self) -> Result<(), ZipError>;                  // smart.end() + the 'end' handler
    /// ZipCrypto only (zip-crypto-stream.js:70-78): between write_data and end_data the
    /// compressed bytes are in `out` uncounted, the caller keeps them (bufferedData) and
    /// passes them back here, in any slicing, after end_data wrote the local header.
    /// Err(NoEntryOpen) unless end_data ran for the open entry.
    pub fn encrypt_data(&mut self, chunk: &[u8]) -> Result<(), ZipError>; // encrypt.write(chunk)
    pub fn encrypt_end(&mut self) -> Result<(), ZipError>;               // encrypt.end() + its 'end' handler
    /// zip-archive-output-stream.js:86-88 after the caller wrote the stored payload:
    /// accounts for it (`offset += ae.get_size()`, as `this.write(source)` did) and runs
    /// _after_append. Err(NoEntryOpen) unless entry() returned StoredBuffer.
    pub fn complete_stored(&mut self) -> Result<(), ZipError>;
    pub fn take_output(&mut self) -> Vec<u8>;                            // std::mem::take(&mut self.out)

    // ---- zip_archive_output_stream.rs ----
    pub fn _after_append(&mut self, ae: ZipArchiveEntry);                // :62-72
    pub fn _finish(&mut self);                                           // :111-127 without this.end()
    pub fn _normalize_entry(&mut self, ae: &mut ZipArchiveEntry, now: &DateFields); // :129-145
    pub fn _write_central_directory_end(&mut self);                      // :169-194
    pub fn _write_central_directory_zip64(&mut self);                    // :196-226
    pub fn _write_data_descriptor(&mut self, ae: &ZipArchiveEntry);      // :296-309
    pub fn get_comment(&self) -> &str;                                   // :355-357
    pub fn is_zip64(&self) -> bool;                                      // :359-366
    pub fn set_comment(&mut self, comment: &str);                        // :368-370

    // ---- virtual methods: dispatcher + base body (section 6.9) ----
    pub fn _write_local_file_header(&mut self, ae: &mut ZipArchiveEntry);          // dispatcher
    pub fn base_write_local_file_header(&mut self, ae: &mut ZipArchiveEntry);      // :311-353
    pub fn _write_central_file_header(&mut self, ae: &mut ZipArchiveEntry);        // dispatcher
    pub fn base_write_central_file_header(&mut self, ae: &mut ZipArchiveEntry);    // :228-294
    pub fn _append_buffer(&mut self, ae: ZipArchiveEntry, len: u64, crc: u32, opts: &EntryOptions) -> Result<EntryStatus, ZipError>; // dispatcher
    pub fn base_append_buffer(&mut self, ae: ZipArchiveEntry, len: u64, crc: u32, opts: &EntryOptions) -> Result<EntryStatus, ZipError>; // :74-97
    pub fn _append_stream(&mut self, ae: ZipArchiveEntry, opts: &EntryOptions) -> Result<EntryStatus, ZipError>; // dispatcher
    pub fn base_append_stream(&mut self, ae: ZipArchiveEntry, opts: &EntryOptions) -> Result<EntryStatus, ZipError>; // :99-109 without the stream wiring
    /// Builds self._smart for `ae` (upstream: construction part of _smartStream).
    pub fn _smart_stream(&mut self, ae: &mut ZipArchiveEntry, opts: &EntryOptions) -> Result<EntryStatus, ZipError>; // dispatcher
    pub fn base_smart_stream(&mut self, ae: &mut ZipArchiveEntry, opts: &EntryOptions) -> Result<EntryStatus, ZipError>; // :148-151
    pub fn base_smart_stream_write(&mut self, chunk: &[u8]) -> Result<(), ZipError>; // process.pipe(this, {end:false}) data flow, :165
    pub fn base_smart_stream_end(&mut self) -> Result<(), ZipError>;                 // handleStuff, :153-160
}
```

Ownership rules that make the upstream control flow expressible:

- `entry` owns `ae` until it is stored in `self._entry` (every status leaves the entry
  open). `write_data` and `end_data` require `self._smart` to be `Some`, `complete_stored`
  requires it to be `None`; otherwise they return `Err(ZipError::NoEntryOpen)`. Each starts
  with `let mut ae = self._entry.take().ok_or(ZipError::NoEntryOpen)?;` and either puts it
  back or hands it to `_after_append`. This is the translation of upstream's shared mutable
  `ae`.
- `complete_stored` is `self.offset = self.offset.wrapping_add(ae.get_size());` followed by
  `self._after_append(ae);`. The payload bytes themselves never pass through the writer:
  for a native caller they go straight to its own output, after the bytes of
  `take_output()`; in the package TypeScript writes them (7.5).
- `_after_append` writes the data descriptor before pushing (upstream pushes first; the
  order of those two statements is unobservable).
- `_finish` iterates with `let mut entries = std::mem::take(&mut self._entries);`, calls
  `self._write_central_file_header(ae)` for each, then puts the vector back before calling
  `is_zip64()` (which reads `_entries.len()`).
- After an `Err` the writer is poisoned the way upstream is: `processing` stays true
  (ZIP-048). No cleanup code.
- `finish()` while `processing` only sets `_archive.finish`; `_after_append` then runs
  `_finish()` (ZIP-055). The TypeScript engine never relies on this path (7.5) but native
  callers and cargo tests do.
- `_finish` does not "end" anything; TypeScript calls `this.end()` after draining.

### 6.9 Virtual dispatch table for the encrypted engines (units rs-zip-writer, rs-zip20, rs-aes)

Upstream subclasses override five methods and call the parent with
`ZipStream.prototype.method.call(this, ...)`. In Rust each overridable method `m` has a
dispatcher `m` in `zip_archive_output_stream.rs` that matches on `self.encryption`, a base
body `base_m` in the same file, and override bodies in the subclass files. An override that
calls the parent calls `self.base_m(...)`. The dispatcher bodies are exactly this table:

| dispatcher | `Encryption::None` | `Encryption::ZipCrypto` (zip_crypto_stream.rs) | `Encryption::Aes256` (zip_aes_stream.rs) |
|---|---|---|---|
| `_write_local_file_header` | `base_write_local_file_header` | `zip20_write_local_file_header` (zip-crypto-stream.js:27-31) | `aes_write_local_file_header` (zip-aes-stream.js:42-52) |
| `_write_central_file_header` | `base_write_central_file_header` | `base_write_central_file_header` | `aes_write_central_file_header` (:54-144) |
| `_append_buffer` | `base_append_buffer` | `zip20_append_buffer` (:89-100) | `aes_append_buffer` (:146-154) |
| `_append_stream` | `base_append_stream` | `zip20_append_stream` (:102-117) | `base_append_stream` |
| `_smart_stream` | `base_smart_stream` | `zip20_smart_stream` (:42-46) | `aes_smart_stream` (:159-163) |
| `write_data` | `base_smart_stream_write` | `zip20_smart_stream_write` (:52-54) | `aes_smart_stream_write` (:179) |
| `end_data` | `base_smart_stream_end` | `zip20_smart_stream_end` (:56-78) | `aes_smart_stream_end` (:165-172) |

Signatures of the override bodies (all `impl ZipArchiveOutputStream` blocks, `pub(crate)`):

```rust
// zip_crypto_stream.rs
fn zip20_write_local_file_header(&mut self, ae: &mut ZipArchiveEntry);
fn zip20_append_buffer(&mut self, ae: ZipArchiveEntry, len: u64, crc: u32, opts: &EntryOptions) -> Result<EntryStatus, ZipError>;
fn zip20_append_stream(&mut self, ae: ZipArchiveEntry, opts: &EntryOptions) -> Result<EntryStatus, ZipError>;
fn zip20_smart_stream(&mut self, ae: &mut ZipArchiveEntry, opts: &EntryOptions) -> Result<EntryStatus, ZipError>;
fn zip20_smart_stream_write(&mut self, chunk: &[u8]) -> Result<(), ZipError>;
fn zip20_smart_stream_end(&mut self) -> Result<(), ZipError>;

// zip_aes_stream.rs
pub(crate) const ZIP_AES_METHOD: i32 = 99;                                      // :11; i32 like every method constant (10.1)
pub(crate) fn _build_aes_extra_field(ae: &ZipArchiveEntry) -> [u8; 11];         // :30-40
fn aes_write_local_file_header(&mut self, ae: &mut ZipArchiveEntry);
fn aes_write_central_file_header(&mut self, ae: &mut ZipArchiveEntry);
fn aes_append_buffer(&mut self, ae: ZipArchiveEntry, len: u64, crc: u32, opts: &EntryOptions) -> Result<EntryStatus, ZipError>;
fn aes_smart_stream(&mut self, ae: &mut ZipArchiveEntry, opts: &EntryOptions) -> Result<EntryStatus, ZipError>;
fn aes_smart_stream_write(&mut self, chunk: &[u8]) -> Result<(), ZipError>;
fn aes_smart_stream_end(&mut self) -> Result<(), ZipError>;
```

How each `_append_buffer` uses `len` and `crc` (the payload is not an argument, 5.4):

- **base** (zip-archive-output-stream.js:74-97). `if len == 0 { ae.set_method(METHOD_STORED as u16) }`;
  if the method is stored: `set_size(len)`, `set_compressed_size(len)`, `set_crc(crc)`;
  `self._write_local_file_header(&mut ae)`; then, stored: keep `ae` in `self._entry`,
  build no `_smart` and return `StoredBuffer` (upstream's `this.write(source)`,
  `_afterAppend` and callback of :86-88 happen when the caller has emitted the payload and
  calls `complete_stored()`); deflated: `self._smart_stream(&mut ae, opts)` and return its
  status; any other method: `Err(MethodNotImplemented(method))`.
- **ZipCrypto** (zip-crypto-stream.js:89-100). `set_size(len)`, `set_compressed_size(len)`,
  `use_data_descriptor(false)`, `_smart_stream`. `crc` is not read (the CRC comes from the
  pipeline). Never returns `StoredBuffer`.
- **AES** (zip-aes-stream.js:146-154). `set_size(len)`, `set_compressed_size(len + 28)`,
  `set_crc(crc)`, `_write_local_file_header`, `_smart_stream`. Never returns `StoredBuffer`.

How the stream plumbing of each `_smartStream` maps to the three sans-IO steps:

- **base** (zip-archive-output-stream.js:147-167). `_smart_stream`: `Process::Deflate(DeflateCRC32Stream::new(opts.level))`
  if `ae.get_method() == METHOD_DEFLATED`, else `Process::Crc32`; returns `OpenDeflated` or
  `OpenStored`. `write`: run `_transform` into a temporary vector and `self.write(&tmp)`.
  `end`: `_flush` (deflate only), `self.write(&tmp)`, then `handleStuff`: `set_crc(u32::from_be_bytes(digest))`,
  `set_size(size(false))`, `set_compressed_size(size(true))`, `_after_append(ae)`.
- **ZipCrypto** (zip-crypto-stream.js:42-87). `_smart_stream`: same process choice; stores
  `opts.key` and `opts.random` (must be 12 bytes, else `InvalidRandomLength`). `write`:
  `_transform` into a temporary vector that is appended to `self.out` without advancing
  `self.offset`: these are the chunks of upstream's `bufferedData`, which the caller takes
  with `take_output()` and keeps (V16); nothing is written to the archive. `end`: `_flush`
  into `smart.buffered_data` (the last chunk); `set_crc`, `set_size(size(false))`,
  `set_compressed_size(size(true) + 12)`; `self._write_local_file_header(&mut ae)` (now,
  with the real values); `smart.encrypt =
  Some(CryptoStream::new(&key, u16::from_be_bytes([digest[0], digest[1]]), header))`; the
  entry and the pipeline stay open. `encrypt_data(chunk)`: `_transform` of `smart.encrypt`
  into a temporary vector that is passed to `self.write` (the cipher state carries across
  calls, so the slicing does not matter; upstream also writes the buffered chunks one by
  one, zip-crypto-stream.js:69-73). `encrypt_end`: the same for `smart.buffered_data`,
  **only if it is non-empty**, then `_after_append(ae)`. The caller makes no
  `encrypt_data` call for an empty chunk.
  The "only if non-empty" conditions reproduce P17: upstream's `CryptoStream` emits its
  12-byte header inside the first `_transform` call and has no `_flush`
  (crypto-stream.js:31-50), and a stored entry with no data produces no `'data'` event.
- **AES** (zip-aes-stream.js:159-182). `_smart_stream`: deflate iff the i16 little-endian at
  offset 9 of `ae.get_extra()` is `> 0` (`ExtraTooShort` if the extra has fewer than 11
  bytes); `AesHmacEtmStream::new(&opts.key, &opts.random)?`. `write`: `_transform` of the
  process into a temporary vector; if it is non-empty, `AesHmacEtmStream::_transform` it and
  `self.write` the ciphertext. `end`: `_flush` of the process, encrypt any output the same
  way, then `AesHmacEtmStream::_flush` (salt and verifier if not yet sent, then the 10-byte
  MAC) and `self.write`; then `onEnd`: `set_crc`, `set_size(size(false))`,
  `set_compressed_size(encryption_stream.get_total_size())`, `_after_append(ae)`.

### 6.10 `zip/zip_stream.rs` (unit rs-zip-entry)

```rust
/// What ZipStream.entry (zip-stream/index.js:101-150) hands to the entry object after the
/// TypeScript layer has normalized and validated the JS data.
#[derive(Debug, Clone)]
pub struct ZipEntryData {
    pub name: String,               // data.name after _normalizeFileData
    pub date: DateFields,           // data.date read with the forceLocalTime getter family
    pub name_prepend_slash: bool,   // truthiness of data.namePrependSlash
    pub store: bool,                // truthiness of data.store
    pub comment: String,            // data.comment ("" when data.comment.length is 0)
    pub mode: Option<i32>,          // Some iff typeof data.mode === 'number' (after the symlink adjustment)
}

pub struct ZipStream { pub inner: ZipArchiveOutputStream }

impl ZipStream {
    pub fn new(force_zip64: bool, encryption: Encryption) -> Self;
    /// index.js:114-116 and 126-149, in this exact order:
    ///   empty name: Err(EntryNameRequired)
    ///   let mut entry = ZipArchiveEntry::new(Some(&data.name));     // :126
    ///   entry.set_time(&data.date);                                 // :127
    ///   if data.name_prepend_slash { entry.set_name(&data.name, true) }   // :128-130
    ///   if data.store { entry.set_method(0) }                       // :131-133
    ///   if !data.comment.is_empty() { entry.set_comment(&data.comment) }  // :134-136
    ///   if let Some(mode) = data.mode { entry.set_unix_mode(mode) } // :140-145
    ///   self.inner.entry(entry, source, opts, &data.date)           // :149 (`now` is never read: time is set)
    pub fn entry(&mut self, source: Source, data: &ZipEntryData, opts: &EntryOptions) -> Result<EntryStatus, ZipError>;
}
```

`finalize` (index.js:158-160) is not ported to Rust: nothing in the package calls it there
(V21). It is `this.finish()`, and callers use `inner.finish()`.

### 6.11 `zip/encrypted/*` primitives (units rs-zip20, rs-aes)

```rust
// crc.rs  (lib/zip20/crc.js)
pub const CRC_TABLE: [u32; 256];                     // built by a const fn, same loop as crc.js:5-15
pub fn crc32(old_crc: u32, char_at: u8) -> u32;      // (old_crc >> 8) ^ CRC_TABLE[((old_crc ^ char_at as u32) & 0xff) as usize]

// crypto_cipher.rs  (lib/zip20/CryptoCipher.js)
pub struct CryptoCipher { pub key: Vec<u8>, pub key0: u32, pub key1: u32, pub key2: u32 }
impl CryptoCipher {
    pub fn new(key: &[u8]) -> Self;                  // :14-21
    pub fn _init(&mut self);                         // :23-31
    pub fn _update_keys(&mut self, b: u8);           // :33-38
    pub fn _stream_byte(&self) -> u8;                // :40-43
    pub fn _encrypt_byte(&mut self, b: u8) -> u8;    // :45-49
    pub fn _decrypt_byte(&mut self, b: u8) -> u8;    // :51-55
    pub fn encrypt(&mut self, data: &[u8]) -> Vec<u8>;  // :57-63
    pub fn decrypt(&mut self, data: &[u8]) -> Vec<u8>;  // :65-71
}

// crypto_stream.rs  (lib/zip20/crypto-stream.js)
pub const HEADER_LENGTH: usize = 12;
pub struct CryptoStream { pub crc: u16, pub cipher: CryptoCipher, pub header_sent: bool, pub header: [u8; 12] }   // upstream's `this.key` is read by nothing after the constructor and is not kept (V21)
impl CryptoStream {
    /// crc = upstream `this.crc.readUInt16BE(0)` (the two most significant CRC bytes).
    /// header = the bytes upstream draws with crypto.randomBytes(12); injected.
    pub fn new(key: &[u8], crc: u16, header: [u8; 12]) -> Self;        // :13-24
    pub fn _encrypt(&mut self, data: &[u8]) -> Vec<u8>;                // :27-29
    pub fn _transform(&mut self, data: &[u8], out: &mut Vec<u8>);      // :31-50
}

// decrypto_stream.rs  (lib/zip20/decrypto-stream.js)
pub struct DecryptoStream { pub cipher: CryptoCipher, pub header: Vec<u8>, pub header_processed: bool, pub total_size: u64 }   // `this.key` is not kept either (V21)
impl DecryptoStream {
    pub fn new(key: &[u8]) -> Self;                                    // :12-25 (crc is stored and never used upstream; not taken)
    pub fn get_total_size(&self) -> u64;                               // :29-31
    pub fn _decrypt(&mut self, data: &[u8]) -> Vec<u8>;                // :33-35
    pub fn _transform(&mut self, data: &[u8], out: &mut Vec<u8>);      // :37-60
}

// aes_hmac_etm_stream.rs  (lib/aes/aes-hmac-etm-stream.js)
// SALT_LENGTH (:8): not ported, nothing in the package uses it (V21); the salt is an argument
pub const KEY_LENGTH: usize = 32;
pub const COMPOSITE_KEY_LENGTH: usize = 2 * KEY_LENGTH + 2;
pub const PBKDF2_ITERATION_COUNT: u32 = 1000;
pub struct CompositeKey { pub aes_key: [u8; 32], pub hmac_key: [u8; 32], pub password_verifier: [u8; 2] }
pub fn derive_key(salt: &[u8], key: &[u8]) -> CompositeKey;            // :54-61
pub struct AesHmacEtmStream { /* salt: Vec<u8>, cipher: ctr::Ctr128LE<aes::Aes256>, hmac: Hmac<Sha1>, password_verifier: Vec<u8>, */ pub header_sent: bool, pub total_size: u64 }
impl AesHmacEtmStream {
    pub fn new(key: &[u8], salt: &[u8]) -> Result<Self, ZipError>;     // :31-51 (salt is never defaulted here)
    pub fn from_parts(aes_key: &[u8], hmac_key: &[u8], password_verifier: &[u8], salt: &[u8]) -> Result<Self, ZipError>; // InvalidKeyLength unless aes_key is 32 bytes
    pub fn get_total_size(&self) -> u64;                               // :63-65
    pub fn ensure_header_sent(&mut self, out: &mut Vec<u8>);           // :67-77
    pub fn _transform(&mut self, data: &[u8], out: &mut Vec<u8>);      // :79-91
    pub fn _flush(&mut self, out: &mut Vec<u8>);                       // :93-103
}
```

The CTR counter block starts as `01 00 00 ... 00` and increments as a 128-bit little-endian
integer (ENCRYPTED-058/062): `ctr::Ctr128LE::<aes::Aes256>::new(key, iv)` with that IV. The
keystream position carries across calls (`apply_keystream`).

`AesHmacEtmStream::new` calls `derive_key` and builds the MAC with
`Hmac::<Sha1>::new_from_slice(&composite.hmac_key)`. That constructor returns a `Result`
although HMAC accepts every key length, and `unwrap` / `expect` are banned (5.5), so the
impossible error is mapped:
`.map_err(|_| ZipError::InvalidKeyLength { expected: KEY_LENGTH, actual: composite.hmac_key.len() })?`.
`from_parts` maps it the same way. This is why `new` returns `Result<Self, ZipError>`; its
only caller in the crate is `aes_smart_stream` (6.9), which propagates with `?`.

### 6.12 `tar/headers.rs`, `tar/pack.rs` (unit rs-tar)

```rust
// headers.rs
/// The `opts` object of headers.encode, already marshalled (5.6).
#[derive(Debug, Clone)]
pub struct Header {
    pub name: String,
    pub typeflag_is_5: bool,        // opts.typeflag === 5
    pub mode: i32,                  // ToInt32(opts.mode)
    pub uid_oct: String,            // opts.uid.toString(8)
    pub gid_oct: String,            // opts.gid.toString(8)
    pub size: f64,                  // opts.size
    pub size_oct: String,           // opts.size.toString(8)
    pub mtime: f64,                 // opts.mtime.getTime(), NaN for an Invalid Date
    pub type_: String,              // opts.type
    pub linkname: Option<String>,   // truthiness: read through numeric::truthy_str
    pub uname: Option<String>,
    pub gname: Option<String>,
    pub devmajor_oct: String,       // (opts.devmajor || 0).toString(8)
    pub devminor_oct: String,       // (opts.devminor || 0).toString(8)
}
/// headers.js:18-29. `pax` is Some iff opts.pax is truthy; each element is one record body
/// (' key=value\n') in for...in order.
pub fn encode_pax(name: &str, linkname: Option<&str>, pax: Option<&[String]>) -> Vec<u8>;
/// headers.js:51-92. None is upstream's `return null` (not representable in ustar).
pub fn encode(opts: &Header) -> Option<[u8; 512]>;
pub(crate) fn to_typeflag(flag: &str) -> u8;                                  // :203-226
pub(crate) fn cksum(block: &[u8; 512]) -> u32;                                // :235-240
pub(crate) fn encode_oct(val: &str, n: usize) -> String;                      // :242-246 after the toString(8) (done by the caller)
pub(crate) fn encode_size_bin(num: f64, buf: &mut [u8; 512], off: usize);     // :248-254
pub(crate) fn encode_size(num: f64, num_oct: &str, buf: &mut [u8; 512], off: usize); // :256-262
pub(crate) fn add_length(str: &str) -> String;                                // :316-322 (integer arithmetic, 11.6)

// pack.rs
pub const END_OF_TAR: [u8; 1024] = [0u8; 1024];                               // pack.js:10
pub struct Pack { pub(crate) out: Vec<u8>, pub _finalized: bool }
impl Pack {
    pub fn new() -> Self;
    pub fn push(&mut self, data: &[u8]);                                      // Readable.push of bytes
    pub fn finalize(&mut self);                                               // :178-181: if !_finalized { _finalized = true; push(&END_OF_TAR) }
    pub fn _encode(&mut self, header: &Header, pax: Option<&[String]>);       // :194-203
    pub fn _encode_pax(&mut self, header: &Header, pax: Option<&[String]>);   // :205-234
    pub fn take_output(&mut self) -> Vec<u8>;
}
pub fn overflow(pack: &mut Pack, size: f64);                                  // :280-283
```

`_encode_pax` builds both of its headers with `typeflag_is_5 = false`, `name = "PaxHeader"`,
and `linkname = Some("PaxHeader")` iff the original link name is truthy (upstream's
`newHeader` object literal has no `typeflag` property and uses
`header.linkname && 'PaxHeader'`, pack.js:212-225); all other fields are copied from the
original header. The first header has `type_ = "pax-header"` and the pax block length as
size; the second has the original `type_`, `size` and `size_oct`.

`Pack` has no entry state: the `Sink` state machine (written counter, size check, void
check, link-name collection, pending queue, finalize deferral) is TypeScript (7.8). The
octal strings of fields upstream computes itself are produced in Rust: mode
`i64_to_string_radix8((opts.mode & 0o7777) as i64)` (`opts.mode` is an `i32`, RS-23; the
masked value is never negative, headers.js:70), mtime `i64_to_string_radix8(to_int32(opts.mtime / 1000.0) as i64)`,
checksum `format!("{:o}", cksum)`, and in `_encode_pax` the pax block size
`format!("{:o}", pax_header.len())`.

---

## 7. Pinned TypeScript interfaces (`src/`)

General rules for all of `src/`:

- `"strict": true`, target ES2022, no downleveling of classes, async generators or spread
  (their timing and semantics are part of the port). No `any` in exported types; use
  `unknown` and narrow with the same runtime checks upstream has.
- Relative imports carry the `.js` extension. Node builtins are imported as `node:fs`,
  `node:path`, `node:stream`, `node:zlib`, `node:crypto`, `node:util`, `node:events`.
- Private members keep their upstream names and stay ordinary properties. No ported member
  gets a TypeScript `private` or `protected` modifier: subclasses in other units
  (`src/index.ts`, `src/encrypted/**`), `src/vending.ts` and the tests assign and call the
  underscore members (`_format`, `_module`, `_modulePipe`, `_engine`, `_state`,
  `_normalizeEntryData`, TESTS-103). The one exception is `src/readdir-glob.ts`, which
  keeps the modifiers of its TypeScript upstream. ECMAScript `#private` fields are
  forbidden everywhere.
- The only escape hatch for an expression that upstream types dynamically is a type
  assertion on that one expression, with the spellings pinned in TS-41. No `any`, no
  `@ts-ignore`, no added narrowing branch. The assertion wraps the upstream expression and
  changes nothing else in it (`delete instance[method]` stays a computed member access).
- Every TypeScript snippet of this guide was compiled with the pinned `typescript` and
  `@types/node` (12.2) before it was pinned. A pinned spelling that `tsc` rejects is a
  defect of this guide: report it (unit loop step 1), do not pick another spelling
  silently. `@types/node` 18 declares several zlib and stream classes only as interfaces;
  use the factory function upstream's constructor is equivalent to (7.7).
- A class whose base class is not upstream's passes the constructor options that V9 lists
  for it (11.12). Property descriptors are ported as descriptors (TS-42).
- Class fields that upstream assigns in a subclass constructor are declared once on the base
  class and never redeclared in a subclass (ARCHIVER-CORE-005).
- Every upstream `setImmediate`, `setTimeout`, `queueMicrotask`, `process.nextTick` and
  every synchronous callback invocation is ported one to one. No `async`/`await`, no
  promise wrappers, no `stream.pipeline`, no `for await` in ported code, except where
  upstream itself uses them (deps/readdir-glob/src/index.ts).

### 7.1 `src/types.ts` (scaffold unit, verbatim)

```ts
import type { Dirent, Stats } from 'node:fs';
import type { Readable, TransformOptions } from 'node:stream';
import type { ZlibOptions } from 'node:zlib';
import type { ArchiverError } from './error.js';
import type { Options as ReaddirGlobOptions } from './readdir-glob.js';

export interface DateFields {
  year: number; month: number; date: number; hours: number; minutes: number; seconds: number;
}

export interface EntryData {
  type?: string;                          // 'file' | 'directory' | 'symlink'
  name?: string | null;
  date?: Date | string | null;
  mode?: number | null;
  prefix?: string | null;
  sourcePath?: string | null;
  stats?: Stats | Dirent | false | null;
  sourceType?: 'buffer' | 'stream';
  linkname?: string;
  callback?: () => void;                  // per-entry completion hook (core.js:358-363)
  store?: boolean; comment?: string; namePrependSlash?: boolean;   // zip entries (deps/zip-stream/index.js:128-135)
  [key: string]: unknown;                 // arbitrary caller keys pass through untouched
}
export type EntryDataFunction = (data: EntryData) => EntryData | false;

export interface ProgressData {
  entries: { total: number; processed: number };
  fs: { totalBytes: number; processedBytes: number };
}

/** Options of `Archiver.prototype.glob`: those of readdir-glob, and the `cwd` core.js:694 reads. */
export type GlobOptions = ReaddirGlobOptions & { cwd?: string };

/** Listeners of the events an `Archiver` emits (core.js) and of the stream events it is used with. */
export interface ArchiverEvents {
  entry: (entry: EntryData) => void;
  progress: (progress: ProgressData) => void;
  warning: (err: ArchiverError) => void;
  error: (err: ArchiverError) => void;
  data: (chunk: Buffer) => void;
  end: () => void;
  close: () => void;
  finish: () => void;
  drain: () => void;
  pipe: (src: Readable) => void;
  unpipe: (src: Readable) => void;
}

export type ModuleCallback = (err?: Error | null, entry?: unknown) => void;

/** The plugin ("module") contract of core.js:164-247 (ARCHIVER-CORE-106). */
export interface ArchiverModule {
  append(source: Buffer | Readable, data: EntryData, callback: ModuleCallback): void;
  finalize?(): void;
  end?(): void;
  on(event: string, listener: (...args: unknown[]) => void): unknown;
  pipe(destination: NodeJS.WritableStream, options?: unknown): unknown;
  unpipe(destination?: NodeJS.WritableStream): unknown;
  supports?: { directory?: boolean; symlink?: boolean };   // archiver 7 (V12)
}
export type ModuleConstructor = new (options?: ArchiverOptions) => ArchiverModule;

export interface CoreOptions extends TransformOptions { statConcurrency?: number }
export interface ZipOptions {
  comment?: string; forceLocalTime?: boolean; forceZip64?: boolean; namePrependSlash?: boolean;
  store?: boolean; zlib?: ZlibOptions; level?: number;
}
export interface TarOptions { gzip?: boolean; gzipOptions?: ZlibOptions | null }
export interface EncryptedOptions extends ZipOptions {
  password?: string | Buffer;
  encryptionMethod?: 'aes256' | 'zip20';
  salt?: string | Buffer; // AES: fixed salt for every entry (zip-aes-stream.js:162); a string is converted with Buffer.from (7.9)
  zip20Header?: Buffer;   // ZipCrypto: fixed 12-byte random header for every entry (V10); a Buffer of exactly 12 bytes
}
/** Options of the three public cipher streams (they are passed whole to Transform, crypto-stream.js:17). */
export interface CryptoStreamOptions extends TransformOptions { key: string | Buffer; crc: Buffer; header?: Buffer }   // header: V10
export interface DecryptoStreamOptions extends TransformOptions { key: string | Buffer; crc?: Buffer }
export interface AesHmacEtmStreamOptions extends TransformOptions { key: string | Buffer; salt?: string | Buffer | null }
export interface ArchiverOptions extends CoreOptions, EncryptedOptions, TarOptions {
  [key: string]: unknown;
}

export interface Match { relative: string; absolute: string; stat?: Stats | Dirent }

export interface QueueTask { source: Buffer | Readable | null; filepath?: string; data: EntryData }
```

### 7.2 Package entry, vending function, archiver 7 members

`src/index.ts` is the port of node-archiver/index.js plus the package surface:

```ts
export { Archiver };                                   // index.js:6
export class ZipArchive extends Archiver { ... }       // index.js:8-17, literal
export class TarArchive extends Archiver { ... }       // index.js:19-28
export class JsonArchive extends Archiver { ... }      // index.js:30-39
export { ArchiverError } from './error.js';            // addition (1.2)
export { ZipEncrypted } from './encrypted/zip-encrypted.js';
export { ZipAesStream } from './encrypted/aes/zip-aes-stream.js';
export { AesHmacEtmStream } from './encrypted/aes/aes-hmac-etm-stream.js';
export { ZipCryptoStream } from './encrypted/zip20/zip-crypto-stream.js';
export { CryptoStream } from './encrypted/zip20/crypto-stream.js';
export { DecryptoStream } from './encrypted/zip20/decrypto-stream.js';
export { CryptoCipher } from './encrypted/zip20/crypto-cipher.js';
export { create, registerFormat, isRegisteredFormat } from './vending.js';
export type * from './types.js';
export { default } from './vending.js';                // the archiver 7 vending function
```

`src/vending.ts` is a literal port of
archiver-zip-encrypted/node_modules/archiver/index.js:8-84: a module-level
`formats` (a plain object, as upstream; archiver-wasm keeps it on
`globalThis[Symbol.for('archiver-wasm.formats')]`, so that the two bundles of the package
share one registry, V20 and 15.4), `vending(format, options)`,
`vending.create`, `vending.registerFormat`, `vending.isRegisteredFormat`, with the four
thrown messages `'create(' + format + '): format not registered'`,
`'register(' + format + '): format already registered'`,
`'register(' + format + '): format module invalid'`,
`'register(' + format + '): format module missing methods'`, and the three pre-registrations
`zip`, `tar`, `json` (index.js:80-82) using `src/plugins/*`, made only by the bundle that
finds no registry yet (`if (!registered)`, V20). `'zip-encrypted'` is not
pre-registered (callers register it, as with upstream). `create` does
`new Archiver(format, options)`, `instance.setFormat(format)`,
`instance.setModule(new formats[format](options))` (index.js:33-35). It imports `Archiver`
from `./core.js`, never from `./index.js`. The module's default export is `vending`; it also
exports `create`, `registerFormat` and `isRegisteredFormat` by name (the same function
objects that are attached to `vending`).

Additions to `src/core.ts` from archiver 7 lib/core.js (R19):

```ts
constructor(format?: string | ArchiverOptions, options?: ArchiverOptions) {
  if (typeof format !== 'string') { options = format; }           // archiver 7 core.js:30-33 (V11)
  options = { highWaterMark: 1024 * 1024, statConcurrency: 4, ...options };   // core.js:32-36
  super(options);
  ...                                                             // core.js:38-61 literally
}
_moduleSupports(key) {                                            // archiver 7 core.js:260-266
  const supports = (this._module as ArchiverModule).supports;     // TS-41; one read of a plain property instead of three
  if (!supports || !supports[key]) { return false; }
  return supports[key] as boolean;
}
setFormat(format) {                                               // archiver 7 core.js:813-822
  if (this._format) { this.emit('error', new ArchiverError('FORMATSET')); return this; }
  this._format = format;
  return this;
}
setModule(module) {                                               // archiver 7 core.js:830-845
  if (this._state.aborted) { this.emit('error', new ArchiverError('ABORTED')); return this; }
  if (this._state.module) { this.emit('error', new ArchiverError('MODULESET')); return this; }   // P23: never true
  this._module = module;
  this._modulePipe();
  this._supportsDirectory = this._moduleSupports('directory');    // bridge to the archiver 8 flags
  this._supportsSymlink = this._moduleSupports('symlink');
  return this;
}
```

Everything else in `src/core.ts` is node-archiver/lib/core.js:1-795 statement by statement.
`_format` and `_module` keep the `false` sentinel (`string | false`, `ArchiverModule | false`).
`this._streams = []` and `this._task` are kept.

Declared members of `Archiver` (binding: other units are written against them). None has a
`private` or `protected` modifier. Bodies are upstream's; only the types are added here.

```ts
export default class Archiver extends Transform {
  _supportsDirectory = false;                        // core.js:23
  _supportsSymlink = false;                          // core.js:24
  options: ArchiverOptions;
  _format: string | false;
  _module: ArchiverModule | false;
  _pending: number;
  _pointer: number;
  _entriesCount: number;
  _entriesProcessedCount: number;
  _fsEntriesTotalBytes: number;
  _fsEntriesProcessedBytes: number;
  _queue: QueueObject<QueueTask>;
  _statQueue: QueueObject<QueueTask>;
  _state: { aborted: boolean; finalize: boolean; finalizing: boolean; finalized: boolean; modulePiped: boolean };
  _streams: unknown[];
  _task?: QueueTask | null;                          // assigned only in _onQueueTask and _moduleAppend

  constructor(format?: string | ArchiverOptions, options?: ArchiverOptions);
  _abort(): void;
  _append(filepath: string, data?: EntryData): void;
  _finalize(): void;
  _maybeFinalize(): boolean;
  _moduleAppend(source: Buffer | Readable, data: EntryData, callback: () => void): void;
  _moduleFinalize(): void;
  _modulePipe(): void;
  _moduleUnpipe(): void;
  _moduleSupports(key: 'directory' | 'symlink'): boolean;          // archiver 7
  _normalizeEntryData(data?: EntryData, stats?: Stats | Dirent): EntryData;
  _onModuleError(err: Error): void;
  _onQueueDrain(): void;
  _onQueueTask(task: QueueTask, callback: () => void): void;
  _onStatQueueTask(task: QueueTask, callback: () => void): void;
  _shutdown(): void;
  _transform(chunk: Buffer, encoding: BufferEncoding, callback: TransformCallback): void;
  _updateQueueTaskWithStats(task: QueueTask, stats: Stats | Dirent): QueueTask | null;

  abort(): this;
  append(source: Buffer | NodeJS.ReadableStream | string | null, data?: EntryData): this;   // whatever is-stream accepts (core.js:545)
  directory(dirpath: string, destpath?: string | false | null, data?: EntryData | EntryDataFunction | null): this;
  file(filepath: string, data?: EntryData): this;
  glob(pattern: string, options?: GlobOptions, data?: EntryData): this;   // readdir-glob's options and `cwd` (7.1)
  finalize(): Promise<void>;
  symlink(filepath: string, target: string, mode?: number): this;
  pointer(): number;
  setFormat(format: string): this;                                    // archiver 7
  setModule(module: ArchiverModule): this;                            // archiver 7
}
```

The events are typed by an interface that merges with the class, declared directly above
it. It emits no code; the methods stay Transform's:

```ts
export default interface Archiver {
  on<E extends keyof ArchiverEvents>(event: E, listener: ArchiverEvents[E]): this;
  on(event: string | symbol, listener: (...args: never[]) => void): this;
  once<E extends keyof ArchiverEvents>(event: E, listener: ArchiverEvents[E]): this;
  once(event: string | symbol, listener: (...args: never[]) => void): this;
  off<E extends keyof ArchiverEvents>(event: E, listener: ArchiverEvents[E]): this;
  off(event: string | symbol, listener: (...args: never[]) => void): this;
}
```

`Zip` and `Tar` declare `on`, `pipe` and `unpipe` the same way, as overload signatures above
the upstream bodies, which keep taking no parameters and forwarding `arguments`.

The parameter types describe the contract, not a check: every runtime test upstream makes
on these arguments (`typeof filepath !== 'string'`, `destpath === false`, ...) stays (TS-22).
Calls on `this._module` use the assertion spelling of TS-41, because the `false` sentinel
is part of its type.

### 7.3 `src/queue.ts` (port of the used subset of async.queue 3.2.6)

```ts
export type QueueWorker<T> = (task: T, callback: (err?: Error | null) => void) => void;
export interface QueueObject<T> {
  concurrency: number;
  push(data: T): void;
  kill(): void;
  idle(): boolean;
  drain(handler: () => void): void;
  length(): number;
  running(): number;
  process(): void;
}
export function queue<T>(worker: QueueWorker<T>, concurrency?: number | null): QueueObject<T>;
```

The file keeps the shape of its five upstream sources, so that it reads side by side with
them (the `PORTMAP.tsv` rows of queue.js, DoublyLinkedList.js, async/queue.js, onlyOnce.js
and setImmediate.js):

```ts
function onlyOnce<A extends unknown[]>(fn: ((...args: A) => void) | null) { ... }    // async/internal/onlyOnce.js:7-13, literal
const _setImmediate = queueMicrotask;                                                // async/internal/setImmediate.js:24-25
type DLLNode<T> = { data: T; prev?: DLLNode<T> | null; next?: DLLNode<T> | null };
class DLL<T> { head; tail; length; removeLink; empty; insertAfter; push; shift }   // the used members of async/internal/DoublyLinkedList.js:10-85, each literal
function setInitial<T>(dll: DLL<T>, node: DLLNode<T>) { ... }                        // async/internal/DoublyLinkedList.js:88-91
function _queue<T>(worker: (items: T[], callback: (err?: Error | null) => void) => void,
                   concurrency: number | null | undefined, payload: number): QueueObject<T> { ... }   // async/internal/queue.js:26-293
export function queue<T>(worker: QueueWorker<T>, concurrency?: number | null): QueueObject<T> {       // async/queue.js:7-12
  var _worker = worker;                                                              // wrapAsync is not ported
  return _queue<T>((items, cb) => { _worker(items[0], cb); }, concurrency, 1);
}
```

`DLL` has the members of the upstream class that the queue uses, each a literal copy; it
links the task items through their own `prev` and `next` properties, so `shift()` is O(1)
(an `Array` here makes draining a long queue quadratic). `insertBefore`, `unshift`, `pop`,
`toArray`, the iterator and `remove` are not ported: nothing in the package calls them
(V21). `QueueWorker` is declared in the file and not exported.

`_setImmediate` is `queueMicrotask` itself, captured when the module is evaluated as
upstream captures its defer; the closure `(fn, ...args) => defer(() => fn(...args))` that
upstream wraps around it (setImmediate.js:18-20, 34) is left out (N5).

Exact semantics of `_queue` (node-archiver/node_modules/async/internal/queue.js):

- `concurrency == null` gives 1; `concurrency === 0` throws
  `new RangeError('Concurrency must not be zero')` synchronously (queue.js:27-31). Nothing
  else is validated.
- State, all of it closure variables of `_queue` and none of it a property of `q`:
  `_tasks = new DLL<T>()` (FIFO; upstream's `q._tasks`, queue.js:162, which the pinned
  `QueueObject` does not expose), `numRunning = 0`, `drainHandlers: Array<() => void> = []`
  (upstream's `events.drain`; `on`, `once`, `off` and `trigger` are reduced to assigning
  and iterating this one array), `processingScheduled = false`, `isProcessing = false`.
- `push(data)` returns `_insert(data)` (queue.js:67-104): `_tasks.push({ data })`; if
  `!processingScheduled`, set it and call
  `_setImmediate(() => { processingScheduled = false; q.process(); })` (queue.js:90-96).
  The worker never runs synchronously inside `push`. Nothing is returned (upstream
  returns a promise when no callback is given, queue.js:98-103).
- `process()` (queue.js:212-245): `if (isProcessing) return; isProcessing = true;` then
  `while (numRunning < q.concurrency && _tasks.length)`: the payload loop of lines 220-229
  as written (`var l = _tasks.length; if (payload) l = Math.min(l, payload);`, then `l`
  times `var node = _tasks.shift() as { data: T }; data.push(node.data);`),
  `numRunning += 1`, `var cb = onlyOnce(_createCB()); _worker(data, cb);`; finally
  `isProcessing = false`. `payload` is always 1, so one task is shifted per round and the
  caller's worker receives `items[0]`. The pause test of line 219 is not ported. The
  `isProcessing` guard is required: archiver workers may call back synchronously
  (core.js:369, 389).
- The callback (queue.js:106-135): `onlyOnce` makes a second invocation throw
  `new Error('Callback was already called.')`; the first runs the function `_createCB()`
  returned, which does `numRunning -= 1`, then `if (q.idle())` calls every drain handler
  synchronously (`drainHandlers.forEach(handler => handler())`), then `q.process()`.
  `_createCB` takes no `tasks` argument and the function it returns has no `err`
  parameter, because nothing would read it: the loop of
  lines 110-125 (the per-task callback, which only settles the promise `push` returned,
  the `'error'` event and `workersList`) and the `'unsaturated'` trigger are not ported.
- `idle()`: `_tasks.length + numRunning === 0` (queue.js:255-257).
- `drain(handler)`: replaces the handler list with `[handler]` (queue.js:147-158:
  `drainHandlers = []; drainHandlers.push(handler);`). It is not a member of the object
  literal. As upstream, it is added afterwards with
  `Object.defineProperties(q, { drain: { writable: false, value: (handler) => { ... } } })`
  (queue.js:269-286, TS-42), which makes it non-writable, non-enumerable and
  non-configurable; the literal is therefore asserted `as QueueObject<T>` (TS-41). The
  form without a handler, which returns a promise (queue.js:148-155), is not ported.
- `kill()`: `drainHandlers = []; _tasks.empty();`. Running workers are not interrupted
  and their callbacks still work; later pushes are still accepted and processed
  (queue.js:191-194).
- `length()` is `_tasks.length`; `running()` is `numRunning`.

Left out of queue.js (N5; archiver uses none of it): `wrapAsync`, `workersList`, the
events `error`, `saturated`, `unsaturated` and `empty` with their four
`defineProperties` entries, `_createTaskItem` and the task callback, the promise results of
`push` and `drain`, the array form of `push`, `pushAsync`, `unshift`, `unshiftAsync`,
`remove`, `pause`, `resume`, `paused`, `started`, `buffer`, `payload` as a property, the
iterator, and `_maybeDrain`.

### 7.4 Small helpers (units ts-helpers, ts-entry, ts-glob)

```ts
// src/error.ts  (lib/error.js, R13: a function constructor, not a class)
export interface ArchiverError extends Error { code: string; data?: unknown }
export const ArchiverError: { new (code: string, data?: unknown): ArchiverError; prototype: ArchiverError };

// src/utils.ts  (lib/utils.js, literal)
export function collectStream(source: NodeJS.ReadableStream, callback: (err: Error | null, buffer?: Buffer) => void): void;
export function dateify(dateish?: unknown): Date;
export function normalizeInputSource(source: unknown): unknown;
export function sanitizePath(filepath: string): string;
export function trailingSlashIt(str: string): string;

// src/normalize-path.ts  (normalize-path 3.0.0 without the stripTrailing parameter; default export)
export default function normalizePath(path: string): string;

// src/is-stream.ts  (is-stream 4.0.1 isStream without the options parameter)
export function isStream(stream: unknown): stream is NodeJS.ReadableStream | NodeJS.WritableStream;

// src/lazystream.ts  (lazystream 1.0.1 Readable on node:stream PassThrough; the whole file is pinned below)
export class Readable extends PassThrough { constructor(fn: () => NodeJS.ReadableStream) }

// src/readdir-glob.ts  (deps/readdir-glob/src/index.ts, copied statement by statement, without the callback form)
export type Options = { ... };
class ReaddirGlob extends EventEmitter { ... }      // same members, same visibility; constructor(cwd?: string, options?: Options)
const readdirGlob: { (pattern?: string, options?: Options): ReaddirGlob; ReaddirGlob: typeof ReaddirGlob };
export default readdirGlob;
```

Parameters and forms of these helpers that no caller in the package uses are not ported
(V21):

- `normalizePath` has no `stripTrailing` parameter and no branch that pops the trailing
  empty segment (normalize-path/index.js:31-33). Every upstream call site passes `false`
  (utils.js:59, zip-stream/utils.js:18), so the result is always the one of `false`: every
  run of `/` or `\` becomes one `/` and a trailing run survives. The Rust copy keeps both
  values of the flag (6.6).
- `isStream` has no `options` parameter and no `!checkOpen ||` operand. Every caller uses
  the default `checkOpen = true`, with which the operand is `false`.
- `lazystream.Readable` has no `options` parameter (below).
- readdir-glob has no callback form: the type `Callback`, the `cb` parameter of the
  constructor and of the `readdirGlob` function, the `typeof options === 'function'`
  branch and the block that collects matches for the callback (index.ts:201, 222-225, 263-269)
  are not ported. archiver constructs the globber with `(dirpath, options)` and listens to
  its events (core.js:632, 694). The option `absolute` stays in `Options`. The module
  exports `Options` and the default export only; `Stat`, `Match`, `ReaddirGlob` and
  `readdirGlob` are declared in the file and not exported by name.

`lazystream.Readable` keeps the "replace `_read` on the instance, delete it on first call"
mechanism of lazystream.js:15-36 (an own property `_read` that deletes itself, calls `fn`,
forwards the source `'error'` with `this.emit.bind(this, 'error')`, pipes the source into
`this`, then calls the prototype `_read` with the same arguments) and the synthetic
`this.emit('readable')` at construction. The file, apart from its imports and upstream's
own comment above `beforeFirstCall`:

```ts
// node-archiver/node_modules/lazystream/lib/lazystream.js:15
function beforeFirstCall(instance: Readable, method: '_read', callback: (this: Readable, ...args: Parameters<Readable['_read']>) => void) {
  instance[method] = function(this: Readable) {
    delete (instance as { _read?: unknown })[method];
    callback.apply(this, arguments as unknown as Parameters<Readable['_read']>);
    return this[method].apply(this, arguments as unknown as Parameters<Readable['_read']>);
  };
}

// node-archiver/node_modules/lazystream/lib/lazystream.js:23
export class Readable extends PassThrough {
  constructor(fn: () => NodeJS.ReadableStream) {
    super({ autoDestroy: false, emitClose: false });   // PORTING.md V9

    beforeFirstCall(this, '_read', function() {
      var source = fn.call(this);
      var emit = this.emit.bind(this, 'error');
      source.on('error', emit);
      source.pipe(this);
    });

    this.emit('readable');
  }
}
```

Four things differ from lazystream.js:23-37, and nothing else may:

- `beforeFirstCall` keeps its `method` parameter and the computed accesses
  `instance[method]`, `delete instance[method]` and `this[method]`; the parameter is typed
  as the literal `'_read'`, and the two assertions are the ones of TS-41.
- The `options` parameter is not ported, because no caller in the package passes it
  (V21): archiver constructs the lazy stream with the factory alone (core.js:457-459).
  The base constructor is not given upstream's `options` and `fn` is called with no
  argument.
- The base constructor gets `{ autoDestroy: false, emitClose: false }`, the lifecycle of
  the readable-stream 2.3.8 `PassThrough` that upstream extends (V9, 11.12).
- The guard `if (!(this instanceof Readable)) return new Readable(fn, options);`
  (lazystream.js:24-25) is not ported (N5): an ES class cannot be called without `new`.

### 7.5 The zip engine: `src/compress-commons/*` (unit ts-zip-engine)

`archive-output-stream.ts` is a literal port of the upstream file: `class ArchiveOutputStream
extends Transform`, fields `offset = 0` and `_archive = { finish, finished, processing }`,
the four scaffold hooks, `_emitErrorCallback`, identity `_transform`, `entry` (lines 45-78
unchanged, including the four error strings (archive-output-stream.js:51, 55, 59, 73) and
`return this`), `finish`, `getBytesWritten`,
and the `write(chunk, cb)` override that adds `chunk.length` to `this.offset` and forwards
exactly two arguments to `super.write`.

`zip-archive-output-stream.ts` keeps the class, `_defaults` (lines 28-41, literal), the
constructor state (44-60, literal) and the method names, but the bodies that produced bytes
now drive the wasm engine. Pinned skeleton:

```ts
export default class ZipArchiveOutputStream extends ArchiveOutputStream {
  constructor(options) {
    const _options = _defaults(options);
    super(_options);
    this.options = _options;
    this._entry = null;
    this._entries = [];
    this._archive = { centralLength: 0, centralOffset: 0, comment: '', finish: false,
      finished: false, processing: false, forceZip64: _options.forceZip64,
      forceLocalTime: _options.forceLocalTime };
    this._engine = new wasm.WasmZipStream(_options.forceZip64, this._encryptionMethod());
    if (this.destroyed) { this._engine.free(); }     // 5.4: a `signal` that was aborted already ran _destroy inside super()
  }

  // Hooks the encrypted subclasses override (prototype methods: safe to call from this constructor).
  _encryptionMethod(): number { return 0; }          // ZipCryptoStream: 1, ZipAesStream: 2
  _entryKey(): Buffer { return EMPTY; }              // subclasses: this.key (always a Buffer, 7.9)
  _entryRandom(): Buffer { return EMPTY; }           // subclasses: the salt / the 12 header bytes as a Buffer, bodies pinned in 7.9

  _destroy(err, callback) {                          // 5.4 lifetime
    if (this._engine) { this._engine.free(); }
    callback(err);
  }

  _drain() {                                         // forwards what the last wasm call produced
    const out = this._engine.takeOutput();
    if (out.length > 0) { this.write(toBuffer(out)); }
  }

  _engineEntry(ae, source /* Buffer | null */) {     // Rust: ZipStream::entry
    if (Buffer.byteLength(wasmString(ae.name)) > MAX_TEXT) { throw new Error('entry name too large'); }         // V16: MAX_TEXT = 64 MiB
    if (Buffer.byteLength(wasmString(ae.comment)) > MAX_TEXT) { throw new Error('entry comment too large'); }
    const d = ae.date;
    let crc = 0;
    if (source !== null) {                           // :82 and zip-aes-stream.js:149, in slices (5.4)
      for (let i = 0; i < source.length; i += MAX_CHUNK) {
        crc = wasm.crc32Update(crc, source.subarray(i, i + MAX_CHUNK));
      }
    }
    const key = this._entryKey();
    const random = this._entryRandom();              // V10: drawn once per entry, here
    this._engine.setOffset(this.offset);             // archive-output-stream.js:92-97: the one offset is counted here (ZIP-135)
    const status = this._engine.entry(wasmString(ae.name), d.year, d.month, d.date, d.hours, d.minutes, d.seconds,
      ae.namePrependSlash, ae.store, wasmString(ae.comment), ae.mode !== undefined, ae.mode !== undefined ? ae.mode : 0,
      resolveLevel(this.options.zlib), key, random,
      source !== null, source !== null ? source.length : 0, crc);
    this._drain();
    return status;                                   // 0 stored buffer, 1 open stored, 2 open deflated
  }

  _afterAppend(ae) {                                 // :62-72; the data descriptor was written by Rust
    this._entries.push(ae);
    this._archive.processing = false;
    this._entry = null;
    if (this._archive.finish && !this._archive.finished) { this._finish(); }
  }

  _appendBuffer(ae, source, callback) {              // :74-97 (and the AES / ZipCrypto overrides)
    if (this.destroyed) {                            // V17: this.write is dropped; :75, :85-88 still complete, a smart stream never ends
      if ((source.length === 0 || ae.store) && this._encryptionMethod() === 0) { this._afterAppend(ae); callback(null, ae); }
      return;
    }
    let status;
    try { status = this._engineEntry(ae, source); } catch (err) { callback(err); return; }   // 13.4
    if (status === 0) {                              // stored buffer, plain engine: upstream called back synchronously (:85-89)
      this.write(source);                            // :86; the payload never enters wasm (5.4, V16)
      this._engine.completeStored();                 // Rust: _after_append (writes the descriptor of ZIP-058)
      this._drain();
      ae._setInfo(this._engine.lastEntry());
      this._afterAppend(ae);
      callback(null, ae);
      return;
    }
    this._smartStream(ae, callback, status === 2).end(source);   // :91
  }

  _appendStream(ae, source, callback) {              // :99-109
    if (this.destroyed) { return; }                  // V17
    let status;
    try { status = this._engineEntry(ae, null); } catch (err) { callback(err); return; }     // 13.4
    var smart = this._smartStream(ae, callback, status === 2);
    source.once('error', function (err) {
      smart.emit('error', err);
      smart.end();
    });
    source.pipe(smart);
  }

  _finish() {                                        // :111-127
    if (this.destroyed) { return; }                  // V17
    this._engine.setComment(wasmString(this.getComment()));   // 5.6: a non-string throws here, where upstream's Buffer.byteLength threw (:190)
    this._engine.setOffset(this.offset);             // :112 centralOffset = this.offset (ZIP-135)
    this._engine.finish();
    this._archive.centralOffset = this._engine.centralOffset();
    this._archive.centralLength = this._engine.centralLength();
    this._drain();
    this._archive.processing = false;
    this._archive.finish = true;
    this._archive.finished = true;
    this.end();
  }

  _normalizeEntry(ae) {}                             // performed in Rust (_normalize_entry) at the start of entry()

  _smartStream(ae, callback, deflate) {              // :147-167
    if (deflate) { validateZlibOptions('deflateRaw', this.options.zlib); }   // stands in for `new DeflateCRC32Stream(this.options.zlib)` throwing (ZIP-054)
    var process = new SmartStream(this, function (err) { callback(err, ae); });   // engine failure: delivered, 13.4
    var error = null;
    function handleStuff() {
      if (this.destroyed) { return; }                // V17
      ae._setInfo(this._engine.lastEntry());         // crc, sizes, method... as Rust computed them
      this._afterAppend(ae);
      callback(error, ae);
    }
    process.once('end', handleStuff.bind(this));
    process.once('error', function (err) { error = err; });
    process.pipe(this, { end: false });
    return process;
  }

  getComment(comment) { return this._archive.comment !== null ? this._archive.comment : ''; }   // :355-357
  isZip64() { return this._engine.isZip64(); }                                                   // :359-366, computed in Rust
  setComment(comment) { this._archive.comment = comment; }                                       // :368-370
}

// One per entry: the TypeScript stand-in for CRC32Stream / DeflateCRC32Stream and, in the
// encrypted engines, for the encryption stream piped behind them.
class SmartStream extends Transform {
  constructor(zip, onEngineError) { super(); this._zip = zip; this._onEngineError = onEngineError;
    this._bufferedData = []; }                       // zip-crypto-stream.js:46
  _transform(chunk, encoding, callback) {
    if (this._zip.destroyed) { callback(); return; } // V17
    try {
      for (let i = 0; i < chunk.length; i += MAX_CHUNK) {          // 5.4: bounded slices; an empty chunk makes no call
        this._zip._engine.writeData(chunk.subarray(i, i + MAX_CHUNK));
        const out = this._zip._engine.takeOutput();
        if (out.length > 0) {
          if (this._zip._encryptionMethod() === 1) { this._bufferedData.push(toBuffer(out)); }   // zip-crypto-stream.js:52-54 (V16)
          else { this.push(toBuffer(out)); }
        }
      }
    } catch (err) { this._fail(err); return; }
    callback();
  }
  _flush(callback) {
    if (this._zip.destroyed) { callback(); return; } // V17
    try {
      // ZipCrypto writes its local header now (zip-crypto-stream.js:65). Nothing of this entry
      // has been emitted yet, so the TypeScript offset is exact at this point (ZIP-135).
      if (this._zip._encryptionMethod() === 1) { this._zip._engine.setOffset(this._zip.offset); }
      this._zip._engine.endData();
      this._take();
      if (this._zip._encryptionMethod() === 1) {     // zip-crypto-stream.js:70-73
        for (const chunk of this._bufferedData) {
          for (let i = 0; i < chunk.length; i += MAX_CHUNK) {
            this._zip._engine.encryptData(chunk.subarray(i, i + MAX_CHUNK));
            this._take();
          }
        }
        this._bufferedData = [];
        this._zip._engine.encryptEnd();
        this._take();
      }
    } catch (err) { this._fail(err); return; }
    callback();
  }
  _take() {                                          // forwards what the last wasm call produced
    const out = this._zip._engine.takeOutput();
    if (out.length > 0) { this.push(toBuffer(out)); }
  }
  _fail(err) {                                       // 13.4: never swallowed
    this.destroy();                                  // no 'end': handleStuff does not run, _archive.processing stays true
    this._onEngineError(err);
  }
}
```

Facts the skeleton relies on:

- The TypeScript flags `_archive.processing / finish / finished` are authoritative for JS
  callers. The Rust writer keeps its own copies; between `endData()` and the `'end'` event
  of the `SmartStream` the Rust flag is already false while the TypeScript flag is still
  true, which is what makes a second `entry()` fail with `'already processing an entry'`
  during that window, as upstream.
- TypeScript never calls `this._engine.finish()` while an entry is open: `finish()`
  (archive-output-stream.js:80-86) only sets the flag, and `_afterAppend` calls `_finish()`
  after the entry's bytes (including the data descriptor, which Rust emitted in `endData`)
  have flowed. Byte order is therefore entry, descriptor, central directory, as upstream,
  and `_finish()` (which calls `this.end()`) still runs before the entry callback
  (ZIP-055).
- Callback timing (ZIP-046, V3): status 0 calls back synchronously inside `entry()`; every
  other completion happens in the `'end'` event of the `SmartStream`, hence asynchronously.
- There is one offset, `this.offset` of the TypeScript `ArchiveOutputStream`, advanced by
  every `write()` into the engine, including bytes a caller writes directly into the public
  engine classes (as-stream.js:11-16; ZIP-135). Rust advances its own copy while it writes
  and is re-synchronized with `setOffset(this.offset)` at the three points where upstream
  reads the offset for a record: before `entry()` (local header offset of the plain and AES
  engines), before `finish()` (central directory offset), and before `endData()` of a
  ZipCrypto entry (its local header is written there). At each of these points everything
  produced so far has been written into `this`: the previous entry's `SmartStream` emits
  `'end'` only after its last chunk was piped, and `_drain()` writes synchronously. No
  other wasm call is preceded by `setOffset`.
- Payload slicing (5.4): `_engineEntry` computes the CRC of a buffer source for every
  engine, although the ZipCrypto engine and the deflated plain path do not read it (they
  take the CRC from the pipeline); this keeps the decision "is a CRC needed up front" in
  Rust, where upstream's method choice lives. A stored buffer of the plain engine is
  written by `this.write(source)` as one chunk, exactly as upstream line 86.
- Engine failures (13.4): an exception from `writeData` / `endData` is caught by
  `SmartStream`, which destroys itself and calls the entry callback with the error. The
  `'error'` listener of `_smartStream` (`error = err`) therefore only ever records source
  stream errors, as upstream.
- For the AES engine nothing else changes in TypeScript. For ZipCrypto the `SmartStream`
  is also upstream's `bufferedData` (zip-crypto-stream.js:46-54, V16): it keeps what
  `writeData` produced, and in `_flush`, after `endData()` emitted the local header, it
  passes those chunks to `encryptData` and ends with `encryptEnd()`.
- `this._engine.entry` can throw only on programming errors (the guards ran in TypeScript
  first). If it does, or if `_engineEntry` rejects a name or comment (V16), `_appendBuffer`
  / `_appendStream` deliver the exception through the entry callback. The same holds for a
  `TypeError` from `_entryRandom()` (an invalid `zip20Header`, 7.9); the constructor check
  of `ZipCryptoStream` makes that unreachable unless the options object is mutated later.
- An exception from `validateZlibOptions` propagates out of `entry()` after the local
  header has been written and leaves `_archive.processing` true, exactly as ZIP-054
  describes for upstream.

`util.ts` is deps/compress-commons/lib/util/index.js literally (note: it wraps only streams
without `_readableState`, unlike `src/utils.ts`, ZIP-114). `index.ts` is the barrel.
`archive-entry.ts` is the four-empty-method class of archive-entry.js.

### 7.6 The recording entry and `ZipStream.entry` (units ts-zip-engine, ts-zip-stream)

The real `ZipArchiveEntry` lives in Rust. So that `src/zip-stream/index.ts` can stay a
literal port of deps/zip-stream/index.js:101-150, TypeScript has a class with the same name
whose setters only record their arguments; `ZipStream::entry` in Rust replays them in the
fixed upstream order (6.10). After the entry completes, the same object carries the result.

```ts
// src/compress-commons/zip-archive-entry.ts
function dateFields(d: Date, forceLocalTime?: boolean): DateFields;   // getter selection of zip/util.js:2-16; not exported

export default class ZipArchiveEntry extends ArchiveEntry {
  // recorded by ZipStream.entry
  name: string;
  date: DateFields;                 // set by setTime
  namePrependSlash = false;         // set by setName(name, true)
  store = false;                    // set by setMethod(0)
  comment = '';                     // set by setComment
  mode: number | undefined = undefined;   // set by setUnixMode
  // filled when the entry completes: a plain copy of every WasmZipEntryInfo getter (5.3)
  _info: ZipEntryInfo | null = null;

  constructor(name: string);
  setTime(time: Date, forceLocalTime?: boolean): void;   // throws Error('invalid entry time') unless time instanceof Date (:325-327)
  setName(name: string, prependSlash?: boolean): void;   // records name and prependSlash; sanitizing happens in Rust
  setMethod(method: number): void;                       // throws Error('invalid entry compression method') if method < 0 (:276-278); records store = (method === 0)
  setComment(comment: string): void;
  setUnixMode(mode: number): void;
  _setInfo(info: WasmZipEntryInfo | undefined): void;    // copies the getters into _info, then info.free() (5.4); undefined leaves _info null

  // upstream getter names, valid after completion (before completion they return the recorded value or 0 / '' / EMPTY):
  getName(): string; getSize(): number; getCompressedSize(): number; getCrc(): number;
  getMethod(): number; getTimeDos(): number; getExtra(): Buffer; getCentralDirectoryExtra(): Buffer;
  getLocalFileDataExtra(): Buffer; getComment(): string; getExternalAttributes(): number;
  getInternalAttributes(): number; getPlatform(): number; getUnixMode(): number;
  getVersionNeededToExtract(): number;
  getGeneralPurposeBit(): { usesDataDescriptor(): boolean; usesUTF8ForNames(): boolean; usesEncryption(): boolean; usesStrongEncryption(): boolean };
  isDirectory(): boolean; isUnixSymlink(): boolean; isZip64(): boolean;
  get _offsets(): { file: number; data: number; contents: number };
}
```

`ZipEntryInfo` is declared in the same file and not exported: `{ name: string; size: number; csize: number;
crc: number; method: number; time: number; minver: number; platform: number; exattr: number;
inattr: number; gpb: number; extra: Buffer; comment: string; offsetFile: number;
offsetData: number; offsetContents: number }`. `_setInfo` reads each getter of the wasm
snapshot exactly once (each getter call copies out of wasm memory), wraps `extra` with
`toBuffer`, stores the object and calls `info.free()`, so the snapshot never outlives the
call. The upstream-named getters read `_info`; no wasm object is reachable from a
`ZipArchiveEntry`.

`src/zip-stream/index.ts` (unit ts-zip-stream) is then deps/zip-stream/index.js statement by
statement, including the in-place mutation of `options` (23-47), the spread in
`_normalizeFileData` (57-67), the three callback errors (106-125), and lines 126-149 as
written upstream:

```ts
const entry = new ZipArchiveEntry(data.name);
entry.setTime(data.date, this.options.forceLocalTime);
if (data.namePrependSlash) { entry.setName(data.name, true); }
if (data.store) { entry.setMethod(0); }
if (data.comment.length > 0) { entry.setComment(data.comment); }
if (data.type === 'symlink' && typeof data.mode !== 'number') { data.mode = 40960; }
if (typeof data.mode === 'number') {
  if (data.type === 'symlink') { data.mode |= 40960; }
  entry.setUnixMode(data.mode);
}
if (data.type === 'symlink' && typeof data.linkname === 'string') { source = Buffer.from(data.linkname); }
return super.entry(entry, source, callback);
```

`src/zip-stream/utils.ts` is deps/zip-stream/utils.js literally (its own `dateify` and
`sanitizePath`; do not import the copies in `src/utils.ts`). `src/plugins/zip.ts` is
lib/plugins/zip.js literally plus `this.supports = { directory: true, symlink: true }` (V12);
`on`, `pipe`, `unpipe` forward with `apply(this.engine, arguments)`.

### 7.7 `src/zlib-options.ts` and `src/gzip.ts` (unit ts-helpers and ts-tar)

```ts
// src/zlib-options.ts
/** Throws exactly what Node throws for an invalid option bag, by constructing and closing
 *  the zlib object upstream would have constructed. No data is ever written to it. */
export function validateZlibOptions(kind: 'deflateRaw' | 'gzip', options: unknown): void;
//   'deflateRaw': zlib.createDeflateRaw(options as ZlibOptions).close()
//   'gzip':       zlib.createGzip(options as ZlibOptions).close()
/** options.level if it is a number and not NaN, else -1 (zlib default). */
export function resolveLevel(options: unknown): number {
  const level = (options as { level?: unknown } | null | undefined)?.level;
  return typeof level === 'number' && !Number.isNaN(level) ? level : -1;
}
/** options.strategy if it is a number and not NaN, else 0. */
export function resolveStrategy(options: unknown): number {
  const strategy = (options as { strategy?: unknown } | null | undefined)?.strategy;
  return typeof strategy === 'number' && !Number.isNaN(strategy) ? strategy : 0;
}
/** gzip header OS byte of Node's zlib on this platform (R14). */
export const GZIP_OS: number;   // process.platform === 'darwin' ? 19 : process.platform === 'win32' ? 10 : 3

// src/gzip.ts
export class Gzip extends Transform {            // node:stream; _transform -> WasmGzip.write per slice of MAX_CHUNK (5.4), _flush -> WasmGzip.finish,
  constructor(level: number, strategy: number);  //               _destroy -> WasmGzip.free (5.4 lifetime)
  _finished: boolean;                            // _finish(): WasmGzip.finish once, from the last _transform of an ended stream or from _flush (V3)
  _finish(): Buffer;
  _processCallback(out: Buffer[], callback: TransformCallback): void;  // setImmediate, then push each non-empty Buffer and callback() (V3)
}
/** Replacement for zlib.createGzip(options) (lib/plugins/tar.js:28): validates, then builds a Gzip. */
export function createGzip(options?: unknown): Gzip;
```

`zlib.createDeflateRaw(options)` is `new zlib.DeflateRaw(options)` at run time, the
constructor that upstream's `DeflateCRC32Stream` reaches through `super(options)`
(deflate-crc32-stream.js:4-6), and throws the same errors. The `new` spelling does not
type-check: `@types/node` 18.19 declares `DeflateRaw` and `Gzip` only as interfaces
(zlib.d.ts:156-160). The file imports `* as zlib from 'node:zlib'` and the type
`ZlibOptions`.

`resolveLevel` and `resolveStrategy` are called with whatever the caller put into the
option bag, including nothing: `createGzip(undefined)` is the default tar path, and
`gzipOptions: null` survives the `typeof options.gzipOptions !== "object"` test of
tar.js:22-24. `undefined`, `null` and a non-object all give the default, which is what Node
does with them (`zlib.createGzip(null)` and `zlib.createGzip(5)` compress at the default
level). These two functions have no upstream source, so the optional chaining is not a
departure from TS-09.

Where each validation happens: `validateZlibOptions('deflateRaw', this.options.zlib)` inside
`_smartStream` for deflated entries (7.5); `createGzip(options.gzipOptions)` in the `Tar`
constructor. The level passed to Rust is `resolveLevel(this.options.zlib)` for zip (7.5)
and `resolveLevel(options)` for gzip. `_defaults` guarantees that `zlib.level` is of type
number, but NaN is a number: upstream hands it to zlib, which treats it as the default
level (`new zlib.DeflateRaw({ level: NaN })._level` is -1; an archive made with
`zlib: { level: NaN }` is byte-identical to one made with level -1), while the bare wasm
`i32` conversion would turn NaN into 0 and silently switch compression off (ZIP-136).
`resolveLevel` returns -1 for NaN and every other number unchanged. A fractional level is
truncated toward zero on both sides (by the wasm `i32` conversion here, by the native
binding in Node: level 0.9 produces the output of level 0).

### 7.8 The tar engine: `src/tar-stream/pack.ts`, `src/plugins/tar.ts` (unit ts-tar)

`pack.ts` is deps/tar-stream/pack.js statement by statement on `streamx` `Readable` /
`Writable` (`import streamx from 'streamx'; const { Readable, Writable, getStreamError } = streamx;`
because streamx is a CommonJS package), with b4a calls
replaced by Buffer calls (`b4a.from(x)` is `Buffer.from(x)`, `b4a.isBuffer(x)` is
`Buffer.isBuffer(x) || x instanceof Uint8Array`, `b4a.concat` is `Buffer.concat`,
`b4a.toString(buf, 'utf-8')` is `Buffer.from(buf.buffer, buf.byteOffset, buf.byteLength).toString('utf-8')`).
Exactly four places differ from upstream because they produced bytes, and one hook is added
for the lifetime rule of 5.4:

```ts
class Pack extends Readable {
  constructor (opts) { super(opts); ...; this._wasm = new wasm.WasmPack() }   // :128-135

  _destroy (cb) { this._wasm.free(); cb() }         // added (upstream Pack has no _destroy): 5.4 lifetime

  finalize () {                                     // :172-183
    if (this._stream || this._pending.length > 0) { this._finalizing = true; return }
    if (this._finalized) return
    this._finalized = true
    this._wasm.finalize()                           // was: this.push(END_OF_TAR)
    this.push(toBuffer(this._wasm.takeOutput()))
    this.push(null)
  }

  _encode (header) {                                // :194-234 run in Rust (Pack::_encode, Pack::_encode_pax)
    const pax = header.pax
    if (pax) {
      for (const key in pax) this._wasm.paxRecord(' ' + key + '=' + pax[key] + '\n')   // headers.js:24-26
    }
    this._wasm.encode(                              // every string argument: 5.6
      wasmString(header.name), header.typeflag === 5, header.mode,
      '' + header.uid.toString(8), '' + header.gid.toString(8),         // concatenated like headers.js:244
      header.size, wasmString(header.size.toString(8)),
      header.mtime.getTime(),
      typeof header.type === 'string' ? header.type : '',
      header.linkname ? (pax ? '' + header.linkname : wasmString(header.linkname)) : undefined,   // with pax only concatenated, headers.js:21
      header.uname ? wasmString(header.uname) : undefined,
      header.gname ? wasmString(header.gname) : undefined,
      '' + (header.devmajor || 0).toString(8), '' + (header.devminor || 0).toString(8),
      !!pax)
    this.push(toBuffer(this._wasm.takeOutput()))
  }
  // _encodePax does not exist in TypeScript.
}

function overflow (self, size) {                    // :280-283
  self._wasm.overflow(size)                         // was: size &= 511; if (size) self.push(END_OF_TAR.subarray(0, 512 - size))
  const out = self._wasm.takeOutput()
  if (out.length > 0) self.push(toBuffer(out))
}
```

`Sink` (pack.js:12-125) is unchanged, including `this._pack.push(data)` for body bytes
(line 83: body bytes go straight to the readable side and never enter wasm), the
`'Size mismatch'` check with `!==` (line 102), `'No body allowed for this entry'`, the
link-name collection, and the header mutation `this.header.linkname = ...` (line 92).
`Pack.entry` (137-170) is unchanged, including the defaults written into the caller's
header object, except for the statement `if (sink._isVoid) { return sink }` (165-167),
which is not ported: the next statement is `return sink` in both cases.
`modeToType`, `noop`, `mapWritable`, `DMODE`, `FMODE` are unchanged. The constant
`END_OF_TAR` (pack.js:10) is not declared in TypeScript: both of its uses are the wasm
calls above, and the bytes are `END_OF_TAR` of `tar/pack.rs` (6.12).
`src/tar-stream/constants.ts` is one line, `export { constants as default } from 'node:fs'`.
The literal fallback object of constants.js:1-8 and the `|| constants` branch are not
ported (V21): `node:fs` always has `constants` on the supported Node versions.
`src/tar-stream/index.ts` exports `pack` and the type `Pack` (and nothing for `extract`,
N3). `Sink` and `Header` are not exported from `pack.ts`.

`src/plugins/tar.ts` is lib/plugins/tar.js statement by statement, with
`zlib.createGzip(options.gzipOptions)` replaced by `createGzip(options.gzipOptions)` from
`src/gzip.ts`, and `this.supports` added (V12). `on`, `pipe`, `unpipe` keep the
`apply(..., arguments)` form, so `unpipe` without a compressor still fails with the upstream
TypeError (P9). The streamx `Readable` type declares no `unpipe` member
(deps/streamx/index.d.ts:112-125); the call is written with the assertion pinned in TS-41,
not with an added `if`, so that the missing method still throws at run time.

### 7.9 Encrypted classes (unit ts-encrypted)

```ts
// src/callable.ts  (scaffold unit, verbatim)
/** Makes an ES class callable without `new` (upstream: `if (!(this instanceof X)) return new X(options)`). */
export function callable<A extends unknown[], T extends object>(
  cls: new (...args: A) => T,
): (new (...args: A) => T) & ((...args: A) => T) {
  const proxy = new Proxy(cls, {
    apply: (target, _thisArg, args) => new target(...(args as A)),
  }) as unknown as (new (...args: A) => T) & ((...args: A) => T);
  // class XImpl is published as X (7.9): X.name and instance.constructor are upstream's
  Object.defineProperty(cls, 'name', { value: cls.name.replace(/Impl$/, ''), configurable: true });
  Object.defineProperty(cls.prototype, 'constructor', { value: proxy, writable: true, configurable: true });
  return proxy;
}
```

Each upstream function constructor becomes `class XImpl ... ; export const X = callable(XImpl)`.
A statement that upstream runs before calling the parent constructor and that touches
`this` moves to directly after `super(...)`; statements that only touch `options` stay
before it.

- `ZipEncrypted` (lib/zip-encrypted.js:23-43) `extends Zip`. Order: password check and
  throw (24-26); `options.password = Buffer.from(options.password, 'utf-8')` when not a
  Buffer (27-29); archiver 7 defaults applied to the caller's object in place, each only
  when the key is `undefined`: `comment ''`, `forceUTC false`, `namePrependSlash false`,
  `store false` (archiver 7 lib/plugins/zip.js:26-31, lodash `defaults`); `super(options)`
  (35); `this.options = options`; the `switch` (37-41) assigning `this.engine`. The engine
  the parent constructor created is discarded, as upstream.
- `ZipAesStream` (lib/aes/zip-aes-stream.js:16-28) `extends ZipStream`: compute the key
  Buffer from `options.password` (Buffer, else `Buffer.from(password)`), `super(options)`,
  `this.key = key`. Overrides only the three hooks of 7.5: `_encryptionMethod()` returns 2,
  `_entryKey()` returns `this.key`, and
  `_entryRandom() { const salt = this.options.salt; return salt ? (Buffer.isBuffer(salt) ? salt : Buffer.from(salt)) : crypto.randomBytes(16); }`.
  The conversion is required: upstream hands a string salt to `pbkdf2Sync`, which accepts
  it (aes-hmac-etm-stream.js:37-42, 55), but a string at a `&[u8]` parameter would be
  coerced to wrong bytes without any error (5.6). The salt is not length-checked
  (ENCRYPTED-060). No other method exists on the class.
- `ZipCryptoStream` (lib/zip20/zip-crypto-stream.js:13-25) likewise: `_encryptionMethod()`
  returns 1, `_entryKey()` returns `this.key`, and
  `_entryRandom() { const h = checkHeader(this.options.zip20Header); return h ? h : crypto.randomBytes(12); }`
  where the module-level `checkHeader(h)` returns `undefined` for a falsy `h`, returns `h`
  when `Buffer.isBuffer(h) && h.length === 12`, and otherwise throws
  `new TypeError('zip20Header must be a Buffer of 12 bytes')` (V10). The constructor calls
  `checkHeader(options.zip20Header)` once, after the key computation and before
  `super(options)`, so that a wrong value fails where the engine is created and not in the
  middle of an entry. Written to directly, the class is the identity Transform it inherits
  (TESTS-082); such bytes count into `offset` (ZIP-135).
- `AesHmacEtmStream` (lib/aes/aes-hmac-etm-stream.js) `extends Transform` (node:stream),
  constructed with the whole options object (line 35): `this.salt = options.salt`, default
  `crypto.randomBytes(16)`; `this.key = this.deriveKey(this.salt, options.key)`;
  `this.passwordVerifier = this.key.passwordVerifier`; `this.headerSent`, `this.totalSize`
  mirror the wasm state after each call. The wasm object is created in the constructor with
  `new wasm.WasmAesHmacEtmStream(this.key.aesKey, this.key.hmacKey, this.key.passwordVerifier, saltBytes)`
  where `saltBytes` is `this.salt` if it is a Buffer and `Buffer.from(this.salt)` otherwise
  (`this.salt` itself keeps the caller's value, as upstream). `deriveKey(salt, key)` returns
  `{ aesKey, hmacKey, passwordVerifier }` as three Buffers sliced from
  `WasmAesHmacEtmStream.deriveKey(salt, key)` at 0..32, 32..64, 64..66 (a string `key` or
  `salt` is first converted with `Buffer.from(x)`, which is what `pbkdf2Sync` does; a
  TypedArray that is not a `Uint8Array`, or a `DataView`, is first re-viewed as its bytes
  with `Buffer.from(x.buffer, x.byteOffset, x.byteLength)`, because the glue would copy it
  element by element or as nothing (5.6); a value that is neither a string nor a
  Buffer/TypedArray/DataView throws a `TypeError`, as upstream). `_transform` and
  `_flush` call the wasm `transform` (once per slice of `MAX_CHUNK`, 5.4) / `flush` and push
  each non-empty result as a Buffer. `getTotalSize()` returns `this.totalSize`
  (aes-hmac-etm-stream.js:63-65), the mirrored field, so it still answers after the stream
  was destroyed and its wasm object freed (5.4). (Upstream pushes salt and verifier as two
  chunks; archiver-wasm pushes them together with the first ciphertext, V4.)
- `CryptoStream` (lib/zip20/crypto-stream.js:13-24), constructor in upstream order:
  `this.key = options.key; this.crc = options.crc; this.cipher = new CryptoCipher(this.key)`
  (a TypeScript `CryptoCipher`, so that an invalid key throws there, as upstream, and so
  that `this.cipher.key` is the key as a Buffer); `this.headerSent = false`; then the
  addition `this.header = options.header`, which must be `undefined` or a Buffer of exactly
  12 bytes, else `throw new TypeError('header must be a Buffer of 12 bytes')` (V10). The
  wasm `WasmCryptoStream` is created inside the first `_transform` with
  `(this.cipher.key, this.crc.readUInt16BE(0), this.header || crypto.randomBytes(12))`, so a
  missing or short `crc` throws where upstream throws (crypto-stream.js:34). Data is passed
  in slices of `MAX_CHUNK`; a zero-length result is not pushed.
- `DecryptoStream` (lib/zip20/decrypto-stream.js:12-25), constructor in upstream order:
  `this.key = options.key; this.crc = options.crc; this.cipher = new CryptoCipher(this.key)`
  (decrypto-stream.js:18-20); `this.header = Buffer.alloc(0)`, `this.headerProcessed = false`,
  `this.totalSize = 0`. The wasm object is `new wasm.WasmDecryptoStream(this.cipher.key)`:
  the Buffer, never `options.key`, which the unmodified test passes as the string `'123'`
  (archiver-zip-encrypted/test/crypto-stream.js:10-11) and which the glue would turn into
  the bytes `01 02 03` (5.6). `_transform` passes slices of `MAX_CHUNK` and sets
  `this.totalSize` from the wasm `getTotalSize()` after each call; `getTotalSize()` returns
  `this.totalSize` (decrypto-stream.js:29-31). `this.header` and `this.headerProcessed`
  keep their initial values: the header state lives in Rust.
- `CryptoCipher` (lib/zip20/CryptoCipher.js): plain class; constructor sets `this.key` to the
  key, converted with `Buffer.from(key)` when it is not a Buffer (CryptoCipher.js:15-18),
  and creates `new wasm.WasmCryptoCipher(this.key)`; `encrypt(data)` / `decrypt(data)`
  return Buffers from `WasmCryptoCipher` (slices of `MAX_CHUNK`, results joined with
  `Buffer.concat` when there is more than one). Data must be a Buffer (ENCRYPTED-107).

Every one of these classes converts or rejects before the wasm call; none passes an option
value straight to a `&[u8]` parameter (5.6, V14). The three Transform shells free their
wasm object in `_destroy` (5.4); `CryptoCipher` has no end of life and is left to the
`FinalizationRegistry`.

### 7.10 `src/plugins/json.ts` (unit ts-entry)

lib/plugins/json.js statement by statement on `node:stream` Transform, with one changed
statement: `data.crc32 = crc32.unsigned(sourceBuffer)` becomes the sliced form of 5.4,

```ts
var crc = 0;
for (var i = 0; i < sourceBuffer.length; i += MAX_CHUNK) {
  crc = wasm.jsonAppend(crc, sourceBuffer.subarray(i, i + MAX_CHUNK));
}
data.crc32 = crc;
```

(0 for an empty buffer, as `crc32.unsigned` gives). `data.crc32 = 0` first (line 53), then
`data.size = sourceBuffer.length || 0` (59), then the CRC (60), then `files.push(data)`,
then the callback: the key insertion order is observable (TAR-JSON-110/117).
`_writeStringified` stays `JSON.stringify(this.files)` (R4). `this.supports` added (V12).

---

## 8. JavaScript to Rust pattern table

Each row: the JS pattern, one upstream example, and the Rust shape to write. When a pattern
is not listed, stop and add it here (M8).

**RS-01 Class with instance state.** `class X { constructor() { this.a = 0 } m() {} }` becomes
`pub struct X { pub a: T }` with `impl X { pub fn new() -> Self; pub fn m(&mut self) }`. Field
and method names are the snake_case of the upstream names, leading underscore kept.

```js
this._archive.centralOffset = this.offset;                 // zip-archive-output-stream.js:112
```
```rust
self._archive.central_offset = self.offset;
```

**RS-02 Inheritance, overriding, parent calls.** One struct, a dispatcher per overridable
method, `base_*` and per-subclass bodies (6.9). Never a trait object.

```js
ZipAesStream.prototype._writeLocalFileHeader = function (ae) {      // zip-aes-stream.js:42-52
    let gpb = ae.getGeneralPurposeBit();
    gpb.useEncryption(true);
    ae.setExtra(Buffer.concat([ae.getExtra(), _buildAesExtraField(ae)]));
    ae.setMethod(ZIP_AES_METHOD);
    ae.setVersionNeededToExtract(51);
    ZipStream.prototype._writeLocalFileHeader.call(this, ae);
};
```
```rust
pub(crate) fn aes_write_local_file_header(&mut self, ae: &mut ZipArchiveEntry) {
    ae.get_general_purpose_bit_mut().use_encryption(true);
    let mut extra = ae.get_extra().to_vec();
    extra.extend_from_slice(&_build_aes_extra_field(ae));
    ae.set_extra(extra);
    ae.set_method(ZIP_AES_METHOD as u16);
    ae.set_version_needed_to_extract(51);
    self.base_write_local_file_header(ae);
}
```

**RS-03 Transform stream that observes or transforms data.** A struct with
`_transform(&mut self, chunk: &[u8], out: &mut Vec<u8>)` and, if upstream has `_flush`,
`_flush(&mut self, out: &mut Vec<u8>)`. `this.push(x)` is `out.extend_from_slice(x)`.
`callback(null, chunk)` (pass through) is `out.extend_from_slice(chunk)`.

```js
_transform(chunk, encoding, callback) {                    // crc32-stream.js:11-17
  if (chunk) { this.checksum = crc32.buf(chunk, this.checksum) >>> 0; this.rawSize += chunk.length; }
  callback(null, chunk);
}
```
```rust
pub fn _transform(&mut self, chunk: &[u8], out: &mut Vec<u8>) {
    self.checksum = crc32::buf(chunk, self.checksum);
    self.raw_size += chunk.len() as u64;
    out.extend_from_slice(chunk);
}
```

**RS-04 Subclass of a native Node class that instruments it** (`DeflateCRC32Stream extends
zlib.DeflateRaw`, overriding `push` and `_transform`, deflate-crc32-stream.js:12-24). A struct
that owns a `flate2::Compress` (raw) and counts every byte it appends to `out` in
`compressed_size`, including the bytes produced by the final flush.

**RS-05 Pipe chains and `once('end')` handlers.** `a.pipe(b).pipe(this, {end: false})` plus an
end handler becomes three sans-IO steps: build (`_smart_stream`), feed (`write_data`: output
of `a` is the input of `b`, output of `b` goes to `self.write`), finish (`end_data`: flush `a`,
feed and flush `b`, then run the body of the end handler). A stage is only invoked with a
non-empty chunk, because a stream does not emit empty chunks (6.9).

**RS-06 Node-style callbacks.** Rust has none. `callback(null, ae)` is `Ok(...)`,
`callback(new Error(m))` is `Err(...)`. Whether the JS callback runs synchronously or later
is decided in TypeScript (7.5).

**RS-07 Errors.** `callback(new Error('unacceptable entry after finish'))` and
`throw new Error(...)` both become `return Err(ZipError::Variant)` whose `Display` is the
upstream string (6.2). The channel is restored in TypeScript (13).

**RS-08 Shared mutable entry object with properties added later.** `ae` is an owned
`ZipArchiveEntry` moved into the writer, taken out of `self._entry` for the duration of a
step and put back (6.8). Ad hoc properties are declared fields (`ae._offsets = {...}` at
zip-archive-output-stream.js:140 is `ae._offsets = Offsets::default()`).

**RS-09 Sentinels.** `-1` and `null` become `Option`, and the getter reproduces the fallback.

```js
getTimeDos() { return this.time !== -1 ? this.time : 0; }      // zip-archive-entry.js:181-183
if (ae.getMethod() === -1) { ae.setMethod(METHOD_DEFLATED); }  // zip-archive-output-stream.js:130-132
```
```rust
pub fn get_time_dos(&self) -> u32 { self.time.unwrap_or(0) }
if ae.get_method() == -1 { ae.set_method(METHOD_DEFLATED as u16); }
```
The compression method is the one quantity with two types (10.1): `get_method()` returns
`i32` so that `-1` exists, the method constants (`METHOD_STORED`, `METHOD_DEFLATED`,
`ZIP_AES_METHOD`) are `i32` so that they compare with the getter without a cast, and
`set_method` takes `u16`, so a constant is passed as `METHOD_DEFLATED as u16`.

**RS-10 Many tiny `this.write(...)` calls.** One Rust line per upstream line.

```js
this.write(getLongBytes(SIG_LFH));                              // zip-archive-output-stream.js:325-330
this.write(getShortBytes(ae.getVersionNeededToExtract()));
this.write(gpb.encode());
this.write(getShortBytes(method));
```
```rust
self.write(&get_long_bytes(SIG_LFH as u64));
self.write(&get_short_bytes(ae.get_version_needed_to_extract() as u64));
self.write(&ae.get_general_purpose_bit().encode());
self.write(&get_short_bytes(method as u16 as u64));
```

**RS-11 Fixed-layout Buffer building.** `Buffer.alloc(n)` plus `writeUInt16LE` / `writeInt8`
becomes a `[u8; N]` filled with `to_le_bytes`; `Buffer.concat([a, b])` becomes
`extend_from_slice` in the same order.

```js
let buffer = Buffer.alloc(11);                                  // zip-aes-stream.js:30-40
buffer.writeUInt16LE(0x9901, 0); buffer.writeUInt16LE(0x7, 2); buffer.writeUInt16LE(0x1, 4);
buffer.writeUInt16LE(0x4541, 6); buffer.writeInt8(0x3, 8); buffer.writeUInt16LE(ae.getMethod(), 9);
```
```rust
let mut buffer = [0u8; 11];
buffer[0..2].copy_from_slice(&0x9901u16.to_le_bytes());
buffer[2..4].copy_from_slice(&0x7u16.to_le_bytes());
buffer[4..6].copy_from_slice(&0x1u16.to_le_bytes());
buffer[6..8].copy_from_slice(&0x4541u16.to_le_bytes());
buffer[8] = 0x3;
buffer[9..11].copy_from_slice(&(ae.get_method() as u16).to_le_bytes());
```

**RS-12 32-bit coercion idioms.** See section 10.1. `x >>> 0` on a value that is already a
`u32` is nothing; `(v & 0xffffffff) >>> 0` is `v as u32`; `(v & 0xffff) >>> 0` is `v as u16`;
`n | 0` on a double is `numeric::to_int32(n)`.

**RS-13 Signed results of bitwise operators.** Do the arithmetic in `i32` exactly as JS does,
convert once.

```js
extattr |= (mode << SHORT_SHIFT) | (this.isDirectory() ? S_DOS_D : S_DOS_A);   // zip-archive-entry.js:338
this.setExternalAttributes(extattr);                                             // >>> 0 inside
```
```rust
extattr |= (mode << SHORT_SHIFT) | (if self.is_directory() { S_DOS_D } else { S_DOS_A });
self.set_external_attributes(extattr as u32);
```

**RS-14 `Math.imul`, `& 0xFFFFFFFF`, `>>>`.** `u32` with explicit wrapping operations.

```js
this.key1 = _uint32(this.key1 + (this.key0 & 0xFF));            // CryptoCipher.js:35-37
this.key1 = _uint32(Math.imul(this.key1, 134775813) + 1);
this.key2 = crc32(this.key2, this.key1 >>> 24);
```
```rust
self.key1 = self.key1.wrapping_add(self.key0 & 0xFF);
self.key1 = self.key1.wrapping_mul(134775813).wrapping_add(1);
self.key2 = crc32(self.key2, (self.key1 >> 24) as u8);
```

**RS-15 `|` used as float truncation and NaN-to-zero.** Each operand goes through
`to_int32` (10.5): `(val.seconds / 2)` inside the `|` chain of zip/util.js:17-24 is
`to_int32(d.seconds / 2.0)`.

**RS-16 Mixed-endian Buffer access.**

```js
header.writeUInt16LE(this.crc.readUInt16BE(0), HEADER_LENGTH - 2);   // crypto-stream.js:34
```
```rust
header[HEADER_LENGTH - 2..].copy_from_slice(&self.crc.to_le_bytes());   // self.crc: u16 = crc bytes 0..2 read big-endian
```
Result: `header[10]` is CRC bits 16..23, `header[11]` is CRC bits 24..31 (ENCRYPTED-028).

**RS-17 Slices with computed or negative indexes.** Compute the start explicitly; prove it
is in range or use `get(..)`.

```js
data = data.slice(HEADER_LENGTH - this.header.length);          // decrypto-stream.js:41 (a negative index)
```
```rust
let keep = self.header.len() - HEADER_LENGTH;                   // > 0 on this branch
let data = &data[data.len() - keep..];                          // keep <= data.len(): header grew by data.len() in this call
```

**RS-18 String length versus byte length.** `Buffer.byteLength(s) !== s.length` is
`!s.is_ascii()`. A length that is written into the archive is always the UTF-8 byte length
(`s.len()`); upstream's `name.length` on a string is only used when the string is ASCII
(zip-archive-output-stream.js:320-322, 345). `s.length` used for a comparison only
(headers.js:244) is `numeric::utf16_len(s)`.

**RS-19 Regex-based sanitizing.** Hand-written, no `regex` crate. `/^\w+:/` is "one or more
of `[A-Za-z0-9_]` then `:`" at the start, removed once; `/^(\.\.\/|\/)+/` is "any leading mix
of `../` and `/`", removed once. Applied in this order, exactly once per call
(zip-archive-entry.js:288-290). The function is not idempotent; do not loop.

**RS-20 `Buffer.write(string, offset)`.** `numeric::write_at(&mut buf, s, offset)`; never
`copy_from_slice` with an unchecked length (tar `uname` / `gname`, headers.js:82-83).

**RS-21 `return null` meaning "not representable".** `Option`, not an error.

```js
if (b4a.byteLength(name) !== name.length) return null // utf-8   // headers.js:57
```
```rust
if !name.is_ascii() { return None; }
```

**RS-22 String-keyed switch with a default arm.** `match s { "file" => 0, ..., _ => 0 }`
(headers.js:203-226). Do not turn the input into an enum that rejects unknown strings.

**RS-23 Radix conversion.** Values upstream formats with `toString(8)` either arrive as
strings (computed in TypeScript, 10.4) or are integers formatted with
`numeric::i64_to_string_radix8`. Never `format!("{:o}", x)` on a signed integer.

**RS-24 Floating-point math for an integer question.** `Math.floor(Math.log(len) / Math.log(10)) + 1`
(headers.js:318) is a decimal digit count computed with integers (11.6).

**RS-25 Large integers held in doubles.** `u64` for sizes and offsets inside Rust; where
upstream does double arithmetic on a value that TypeScript passed as `f64` (tar size,
headers.js:248-254), keep `f64` and port the arithmetic literally:
`buf[off + i] = (to_int32(num) & 0xff) as u8; num = (num / 256.0).floor();`.

**RS-26 Dates.** Rust never sees a `Date`, the clock or a time zone. It receives
`DateFields` (zip) or milliseconds as `f64` (tar).

**RS-27 State flags on a shared object.** `this._archive.processing` is
`self._archive.processing`; same names, same transitions, same order.

**RS-28 Buffering chunks in an array, then a promise chain of writes**
(zip-crypto-stream.js:46-73). One `Vec<u8>` and one call.

**RS-29 Global monkey patch changing a cipher** (aes-hmac-etm-stream.js:16-25).
`ctr::Ctr128LE<aes::Aes256>`; no global state.

**RS-30 Node crypto.** `crypto.pbkdf2Sync(key, salt, 1000, 66, 'sha1')` is
`pbkdf2::pbkdf2_hmac::<sha1::Sha1>(key, salt, 1000, &mut out66)`;
`crypto.createHmac('sha1', k)` is `Hmac::<Sha1>::new_from_slice(k)`;
`hmac.digest().slice(0, 10)` is the first 10 bytes of `finalize().into_bytes()`.
`crypto.randomBytes` has no Rust counterpart: random bytes are parameters.

**RS-31 State read back from serialized bytes.** Literal, bounds-checked (R10):

```js
var deflate = ae.getExtra().readInt16LE(9) > 0;                 // zip-aes-stream.js:160
```
```rust
let extra = ae.get_extra();
let deflate = match extra.get(9..11) {
    Some(b) => i16::from_le_bytes([b[0], b[1]]) > 0,
    None => return Err(ZipError::ExtraTooShort),
};
```

**RS-32 Dead exports and unused constants.** A constant that the package uses is ported
with its name. Constants, functions, methods and fields that nothing in the package calls
or reads are not ported, and each one is listed in 3.4 or in V21 (3.2). Nothing is silently
dropped and nothing is "fixed".

**RS-33 Comparisons against `ZIP64_MAGIC`.** `u64`, strict `>` exactly where upstream has `>`
(`0xFFFFFFFF` itself is not zip64, ZIP-092/093).

**RS-34 Truthiness of optional strings.** `if (opts.uname) ...` is
`if let Some(uname) = truthy_str(&opts.uname) { ... }`.

**RS-35 Iterating bytes.** `for (let b of data)` over a Buffer is `for &b in data`.

**RS-36 Iterating a collection while mutating elements and `self`.**
`this._entries.forEach(function (ae) { this._writeCentralFileHeader(ae) }.bind(this))`
(zip-archive-output-stream.js:113-117) uses the `std::mem::take` pattern of 6.8. Never clone
the entries, never reorder, never key by name (ZIP-126).

**RS-37 Getter results held across a mutation of the same object.** JS keeps `gpb`, `name`
and `extra` in locals and then mutates `ae` (zip-archive-output-stream.js:312-323:
`ae.setVersionNeededToExtract(...)`, `ae._offsets.file = this.offset`). In Rust a borrowed
getter result cannot live across the `&mut` call. Copy what is needed first, keep the
upstream statement order, and re-read through the getter where upstream reads a live
object (`gpb`):

```rust
let method = ae.get_method();
let name = ae.get_name().unwrap_or("").to_owned();
let extra = ae.get_local_file_data_extra().to_vec();
if ae.is_zip64() {
    ae.get_general_purpose_bit_mut().use_data_descriptor(true);
    ae.set_version_needed_to_extract(MIN_VERSION_ZIP64);
}
ae._offsets.file = self.offset;
```

**RS-38 Widen before arithmetic on a narrow field.** The pinned field types are as narrow as
the stored value (`platform: u8`, `minver: u16`). JS computes on int32, so every shift or
sum is done after a cast to the width of the result:

```js
this.write(getShortBytes((ae.getPlatform() << 8) | VERSION_MADEBY));   // zip-archive-output-stream.js:254
```
```rust
self.write(&get_short_bytes((((ae.get_platform() as u16) << 8) | VERSION_MADEBY) as u64));
```
`ae.get_platform() << 8` on the `u8` is a compile error (deny-by-default overflow lint).

**RS-39 Ternaries inside a bitwise chain.** One parenthesized `if` / `else` per ternary, in
upstream's order, on the type of the flag constants, with one cast at the end.

```js
return getShortBytes(                                            // general-purpose-bit.js:21-26
  (this.descriptor ? DATA_DESCRIPTOR_FLAG : 0) |
    (this.utf8 ? UFT8_NAMES_FLAG : 0) |
    (this.encryption ? ENCRYPTION_FLAG : 0) |
    (this.strongEncryption ? STRONG_ENCRYPTION_FLAG : 0),
);
```
```rust
get_short_bytes(
    ((if self.descriptor { DATA_DESCRIPTOR_FLAG } else { 0 })
        | (if self.utf8 { UFT8_NAMES_FLAG } else { 0 })
        | (if self.encryption { ENCRYPTION_FLAG } else { 0 })) as u64,
)
```
The fourth operand has no arm: `strongEncryption` is not ported, because nothing in the
package sets it (V21, 6.6), and upstream's operand is then always 0.
`cargo fmt` spreads an arm that exceeds its single-line width over five lines. That layout
is accepted (12.3). Do not shorten the arms with locals, with `u16::from(b) * FLAG` or with
a helper: the chain stays one expression. The file-private flag constants keep their
upstream spelling and get the type of the chain: `const ENCRYPTION_FLAG: u16 = 1 << 0;`.

**RS-40 A lint that fires on the upstream spelling.** The gate is
`cargo clippy --workspace -- -D warnings` (section 16), and a mechanical port keeps
spellings that clippy would write differently. The expression stays as upstream has it.

- If the lint is in the `[workspace.lints.clippy]` list of 15.1, there is nothing to do.
  The list holds `needless_range_loop`: a counting loop that indexes is ported as one
  (`for (let i = 0; i < 148; i++) sum += block[i]`, headers.js:237, is
  `for i in 0..148 { sum += block[i] as u32; }`).
- If it is not, the lint is added to that list first, with the upstream line that needs it
  (M8). It is not silenced with an item-level `#[allow(...)]`, and the expression is not
  rewritten. The only item-level attributes are the ones this guide prints
  (`#[allow(clippy::too_many_arguments)]` in 5.3).
- No attribute is added on suspicion. A unit cannot run clippy before the crate compiles
  (M1), so lints are settled in compile-fix stage (a) (2.1), by this rule. `1 << 0`
  (general-purpose-bit.js:4) needs nothing: `clippy::identity_op` exempts exactly that
  spelling, while `2 << 0` and `x | 0` would be reported.
- `dead_code` and `unused` are never allowed (section 16 item 2). An upstream constant that
  nothing reads is not ported (6.5, V21); a parameter that the body does not read gets a
  leading underscore (section 6 rules); a private function that nothing calls is a porting
  error.

---

## 9. JavaScript to TypeScript pattern table

The TypeScript layer is a transliteration: add types, change nothing else.

**TS-01 Node-style callbacks.** Keep the signature, the arity at each call site
(`callback(err)` versus `callback(err, data)`) and whether the call is synchronous.

```js
self.engine.entry(data, sourceBuffer, function (err) { callback(err, data); });   // plugins/tar.js:58-60
```
```ts
self.engine.entry(data, sourceBuffer, function (err?: Error | null) { callback(err, data); });
```

**TS-02 Deferral primitives.** `setImmediate(callback)` (core.js:180, 208, 396, 406, 416),
`setTimeout(() => this._next())` (readdir-glob index.ts:271), `queueMicrotask` (queue) are
copied one to one. Never replace one with another, never `await`.

**TS-03 `async.queue`.** `import { queue } from './queue.js'`; call sites unchanged
(core.js:47-53).

**TS-04 Stream subclasses.** `class Archiver extends Transform` with `_transform(chunk,
encoding, callback)`, `this._module.pipe(this)`, `this.end()` unchanged; the base class comes
from `node:stream` (R1). Where upstream's base is not a snapshot of the Node streams
(lazystream on readable-stream 2), the constructor options of V9 are part of the port
(11.12).

**TS-05 Subclass constructors that assign base fields after `super()` and then call a base
method** (index.js:8-17). Same shape. Fields are declared on `Archiver` only.

**TS-06 Function-constructor error type.**

```js
function ArchiverError(code, data) {                             // lib/error.js:28-35
  Error.captureStackTrace(this, this.constructor);
  this.message = ERROR_CODES[code] || code;
  this.code = code;
  this.data = data;
}
util.inherits(ArchiverError, Error);
```
```ts
export const ArchiverError = function ArchiverError(this: ArchiverError, code: string, data?: unknown) {
  Error.captureStackTrace(this, this.constructor);
  this.message = ERROR_CODES[code] || code;
  this.code = code;
  this.data = data;
} as unknown as { new (code: string, data?: unknown): ArchiverError; prototype: ArchiverError };
util.inherits(ArchiverError, Error);
```

**TS-07 Error channels.** `this.emit('error', new ArchiverError(code)); return this;` stays
an emit (never `destroy(err)`, never `throw`). A `throw` stays a throw. `Promise.reject`
stays only in `finalize()` (core.js:711-720). Section 13 lists every site.

**TS-08 Option bags.** Spread with defaults first is kept literally; in-place mutation of the
caller's object is kept; `!!x` coercions are kept.

```js
options = { highWaterMark: 1024 * 1024, statConcurrency: 4, ...options };   // core.js:32-36
```
```ts
options = { highWaterMark: 1024 * 1024, statConcurrency: 4, ...options };
```
Not `options.statConcurrency ?? 4`: an explicit `undefined` must override the default.

**TS-09 Truthiness and strict sentinel checks.** Copy the operator. `=== false`, `=== null`,
`typeof x === 'number'`, `!data.name`, `options.cwd || '.'` are not interchangeable with
`==`, `??`, `?.` (core.js:92, 267, 285, 291, 301, 304, 694).

**TS-10 Bitwise masks on modes.** Stay in TypeScript on `number` (`data.mode &= 4095`,
core.js:285-296). The result is a small non-negative integer by the time it reaches wasm.

**TS-11 Counters.** `_pointer`, `_fsEntriesTotalBytes` and friends are `number`. No BigInt.

**TS-12 Dates.** `dateify` is copied (numbers become "now", P7). `Date` objects stay on the
entry data and in emitted payloads. Conversion to numbers happens only in the statement
that calls wasm (`dateFields(...)`, `header.mtime.getTime()`).

**TS-13 Buffers.** `Buffer.alloc(0)`, `Buffer.from(string)`, `Buffer.concat([])`,
`Buffer.isBuffer` are kept. A plain `Uint8Array` is not accepted where upstream uses
`Buffer.isBuffer` (ARCHIVER-CORE-019). wasm output is wrapped with `toBuffer` (5.4).

**TS-14 Duck-typed stream detection and the eager PassThrough.** `isStream` from
`src/is-stream.ts`; `return source.pipe(new PassThrough());` (utils.js:52) unchanged. Never
`instanceof Readable`, never `stream.pipeline`.

**TS-15 Regexes.** `sanitizePath` and `normalizePath` keep their regexes character for
character (utils.js:58-62). No `path.normalize`, no `path.posix`.

**TS-16 Local handler functions bound with `.bind(this)` that close over a later `const`**
(core.js:596-635, 679-697). Keep the declaration order (handlers, then
`const globber = ...`, then `on('error')`, `on('match')`, `on('end')` in that order) and
`.bind(this)`. Annotate `this: Archiver` on the function declarations.

**TS-17 Event-driven flow control.** `globber.pause()` on every match and
`entryData.callback = globber.resume.bind(globber)` stay; the continuation lives on the data
object so that a data function replacing the object loses it exactly like upstream
(GLOB-FS-116). Do not move it into a closure or a WeakMap.

**TS-18 Platform constant.** `const win32 = process.platform === "win32";` at module level
(core.js:20).

**TS-19 fs calls.** Callback `lstat`, `readlinkSync`, `createReadStream`, callback
`fs.readdir`/`fs.stat` wrapped in hand-rolled promises with the same `switch (err.code)`
arms (readdir-glob index.ts:6-59). Not `fs.promises`.

**TS-20 Recursive async generator pumped manually.** `iterator.next().then(...).catch(...)`
in `_next` stays (index.ts:285-319). Not `for await`: the `.catch` must also catch exceptions
thrown by `'match'` listeners (GLOB-FS-041).

**TS-21 EventEmitter state machines.** `paused`, `aborted`, `inactive` booleans with the same
visibility; `ReaddirGlob extends EventEmitter`.

**TS-22 Argument overloading by `typeof`.** Union parameter types plus the same runtime
ladder (`destpath === false`, `typeof destpath !== 'string'`, `typeof data === 'function'`,
core.js:580-591; `typeof buffer === 'function'`, pack.js:140-143).

**TS-23 `throw` inside `try` used to funnel into an emit** (core.js:611-625). Keep the
`try`/`catch`/`throw new ArchiverError('DIRECTORYFUNCTIONINVALIDDATA', ...)` shape so both
paths skip the resume.

**TS-24 Instance method patched over the prototype method** (lazystream.js:15-21). Keep it
(7.4); do not replace it with a boolean flag.

**TS-25 Mutation versus copy of caller objects.** `_append` mutates the caller's `data`
(core.js:87-96); `glob`/`directory` copy with `Object.assign({}, data)`; `append` builds a new
object through spread. Keep each as is. Do not add `Readonly<>`.

**TS-26 Default-export factory with a class attached** (readdir-glob index.ts:338-348,
archiver 7 index.js). A function with properties, typed by an interface with a call
signature.

**TS-27 Proxy methods using `apply(target, arguments)`** (plugins/zip.js:57-71,
plugins/tar.js:87-117). Keep `function` methods with `arguments` and `apply`, including the
return value (the engine or the destination, not `this`).

**TS-28 streamx classes** with `_open`, `_write`, `_final`, `_predestroy`, `_destroy`,
`eagerOpen`, `mapWritable`, and `push()` returning a backpressure flag (pack.js:12-125).
Extend the streamx classes; do not re-implement the hooks on Node streams (R2).

**TS-29 Truthiness-based defaults written into the caller's object** (pack.js:147-152).
Same statements, same order; the mutated object is what `'entry'` later emits
(TAR-JSON-030).

**TS-30 `for...in` and implicit string conversion.** Performed in TypeScript, result passed
to Rust (7.8). Rust never iterates a map for output order. A value that reaches a string
parameter of a wasm call and is not a string by construction goes through `wasmString`
(5.6).

**TS-31 Accumulating a stream into a Buffer** (`collectStream`, utils.js:5-27). Same three
listeners, never removed, `Buffer.alloc(size)` plus `copy`.

**TS-32 zlib objects built from option bags.** `createGzip` / `validateZlibOptions` (7.7).

**TS-33 Constructors callable without `new`, and `this.x = ...` before the parent
constructor.** `callable()` and the ordering rule of 7.9.

**TS-34 Synchronous plain `Error` thrown from a constructor** (zip-encrypted.js:24-26, 40).
Same `throw new Error(text)`; not an `ArchiverError`, not an emit.

**TS-35 Transform shells over wasm encoders.** `_transform(data, encoding, cb)` calls the
wasm method once per slice of at most `MAX_CHUNK` bytes (5.4), pushes each non-empty result
as a Buffer, then `cb()`; `_flush` likewise with one call. `Gzip` makes the wasm calls synchronously
and defers the pushes and `cb()` with `setImmediate` (V3). Lazy header emission, counters
and MAC state live in Rust; counters that upstream exposes (`totalSize`, `headerSent`) are
mirrored into fields after each call. `_destroy(err, cb)` frees the wasm object (5.4).

**TS-36 Pipelines with `once('end')` / `once('error')`.** `SmartStream` (7.5); the listener
wiring of zip-archive-output-stream.js:161-165 and 104-108 is kept line for line.

**TS-37 Arbitrary user keys on entry data.** `EntryData` has an index signature; objects are
never rebuilt from a whitelist; `JSON.stringify(this.files)` serializes the live objects
(json.js:40).

**TS-38 Template-method hooks.** The scaffold hooks of `ArchiveOutputStream` stay; the
encrypted subclasses override only `_encryptionMethod`, `_entryKey`, `_entryRandom` (7.5).

**TS-39 Runtime type switches on inputs** (`Buffer.isBuffer(source)`, `isStream(source)`,
`source === null`, `typeof callback !== 'function'`). Kept verbatim in front of every wasm
call; wasm only ever receives the narrowed value.

**TS-40 Module-format assumptions of the tests.** Solved by shims next to the vendored
tests and by the CommonJS entry `src/commonjs.ts` (14.1, 15.4), never by editing tests.

**TS-41 Type assertions for dynamically typed upstream expressions.** `"strict": true` rejects
several patterns this guide tells you to keep. The only allowed way out is `as T` or
`as unknown as T` on the single expression concerned. Never `any`, never `@ts-ignore` /
`@ts-expect-error`, never an added narrowing branch (an `if` that upstream does not have
changes behavior, for example it would turn the TypeError of P9 into a silent no-op).
Pinned spellings:

```ts
// TS-27, proxy methods (plugins/zip.js:57-71, plugins/tar.js:87-117): `arguments` is not an array type
on() { return this.engine.on.apply(this.engine, arguments as unknown as Parameters<ZipStream['on']>); }
// (the tar plugin uses the class of the object it forwards to: Parameters<Pack['on']>, Parameters<Gzip['pipe']>, ...)

// P9, Tar.unpipe without a compressor: streamx's Readable type has no `unpipe`; the call must still be made and throw
return (this.engine as unknown as { unpipe: (...a: unknown[]) => unknown }).unpipe.apply(this.engine, arguments as unknown as unknown[]);

// TS-24, lazystream (lazystream.js:16-19): deleting an own property that shadows a required method, and
// `arguments` at an apply; upstream's computed access stays, `method` is typed as the literal '_read' (7.4)
delete (instance as { _read?: unknown })[method];
callback.apply(this, arguments as unknown as Parameters<Readable['_read']>);

// the `false` sentinel of Archiver._module (core.js:40): every call site, no `if (this._module)`
(this._module as ArchiverModule).append(source, data, ...);
(this._module as ArchiverModule).pipe(this);

// values coming out of nodeRequire (15.3)
export const wasm = nodeRequire('./wasm/archiver_wasm.cjs') as ArchiverWasm;

// a bag typed `unknown` that is handed to a Node API (7.7)
zlib.createDeflateRaw(options as ZlibOptions).close();

// one property read from a value typed `unknown` (7.7; the assertion names only that property)
const level = (options as { level?: unknown } | null | undefined)?.level;

// a parameter typed `unknown` that upstream reassigns and returns (utils.js:29-41, zip-stream/utils.js:3-15)
return dateish as Date;

// isStream() narrows to ReadableStream | WritableStream, and a WritableStream has no `pipe`
// (utils.js:52; compress-commons util/index.js:12 is the same with `source.pipe(normalized)`)
return (source as NodeJS.ReadableStream).pipe(new PassThrough());

// duck typing on `unknown` (is-stream/index.js:1-6): one module-level type, asserted at every property read
type StreamLike = { writable?: boolean; readable?: boolean; pipe?: unknown };
(stream as StreamLike).writable

// a property that the narrowed type does not declare (compress-commons util/index.js:10): the same shape
(source as { _readableState?: unknown })._readableState

// DLL.shift() under a length test (queue.js:225; DoublyLinkedList.js:54 returns `this.head && ...`)
var node = _tasks.shift() as { data: T };

// an object literal that Object.defineProperties completes afterwards (queue.js:161-291, TS-42)
var q = { concurrency, push(data) { ... }, ... } as QueueObject<T>;
```

Every spelling above compiles under the pinned `typescript` and `@types/node`; the ones of
7.3, 7.4 and 7.7 are in the written files. A dynamic pattern that needs an assertion and is
not listed here gets a row here first (M8). The row keeps the upstream expression and
names the narrowest type that makes it compile.

**TS-42 `Object.defineProperties` and `Object.defineProperty`.** Ported as the same call
with the same descriptor, after the same object literal. Folding the property into the
literal makes it writable, enumerable and configurable, which upstream's is not.

```js
Object.defineProperties(q, {                                     // async/internal/queue.js:270-291
    drain: { writable: false, value: eventMethod('drain') },
    ...
});
```
```ts
Object.defineProperties(q, {
    drain: {
        writable: false,
        value: (handler: () => void) => { drainHandlers = []; drainHandlers.push(handler); }
    }
});
```
The literal that the call completes is asserted to the finished type (TS-41).

Coverage of the inventory pattern lists: core 1-19 are TS-01..19 and TS-25; zip 1-19 are
RS-02..15, RS-18, RS-19, RS-26, RS-27, RS-32, TS-08, TS-36, TS-39; tar-json 1-19 are RS-20..26,
TS-01, TS-27..32, section 13; encrypted 1-17 are RS-02, RS-11, RS-14, RS-16, RS-28..31, RS-33,
TS-33..36; glob-fs 1-23 are TS-02, TS-03, TS-06..09, TS-13..26; tests 1-16 are RS-17, TS-01,
TS-33, TS-35, TS-37, TS-40 and the rows above. RS-37, RS-38 and TS-41 were added by the
review of this guide and have no inventory source; RS-39, RS-40 and TS-42 were added after
the trial run (2.3).

---

## 10. Numeric semantics

### 10.1 Types

| Quantity | JS (upstream) | Rust | Across wasm | TypeScript |
|---|---|---|---|---|
| CRC-32 | signed int32 from crc-32, made unsigned with `>>> 0` | `u32` | `u32` | `number` (0 .. 2^32-1) |
| DOS date/time | int32 | `u32` (`Option<u32>` when unset) | `u32` | `number` |
| external attributes | `attr >>> 0` | `u32` | `u32` | `number` |
| unix mode into `setUnixMode` | number, then `\|`, `<<` | `i32` | `i32` | `number` |
| sizes, offsets, counts | double (exact to 2^53) | `u64` | `f64` | `number`, never `bigint` |
| tar size | double | `f64` (ported arithmetic is on doubles) | `f64` | `number` |
| tar mtime | `Date` | `f64` milliseconds | `f64` | `Date` |
| ZipCrypto keys | int32 with `Math.imul`, `>>>` | `u32` | not exposed | not exposed |
| general purpose flag word, version needed, version made by, internal attributes | small ints | `u16` | `u16` | `number` |
| compression method | small int, `-1` when unset | field `Option<u16>`; `get_method()` returns `i32` (`-1` for `None`); the constants `METHOD_STORED`, `METHOD_DEFLATED` and `ZIP_AES_METHOD` are `i32`, like the getter; `set_method` takes `u16`, so a constant is passed as `METHOD_DEFLATED as u16` (RS-09) | `i32` (`-1` when unset) | `number` |
| platform | small int | `u8` | `u8` | `number` |
| argument of `getShortBytes`, `getLongBytes`, `getEightBytes` | any number | `u64`, whatever the type at the call site: widen with `as u64` (the `i32` method as `method as u16 as u64`, RS-10; a narrow field after the arithmetic, RS-38); the function truncates | not exposed | not exposed |
| zlib level | number | `i32` | `i32` | `number` |

### 10.2 Coercion idioms

| JS | Meaning | Rust | Domain in which both sides agree |
|---|---|---|---|
| `x >>> 0` where `x` is an int32 result | reinterpret as unsigned | `x as u32` (from `i32`) | every int32 |
| `crc32.buf(b) >>> 0` | unsigned CRC | `crc32::buf(b, 0)` (already `u32`) | every input |
| `n \| 0` where `n` is a double | ECMAScript ToInt32 | `numeric::to_int32(n)`; never `n as i32` (saturates, 11.5) | every double, NaN and the infinities included |
| `(v & 0xffff) >>> 0`, then `writeUInt16LE` | low 16 bits | `v as u16` | every integer the port holds; the mask keeps the write in range, nothing throws |
| `(v & 0xffffffff) >>> 0`, then `writeUInt32LE` | low 32 bits | `v as u32` | as above |
| `v % 0x0100000000`, `(v / 0x0100000000) \| 0`, each into `writeUInt32LE` | low and high words | `v as u32`, `(v >> 32) as u32`, or `u64::to_le_bytes` | `0 <= v < 2^53`, the range in which a JS number is an exact size or offset (10.1). From `2^63` upstream throws `ERR_OUT_OF_RANGE` (the `\| 0` turns the high word negative) where Rust writes the bytes; no archiver-wasm path produces such a value and the throw is not ported |
| `a << n` (int32) | shift, bits fall off the top | `a << n` on `i32` (Rust only panics on a shift amount >= 32; all amounts here are constants) | every int32, constant `n` below 32 |
| `a >>> n` | logical shift | `(a as u32) >> n` | as above |
| `a >> n` (int32) | arithmetic shift | `a >> n` on `i32` | as above |
| `~c` | bitwise not | `!c` | every int32 |
| `Math.imul(a, b)` | 32-bit wrapping product | `a.wrapping_mul(b)` on `u32` | every pair |
| `_uint32(a + b)` | 32-bit wrapping sum | `a.wrapping_add(b)` | every pair of uint32 |
| `size &= 511` | low 9 bits after ToInt32 | `to_int32(size) & 511` | every double |
| `Math.floor(num / 0x100)` on a non-negative double | floor | `(num / 256.0).floor()` | every non-negative finite double |

The last column is the contract. Where a JS idiom ends in a Buffer write, the write checks
its range and throws; the Rust side has no such check. Inside the domain the bytes are
equal. Outside it the port neither reproduces the throw nor adds an error (V13), and a
reviewer does not report the missing throw (2.3, K5). A row that is added to this table
states its domain.

Every addition, multiplication or subtraction that can leave the range of its type is
written with an explicit `wrapping_*` call. Native tests run with overflow checks on, the
release wasm with checks off; code that relies on implicit wrapping passes one and breaks
the other. CI runs `cargo test` and `cargo test --release`.

### 10.3 Unix mode and external attributes (zip-archive-entry.js:335-342)

```rust
pub fn set_unix_mode(&mut self, mut mode: i32) {
    mode |= if self.is_directory() { S_IFDIR } else { S_IFREG };
    let mut extattr: i32 = 0;
    extattr |= (mode << SHORT_SHIFT) | (if self.is_directory() { S_DOS_D } else { S_DOS_A });
    self.set_external_attributes(extattr as u32);
    self.mode = Some((mode & MODE_MASK) as u32);
    self.platform = PLATFORM_UNIX;
}
```

Check values (asserted by node-archiver/test/plugins.js:221-250): file 0644 gives
`0x81A40020` (2175008800); file 0777 gives `0x81FF0020` (2180972576); directory 0755 gives
`0x41ED0010` (1106051088); symlink with no permission bits (mode 40960) gives `0xA0000020`
(2684354592). The type bit is OR-ed in, not substituted: `0o120000 | 0o100000` is still
`0o120000`. In JS `0o120000 << 16` is negative (-1610612736); only the final `>>> 0` makes it
2684354592.

The masks applied before this point stay in TypeScript: `& 4095` (`& 511` on win32) in
`_normalizeEntryData` (core.js:285-296), `|= 40960` for symlinks (zip-stream/index.js:137-143).
Rust must not mask again.

### 10.4 Octal

- Mode literals stay in the notation upstream uses: decimal in archiver core and zip-stream
  (`511`, `493`, `420`, `4095`, `40960`), `0o755` / `0o644` / `0o7777` in tar-stream.
- Tar numeric fields are ASCII octal: `encode_oct(val, n)` returns `n` digits, zero padded
  on the left, plus one space; if the digit string is longer than `n` it returns `n` sevens
  plus a space (headers.js:242-246). Mode, uid, gid, checksum, devmajor, devminor use
  `n = 6` in an 8-byte field (digits, space, NUL); size and mtime use `n = 11` in a 12-byte
  field (digits, space, no NUL).
- The digit string is `value.toString(8)` in JS. For uid, gid, size, devmajor and devminor
  the value comes from the user and may be anything (a fractional number gives `'1.4'`, a
  string is returned unchanged, an object gives `'[object Object]'`), so TypeScript calls
  `.toString(8)` and passes the string (7.8). For mode, mtime, the checksum and the pax
  block size the value is an integer computed by the port, formatted in Rust.
- A size whose octal string is longer than 11 characters is written in base-256 instead:
  byte 0 is `0x80`, bytes 1..11 the value big-endian (headers.js:248-262).

### 10.5 DOS time (compress-commons zip/util.js:1-25)

```rust
pub fn date_to_dos(d: &DateFields) -> u32 {
    let year = d.year;
    if year < 1980.0 {
        return 2162688;        // 1980-1-1 00:00:00
    } else if year >= 2044.0 {
        return 2141175677;     // 2043-12-31 23:59:58
    }
    ((to_int32(year - 1980.0) << 25)
        | (to_int32(d.month + 1.0) << 21)
        | (to_int32(d.date) << 16)
        | (to_int32(d.hours) << 11)
        | (to_int32(d.minutes) << 5)
        | to_int32(d.seconds / 2.0)) as u32
}
```

- The fields come from `getUTC*` unless `forceLocalTime` is truthy (TypeScript, R7).
  The default is UTC.
- Both comparisons are false for `NaN`, and `to_int32(NaN)` is 0, so an Invalid Date packs
  to 0 and is written as `00 00 00 00`. It is not replaced by "now" (ZIP-086).
- Seconds are halved with truncation (59 gives 29). Milliseconds are ignored.
- Check value: 2013-01-03T14:26:38Z packs to date 16931, time 29523, bytes `53 73 23 42`.
- The value is written as one little-endian u32 (time in the low 16 bits), the same in the
  local and the central header.

### 10.6 Tar mtime (deps/tar-stream/headers.js:74)

`encodeOct((opts.mtime.getTime() / 1000) | 0, 11)` is
`encode_oct(&i64_to_string_radix8(to_int32(opts.mtime / 1000.0) as i64), 11)`.
Truncation is toward zero, then the value wraps to int32, then it is printed as sign plus
magnitude. Check values (verified against upstream, TAR-JSON-078..080):

| mtime | field (12 bytes) |
|---|---|
| 2013-01-03T14:26:38.999Z | `12071312436 ` (38 s, milliseconds dropped) |
| 2038-01-19T03:14:07Z | `17777777777 ` |
| 2038-01-19T03:14:08Z | `77777777777 ` (wrapped negative, 12 characters, saturates) |
| 2080-01-01T00:00:00Z | `-6106043200 ` |
| 2107-01-01T00:00:00Z | `00154010400 ` |
| 1969-12-31T23:59:59Z | `000000000-1 ` |
| -500 ms | `00000000000 ` (truncation, not floor) |
| Invalid Date | `00000000000 ` |

### 10.7 Sizes and offsets

- Rust: `u64` everywhere in the zip writer. zip64 predicates are strict `>` against
  `0xFFFF_FFFF` (entry size, compressed size, local header offset, central directory size
  and offset) and against `0xFFFF` (entry count).
- 32-bit header fields are written with `get_long_bytes(v)`, which truncates; 16-bit length
  fields with `get_short_bytes(v)`, which truncates. A name, extra or comment longer than
  65535 bytes is written in full with a wrapped length field and no error (ZIP-062).
- Across wasm: `f64`. TypeScript: `number`. `pointer()` and the progress byte counters are
  plain JS additions and never pass through Rust.

### 10.8 Dates in TypeScript

- `Date` objects are never converted, cloned or normalized before the statement that calls
  wasm. `stats.mtime` is passed by reference (core.js:305).
- "Now" is `new Date()` evaluated at exactly the upstream sites: `dateify`
  (utils.js:30, 37; zip-stream/utils.js:4, 11) and `Pack.entry` (pack.js:152). There is no
  clock injection API; tests that need a fixed "now" replace the global `Date` in the test.

### 10.9 String lengths

JS `.length` counts UTF-16 units; Rust `.len()` counts UTF-8 bytes. Lengths written into an
archive are byte lengths (RS-18). JS strings cross the boundary as UTF-8 with lone
surrogates replaced by U+FFFD, which is what `Buffer.from(str)` does upstream.

---

## 11. Known semantic traps

Code that looks the same in both languages and behaves differently. Reviewers check each.

### 11.1 A side effect inside `debug_assert!`

`debug_assert!` and `debug_assert_eq!` are erased from the release wasm, including their
arguments. Anything that writes, pushes, takes or advances state must be a statement.

```rust
// WRONG: in release the descriptor is never written and the entry is never recorded
debug_assert!(self._after_append_checked(ae));
// WRONG: the 12 header bytes are never consumed in release
debug_assert_eq!(encrypt._transform(&buffered, &mut enc), ());
// RIGHT
self._after_append(ae);                      // zip-archive-output-stream.js:62-72
debug_assert!(!self._archive.processing);    // pure read only
```

Assertions may contain only field reads and pure getters. Clippy's
`debug_assert_with_mut_call` is denied in both crates. The same applies to `assert!` used as
a statement carrier.

### 11.2 Eager `unwrap_or` versus lazy `unwrap_or_else`; eager defaults in TypeScript

JS `a || b` evaluates `b` only when `a` is falsy. `Option::unwrap_or(b)` and a helper
function taking the default as an argument evaluate `b` always.

- TypeScript: `dateish = dateish || new Date()` (utils.js:30) and
  `this.options.salt || crypto.randomBytes(16)` (aes-hmac-etm-stream.js:37-40) must stay
  `||` expressions or `if` statements. `withDefault(options.salt, crypto.randomBytes(16))`
  draws random bytes even when a salt was injected.
- Rust: `self._entry.take().unwrap_or(ZipArchiveEntry::new(None))` builds a throwaway entry
  on every call, and `x.unwrap_or(self.take_output())` drains the output on the happy path.
  Use `match`, `if let` or `unwrap_or_else` whenever the fallback allocates, mutates or
  returns early; `unwrap_or(0)` and `unwrap_or("")` are fine.

### 11.3 Slices and indexes on short or empty input

JS returns `undefined`, clamps, or throws a catchable `RangeError`. Rust panics, and a panic
is a dead wasm instance (5.5).

| Upstream | JS behavior | Rust |
|---|---|---|
| `name[name.length - 1] !== '/'` with `name === ''` (headers.js:56) | `undefined !== '/'` is true, the slash is appended | `!name.ends_with('/')`; never `name.as_bytes()[name.len() - 1]` |
| `data.name.slice(-1) === '/'` on `''` (zip-archive-entry.js:357) | `''`, false | `name.ends_with('/')` |
| `this.crc.readUInt16BE(0)` on a short Buffer (crypto-stream.js:34) | throws RangeError | evaluated in TypeScript (7.9); Rust receives a `u16` |
| `ae.getExtra().readInt16LE(9)` (zip-aes-stream.js:160) | throws RangeError | `extra.get(9..11)`, `Err(ExtraTooShort)` (RS-31) |
| `buf.readUInt32LE(0)` (zip/util.js:37) | throws RangeError | `Option` |
| `data.slice(HEADER_LENGTH - this.header.length)` (decrypto-stream.js:41) | negative index, last bytes | explicit start (RS-17) |
| 12 random header bytes, 32-byte AES key | fixed by construction | `<[u8; 12]>::try_from(slice)` mapped to `InvalidRandomLength` / `InvalidKeyLength` |

### 11.4 Bounds checks where JS silently truncates or wraps

- `b4a.write(buf, opts.uname, 265)` with a 300-byte `uname` stops at byte 511 in JS
  (headers.js:82). `buf[265..265 + n].copy_from_slice(..)` panics. Use `write_at`, and keep
  the upstream write order (name, mode, uid, gid, size, mtime, typeflag, linkname, magic,
  version, uname, gname, devmajor, devminor, prefix, checksum) because later writes
  overwrite an overflowing earlier field (P12).
- Length fields: `getShortBytes(name.length)` wraps at 65536 (ZIP-062).
  `u16::try_from(len).unwrap()` panics; `get_short_bytes(len as u64)` is the port.
- No placeholder constants "until later". A buffer size, table size or limit that upstream
  defines is ported with its value; one that upstream does not have is not introduced.

### 11.5 Truncation, floor, saturation and remainder on negative values

- `(mtime.getTime() / 1000) | 0` truncates toward zero: -500 ms gives 0, not -1
  (headers.js:74). `f64::floor` gives -1.
- `n as i32` on an `f64` saturates at `i32::MAX`; JS `n | 0` wraps. 2147483648 seconds
  (2038-01-19T03:14:08Z) must become -2147483648, which prints as `77777777777 `, not
  `17777777777 ` (10.6). Use `to_int32`.
- `(val.seconds / 2)` inside a `|` chain truncates (zip/util.js:23).
- `Math.floor(num / 0x100)` in `encodeSizeBin` is a real floor on a non-negative double.
- JS `%` and Rust `%` both take the sign of the dividend; `rem_euclid` does not. The only
  place a negative operand can occur is inside `to_int32`.
- `x >> n` is arithmetic on `i32` in both languages; JS `>>>` is `(x as u32) >> n`.
  `this.key1 >>> 24` (CryptoCipher.js:37) must be a logical shift.

### 11.6 Behavior fixed by the JS runtime at "format time"

Calls that look like plain formatting or plain math but whose result is defined by the JS
runtime, so the obvious Rust spelling gives different text.

- `Number.prototype.toString(8)` prints a negative number as sign plus magnitude
  (`(-1).toString(8)` is `'-1'`). `format!("{:o}", -1i32)` is `37777777777`. Tar mtime for
  1969-12-31T23:59:59Z must be `000000000-1 ` (10.6).
- `Math.floor(Math.log(len) / Math.log(10)) + 1` (headers.js:318) is floating point:
  `Math.log(1000) / Math.log(10)` is 2.9999999999999996, and the following line
  (`if (len + digits >= Math.pow(10, digits)) digits++`) happens to repair it. The port
  uses integers: `digits` = number of decimal digits of `len`; then
  `if len + digits >= 10^digits { digits += 1 }`; the record is
  `(len + digits).to_string() + str`. `len` is the UTF-8 byte length of the record body
  including the leading space and trailing newline. Equivalence with the JS formula was
  verified for `len` 1..3,000,000 (TAR-JSON-094).
- `str.length` used as a byte count (10.9).
- `Buffer.from(Array(2))` (constants.js) is two zero bytes: holes coerce to 0.
- `digest('hex').toUpperCase()` (crc32-stream.js:23-25): upper-case hex. `hex` is not
  ported, because nothing in the package calls it (V21).
- String concatenation with arbitrary values (`data.type + ' entries not currently
  supported'`, zip-stream/index.js:111, yields `'undefined entries ...'`;
  `' ' + key + '=' + pax[key] + '\n'`) is JS string conversion and stays in TypeScript.
- `JSON.stringify` of entry objects (`Date.prototype.toJSON`, dropped functions and
  `undefined`, `fs.Stats` fields) stays in TypeScript (R4).

### 11.7 Order and repetition that look redundant

- The tar checksum is computed after every other field is written (headers.js:89).
- The AES extra field records `ae.getMethod()` before `setMethod(99)` (zip-aes-stream.js:47-48).
- `sanitizePath` is applied up to three times to a zip entry name and is not idempotent
  (`'c:c:/x'` becomes `'c:/x'`, then `'x'`). Do not deduplicate the calls (R6).
- The UTF-8 flag is sticky: `setName` and `setComment` only ever set it
  (zip-archive-entry.js:207-211, 294-296).
- `drain` fires every time a queue becomes idle; `_onQueueDrain` relies on state flags.
- Central directory order is completion order; duplicate names are legal (ZIP-126). No map.
- `for...in` over `header.pax` yields integer-like keys first in ascending order, then
  string keys in insertion order, including inherited enumerable keys (TAR-JSON-093).

### 11.8 Synchronous versus deferred, microtask versus macrotask

- `queue.push` never runs the worker synchronously; the first task starts on a microtask
  (7.3). `append(...).abort()` depends on the queue being idle right after `kill()`
  (TESTS-019).
- `setImmediate(callback)` between entries (core.js:208) is a macrotask and must stay one.
- The glob walker starts on `setTimeout(fn)` with no delay argument.
- `finalize()` may finalize the module synchronously and returns a promise that follows
  the module's `'end'` / `'error'` events only (core.js:725-737). It is not an `async`
  function.
- `emit('error', e)` with no listener throws `e` synchronously out of the emitting method.
  `emit('warning', e)` with no listener does nothing.

### 11.9 JS truthiness

`0`, `''`, `NaN`, `null`, `undefined` and `false` are falsy. `!header.mode` replaces an
explicit mode 0 by the default (pack.js:149); `if (stats.size)` skips size 0
(core.js:101); `!options.password` rejects `''` but accepts an empty Buffer
(zip-encrypted.js:24); `data.stats === false` is not a truthiness test (core.js:267).

### 11.10 Class construction order in TypeScript

A subclass cannot touch `this` before `super()`. A base constructor can call a prototype
method that a subclass overrides, but the subclass's instance fields are not assigned yet
at that moment; the three hooks of 7.5 therefore read nothing from `this` except
`this.options` (set by the base constructor before the engine is created) and `this.key`
(read per entry, long after construction). `_encryptionMethod()` is the only hook called
from the base constructor and returns a literal.

### 11.11 A loop around a codec that has buffers of its own

`compress_vec(input, out, flush)` reads like "give input, get output". It is zlib's C
interface: every call reports how much input it took and how much output it wrote, and
either can be less than everything.

- "All input consumed" is not "done". The codec returns as soon as the output space is
  used up, and it may have taken the last input byte in that same call while it still
  holds compressed bytes. The continue condition is "the call filled the output buffer",
  which is Node's `availOutAfter === 0`.
- "Nothing happened" is not an `Err`. The rust backend of flate2 answers a call that could
  do nothing (an empty input without a flush, any write after the stream has ended) with
  `Ok(Status::BufError)`. A loop that ends only on `Err` or on consumed input then spins
  forever, inside wasm, where nothing can interrupt it.

```rust
// WRONG: leaves output inside the compressor, and never returns for a write after the end
while !input.is_empty() {
    let before = compress.total_in();
    compress.compress_vec(input, out, flush).map_err(|e| DeflateError(e.to_string()))?;
    input = &input[(compress.total_in() - before) as usize..];
}
```

The crate has one such loop, `crc32_stream::deflate`, and its three outcomes are pinned in
6.4. No other function under `src/` calls a method of `flate2::Compress`; a unit that
needs deflate goes through `DeflateCRC32Stream` or `deflate`. Tests inflate with
`flate2::read::DeflateDecoder`, which brings its own loop. Any other loop whose progress
depends on a library call gets the same two things pinned before it is written: the
continue condition and the no-progress exit with its error text.

### 11.12 The same base class name from another stream implementation

`extends PassThrough` reads the same whether `PassThrough` comes from readable-stream 2,
from readable-stream 4 or from `node:stream`. The behavior a subclass inherits does not:

| | readable-stream 2.3.8 | readable-stream 4, `node:stream`, the zlib classes |
|---|---|---|
| after `'end'` and `'finish'` | not destroyed, no `'close'` | destroyed (`autoDestroy`), `'close'` emitted (`emitClose`) |
| `'error'` emitted on a pipe destination that has no other `'error'` listener | emitted again at once, so it throws out of the emitting call | the destination is destroyed and the error is emitted later; with `autoDestroy: false` it is emitted again at once |
| `_read` throws | the exception leaves `read()` | caught and turned into an `'error'` event |
| order on a `PassThrough` that ran to its end | `'finish'`, then `'end'` | `'end'`, then `'finish'` |

V9 records what the port does about each class whose base changed. Only
`lazystream.Readable` has a v2 base: its constructor options restore the first two rows,
and the last two are listed in V9 as remaining differences. The classes that stood on
readable-stream 4 or on a zlib class (`Archiver`, `Json`, `ArchiveOutputStream`, the
`PassThrough` of `normalizeInputSource`, `SmartStream`, `Gzip`) have the Node defaults on
both sides and pass no lifecycle options. A unit that finds a base class missing from this
list has it added to V9 first, with both sides observed by running them (2.3, rule 5).

---

## 12. Dependency policy

### 12.1 Rust crates (exact list; nothing else may be added)

```toml
# crates/archiver-core/Cargo.toml
[package]
name = "archiver-core"
version = "0.1.0"
edition = "2021"

[dependencies]
flate2 = { version = "1.1", default-features = false, features = ["rust_backend"] }  # miniz_oxide, pure Rust
crc32fast = "1.4"
aes = "0.8"
ctr = "0.9"
hmac = "0.12"
sha1 = "0.10"
pbkdf2 = { version = "0.12", default-features = false, features = ["hmac"] }

# crates/archiver-wasm/Cargo.toml
[package]
name = "archiver-wasm"
version = "0.1.0"
edition = "2021"

[lib]
crate-type = ["cdylib", "rlib"]

[dependencies]
archiver-core = { path = "../archiver-core" }
wasm-bindgen = "=0.2.100"   # exact pin, confirmed by the toolchain gate (2.2); the glue behavior of 5.6 was observed with it

[package.metadata.wasm-pack.profile.release]
wasm-opt = false            # opt-level 3 and LTO already ran; wasm-pack would run whichever wasm-opt is on PATH (2.2)
```

Both manifests end with `[lints]` / `workspace = true` (15.1). With `Cargo.lock` as the gate
resolved it, the ranges above are `flate2` 1.1.10 (`miniz_oxide` 0.9.1), `crc32fast` 1.5.2,
`aes` 0.8.4, `ctr` 0.9.2, `hmac` 0.12.1, `sha1` 0.10.7, `pbkdf2` 0.12.2.

There are no `[dev-dependencies]` in either crate. The tests under `crates/archiver-core/tests/`
read no JSON: their inputs are generated Rust tables (14.3). They use only the crates
listed above (`flate2` to inflate deflated golden payloads).

Forbidden, with the reason: `rand` / `getrandom` (randomness is injected), `chrono` /
`time` (no clock, no time zone in Rust), `regex` (RS-19), `serde` / `serde-wasm-bindgen` /
`js-sys` / `web-sys` (flat arguments only), `zip`, `tar`, `libflate`, `zlib-rs` or any C
dependency (pure Rust, and the port is of upstream's logic, not of another crate's),
`console_error_panic_hook` and `wee_alloc` (no JS imports in the wasm module), `bytemuck` /
`byteorder` (use `to_le_bytes`). `Cargo.lock` is committed.

### 12.2 npm packages

Runtime `dependencies` (exact list):

| Package | Range | Why it is not ported |
|---|---|---|
| `minimatch` | `^10.2.2` | fixed decision; the range readdir-glob 3.0.0 declares |
| `streamx` | `^2.28.1` | base classes of the tar engine (R2) |

`devDependencies`: `typescript@5.9.3`, `tsdown@0.23.1`, `tsx@4.23.15` (runs the
TypeScript test files, 14.3), `@types/mocha@10.0.10` (types them), `@types/node@18.19.130` (`typescript`, `tsx` and `@types/node`
at the exact versions the toolchain gate recorded, 2.2; `tsdown` replaced the `tsup` of the
gate and is pinned exactly too; `@types/node` stays on the 18 line so that `tsc` rejects an
API the lowest supported Node does not have), `publint@0.3.24` and
`@arethetypeswrong/core@0.18.5` (tsdown runs both on the CommonJS build, 15.4),
`mocha@11.7.5`, `chai@6.2.2`, `mkdirp@3.0.1`, `tar@6.2.1` (must stay on 6: the test uses
the default export), `yauzl@3.3.0`, `readable-stream@^4.7.0`, `should@^13.2.3`,
`rimraf@^5.0.5`, `lazystream@^1.0.1`, `aes-js@3.1.2`, and for the differential tests
`archiver@8.0.0` and `archiver-zip-encrypted@2.0.0` (which brings its own nested
`archiver@7`).

`package-lock.json` is committed and CI installs with `npm ci`. The transitive versions
under the two oracle packages are not left to their caret ranges: `package.json` pins them
with `overrides` to the versions the port was made from (15.4; the three that are also
direct dependencies of the root are pinned by the lockfile alone), and
`scripts/verify-oracle-versions.mjs` checks the installed tree against the oracle table of
14.2 before any differential or golden comparison runs.

Not dependencies, because they are ported: `async`, `buffer-crc32`, `is-stream`,
`lazystream`, `normalize-path`, `readable-stream`, `readdir-glob`, `tar-stream`,
`zip-stream`, `compress-commons`, `crc32-stream`, `crc-32`, `b4a`, `aes-js`.

### 12.3 Tools

Rust `1.99.0`, the exact version in `rust-toolchain.toml`, with the `wasm32-unknown-unknown`
target and the `rustfmt` and `clippy` components (all three are listed in that file, so
`rustup` installs them together with the toolchain, whatever its profile); `wasm-pack`
`0.15.0` (it obtains the `wasm-bindgen` CLI matching the pinned crate version: a download
where a prebuilt one exists, otherwise `cargo install wasm-bindgen-cli`, which the gate saw
on macOS aarch64 and which builds with Rust 1.99.0). Both are fixed by the toolchain gate
(2.2) and installed at exactly those versions in CI; `wasm-pack` comes from its release
archive `wasm-pack-v0.15.0-<target>.tar.gz`. `rustfmt` 1.10.0 with its defaults is the
formatter (there is no `rustfmt.toml`): the Rust listings of this guide are laid out for
reading, and every Rust file is run through `cargo fmt` before it is handed over. Node >= 18
for running; Node >= 18.18 for testing (`mocha` 11.7.5 and `node --import` need it); Node
`^22.18.0 || ^24.11.0 || >=26.0.0` for building (tsdown 0.23.1 declares it; CI builds under
Node 24 and tests under every supported major, 15.5); `7z` on `PATH` for five upstream tests (TESTS-092) and for the extraction
checks; `tar` (bsdtar or GNU tar) for the extraction checks.

---

## 13. Error model

Four kinds of failure exist upstream. The port keeps the kind, the text, and the channel.

### 13.1 `ArchiverError` (TypeScript only)

`new ArchiverError(code, data)`: `message = ERROR_CODES[code] || code`, own enumerable
`message`, `code`, `data`; `name` stays `'Error'`; `instanceof Error` holds (R13). The table
is lib/error.js:3-26, verbatim including typos:

| Code | Message | Raised by | Channel |
|---|---|---|---|
| `ABORTED` | archive was aborted | `finalize()` after abort; `setModule` after abort | emit `'error'`, and `finalize` returns `Promise.reject(sameError)` |
| `DIRECTORYDIRPATHREQUIRED` | diretory dirpath argument must be a non-empty string value | `directory()` | emit `'error'`, return `this` |
| `DIRECTORYFUNCTIONINVALIDDATA` | invalid data returned by directory custom data function | `directory()` data function, data `{ dirpath }` | thrown inside `try`, caught, emit `'error'` |
| `ENTRYNAMEREQUIRED` | entry name must be a non-empty string value | `append()` | emit `'error'`, return `this` |
| `FILEFILEPATHREQUIRED` | file filepath argument must be a non-empty string value | `file()` | emit `'error'`, return `this` |
| `FINALIZING` | archive already finalizing | second `finalize()` | emit `'error'` and rejected promise |
| `QUEUECLOSED` | queue closed | `append`, `file`, `directory`, `symlink` after finalize or abort (not `glob`, P6) | emit `'error'`, return `this` |
| `NOENDMETHOD` | no suitable finalize/end method defined by module | `_moduleFinalize` | emit `'error'` |
| `DIRECTORYNOTSUPPORTED` | support for directory entries not defined by module | `append()` (data `{ name }`): emit `'error'`. fs path (data = entry data): emit `'warning'` | both |
| `FORMATSET` | archive format already set | `setFormat` (archiver 7) | emit `'error'` |
| `INPUTSTEAMBUFFERREQUIRED` | input source must be valid Stream or Buffer instance | `append()`, data `{ name }` | emit `'error'`, return `this` |
| `MODULESET` | module already set | `setModule` (never, P23) | emit `'error'` |
| `SYMLINKNOTSUPPORTED` | support for symlink entries not defined by module | `symlink()` (data `{ filepath }`): emit `'error'`. fs path: emit `'warning'` | both |
| `SYMLINKFILEPATHREQUIRED` | symlink filepath argument must be a non-empty string value | `symlink()` | emit `'error'` |
| `SYMLINKTARGETREQUIRED` | symlink target argument must be a non-empty string value | `symlink()`, data `{ filepath }` | emit `'error'` |
| `ENTRYNOTSUPPORTED` | entry not supported | fs path, other entry types | emit `'warning'` |

Emitting never destroys the stream and never rejects the `finalize()` promise (that promise
listens to the module only). An lstat failure is emitted as `'warning'` with the raw fs
error (core.js:399-408). A module append error is emitted as `'error'` and the queue
continues (core.js:178-182).

### 13.2 Plain `Error` delivered through a callback

| Message | Site | Layer |
|---|---|---|
| `<type> entries not currently supported` | zip-stream/index.js:111 | TS |
| `entry name must be a non-empty string value` | zip-stream/index.js:115 | TS (Rust has `EntryNameRequired` as a guard) |
| `entry linkname must be a non-empty string value when type equals symlink` | zip-stream/index.js:119-123 | TS |
| `not a valid instance of ArchiveEntry` | archive-output-stream.js:51 | TS |
| `unacceptable entry after finish` | archive-output-stream.js:55 | TS (and Rust guard) |
| `already processing an entry` | archive-output-stream.js:59 | TS (and Rust guard) |
| `input source must be valid Stream or Buffer instance` | archive-output-stream.js:72-74 | TS |
| `compression method <n> not implemented` | zip-archive-output-stream.js:94 | Rust (`MethodNotImplemented`), unreachable from ZipStream |
| `Size mismatch`, `No body allowed for this entry`, `tar entry destroyed`, `pack stream destroyed`, `pack stream is already finalized` | tar-stream/pack.js:102, 77, 111, 52, 53 | TS (`Sink`) |
| source stream errors | zip-archive-output-stream.js:104-107, utils.js:9 | TS |

When the callback is not a function, the zip engine uses `_emitErrorCallback`
(archive-output-stream.js:27-31), which emits `'error'` on the engine.

### 13.3 Synchronous throws

| What | Site |
|---|---|
| `TypeError('expected path to be a string')` | normalize-path, reached from `sanitizePath` (truthy non-string names) |
| `RangeError('Concurrency must not be zero')` | `queue()` from the `Archiver` constructor |
| `Error('already finalized or destroyed')` | `Pack.entry` (pack.js:138) |
| `Error('create(<f>): format not registered')`, `Error('register(<f>): format already registered')`, `... format module invalid`, `... format module missing methods` | `src/vending.ts` |
| `Error('options.password is required')`, `Error("Unsupported encryption method: '<m>'. Please use either 'aes256' or 'zip20'.")` | `ZipEncrypted` constructor, password check first |
| `Error('invalid entry time')`, `Error('invalid entry compression method')` | TypeScript `ZipArchiveEntry` setters |
| Node zlib option errors (`RangeError`, `TypeError`) | `validateZlibOptions` (7.7) |
| `TypeError: Cannot read properties of undefined (reading 'apply')` | `Tar.unpipe` without gzip (P9) |
| `Error('Callback was already called.')` | queue callback invoked twice |
| whatever `readlinkSync` throws | `_updateQueueTaskWithStats` (core.js:467), three paths: thrown synchronously out of `file()` itself when `data.stats` is an `fs.Stats` (core.js:97-99, after `_entriesCount` was incremented); uncaught inside the lstat callback on the stat-queue path; a globber `'error'` on the glob path (GLOB-FS-072) |
| `TypeError('zip20Header must be a Buffer of 12 bytes')`, `TypeError('header must be a Buffer of 12 bytes')` | `ZipCryptoStream` constructor and `_entryRandom`; `CryptoStream` constructor (V10, 7.9; archiver-wasm only) |
| `TypeError('expected a string')` | `wasmString` at a string argument of a wasm call (5.6, 15.3; archiver-wasm only): `_engineEntry` and `_finish` of the zip engine (7.5), `Pack._encode` (7.8). Only for values outside the published types (V14); upstream throws a `TypeError` from a `Buffer` call at most of these sites. `Pack._encode` concatenates where upstream does and does not throw there: a `linkname` with `pax` set, and the `toString(8)` result of uid, gid, devmajor and devminor (a non-string result is zero padded where upstream writes it unpadded). |

### 13.4 Errors from Rust

`ZipError` values reach TypeScript as thrown `Error`s (5.5). With section 7 followed, the
variants that guard misuse are not reachable from user input; they exist to keep the
sans-IO API total. One variant depends on the data: `Deflate`.

TypeScript does not catch exceptions from wasm calls except in `SmartStream` (7.5), and
there an exception is never swallowed: `SmartStream._fail` destroys the per-entry stream
(so its `'end'` never fires) and calls the entry callback with the error as
`callback(err, ae)`. `_archive.processing` stays true: the writer is poisoned, as upstream
is after a failed entry (ZIP-048). Archiver core emits the error as `'error'` and moves on
to the next task (core.js:178-182), whose `entry()` then fails with
`'already processing an entry'`; `finalize()` after that does not complete, which is the
behavior upstream has when its own processor fails (ZIP-053), except that archiver-wasm has reported
the cause. A `WebAssembly.RuntimeError` (a trap, 5.5) takes the same route when it happens
inside `SmartStream` and propagates as a synchronous exception from every other call site.

| Message | Site | Channel |
|---|---|---|
| `entry name too large`, `entry comment too large` | `_engineEntry`, thrown in TypeScript (V16) | entry callback, then archiver `'error'` |
| `deflate error: <text>` | `writeData` / `endData` | entry callback, then archiver `'error'` |
| `deflate error: <text>` | `WasmGzip.write` / `WasmGzip.finish` | synchronous throw out of `Gzip._transform` / `Gzip._flush` (7.7) |
| any other `ZipError`, or a trap | `entry`, `completeStored`, `finish` and the other classes | synchronous throw out of the calling method |

`<text>` is one of the two texts of the deflate loop (6.2, 6.4). `deflate compression error`
is flate2 reporting a failure of its own; it is the text that would depend on the data,
and no input is known to cause it. `no progress` is a call that consumed no input and
produced no output; it needs a write after the stream was finished, which the TypeScript
shells never make (a Node stream does not call `_transform` after `_flush`). Both are
pinned so that the loop always ends and a failure, should one happen, is reported.

---

## 14. Test strategy

Five layers. A later layer never replaces an earlier one.

### 14.1 The upstream suites, unmodified

52 tests: node-archiver `test/archiver.js` (24), `test/plugins.js` (16);
archiver-zip-encrypted `test/aes-hmac-etm-stream.js` (1), `as-stream.js` (1),
`crypto-stream.js` (1), `zip-aes.js` (3), `zip-encrypted.js` (4), `zip20.js` (2).

They are vendored byte for byte by `scripts/vendor-upstream-tests.mjs` into `tests/upstream/`
(with both upstream MIT license files) and never edited, not even the import lines. The
imports are satisfied by shim files placed where the tests expect the library:

```
tests/upstream/node-archiver/package.json            {"type":"module"}
tests/upstream/node-archiver/index.js                export * from "../../../dist/index.mjs";
tests/upstream/node-archiver/test/...                verbatim (archiver.js, plugins.js, helpers/index.js, fixtures/**)

tests/upstream/archiver-zip-encrypted/package.json   {"type":"commonjs"}
tests/upstream/archiver-zip-encrypted/index.js       module.exports = require('./lib/zip-encrypted');
tests/upstream/archiver-zip-encrypted/lib/zip-encrypted.js             module.exports = require('../../../../dist/index.cjs').ZipEncrypted;
tests/upstream/archiver-zip-encrypted/lib/aes/aes-hmac-etm-stream.js   (below)
tests/upstream/archiver-zip-encrypted/lib/zip20/zip-crypto-stream.js   module.exports = require('../../../../../dist/index.cjs').ZipCryptoStream;
tests/upstream/archiver-zip-encrypted/lib/zip20/crypto-stream.js       ... .CryptoStream;
tests/upstream/archiver-zip-encrypted/lib/zip20/decrypto-stream.js     ... .DecryptoStream;
tests/upstream/archiver-zip-encrypted/test/...       verbatim (6 spec files, resources/**)
tests/upstream/alias-archiver.cjs                    (below)
```

```js
// tests/upstream/archiver-zip-encrypted/lib/aes/aes-hmac-etm-stream.js
// The upstream test decrypts with aes-js and relies on the little-endian counter patch that
// upstream's library applied globally when required (aes-hmac-etm-stream.js:16-25, N7).
const aes = require('aes-js');
aes.Counter.prototype.increment = function () {
  for (var i = 0; i < 16; i++) {
    if (this._counter[i] === 255) { this._counter[i] = 0; } else { this._counter[i]++; break; }
  }
};
module.exports = require('../../../../../dist/index.cjs').AesHmacEtmStream;

// tests/upstream/alias-archiver.cjs   (mocha --require)
const Module = require('node:module');
const path = require('node:path');
const target = path.resolve(__dirname, '../../dist/index.cjs');
const resolveFilename = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
  return request === 'archiver' ? target : resolveFilename.call(this, request, ...rest);
};
```

How they run (each from its own directory, because every path in the tests is relative to
the working directory, TESTS-006):

```
cd tests/upstream/node-archiver          && mocha --reporter dot
cd tests/upstream/archiver-zip-encrypted && mocha --require ../alias-archiver.cjs
```

Mocha's default spec (`./test/*.{js,cjs,mjs}`, not recursive) selects exactly the 2 and the
6 spec files. Mocha stays the runner: the suites use `before`/`after`, `done` callbacks and
`this.skip()`, and they share fixture symlinks and the `tmp/` and `target/` directories, so
they must run serially in one process (TESTS-014, R20). No `.mocharc` file exists anywhere
in the repository (mocha would pick it up from a parent directory and change these runs).
The node-archiver suite loads the published ESM bundle (`dist/index.mjs`), the encrypted
suite the published CommonJS bundle (`dist/index.cjs`). They are two builds of the same
sources, each with its own classes (15.4, V20).

Prerequisites: `7z` on `PATH` (5 tests spawn it); a clean fixture tree (a crashed run
leaves two symlinks behind that make the next run fail with EEXIST, TESTS-012: the npm
script removes `test/fixtures/directory/subdir/level0link.txt` and `subsublink` before
starting mocha, which is not a change to a test).

Expected result on Linux and macOS: 40 + 12 passing, 0 pending, 0 failing, with mocha's
default 2000 ms timeout. Windows is not a tested platform in this phase: CI has no Windows
job and the npm scripts are POSIX shell. The upstream-conditional `this.skip()` on win32
(M9) and every `win32` branch of the code stay as upstream wrote them, unverified.

### 14.2 Differential tests against the real packages (`tests/differential/`)

Same scenario, same inputs, run once with the upstream oracle and once with archiver-wasm, outputs
compared. Default run: `mocha --no-config "tests/differential/*.test.mjs"`. On demand:
`mocha --no-config --timeout 0 "tests/differential/*.slow.mjs"` (the slow file is selected
by its name, never by `--grep`).

**The oracle is the pinned source.** A byte difference must come from the port, never from
a different upstream version, so the installed oracle tree is fixed by `overrides` and
`package-lock.json` (12.2, 15.4) and checked by `scripts/verify-oracle-versions.mjs`, which
runs before the differential tests and before `scripts/capture-golden.mjs`. The script
locates each package by walking `node_modules` directories upward from the directory of
the package that depends on it (Node's resolution order), reads its `package.json` from
disk (several of these packages do not export it) and fails unless every version equals
this table:

| Resolved from | Package and version |
|---|---|
| the repository root | `archiver` 8.0.0, `archiver-zip-encrypted` 2.0.0 |
| `archiver` 8.0.0 | `zip-stream` 7.0.5, `compress-commons` 7.0.1, `crc32-stream` 7.0.1, `crc-32` 1.2.2, `tar-stream` 3.2.2, `streamx` 2.28.1, `b4a` 1.9.0, `readdir-glob` 3.0.0, `async` 3.2.6, `buffer-crc32` 1.0.0, `is-stream` 4.0.1, `lazystream` 1.0.1, `normalize-path` 3.0.0 |
| `archiver-zip-encrypted` 2.0.0 | `archiver` 7.0.0, `zip-stream` 6.0.0, `compress-commons` 6.0.0, `crc32-stream` 6.0.0, `archiver-utils` 5.0.1, `aes-js` 3.1.2, `buffer-crc32` 1.0.0 |

The first two rows are the versions of the port sources (`.upstream/deps/*/package.json`
and the files cited from `.upstream/node-archiver/node_modules`); the third is the lockfile
of archiver-zip-encrypted 2.0.0. The aes256 and zip20 oracle is built the way the upstream
suite builds it: the `archiver` that `archiver-zip-encrypted` resolves (7.0.0), with
`registerFormat('zip-encrypted', require('archiver-zip-encrypted'))`.

Files (each is a `PORTMAP.tsv` row; units in 4.1):

| File | Content |
|---|---|
| `helpers/run-both.mjs` | Loads both implementations, runs one scenario function against each (in process, or in a child process with `--child <impl> <scenario>`), returns `{ bytes, events, error, pointer }` per implementation. Installs the fixed clock and the random stub described below around the upstream run only. |
| `helpers/zip-records.mjs` | Parses a zip buffer from the end record backwards into end records, central headers, and per entry: local header, payload bytes, data descriptor. Pure JavaScript, no dependency. |
| `helpers/tar-records.mjs` | Splits a tar buffer into 512-byte header blocks (all fields of 17.3), pax record blocks, bodies and padding. |
| `helpers/decrypt.mjs` | ZipCrypto: upstream's own `lib/zip20/decrypto-stream.js`. AES: `aes-js` 3.1.2 with the little-endian counter patch of upstream's aes-hmac-etm-stream.js:16-25, key material from Node's `crypto.pbkdf2Sync`, MAC with `crypto.createHmac`. No archiver-wasm code. |
| `helpers/events.mjs` | Records `entry`, `progress`, `warning`, `error`, `end`, `close` with payload summaries (own enumerable keys in order, `Date` as ISO string, `stats` reduced to `size` and type, errors as `{ name, code, message, data }`). |
| `zip-plain.test.mjs`, `tar.test.mjs`, `targz.test.mjs`, `json.test.mjs`, `aes.test.mjs`, `zip20.test.mjs` | the format cases of the table below |
| `errors-events.test.mjs`, `preserved-defects.test.mjs`, `extraction.test.mjs` | the behavior cases of the table below and the checks of 14.4 |
| `large.test.mjs` | payloads above `MAX_CHUNK` through every loop that slices before a wasm call (L1) |
| `crypto-streams.test.mjs` | the exported encryption classes used on their own (W1 to W4) and passwords outside ASCII (W5) |
| `glob-options.test.mjs` | every `glob()` option that core.js:672-699 passes to readdir-glob (O1) |
| `behaviors.test.mjs` | rows of `BEHAVIORS.tsv` that no other case reaches (B1 to B5) |
| `destroy-abort.test.mjs` | a `signal` aborted in the middle of an archive and before construction (V17), a Buffer comment (V14), names and comments over the length field and over the wasm limit (P24, V16 (d)), the two timing differences of V3 (R1 to R5) |
| `preserved-defects-2.test.mjs` | the preserved defects that `preserved-defects.test.mjs` does not reach (D9 to D17, P24 to P32) |
| `zip-large.slow.mjs` | the S cases |

Determinism: every entry gets an explicit `date`; `Date` is replaced by a fixed-clock
subclass inside the test where upstream reads the clock (tar symlink mtime, P10); file modes
are set by `chmod` in the test; the AES salt is injected through `options.salt`; the
ZipCrypto header through `zip20Header` for archiver-wasm and, for upstream, by replacing
`crypto.randomBytes` during the upstream run with a function that returns the same fixed
bytes for every call of length 12. The stub must not depend on how often or in which order
it is called: archiver-wasm draws the per-entry random bytes once at the start of every entry, also
for entries without payload, while upstream draws only for entries with payload and later
(V10), so the number and order of `crypto.randomBytes` calls is not part of the contract.

Order classes. Upstream does not order every scenario deterministically: with the default
`statConcurrency` of 4, `file()` entries enter the queue in lstat completion order, and
several `directory()` / `glob()` walks interleave (GLOB-FS-068, TESTS-028). Two upstream
runs of such a scenario need not agree with each other.

- **Class D (deterministic order)**: every entry is added with `append()` or `symlink()`;
  or the archive has exactly one fs source (one `file()`, one `directory()` or one `glob()`
  call), with or without `append()` entries; or `statConcurrency: 1` with `file()` calls
  only. Compared as whole archives by the format rules below, and with exact event
  sequences.
- **Class N (order not deterministic upstream)**: every other fs-backed scenario. Compared
  per entry, keyed by name: local header, payload, descriptor and central header with the
  offset fields masked (tar: header block and body; json: the entry object), plus equal
  multisets of entry names and of events.

Comparison rules:

- **tar**, **stored zip** (`store: true` or `zlib.level: 0`), **stored encrypted zip**:
  whole-archive byte equality (class D).
- **deflated zip**: parse both archives entry by entry and require: equal local header
  bytes; equal inflated (and, for encrypted entries, decrypted) payload; equal data
  descriptor CRC and uncompressed size; equal central header bytes except compressed size
  and local header offset (and the same two values inside a zip64 extra); equal end records
  except central directory size and offset; equal entry order and count (class D).
  Compressed sizes are checked only relationally (`csize == payload length`, `+ 12`,
  `+ 28`), never against a constant.
- **tar.gz**: equal 10-byte header, equal gunzipped payload, equal 8-byte trailer.
- **json**: equal after replacing `stats` atime/ctime-like volatile fields; key order equal.
- **events**: the recorded sequence of (`entry`, `progress`, `warning`, `error`) with
  payload summaries is equal, `pointer()` is equal at `finalize` resolution for byte-equal
  cases. For aes256 and zip20 the comparison of `'entry'` payloads ignores the keys that
  only the archiver 7 stack writes (V15: `namePrependSlash`, `linkname`, `store`,
  `comment`, and for `symlink()` entries `date`, `mode`, `store`); the byte-equality cases
  of these two formats never pass a key explicitly set to `undefined` and never pass a
  duck-typed stream. Case A4 asserts each V15 item as the documented difference.
- **hangs** (P1 to P5 and the V8 note): both implementations are run in process; the
  assertion is that 500 ms after the last scheduled input neither has settled the
  `finalize()` promise, called back, or emitted `end` / `close`, and that the events
  recorded up to then are equal. The scenario then destroys both archives so that the test
  process can exit.
- **crashes** (uncaught exceptions and unhandled `'error'` events, P22 and the second
  `readlinkSync` path of 13.3): each implementation runs the scenario in a child process
  whose `uncaughtException` handler prints `{ name, code, message }` and exits with code 7;
  exit code and printed object are compared. Synchronous throws (P9, 13.3) are compared in
  process with `assert.throws` on both.

Required cases. "Formats" lists where the case runs; the P / V / row column names what the
case demonstrates. Every P row of 3.3 appears at least once (section 16 item 7).

| Id | File | Case | Formats | Class | Demonstrates |
|---|---|---|---|---|---|
| Z1 | zip-plain | buffer, string, stream and lazy file (`lazystream`) sources, default method | zip | D | V1 |
| Z2 | zip-plain | empty buffer and empty stream | zip | D | P14 |
| Z3 | zip-plain | directories via `append(null, { name: 'd/' })`, `file()` on a directory, one `directory()` | zip | D | |
| Z4 | zip-plain | symlinks via `symlink()` and from disk | zip | D | |
| Z5 | zip-plain | `prefix`, backslash names, `'c:c:/x'`, `namePrependSlash` | zip | D | R6 |
| Z6 | zip-plain | non-ASCII names, entry comments, archive comment (ASCII and non-ASCII) | zip | D | V5 |
| Z7 | zip-plain | `mode` 0, `null`, 0644, 0777, absent | zip | D | |
| Z8 | zip-plain | `store` per entry and per archive; `zlib.level` 0, 1, 9, NaN, 0.9; `level` shortcut; `forceZip64` with level 0 | zip | D | ZIP-008, ZIP-136 |
| Z9 | zip-plain | `forceZip64`; more than 65535 entries is S5 | zip | D | P15 |
| Z10 | zip-plain | `forceLocalTime` and `forceUTC` with `TZ` set; dates before 1980, in 2043 and 2044, Invalid Date, a numeric date | zip | D | P7, P20 |
| Z11 | zip-plain | a source stream that errors midway | zip | D | P16 |
| Z12 | zip-plain | `ZipStream` used directly: `write('PREFIX')`, then one entry, then `finalize()`; local header offset and central directory offset are the real positions | zip | D | ZIP-135 |
| Z13 | zip-plain | several `file()` calls with the default `statConcurrency`; `file()` plus `directory()`; three `directory()` walks | zip | N | GLOB-FS-068 |
| Z14 | zip-plain | `statConcurrency: 1`, `file()` calls including missing files (warnings) | zip | D | |
| Z15 | zip-plain | one `glob()` with `cwd`, `ignore` and `dot` options | zip | D | |
| T1 | tar | the sources of Z1 and Z2; sizes that are and are not multiples of 512 | tar | D | |
| T2 | tar | directories and symlinks; `symlink()` under the fixed clock | tar | D | P10 |
| T3 | tar | names of 100, 101, 155+100 and 256+ bytes; non-ASCII names | tar | D | P13 |
| T4 | tar | mtime 2038, 2107, before 1970, Invalid Date | tar | D | P11 |
| T5 | tar | `uid`, `gid`, `uname`, `gname` (also over-long), `devmajor`, caller `pax`, `mode` 0 and `null` | tar | D | P12 |
| T6 | tar | several fs sources | tar | N | |
| G1 | targz | T1 inputs with `gzip: true`; `gzipOptions.level` 1, 6, 9; header XFL and OS byte for the platform | tar.gz | D | R14, V2 |
| G2 | targz | `abort()` with and without gzip | tar, tar.gz | D | P9 |
| J1 | json | buffer, string and stream sources; key order; unsigned `crc32`; caller keys | json | D | |
| J2 | json | one `file()` / one `directory()` with stats | json | D | |
| J3 | json | several fs sources | json | N | |
| A1 | aes | buffer and stream, stored and deflated; empty file; directory | aes256 | D | P18, P19 |
| A2 | aes | `forceZip64`, comments, non-ASCII names | aes256 | D | |
| A3 | aes | `salt` as Buffer and as string; no salt (structure and lengths only) | aes256 | D | V10, V14 |
| A4 | aes | the V15 items: caller options not mutated, `'entry'` payload keys, `mode: undefined`, a duck-typed stream source; asserted as the documented difference, on both formats | aes256, zip20 | D | V15 |
| C1 | zip20 | buffer and stream, stored and deflated; the stored empty entry and a directory | zip20 | D | P17, P18 |
| C2 | zip20 | `zip20Header` of wrong type or length throws; `ZipCryptoStream` written to directly, then one entry | zip20 | D | V10, ZIP-135 |
| E1 | errors-events | every `ArchiverError` code with its event, payload and return value, including `glob()` after `finalize()` and `setFormat` / `setModule` called twice; `registerFormat` / `create` / `ZipEncrypted` constructor errors | all | D | P6, P8, P23 |
| E2 | errors-events | `abort()` before any entry, during an entry, after a synchronous `finalize()` | all | D | P5 (resolving half) |
| E3 | errors-events | `finalize()` twice; `finalize()` after `abort()` | all | D | |
| E4 | errors-events | full event sequences and `pointer()` for one scenario per format | all | D | |
| D1 | preserved-defects | a `directory()` data function that throws, and one that returns a number (hang) | zip | D | P1 |
| D2 | preserved-defects | a FIFO inside a walked directory (hang) | zip | D | P2 |
| D3 | preserved-defects | a walked directory with read but no search permission, so that readdir succeeds and every lstat fails (warnings, then hang) | zip | D | P3 |
| D4 | preserved-defects | a walk over an unreadable sub-directory (hang after the `'error'`) | zip | D | P4 |
| D5 | preserved-defects | `abort()` while `finalize()` is deferred (hang) | json | D | P5 |
| D6 | preserved-defects | `collectStream` on a stream that errors and then ends; a plugin `append` with an unknown `sourceType` | tar, json | D | P21 |
| D7 | preserved-defects | a lazily opened file that fails to open in the tar-with-stats path (crash) | tar | D | P22 |
| D8 | preserved-defects | a dangling path whose `readlinkSync` throws: through `file(path, { stats })` (synchronous throw), through the stat queue (crash), through `directory()` (globber `'error'`) | zip | D | 13.3 |
| D9 | preserved-defects-2 | a name, an entry comment and an archive comment of 65535, 65536, 70000 and 70002 (non-ASCII) bytes, and all three at once: the length fields hold the length modulo 65536 and every byte is written | zip, aes256, zip20 (stored) | D | P24 |
| D10 | preserved-defects-2 | a NUL character in a name and in a linkname: it is in the ustar field, no pax header, and a reader sees the name cut there | tar | D | P25 |
| D11 | preserved-defects-2 | names of 28, 90, 2000 and 16000 segments and one with no separator: equal headers. The bounded instance of the defect: 16000 separators take milliseconds | tar | D | P26 |
| D12 | preserved-defects-2 | interior `..` segments, a drive letter behind a prefix, `symlink()` names and targets that are not sanitized. For aes256 and zip20 the `'entry'` name of a `symlink()` is asserted on both sides as the difference of V15 (a) | zip, aes256, zip20 (stored), tar, json | D | P27, V15 |
| D13 | preserved-defects-2 | `glob('**', { follow: true })` over a directory with one link to itself, walked until `ELOOP`: equal events and names, equal bytes for zip and tar. The bounded instance of the defect: one link is linear, each further link doubles the walk | zip (stored), tar, json | D | P28 |
| D14 | preserved-defects-2 | a file shorter, longer, emptied or doubled against its `stats`: `Size mismatch` as `'error'` twice, `finalize()` rejects, two uncaught exceptions (crash) | tar, tar.gz | D | P29 |
| D15 | preserved-defects-2 | `destroy()` while a 16 MiB file is being read: the engine and the `fs.ReadStream` are not destroyed and one descriptor stays open; `abort()` closes it (child process) | zip (deflated and stored), aes256, tar.gz | D | P30 |
| D16 | preserved-defects-2 | `constructor`, `toString`, `hasOwnProperty`, `valueOf`, `__proto__` as format names: registered, `create()` throws a `TypeError`, `registerFormat()` is refused | archiver 7 surface | D | P31 |
| D17 | preserved-defects-2 | `abort()` 0, 1, 2 and 3 turns after `append()`: only after 1 turn there is no `'end'` and no `'close'` (hang) | zip (stored), aes256 (stored), json | D | P32 |
| X1 | extraction | the checks of 14.4 over the archiver-wasm outputs of the Z, T, G, A and C cases | all | D | |
| L1 | large | a payload of 5 MiB + 123 bytes, compressible and incompressible, as a `Buffer`, as a stream of one chunk and as a stream of three chunks cut off the 1 MiB boundary: zip, aes256 and zip20, stored and deflated; tar; tar.gz at the default level, level 1 and level 0; json; `AesHmacEtmStream`, `CryptoStream`, `DecryptoStream` and `CryptoCipher` written to directly. Every payload is also extracted and compared with the source | all | D | V16, ZIP-137, ENCRYPTED-118 |
| W1 | crypto-streams | `AesHmacEtmStream` on its own: salt given and drawn, string and `Buffer` keys, keys outside ASCII, empty chunks, chunks of 1 to 40 bytes and above 1 MiB, called without `new`; the salt, key and verifier fields | aes256 | D | 7.9 |
| W2 | crypto-streams | `CryptoStream` on its own: the check bytes, no data (nothing written, no random bytes drawn), the `header` option | zip20 | D | V10 |
| W3 | crypto-streams | `DecryptoStream` on its own: called without `new`, a `Buffer` key, a key outside ASCII, a wrong key; `CryptoStream` piped into it | zip20 | D | 7.9 |
| W4 | crypto-streams | `CryptoCipher`: `encrypt` and `decrypt` call after call, known bytes, data above 3 MiB | zip20 | D | 7.9 |
| W5 | crypto-streams | passwords outside ASCII: a string, a `Buffer` of the same UTF-8 bytes, a `Buffer` that is not UTF-8 and one of the latin1 bytes; through `ZipEncrypted` and through the engine built by hand; decrypted under the expected bytes and by `7z` | aes256, zip20 | D | ENCRYPTED-006 |
| O1 | glob-options | one `glob()` per option on a tree with a mixed-case file, dot entries, an empty directory and three symlinks: `nodir`, `mark`, `skip`, `follow`, `nocase`, `matchBase`, `noglobstar`, `dot`, `ignore`, `cwd` (absent and relative ones in a child process), `absolute`, `stat`, an array pattern, entry data. Compared with upstream and with the entry list written in the case; one combined case also as stored zip and tar | json, zip, tar | D | |
| B1 | behaviors | constructor defaults: `highWaterMark` and `statConcurrency` given, absent and `null`; `statConcurrency: 0` throws | all | D | ARCHIVER-CORE-006, ARCHIVER-CORE-009 |
| B2 | behaviors | the number of `lstat` calls in flight equals `statConcurrency` | json, zip, aes256 | D | ARCHIVER-CORE-009 |
| B3 | behaviors | a mode read from stats keeps the bits above 0777 | all | D | ARCHIVER-CORE-033 |
| B4 | behaviors | a failed `lstat` takes its entry out of `entries.total` | all | D | ARCHIVER-CORE-047 |
| B5 | behaviors | bytes written to the ZipCrypto engine while an entry is open: the local header offsets are the real positions | zip20 | D | ZIP-135 |
| R1 | destroy-abort | a `signal` aborted at the second `'entry'` with `file()` entries queued, and while a stream entry is being written (child process). zip kinds: no uncaught exception, `AbortError` (`ABORT_ERR`) twice, `finalize()` rejects with it, events equal, stored bytes equal. tar and tar.gz: both crash with `already finalized or destroyed`. json: equal. `progress.fs.totalBytes` is masked, it races in upstream itself | zip (deflated and stored), aes256, zip20, tar, tar.gz, json | D | V17 |
| R2 | destroy-abort | a `signal` that is already aborted at construction, with and without one entry (child process). zip: `AbortError` twice and as the rejection. aes256 and zip20: the uncaught exception is the `AbortError` in both. tar, tar.gz, json: equal events and outcome | zip (deflated and stored), aes256, zip20, tar, tar.gz, json | D | V17 |
| R3 | destroy-abort | a `Buffer` as comment. Archive option: archiver-wasm throws `TypeError('expected a string')` from the constructor. Entry data: archiver-wasm emits it as `'error'`, no uncaught exception. Upstream writes the comment in both | zip (deflated and stored), aes256, zip20 | D | V14 |
| R4 | destroy-abort | a name of 70000 bytes, ASCII and non-ASCII: completes, length field 4464, local header equal, whole archive equal for the stored kinds. A name of exactly 64 MiB: same length and SHA-256 as upstream (zip, stored). A name or an entry comment of 64 MiB + 1: `'error'` `entry name too large` / `entry comment too large` in archiver-wasm and no trap, upstream writes it (zip stored, aes256, zip20). One entry per archive. The cases at 64 MiB take minutes on Node 18 and 20, so `destroy-abort-huge.slow.mjs` registers them and they run with the slow suite. | zip (deflated and stored), aes256, zip20 (each also stored) | D | P24, V16 (d) |
| R5 | destroy-abort | the two timing differences of a deflated buffer entry. A missing `file()` plus `append()`: upstream `warning`, `entry`, `progress` (total 1), archiver-wasm `entry`, `progress` (total 2), `warning`. `abort()` one turn after `append()`: upstream ends, archiver-wasm never ends. Two turns after: archiver-wasm ends, upstream is accepted with either outcome. The stored controls (the warning case, and `abort()` after 0, 1 and 2 turns) are equal | zip | D | V3, P32 |
| S1 | zip-large.slow | a streamed entry above 4 GiB from a sparse file | zip, aes256 | D | P15, P18, P19 |
| S2 | zip-large.slow | a 1.5 GiB `Buffer`, stored and deflated (must complete and compare) | zip, aes256, tar | D | V16 |
| S3 | zip-large.slow | a stored `Buffer` above 0xFFFFFFFF bytes, where the Node version allows one | zip | D | ZIP-058 |
| S4 | zip-large.slow | a ZipCrypto entry above 1 GiB: a sparse stream of 2 GiB + 1 MiB, stored and deflated. It did not fit while the entry was buffered in wasm (must complete and compare) | zip20 | D | V16 |
| S5 | zip-large.slow | 65536 entries | zip | D | zip64 by count |

B1 to B5, W1 to W4, D9 to D17, R1 to R5 and S1 to S5 are the ids in the `describe`
titles of their files (S4 is `S4 a ZipCrypto entry above 1 GiB (V16)`). L1, O1 and W5
are ids of this table only: those suites are named by their `describe` title
(`payloads above MAX_CHUNK (V16)`, `glob() options`, `passwords outside ASCII
(ENCRYPTED-006)`).

Not demonstrated: the extra field half of P24. No public API lets a caller set an extra
field over 65535 bytes (`ZipArchiveEntry` is not exported). The name of 900 MB of V16 is
not run either.

### 14.3 Cargo tests (`cargo test --workspace`, debug and `--release`) and the shared vectors

**Unit tests next to each module.** Each Rust source file has a `#[cfg(test)] mod tests`
written by the unit that owns the file (section 2, unit loop step 1). The table assigns the
mandatory vectors; the test name is binding, because
`crates/archiver-core/tests/LEDGER.tsv` lists every name of this table as
`<module path>::tests::<name>` and `scripts/check-test-ledger.mjs` fails unless
`cargo test --workspace -- --list` contains each of them (14.5). More tests may be added.
Compressed sizes are never asserted as constants: only `csize == payload length`,
`+ 12` (ZipCrypto) or `+ 28` (AES), because the length of a deflate stream is a property
of miniz_oxide, not of the container (V1; zlib itself emits 2 bytes for an empty stream at
levels 1 to 9 and 5 bytes at level 0). An expected value that a unit adds beyond this table
comes from upstream, by running the upstream function (or Node's zlib, for the gzip
header) under node; it is never obtained by running the port. A function with a parameter
that selects a branch is tested with every value of it (K4). The generated tables under
`crates/archiver-core/tests/golden/` belong to tests-golden and are asserted by `golden.rs`
only; a `#[cfg(test)]` module carries its own rows and does not include them.

| File | Test name | Vector |
|---|---|---|
| `numeric.rs` | `to_int32_vectors` | NaN and both infinities give 0; 2147483648.0 gives -2147483648; -0.5 gives 0; 4294967297.0 gives 1 |
| `numeric.rs` | `radix8_sign_magnitude` | -1 gives `"-1"`; 8 gives `"10"` |
| `numeric.rs` | `write_at_bounds` | a string longer than the rest of the buffer is cut at the end, on a character boundary, without panic |
| `crc32.rs` | `buf_16384_pattern` | the 16384-byte `i & 255` buffer gives 3893830384 |
| `crc32.rs` | `buf_text_file` | `'this is a text file'` gives 585446183; `'test'` gives 3632233996 |
| `crc32.rs` | `buf_seed_chaining` | `buf(b, buf(a, 0)) == buf(a + b, 0)` for a split at every position of a 300-byte input |
| `json.rs` | `append_slices` | `append` over two slices equals `append` over the whole buffer; sizes add up |
| `crc32_stream.rs` | `deflate_counts_and_roundtrip` | `compressed_size` equals the bytes appended to `out` including the final flush; inflating them returns the input; an empty input still gives a non-empty stream |
| `crc32_stream.rs` | `zlib_level_mapping` | -1 gives 6, -5 gives 6, 10 gives 9 |
| `crc32_stream.rs` | `deflate_loop_exits` | the out-of-order table of 6.4 for `DeflateCRC32Stream`: after `_flush`, a non-empty `_transform` returns `Err(DeflateError("no progress"))` and appends nothing, an empty one returns `Ok` and appends nothing, a second `_flush` returns `Ok` and appends nothing; one `_transform` whose output is larger than the 32 KiB reserve, followed by `_flush`, inflates to the input |
| `gzip.rs` | `header_and_trailer` | header `1f 8b 08 00 00 00 00 00 XFL OS` with XFL 2 for level 9, 4 for level 1, 0 for level 6, 4 for strategy 2; trailer CRC and length; an empty input is a full member |
| `gzip.rs` | `calls_after_finish` | the out-of-order table of 6.4 for `Gzip`: a non-empty `write` after `finish` returns `Err(DeflateError("no progress"))`, an empty one returns `Ok` and appends nothing, a second `finish` appends exactly the 8 trailer bytes again |
| `zip/util.rs` | `date_to_dos_vectors` | 2013-01-03T14:26:38Z gives bytes `53 73 23 42`; year 1979 gives 2162688; year 2044 gives 2141175677; all-NaN fields give 0 |
| `zip/utils.rs` | `sanitize_not_idempotent` | `'c:c:/x'` gives `'c:/x'`, which gives `'x'` |
| `zip/utils.rs` | `normalize_path_vectors` | both values of `strip_trailing` (K4), each row as `false`, then `true`: `'a\\b//c/'` gives `'a/b/c/'` and `'a/b/c'`; `'//'` gives `'/'` and `''`; `'\\?\'` gives `'/?/'` and `'/?'`; `'\\?\C:\foo'` gives `'//?/C:/foo'` for both |
| `zip/general_purpose_bit.rs` | `encode_bits` | descriptor `08 00`, UTF-8 `00 08`, encryption `01 00`, and their combinations |
| `zip/zip_archive_entry.rs` | `unix_mode_exattr` | the four values of 10.3 |
| `zip/zip_stream.rs` | `entry_replay_order` | the statement order of 6.10 (name with prepended slash, store, comment, mode) on one entry |
| `zip/archive_output_stream.rs` | `guards_and_set_offset` | the two guard errors; `set_offset(6)` before `entry` gives local header offset 6 in the central header and a central directory offset 6 higher (ZIP-135) |
| `zip/zip_archive_output_stream.rs` | `plain_entry_shapes` | every plain row of 17.2, including "stored buffer above 4 GiB" with `Source::Buffer { len: 0x1_0000_0000, crc }` and no payload |
| `zip/encrypted/crc.rs` | `table_spot_values` | `CRC_TABLE[1] == 0x77073096`, `CRC_TABLE[255] == 0x2d02ef8d` |
| `zip/encrypted/crypto_cipher.rs` | `keys_after_init_123` | keys after init with password `'123'` are `e0be8d5d 70bb3140 7e983fff`; a fresh cipher encrypts `'hello world!'` to `28f94f360b86831bd528b11a` |
| `zip/encrypted/crypto_stream.rs` | `header_check_bytes` | with an injected header, decrypting the first 12 output bytes gives the header with bytes 10 and 11 replaced by CRC bits 16..23 and 24..31 (ENCRYPTED-028) |
| `zip/encrypted/decrypto_stream.rs` | `roundtrip_across_splits` | decrypt(encrypt(x)) is x for input split at 1, 11, 12 and 13 bytes |
| `zip/encrypted/zip_crypto_stream.rs` | `zip20_entry_shapes` | the zip20 rows of 17.2; `csize == payload length + 12`; the stored empty entry writes no header bytes (P17) |
| `zip/encrypted/aes_hmac_etm_stream.rs` | `hello_with_fixed_salt` | password `'123'`, salt `000102030405060708090a0b0c0d0e0f`: verifier `56d8`; `'hello'` gives ciphertext `dd9090588d` and MAC `073e32b0fc7af3f25cca`; empty input gives MAC `742c47b8abe1b07dfc30` |
| `zip/encrypted/zip_aes_stream.rs` | `aes_extra_and_shapes` | extra `0199070001004145030800` (deflate) and `0199070001004145030000` (stored); the aes256 rows of 17.2; `csize == payload length + 28` |
| `tar/headers.rs` | `mtime_table` | every row of 10.6 |
| `tar/headers.rs` | `name_split` | the `60a/60b/60c` style split (TAR-JSON-069) |
| `tar/headers.rs` | `pax_record` | `15 path=é.txt\n` |
| `tar/headers.rs` | `add_length_powers_of_ten` | the integer formula of 11.6 for body lengths 7, 8, 9, 96, 97, 98, 995, 996, 997 |
| `tar/pack.rs` | `overflow_and_end` | `overflow` of 0, 512 and 513; `finalize` appends 1024 zero bytes exactly once |

**Golden byte tests** (`crates/archiver-core/tests/golden.rs`, unit tests-golden). The Rust tests
read no JSON and need no parser (12.1): `scripts/capture-golden.mjs` writes Rust.

- The capture script first runs `scripts/verify-oracle-versions.mjs` (14.2), then drives
  the upstream **engines directly**, not archiver core: `new ZipStream(options)` of
  zip-stream 7.0.5 with `entry(source, data, callback)` and `finalize()`; `ZipAesStream`
  and `ZipCryptoStream` of archiver-zip-encrypted 2.0.0 (`lib/aes/zip-aes-stream.js`,
  `lib/zip20/zip-crypto-stream.js`) the same way; `pack()` of tar-stream 3.2.2 with
  `entry(header, body, callback)` and `finalize()`. No archiver core, plugin, queue or file
  system is involved, so no translation by the not-yet-verified TypeScript layer is needed:
  the inputs of a scenario are the inputs of the sans-IO API after the marshalling of 5.6,
  which the script performs with the expressions this guide pins for the call sites.
  - zip: every scenario passes `data` that `_normalizeFileData` changes only by filling
    defaults (the name is a fixed point of `sanitizePath`, `date` is a `Date`, `mode` is a
    number or absent). `ZipEntryData` is then: `name`; the six `getUTC*` values of `date`
    (the script runs with `TZ=UTC` and never sets `forceLocalTime`; an Invalid Date gives
    six NaN); `!!namePrependSlash`; `!!store`; `comment` or `''`; `mode`. A symlink entry is
    recorded as zip-stream/index.js:137-148 transforms it (mode `| 40960`, payload = the
    link name bytes). `level` is `options.zlib.level` after `_defaults`.
  - encryption: `key` is the password bytes; `random` is the fixed AES salt passed as
    `options.salt`, or the fixed 12 ZipCrypto bytes, which the script injects upstream by
    replacing `crypto.randomBytes` with a function returning them for every call of
    length 12.
  - tar: every header field is set explicitly, including `mtime`. The recorded `Header` is
    the header object as it is after `pack.entry` returned (pack.js:147-152 fills its
    defaults into the caller's object), marshalled with the expressions of the `_encode`
    call in 7.8.
- It writes, into `crates/archiver-core/tests/golden/`: one `<name>.bin` per scenario (the
  upstream bytes), and `scenarios.rs`, a generated file that contains only constants of the
  types below (defined by hand in `golden.rs`, which includes the file with
  `#[path = "golden/scenarios.rs"] mod scenarios;`):

```rust
pub enum Payload { Buffer(&'static [u8]), Stream(&'static [&'static [u8]]) }   // Stream: fed with one write_data per chunk
pub enum Compare { Bytes, Structure }                  // Structure: headers equal, payload compared after inflating
pub struct ZipEntry {
    pub name: &'static str,
    pub date: [f64; 6],                                // DateFields in declaration order; f64::NAN for an Invalid Date
    pub name_prepend_slash: bool,
    pub store: bool,
    pub comment: &'static str,
    pub mode: Option<i32>,
    pub payload: Payload,
}
pub struct ZipScenario {
    pub name: &'static str,                            // file stem of the .bin
    pub encryption: u8,                                // 0, 1, 2 as WasmZipStream::new
    pub force_zip64: bool,
    pub level: i32,
    pub archive_comment: &'static str,
    pub key: &'static [u8],
    pub random: &'static [u8],                         // the same for every entry of the scenario
    pub entries: &'static [ZipEntry],
    pub compare: Compare,
    pub expected: &'static [u8],                       // include_bytes!("<name>.bin")
}
pub struct TarHeader {                                 // field for field archiver_core::tar::Header
    pub name: &'static str, pub typeflag_is_5: bool, pub mode: i32,
    pub uid_oct: &'static str, pub gid_oct: &'static str, pub size: f64, pub size_oct: &'static str,
    pub mtime: f64, pub type_: &'static str,
    pub linkname: Option<&'static str>, pub uname: Option<&'static str>, pub gname: Option<&'static str>,
    pub devmajor_oct: &'static str, pub devminor_oct: &'static str,
}
pub struct TarEntry { pub header: TarHeader, pub pax: Option<&'static [&'static str]>, pub body: &'static [u8] }
pub struct TarScenario { pub name: &'static str, pub entries: &'static [TarEntry], pub expected: &'static [u8] }

// generated: scenarios.rs
pub const UPSTREAM_VERSIONS: &[(&str, &str)] = &[/* the oracle table of 14.2 */];
pub const ZIP_SCENARIOS: &[ZipScenario] = &[/* ... */];
pub const TAR_SCENARIOS: &[TarScenario] = &[/* ... */];
```

- `golden.rs` has three tests, all in the ledger: `zip_scenarios`, `tar_scenarios`,
  `sanitize_path_vectors`. A zip scenario is replayed through `ZipStream`: for a
  `Payload::Buffer`, `entry` with `Source::Buffer { len, crc: crc32::buf(payload, 0) }`;
  status `StoredBuffer`: append `take_output()`, then the payload, to the result, call
  `complete_stored()`; otherwise `write_data(payload)` unless it is empty, then
  `end_data()`. For a `Payload::Stream`: `Source::Stream`, one `write_data` per chunk,
  `end_data()`. For ZipCrypto `end_data()` is the sequence of `SmartStream._flush` (7.5):
  `take_output()` (the buffered chunks), `end_data()`, `encrypt_data` of a non-empty
  buffer, `encrypt_end()`. Then `inner.set_comment`, `inner.finish()`. A tar scenario is replayed through `Pack`:
  `_encode(header, pax)`, `push(body)`, `overflow(pack, header.size)` per entry, then
  `finalize()`. `Compare::Bytes` asserts equality with `expected`; `Compare::Structure`
  walks both archives record by record and applies the deflated-zip rule of 14.2.
- The scenarios (binding list; the script produces exactly these):

| Name | Engine | Entries | Options | Compare |
|---|---|---|---|---|
| `zip-stored-buffers` | plain | `a.txt` = `'this is a text file'`, `store`, mode 420; `empty.txt` = empty buffer, default method (P14); `d/` = empty buffer, mode 493; `link` = symlink to `a.txt` | level 1 | Bytes |
| `zip-stored-stream` | plain | `stream.txt` in two chunks, `store` | level 1 | Bytes |
| `zip-names-comments` | plain | `é.txt` with entry comment `ü`; `p.txt` with `namePrependSlash`; archive comment `archive ü` | level 1 | Bytes |
| `zip-dos-dates` | plain | three stored entries dated 1979-12-31T23:59:59Z, 2044-01-01T00:00:00Z and Invalid Date | level 1 | Bytes |
| `zip-force-zip64` | plain | one stored buffer | `forceZip64` | Bytes |
| `zip-deflate` | plain | one buffer and one stream of 4000 bytes each, default method | level 6 | Structure |
| `zip20-stored` | ZipCrypto | stored buffer, stored stream, directory `d/` (P17) | password `123`, fixed 12 bytes | Bytes |
| `aes-stored` | AES-256 | stored buffer, stored stream, directory `d/` | password `123`, fixed 16-byte salt | Bytes |
| `tar-basic` | tar | file `a.txt` (19 bytes), directory `d/`, symlink `link` | | Bytes |
| `tar-long-names` | tar | names of 100, 101, 155+100 and 300 bytes, and `é.txt` | | Bytes |
| `tar-mtime` | tar | one empty file per row of 10.6 | | Bytes |
| `tar-fields` | tar | uid 1000, gid 1001; `uname` / `gname` of 5 and of 40 characters (P12); `devmajor` 8; caller `pax` `{ comment: 'x' }`; bodies of 512 and 513 bytes | | Bytes |

- Golden files are committed; the capture script is re-run only when the upstream pin
  changes, and `UPSTREAM_VERSIONS` records what it ran against.

**Shared sanitizer vectors (R6).** The same run of `scripts/capture-golden.mjs` builds one
in-memory table from the upstream functions, rows `[input, normalizePath(input, false),
sanitizePath(input)]`, and writes it twice: as `tests/vectors/sanitize-path.json` and as
`crates/archiver-core/tests/golden/sanitize_path_vectors.rs`
(`pub const SANITIZE_PATH_VECTORS: &[(&str, &str, &str)]`). Inputs contain no lone
surrogates, so each is a valid Rust string literal. The Rust copy is asserted by the
`sanitize_path_vectors` test of `golden.rs` against `zip/utils.rs`. The three TypeScript
copies are each asserted by a test file beside them (unit tests-golden):
`src/utils.test.ts`, `src/zip-stream/utils.test.ts` and `src/normalize-path.test.ts`.
They run under `tsx`
(`mocha --no-config -n import=tsx "src/**/*.test.ts"`, script `test:unit`). These are the
only tests that import from `src/` directly; they can, because these three modules do not
load the wasm. Every other test goes through the built package.

### 14.4 Extraction with independent tools

Archives produced by archiver-wasm in the differential run are also opened by tools that share no
code with archiver-wasm: `7z t` and `7z x` (with `-p` for both encryption methods), `yauzl`, `tar -tf`
and `tar -xf`, npm `tar` 6 `Parse`, and `gzip -t` for tar.gz. Extracted file contents, modes
and symlink targets are compared with the inputs. Archives that reproduce P17 are compared
with upstream byte for byte and are excluded from the extraction check, since upstream's
own output is malformed there.

### 14.5 Test count ledger

`tests/upstream/LEDGER.tsv` has one row per spec file: suite, file, sha256 of the vendored
file, number of `it(` cases (24, 16, 1, 1, 1, 3, 4, 2). `scripts/verify-upstream-tests.mjs`
recomputes the hashes against `tests/upstream/SHA256SUMS` (and against `.upstream/` when it
is present). `scripts/check-test-ledger.mjs` runs both suites with `--reporter json` and
fails unless, per file, `tests == passes == ledger count`, `pending == 0` (on non-Windows)
and `failures == 0`, and the totals are 40 and 12. The same script checks the Rust side:
`crates/archiver-core/tests/LEDGER.tsv` has one row per required cargo test (the names of the
table in 14.3 as `<module path>::tests::<name>`, plus `zip_scenarios`, `tar_scenarios` and
`sanitize_path_vectors` of `golden.rs`), and the script fails unless
`cargo test --workspace -- --list` prints every one of them. A crate with no tests can
therefore not pass. CI (`.github/workflows/ci.yml`, 15.5) runs the ledger check on Linux
and macOS for every supported Node major.

### 14.6 Not allowed

Editing a vendored test, helper or fixture; `--grep`, `--invert`, `.skip`, `.only`;
raising a timeout to hide a hang; catching an error in a shim; making a shim smarter than a
re-export (the aes-js patch above is the single exception and is upstream's own code);
deleting or regenerating a golden file to make a test pass without a recorded upstream
reason.

---

## 15. Build and packaging

### 15.1 Workspace (scaffold unit, verbatim)

```toml
# Cargo.toml
[workspace]
members = ["crates/archiver-core", "crates/archiver-wasm"]
resolver = "2"

[workspace.lints.clippy]
debug_assert_with_mut_call = "deny"
new_without_default = "allow"      # the pinned argument-less `new()` of CRC32Stream, GeneralPurposeBit, Pack, WasmPack mirror upstream constructors; no Default impls are added
needless_range_loop = "allow"      # upstream's counting loops that index are ported as counting loops (deps/tar-stream/headers.js:237-238); RS-40

[profile.release]
lto = true
codegen-units = 1
panic = "abort"
```

The release profile does not set `opt-level`: 3 is cargo's default for that profile.

Both crate manifests add `[lints] workspace = true`. The `allow` entries are the complete
list of clippy lints that the port silences, and each names the upstream spelling that
needs it. A lint that fires on another upstream spelling is added here, in the same form,
before any file is changed (RS-40); no file carries an `#[allow(...)]` of its own beyond
the attributes this guide prints.

### 15.2 Building the wasm (`scripts/build-wasm.sh`, scaffold unit)

```bash
#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
rm -rf dist/wasm
wasm-pack build crates/archiver-wasm --release --target nodejs --out-dir ../../dist/wasm --out-name archiver_wasm --no-pack
rm -f dist/wasm/.gitignore dist/wasm/package.json dist/wasm/README.md dist/wasm/archiver_wasm_bg.wasm.d.ts
mv dist/wasm/archiver_wasm.js dist/wasm/archiver_wasm.cjs
mv dist/wasm/archiver_wasm.d.ts dist/wasm/archiver_wasm.d.cts
node -e "const w = require('./dist/wasm/archiver_wasm.cjs'); if (typeof w.WasmZipStream !== 'function' || w.crc32Update(0, Buffer.from('test')) !== 3632233996) process.exit(1)"
```

The `nodejs` target emits CommonJS glue that reads `archiver_wasm_bg.wasm` next to itself with
`fs.readFileSync` and instantiates it with `new WebAssembly.Module` /
`new WebAssembly.Instance`, synchronously, when the file is required. That is the
synchronous load the tests need (`new JsonArchive()` at module evaluation time, TESTS-015).
The file is renamed to `.cjs` because the package is `"type": "module"`. `wasm-pack` also
writes `archiver_wasm_bg.wasm.d.ts`, the declarations of the raw wasm exports, which nothing
imports; it is removed so that `dist/wasm/` holds exactly the three files of 15.5. The
output directory is inside `dist/`, next to the two bundles that load it (15.3). The script
removes `dist/wasm` only, never `dist`: `npm run build` runs tsdown first, which cleans
`dist/` and writes the bundles, and this script after it (15.4). The last line
fails the build if a future toolchain stops emitting CommonJS. The build is always
`--release`: wasm-pack's dev profile makes the glue assert argument types, which would
replace the number coercions that section 5.6 relies on with thrown errors. `wasm-opt` is
switched off in the crate manifest (12.1): the gate confirmed that the build is complete
without it, and that with it the result depends on whichever `wasm-opt` is on `PATH` (2.2).
The last line runs under whatever Node executes the build, which in CI is Node 24 (15.5).
It does not show that an old V8 can load the `.wasm`. The tests show that: every job of the
matrix runs them under its own Node, down to the lowest supported major (Node 18), and
they load `dist/wasm/archiver_wasm.cjs` through the two bundles. A `.wasm` that the current
Rust emits but an old V8 cannot load fails there, not at a user's site. The command line,
the Rust version and the wasm-pack version are the ones the toolchain gate proved (2.2);
only the output directory has changed since.

### 15.3 Loading it (`src/wasm.ts` and `src/wasm-types.ts`, scaffold unit, verbatim)

```ts
// src/wasm-types.ts: the TypeScript view of section 5.3. Hand-written; nothing is imported from dist/wasm/.
export interface WasmZipEntryInfo {
  readonly name: string;
  readonly size: number;
  readonly csize: number;
  readonly crc: number;
  readonly method: number;
  readonly time: number;
  readonly minver: number;
  readonly platform: number;
  readonly exattr: number;
  readonly inattr: number;
  readonly gpb: number;
  readonly extra: Uint8Array;
  readonly comment: string;
  readonly offsetFile: number;
  readonly offsetData: number;
  readonly offsetContents: number;
  free(): void;
}
interface WasmZipStream {
  setComment(comment: string): void;
  setOffset(offset: number): void;
  entry(
    name: string,
    year: number, month: number, date: number, hours: number, minutes: number, seconds: number,
    namePrependSlash: boolean, store: boolean, comment: string,
    hasMode: boolean, mode: number, level: number,
    key: Uint8Array, random: Uint8Array,
    isBuffer: boolean, sourceLen: number, sourceCrc: number,
  ): number;
  completeStored(): void;
  writeData(chunk: Uint8Array): void;
  endData(): void;
  encryptData(chunk: Uint8Array): void;
  encryptEnd(): void;
  finish(): void;
  takeOutput(): Uint8Array;
  isZip64(): boolean;
  centralOffset(): number;
  centralLength(): number;
  lastEntry(): WasmZipEntryInfo | undefined;
  free(): void;
}
interface WasmPack {
  paxRecord(body: string): void;
  encode(
    name: string, typeflagIs5: boolean, mode: number,
    uidOct: string, gidOct: string, size: number, sizeOct: string, mtime: number, type: string,
    linkname: string | undefined, uname: string | undefined, gname: string | undefined,
    devmajorOct: string, devminorOct: string, forcePax: boolean,
  ): void;
  overflow(size: number): void;
  finalize(): void;
  takeOutput(): Uint8Array;
  free(): void;
}
interface WasmGzip { write(chunk: Uint8Array): Uint8Array; finish(): Uint8Array; free(): void }
export interface WasmCryptoCipher { encrypt(data: Uint8Array): Uint8Array; decrypt(data: Uint8Array): Uint8Array; free(): void }
export interface WasmCryptoStream { transform(data: Uint8Array): Uint8Array; free(): void }
export interface WasmDecryptoStream { transform(data: Uint8Array): Uint8Array; getTotalSize(): number; free(): void }
export interface WasmAesHmacEtmStream {
  transform(data: Uint8Array): Uint8Array; flush(): Uint8Array; getTotalSize(): number; free(): void;
}

export interface ArchiverWasm {
  WasmZipStream: new (forceZip64: boolean, encryption: number) => WasmZipStream;
  WasmPack: new () => WasmPack;
  WasmGzip: new (level: number, strategy: number, os: number) => WasmGzip;
  WasmCryptoCipher: new (key: Uint8Array) => WasmCryptoCipher;
  WasmCryptoStream: new (key: Uint8Array, crc: number, header: Uint8Array) => WasmCryptoStream;
  WasmDecryptoStream: new (key: Uint8Array) => WasmDecryptoStream;
  WasmAesHmacEtmStream: {
    new (aesKey: Uint8Array, hmacKey: Uint8Array, passwordVerifier: Uint8Array, salt: Uint8Array): WasmAesHmacEtmStream;
    deriveKey(salt: Uint8Array, key: Uint8Array): Uint8Array;
  };
  jsonAppend(seed: number, chunk: Uint8Array): number;
  crc32Update(seed: number, chunk: Uint8Array): number;
}
```

```ts
// src/wasm.ts
import { createRequire } from 'node:module';
import type { ArchiverWasm } from './wasm-types.js';

export type { ArchiverWasm, WasmZipEntryInfo } from './wasm-types.js';

// __filename exists in the CommonJS bundle; import.meta.url is the ES module one.
const nodeRequire = createRequire(typeof __filename === 'string' ? __filename : import.meta.url);

/**
 * The instantiated wasm module. Loaded synchronously when this module is evaluated.
 * The path is relative to the bundle (dist/index.mjs, dist/index.cjs): scripts/build-wasm.sh
 * writes the glue to dist/wasm. Both bundles load the same file, so there is one wasm instance.
 */
export const wasm = nodeRequire('./wasm/archiver_wasm.cjs') as ArchiverWasm;

export const EMPTY: Buffer = Buffer.alloc(0);

/** Largest payload slice one wasm call may carry (5.4, V16). */
export const MAX_CHUNK = 1024 * 1024;

/** Wraps wasm output (a JS-owned Uint8Array) as a Buffer without copying. */
export function toBuffer(u8: Uint8Array): Buffer {
  return Buffer.from(u8.buffer, u8.byteOffset, u8.byteLength);
}

/** Guards an argument of a `&str` or `Option<String>` parameter: the glue traps on most non-strings (5.6). */
export function wasmString(value: unknown): string {
  if (typeof value !== 'string') { throw new TypeError('expected a string'); }
  return value;
}
```

`./wasm/archiver_wasm.cjs` is a path relative to the bundle: `dist/index.mjs` and
`dist/index.cjs` both sit next to `dist/wasm/`, where `scripts/build-wasm.sh` writes the
glue (15.2). It is not correct from `src/` unbundled, and no unbundled code path loads
wasm: the TypeScript unit tests (`src/**/*.test.ts`, 14.3) import only
`src/normalize-path.ts` and the two `sanitizePath` utilities (`src/utils.ts`,
`src/zip-stream/utils.ts`), none of which imports `src/wasm.ts`. Both bundles require the
same file, so a process that loads both has one wasm instance (Node's module cache, V20).
The call goes through `nodeRequire`, so the bundler leaves it alone (and so does a bundler
in an application: 1.2). `createRequire` accepts a path or a `file:` URL. In the CommonJS
bundle it gets `__filename`, in the ESM bundle `import.meta.url`. `tsdown.config.ts` sets
no shim option, and the first branch does not need one (2.2).

`wasmString` is the one guard for string arguments (5.6). It is an addition with no
upstream counterpart: a string passes through unchanged, so no call inside the contract of
the published types behaves differently, and a value outside it becomes a `TypeError`
thrown at the call site instead of a trap (V14). In `_engineEntry` the call site is inside
the `try` of `_appendBuffer` / `_appendStream`, so there it reaches the entry callback.

No TypeScript file imports types from `dist/wasm/`. `tsc --noEmit` and every TypeScript unit
therefore work without a Rust toolchain and before any Rust code exists; the interface
above is what they are written against, member for member the listing of 5.3 under the
marshalling rules of 5.6 (`f64`, `u8`, `u16`, `u32`, `i32` are `number`; `&[u8]` and
`Vec<u8>` are `Uint8Array`; `Option<String>` is `string | undefined`; `Result<T, JsError>`
is `T` and a thrown `Error`; a `#[wasm_bindgen(getter)]` is a `readonly` property; every
class has `free()`).

Drift between the two listings is caught by `scripts/check-wasm-types.mjs` (scaffold unit),
which `npm run build` runs last, after tsdown and the wasm build: it writes a temporary
TypeScript file that assigns `typeof import('<root>/dist/wasm/archiver_wasm.cjs')` to a variable of
type `ArchiverWasm` (imported from `src/wasm-types.ts`), runs `tsc --noEmit --strict` on it and
exits non-zero if tsc reports an error. The check is one-directional: the generated surface
must satisfy the interface. An export that exists in Rust but not in 5.3 is a review
finding for unit rs-wasm.

### 15.4 Bundling and the two module formats

```ts
// tsdown.config.ts (scaffold unit, verbatim)
import { defineConfig } from 'tsdown';

const shared = {
  platform: 'node' as const,
  target: 'node18',
  fixedExtension: true,
  tsconfig: 'tsconfig.json',
  dts: true,
  sourcemap: true,
  deps: { neverBundle: true as const },
};

export default defineConfig([
  { ...shared, entry: { index: 'src/index.ts' }, format: 'esm', clean: true },
  // A default-only entry: tsdown emits `module.exports = archiver` and `export = archiver`.
  {
    ...shared,
    entry: { index: 'src/commonjs.ts' },
    format: 'cjs',
    clean: false,
    publint: { strict: true },
    attw: { level: 'error' as const },
  },
]);
```

Two builds, one per module format. The first bundles `src/index.ts` into `dist/index.mjs`
with the declarations `dist/index.d.mts`. The second bundles `src/commonjs.ts` into
`dist/index.cjs` with the declarations `dist/index.d.cts`. Each bundle has a source map.
`fixedExtension` gives those extensions to both formats. `deps.neverBundle` keeps the
dependencies out of the bundles: `minimatch` and `streamx` are loaded from `node_modules`
when the package runs. Only the first build cleans `dist/`, so the second does not delete
what the first wrote, and the wasm build comes after both (15.2). On the CommonJS build
tsdown runs publint in strict mode and attw at level `error`: the `package.json` and the
declarations are checked by the build itself.

tsdown 0.23.1 declares `node: ^22.18.0 || ^24.11.0 || >=26.0.0`. The package supports
Node 18 and newer (`engines`, and `target: 'node18'` above). The build therefore needs a
newer Node than the package: CI builds under Node 24 and tests under every supported major
(15.5).

No entry is written by hand. The CommonJS entry must be the archiver 7 vending function
itself, with everything else attached to it (TESTS-073). A bundler's CJS output for
`src/index.ts` is an exports object with a `default` member, so the `require` bundle is
built from a second source file that has only a default export. For such an entry tsdown
emits `module.exports = archiver` in `dist/index.cjs` and `export = archiver` in
`dist/index.d.cts`:

```ts
// src/commonjs.ts (scaffold unit, verbatim)
// The CommonJS entry. `require('archiver-wasm')` is the archiver 7 vending function itself, with
// every export of src/index.ts as a property (archiver 7: `require('archiver')('zip')`).
import * as m from './index.js';

function archiver(format: string, options?: m.ArchiverOptions): m.Archiver {
  return m.default(format, options);
}

namespace archiver {
  export import Archiver = m.Archiver;
  export import ZipArchive = m.ZipArchive;
  export import TarArchive = m.TarArchive;
  export import JsonArchive = m.JsonArchive;
  export import ArchiverError = m.ArchiverError;
  export import ZipEncrypted = m.ZipEncrypted;
  export import ZipAesStream = m.ZipAesStream;
  export import AesHmacEtmStream = m.AesHmacEtmStream;
  export import ZipCryptoStream = m.ZipCryptoStream;
  export import CryptoStream = m.CryptoStream;
  export import DecryptoStream = m.DecryptoStream;
  export import CryptoCipher = m.CryptoCipher;
  export import create = m.create;
  export import registerFormat = m.registerFormat;
  export import isRegisteredFormat = m.isRegisteredFormat;
}

// The types of src/types.ts as members: `import archiver = require(...)`, then `archiver.EntryData`.
// Ambient, so nothing is emitted for it.
declare namespace archiver {
  export import DateFields = m.DateFields;
  export import EntryData = m.EntryData;
  export import EntryDataFunction = m.EntryDataFunction;
  export import ProgressData = m.ProgressData;
  export import GlobOptions = m.GlobOptions;
  export import ArchiverEvents = m.ArchiverEvents;
  export import ModuleCallback = m.ModuleCallback;
  export import ArchiverModule = m.ArchiverModule;
  export import ModuleConstructor = m.ModuleConstructor;
  export import CoreOptions = m.CoreOptions;
  export import ZipOptions = m.ZipOptions;
  export import TarOptions = m.TarOptions;
  export import EncryptedOptions = m.EncryptedOptions;
  export import CryptoStreamOptions = m.CryptoStreamOptions;
  export import DecryptoStreamOptions = m.DecryptoStreamOptions;
  export import AesHmacEtmStreamOptions = m.AesHmacEtmStreamOptions;
  export import ArchiverOptions = m.ArchiverOptions;
  export import Match = m.Match;
  export import QueueTask = m.QueueTask;
}

// Transpiled `import archiver from` reads `.default` of the required module.
(archiver as { default?: unknown }).default = archiver;

export default archiver;
```

It is a function merged with two namespaces. The value members are in a normal namespace:
`export import X = m.X` there emits the property assignment, so every value export of
`src/index.ts` is a property of the function. The type members are in an ambient
`declare namespace`, for which nothing is emitted. They are import aliases too: a plain
`export type X = m.X` in that namespace was flattened by the declaration bundler into
`type X = X` (TS2456). With `export = archiver` as the `require` types,
`import archiver = require('archiver-wasm'); archiver('zip')` type-checks, and so do
`archiver.create`, `new archiver.ZipArchive()` and `archiver.EntryData`. The alias lists
must follow 7.1 and 7.2: an export added to `src/index.ts` or a type added to
`src/types.ts` gets a line here in the same change. `scripts/check-tarball.mjs` fails when
the export names of the two bundles differ (15.5), and the CommonJS TypeScript smoke check
of section 16 item 4 compiles against `dist/index.d.cts` in every CI job; if tsc rejects
it, this section is corrected first (M8).

The ESM entry does not re-export the CommonJS one. `import` loads `dist/index.mjs` and
`require` loads `dist/index.cjs`: two bundles of the same sources, each with its own set
of classes. A process that loads both therefore has two `Archiver` constructors and two
`ArchiverError` constructors, and `instanceof` does not hold across the two module formats
(V20). Two things are shared.

The format registry. `src/vending.ts` keeps `formats` on a global symbol, and only the
bundle that loads first registers the built-in formats:

```ts
// src/vending.ts (unit ts-entry; the lines that differ from upstream's `var formats = {}` and its three registrations)
// One registry for the ES module bundle and the CommonJS bundle of this package: a format
// registered through `require` is visible to `import` and the reverse (PORTING.md 15.4).
var REGISTRY = Symbol.for('archiver-wasm.formats');
var shared = globalThis as { [REGISTRY]?: Record<string, ModuleConstructor> };
var registered = shared[REGISTRY] !== undefined;
var formats: Record<string, ModuleConstructor> = shared[REGISTRY] ??= {};
...
if (!registered) {
  vending.registerFormat('zip', Zip);
  vending.registerFormat('tar', Tar);
  vending.registerFormat('json', Json);
}
```

A format registered through `require` is visible to `import` and the reverse. Without the
guard the second bundle would throw `register(zip): format already registered` while it
loads.

The wasm instance. Both bundles `require` the same `dist/wasm/archiver_wasm.cjs` (15.3), which
Node's module cache evaluates once.

The node-archiver suite and the differential tests import `dist/index.mjs`, the encrypted
suite and the archiver 7 surface of the differential tests require `dist/index.cjs` (14.1,
14.2), so the tests run the files that are published. The top-level
`types` describes `main`, for a compiler that does not read `exports`
(`moduleResolution: node10`).

`package.json` (scaffold unit; this is the whole file and every field is binding. `version`
is the version that is published. The exact versions of `typescript`, `tsx` and
`@types/node` in `devDependencies` are the ones recorded by the toolchain gate, 2.2;
`tsdown`, `publint` and `@arethetypeswrong/core` are pinned exactly as well):

```json
{
  "name": "archiver-wasm",
  "version": "0.1.0",
  "description": "node-archiver ported to Rust and WebAssembly, with ZIP encryption built in",
  "license": "MIT",
  "repository": { "type": "git", "url": "git+https://github.com/thilllon/archiver-wasm.git" },
  "type": "module",
  "main": "./dist/index.cjs",
  "module": "./dist/index.mjs",
  "types": "./dist/index.d.cts",
  "exports": {
    ".": {
      "import": { "types": "./dist/index.d.mts", "default": "./dist/index.mjs" },
      "require": { "types": "./dist/index.d.cts", "default": "./dist/index.cjs" }
    },
    "./package.json": "./package.json"
  },
  "files": ["dist", "THIRD_PARTY_NOTICES.md"],
  "engines": { "node": ">=18" },
  "publishConfig": { "access": "public" },
  "dependencies": { "minimatch": "^10.2.2", "streamx": "^2.28.1" },
  "devDependencies": {
    "@arethetypeswrong/core": "0.18.5",
    "@types/mocha": "10.0.10",
    "@types/node": "18.19.130",
    "aes-js": "3.1.2",
    "archiver": "8.0.0",
    "archiver-zip-encrypted": "2.0.0",
    "chai": "6.2.2",
    "lazystream": "^1.0.1",
    "mkdirp": "3.0.1",
    "mocha": "11.7.5",
    "publint": "0.3.24",
    "readable-stream": "^4.7.0",
    "rimraf": "^5.0.5",
    "should": "^13.2.3",
    "tar": "6.2.1",
    "tsdown": "0.23.1",
    "tsx": "4.23.15",
    "typescript": "5.9.3",
    "yauzl": "3.3.0"
  },
  "overrides": {
    "zip-stream@^7.0.0": "7.0.5", "compress-commons@^7.0.0": "7.0.1", "crc32-stream@^7.0.0": "7.0.1", "crc-32@^1.0.0": "1.2.2",
    "tar-stream@^3.0.0": "3.2.2", "b4a@^1.0.0": "1.9.0", "readdir-glob@^3.0.0": "3.0.0", "async@^3.0.0": "3.2.6",
    "buffer-crc32@^1.0.0": "1.0.0", "is-stream@^4.0.0": "4.0.1", "normalize-path@^3.0.0": "3.0.0",
    "archiver@^7.0.0": "7.0.0", "zip-stream@^6.0.0": "6.0.0", "compress-commons@^6.0.0": "6.0.0", "crc32-stream@^6.0.0": "6.0.0",
    "archiver-utils@^5.0.0": "5.0.1"
  },
  "scripts": {
    "build:wasm": "bash scripts/build-wasm.sh",
    "build:ts": "tsdown",
    "build": "npm run build:ts && npm run build:wasm && node scripts/check-wasm-types.mjs",
    "typecheck": "tsc --noEmit",
    "test:rust": "cargo test --workspace && cargo test --workspace --release",
    "test:unit": "mocha --no-config -n import=tsx \"src/**/*.test.ts\"",
    "test:upstream:archiver": "cd tests/upstream/node-archiver && rm -f test/fixtures/directory/subdir/level0link.txt test/fixtures/directory/subdir/subsublink && mocha --reporter dot",
    "test:upstream:encrypted": "cd tests/upstream/archiver-zip-encrypted && mocha --require ../alias-archiver.cjs",
    "test:oracle": "node scripts/verify-oracle-versions.mjs",
    "test:differential": "npm run test:oracle && mocha --no-config \"tests/differential/*.test.mjs\"",
    "test:differential:slow": "npm run test:oracle && mocha --no-config --timeout 0 \"tests/differential/*.slow.mjs\"",
    "test:ledger": "node scripts/verify-upstream-tests.mjs && node scripts/check-test-ledger.mjs",
    "test": "npm run test:rust && npm run test:unit && npm run test:upstream:archiver && npm run test:upstream:encrypted && npm run test:differential && npm run test:ledger",
    "prepack": "npm run build",
    "prepublishOnly": "npm run build && npm test && node scripts/check-tarball.mjs"
  }
}
```

`npm run build` has a fixed order: tsdown first, because its first build cleans `dist/`;
then `scripts/build-wasm.sh`, which writes `dist/wasm/`; then
`scripts/check-wasm-types.mjs`, which reads `dist/wasm/`.
`npm test` expects a built tree (`npm run build` first; CI and `prepublishOnly` do that).
`dist/` is a gitignored build output and holds everything that is built, the wasm
included, so two hooks make a publish from a stale or
empty tree impossible: `prepublishOnly` builds, runs the whole matrix against that build
and checks the tarball; `prepack` builds again from the same sources when npm packs. Both
hooks build, so both need the Node of the build tools. The
`overrides` block pins the oracle trees of 14.2; if npm does not honor one of the entries,
`scripts/verify-oracle-versions.mjs` stops the run, and the entry is corrected here first.

The block is flat: each key is a package with the major range its dependents ask for, each
value the exact version of the oracle table. The two majors of `zip-stream`,
`compress-commons` and `crc32-stream` are told apart by the range in the key, and
`archiver@^7.0.0` leaves the root's own `archiver@8.0.0` alone. The form with one nested
object per oracle package (`"archiver@8.0.0": { ... }`,
`"archiver-zip-encrypted@2.0.0": { ... }`), which this guide first pinned, does not work
with npm 10, the npm of Node 18, 20 and 22: after `npm install`, `zip-stream` 7.0.5 resolved
`compress-commons` 6.0.0 and `crc32-stream` 6.0.0, and `npm ci` rejected the lockfile that the
same npm had just written (`Missing: zip-stream@6.0.0 from lock file`); a lockfile written
by npm 11 was rejected by npm 10 in the same way. With the flat block, npm 10.8.2, 10.9.4
and 11.19.0 each install every row of the oracle table at its version, and `npm ci` of
each of them accepts the lockfile of each other (2.2). The flat block also leaves the
`crc32-stream@^5.0.0` that `compress-commons` 6.0.0 asks for at 5.0.1, which is what the
lockfile of archiver-zip-encrypted 2.0.0 has; the nested form forced it to 6.0.0.

Three packages of the oracle table have no entry: `streamx` (2.28.1), `lazystream` (1.0.1)
and `aes-js` (3.1.2) are direct dependencies of the root, and npm refuses an override that
differs from a direct dependency's own range (`EOVERRIDE`). They are held at the table's
versions by `package-lock.json` (`aes-js` also by its exact range) and checked by
`scripts/verify-oracle-versions.mjs` like the others. An override pins the whole
development tree, not only the two oracle packages; it has no effect on what a consumer of
the published package installs.

`tsconfig.json`: `"target": "ES2022"`, `"module": "ESNext"`, `"moduleResolution": "Bundler"`,
`"strict": true`, `"verbatimModuleSyntax": true`, `"types": ["node", "mocha"]`, `"noEmit": true`,
`"include": ["src"]` (the test files `src/**/*.test.ts` are part of the `tsc` program, which is
why `mocha` is in `types`; they are not reachable from the tsdown entries, so they stay out of `dist/`). `noUncheckedIndexedAccess` stays off (a transliteration cannot satisfy
it without restructuring).

`.gitattributes`: `tests/upstream/**/fixtures/** -text`, `tests/upstream/**/resources/** -text`,
`crates/archiver-core/tests/golden/*.bin binary` (fixture bytes are pinned by CRC assertions,
TESTS-106). The fixture and golden trees are excluded from every formatter.

### 15.5 What the published tarball contains

13 files: `dist/index.mjs`, `dist/index.mjs.map`, `dist/index.d.mts`, `dist/index.cjs`,
`dist/index.cjs.map`, `dist/index.d.cts`, `dist/wasm/archiver_wasm.cjs`,
`dist/wasm/archiver_wasm_bg.wasm`, `dist/wasm/archiver_wasm.d.cts`, `package.json`, `README.md`,
`LICENSE`, `THIRD_PARTY_NOTICES.md`. Nothing from `src/`, `crates/`, `tests/`, `scripts/`
or `.upstream/`.

`scripts/check-tarball.mjs` (scaffold unit) is the executable form of that list: it runs
`npm pack --json --ignore-scripts --pack-destination <temporary directory>`. It packs the
`dist/` that `npm run build` wrote and runs no `prepack`, because it runs with the tests
under every supported Node, and tsdown cannot run under Node 18 or 20. It reads the JSON
report from the end of stdout and fails unless the file list contains `dist/index.mjs`,
`dist/index.d.mts`, `dist/index.cjs`, `dist/index.d.cts`, `dist/wasm/archiver_wasm.cjs`,
`dist/wasm/archiver_wasm_bg.wasm`, `dist/wasm/archiver_wasm.d.cts`, `THIRD_PARTY_NOTICES.md`
and nothing under `src/`, `crates/`, `tests/`, `.upstream/` or `scripts/`. Then it
installs the tarball into an empty temporary project
(together with `typescript` and `@types/node` at the repository's versions, for the
type checks) and runs the smoke checks of section 16 item 4 there under the Node that runs
the script (the TypeScript files are `smoke.cts`, `smoke.mts` and `smoke.ts`; a check that
has not exited after 120 s fails), then deletes the temporary directory and the tarball in it.
The "both formats" check (`formats.mjs`) imports the package and requires it in one
process: both have the same export names, the `require` result is the callable vending
function and its own `default`, a format registered through one is registered in the
other and `zip`, `tar` and `json` are registered in both, and the wasm glue is in the
module cache once.
With `--spec <package spec>` it packs nothing and installs that spec instead, so that the
same checks can be run against the registry.

`.github/workflows/ci.yml` (scaffold unit): on every push and pull request; matrix
`ubuntu-latest` and `macos-latest` by Node 18, 20, 22, 24. Every job installs and builds
under Node 24, because tsdown does not run under Node 18 or 20 (15.4), then switches to
the Node of the matrix for the tests. Steps: checkout, install `7z`
(`p7zip-full` with apt, `p7zip` with brew; TESTS-092), set up Node 24, install the Rust
toolchain named by `rust-toolchain.toml` with the wasm32 target, `rustfmt` and `clippy`
(`rustup toolchain install` with the channel read from that file), restore the cache of
cargo downloads (`~/.cargo/registry`; no dependency is a git dependency, so
`~/.cargo/git` is not cached) and of the `wasm-bindgen` CLI that `wasm-pack` fetches, install `wasm-pack`
at the pinned version from its release archive, verified against a recorded SHA-256
(12.3), `npm ci`, `cargo fmt --check`, `cargo clippy --workspace -- -D warnings`,
`npm run build`, `npm run typecheck`, set up the Node of the matrix, `npm test`,
`node scripts/check-tarball.mjs`.

`.github/workflows/release.yml` (scaffold unit): on a pushed tag `v<version>`, three jobs.
`build` fails unless the tag equals the `version` of `package.json`; same setup as CI on
`ubuntu-latest` with Node 24; `npm ci`; `npm run prepublishOnly`; `npm pack --ignore-scripts`;
uploads the archive as an artifact. It has no `id-token` permission, so build and test code
cannot request the OIDC identity. `publish` is the only job with `id-token: write`; it checks
out nothing, downloads the archive, requires npm 11.5.1 or later (Node 24) and runs
`npm publish <archive> --ignore-scripts --access public`. npm exchanges the OIDC identity of
the workflow for publish access (trusted publisher) and attaches provenance. No npm token
is stored in the repository. `verify`: it checks out the repository and sets up Node, and runs no `npm ci`, because the script
it runs imports only Node built-ins. `npm view archiver-wasm@<version> version` must print
the version, and a fresh `npm install archiver-wasm@<version>` in an empty project must
pass the smoke checks of section 16 item 4
(`node scripts/check-tarball.mjs --spec archiver-wasm@<version>`).

One-time owner setup. npm registers a trusted publisher only for a package that exists,
so the first version is published with the owner's own authentication:
`npm run prepublishOnly && npm publish --ignore-scripts --otp=<code>`. Then the owner
registers the trusted publisher of `archiver-wasm` on npmjs.com (package Settings,
Trusted Publisher, GitHub Actions) or with
`npm trust github archiver-wasm --repo thilllon/archiver-wasm --file release.yml --allow-publish`:

| Setting           | Value                                                    |
| ----------------- | -------------------------------------------------------- |
| Owner             | `thilllon`                                               |
| Repository        | `archiver-wasm`                                          |
| Workflow filename | `release.yml`                                            |
| Environment       | empty; the workflow does not name an environment         |

The workflow filename is part of the registration. `release.yml` is never renamed or moved.
Every later version is published by pushing its tag.

---

## 16. Definition of done

The port is done when all of the following hold on a clean checkout.

1. Every non-test unit of `PORTMAP.tsv` has been through implementer, two reviewers and
   fixer, and every row of `BEHAVIORS.tsv` is implemented at its target (or is one of the
   non-ports of 3.4).
2. No stub, no `todo!`/`unimplemented!`, no `any` in `dist/index.d.mts` or `dist/index.d.cts`, no `@ts-ignore`, no
   `#[allow(dead_code)]` hiding an unported function, no paragraph-long justification
   comment (M6, M7).
3. `cargo fmt --check`, `cargo clippy --workspace -- -D warnings`, `cargo test --workspace`
   and `cargo test --workspace --release` pass, and the cargo half of the ledger check
   passes (every test name of 14.3 exists, 14.5). `tsc --noEmit` passes.
4. `npm run build` produces `dist/` with `dist/wasm/` in it and `scripts/check-wasm-types.mjs` passes.
   From a packed tarball installed into an empty project (`scripts/check-tarball.mjs`), on
   Node 18, 20, 22 and 24, these smoke checks work and the process exits by itself:
   `node -e "require('archiver-wasm')('zip')"`;
   `node --input-type=module -e "import a, { ZipArchive } from 'archiver-wasm'; new ZipArchive()"`;
   a module that imports the package and requires it sees both formats agree (the same
   export names in both, the `require` result is the callable vending function, a format
   registered through one is registered in the other, the wasm glue is loaded once; V20),
   and `ArchiverError.name` and `ZipEncrypted.name` are those names;
   a CommonJS TypeScript file (`smoke.cts`) containing
   `import archiver = require('archiver-wasm'); const a: archiver.Archiver = archiver('zip'); new archiver.ZipArchive();`
   and an ESM one (`smoke.mts`), which both use named imports, the typed events,
   `glob(pattern, { cwd })` and the encrypted options, with a `@ts-expect-error` line for
   each misspelt event field, glob option and mistyped zip entry key, compile with
   `tsc --module node16 --moduleResolution node16 --strict --noEmit`; the ESM file also
   with `--module esnext --moduleResolution bundler`, and the CommonJS one also as
   `smoke.ts` with `--module commonjs --moduleResolution node10`.
5. The upstream suites report 40 and 12 passing, 0 pending, 0 failing on Linux and macOS
   with unmodified test files and default timeouts, and the ledger check passes (14.5).
6. All differential cases of 14.2 pass against the real upstream packages, whose installed
   versions `scripts/verify-oracle-versions.mjs` has confirmed; the slow cases (S1 to S5)
   have passed once on the release commit; all extraction checks of 14.4 pass.
7. The only behavior differences from upstream are the V rows of 3.2 (V15 for the archiver
   7 surface, V16 and V17 for wasm memory, V20 for the two module formats). Every P row of 3.3 is demonstrated by a
   differential case of the table in 14.2 showing archiver-wasm and upstream agree.
8. This file, `BEHAVIORS.tsv` and `PORTMAP.tsv` are consistent with the code (M8).
9. The work is merged to the default branch through a pull request linked to its tracking
   issue, the version is published to npm, and the registry serves it.

---

## 17. Byte layout reference

A quick reference; `BEHAVIORS.tsv` has the edge cases. All zip integers are little-endian.

### 17.1 Zip records

| Record | Layout |
|---|---|
| Local file header (30 + n + e) | `50 4B 03 04`; version needed (2); flags (2); method (2); DOS time+date (4); CRC (4); compressed size (4); size (4); name length (2); extra length (2); name; extra. CRC and both sizes are 12 zero bytes when flag bit 3 is set. Never a zip64 extra. |
| Data descriptor | `50 4B 07 08`; CRC (4); compressed size; size. Sizes are 4 bytes each (16 total) unless the entry `is_zip64()`, then 8 bytes each (24 total). Written iff bit 3 is set. |
| Central file header (46 + n + e + c) | `50 4B 01 02`; version made by (2) = `(platform << 8) \| 45`; version needed (2); flags (2); method (2); DOS time+date (4); CRC (4); compressed size (4); size (4); name length (2); extra length (2); comment length (2); disk start = 0 (2); internal attributes = 0 (2); external attributes (4); local header offset (4); name; extra; comment. |
| zip64 extra (central only, 28) | `01 00`; `18 00`; size (8); compressed size (8); local header offset (8). Present iff `ae.is_zip64() \|\| offset > 0xFFFFFFFF`; then the three 32-bit fields are all `FF FF FF FF` and version needed is 45. Base writer: replaces the entry extra. AES writer: appended after the AES extra, and the 32-bit offset field stays real unless the offset itself overflows (P19). |
| zip64 EOCD (56) | `50 4B 06 06`; 44 (8); version made by 45 (2); version needed 45 (2); disk 0 (4); disk 0 (4); entries (8); entries (8); central size (8); central offset (8). |
| zip64 locator (20) | `50 4B 06 07`; disk 0 (4); offset of the zip64 EOCD = central offset + central size (8); total disks 1 (4). |
| EOCD (22 + c) | `50 4B 05 06`; disk 0 (2); disk 0 (2); entries (2); entries (2); central size (4); central offset (4); comment length (2); comment (UTF-8). When the archive `is_zip64()` (forced, more than 65535 entries, central size or offset above 0xFFFFFFFF) the two counts are `FF FF` and size and offset `FF FF FF FF`, and the zip64 EOCD and locator precede it. |

Flags: bit 0 encryption, bit 3 data descriptor, bit 11 UTF-8 (set when the name or the
entry comment is not ASCII). Platform byte: 3 once `set_unix_mode` ran, else 0.

### 17.2 Zip entry shapes

| Engine | Source | Method | Version | Flags | Local header CRC/sizes | Descriptor | Compressed size |
|---|---|---|---|---|---|---|---|
| plain | buffer | stored (explicit, dir, symlink) | 10 | 0 | real | no | n |
| plain | buffer, empty, default method | 0 (stored) | 20 | 0x0008 | zeros | yes: signature, then 12 zero bytes | 0 |
| plain | buffer | deflate | 20 | 0x0008 | zeros | yes | deflated |
| plain | stream | stored | 20 | 0x0008 | zeros | yes | n |
| plain | stream | deflate | 20 | 0x0008 | zeros | yes | deflated |
| plain | stored buffer above 4 GiB (ZIP-058; reachable because the payload does not enter wasm, V16; asserted by the cargo test `plain_entry_shapes` without allocating the payload, and by slow case S3) | 0 | 45 | 0x0008 | zeros | 24 bytes | n |
| zip20 | buffer | stored | 10 | 0x0001 | real, written after the data is known | no | n + 12 |
| zip20 | buffer | deflate (also when empty) | 20 | 0x0001 | real | no | deflated + 12 |
| zip20 | stream | stored or deflate | 20 | 0x0001 | real | no | payload + 12 |
| zip20 | any, stored, zero data bytes | 0 | 10 or 20 | 0x0001 | real (CRC 0, csize 12, size 0) | no | 12 declared, 0 bytes written (P17) |
| aes256 | buffer | stored | 51 | 0x0001 | real CRC, csize n + 28, size n | no | n + 28 |
| aes256 | buffer | deflate (also when empty) | 51 | 0x0009 | zeros | yes, after the MAC | deflated + 28 |
| aes256 | stream | stored or deflate | 51 | 0x0009 | zeros | yes | payload + 28 |

AES entries: method field 99; extra `01 99 07 00 01 00 41 45 03 mm mm` where `mm mm` is the
real method (8 or 0); payload `salt(16) | verifier(2) | ciphertext | mac(10)`; the CRC field
keeps the real CRC (AE-1). ZipCrypto payload: 12 encrypted header bytes (10 random, then
CRC bits 16..23, then CRC bits 24..31) followed by the encrypted data.

### 17.3 Tar

512-byte ustar header (deps/tar-stream/headers.js:51-92), zero-filled, fields written in
this order:

| Offset | Width | Field | Encoding |
|---|---|---|---|
| 0 | 100 | name | UTF-8 (ASCII by construction), after the prefix split |
| 100 | 8 | mode | `encode_oct(mode & 0o7777, 6)`: 6 digits, space, NUL |
| 108 | 8 | uid | `encode_oct(uid, 6)` |
| 116 | 8 | gid | `encode_oct(gid, 6)` |
| 124 | 12 | size | 11 octal digits and a space, or base-256 with a leading `0x80` |
| 136 | 12 | mtime | `encode_oct(seconds, 11)` (10.6) |
| 156 | 1 | typeflag | `'0'` + code: file 0, link 1, symlink 2, character-device 3, block-device 4, directory 5, fifo 6, contiguous-file 7, pax-header `'x'`; anything else `'0'` |
| 157 | 100 | linkname | only when truthy |
| 257 | 6 | magic | `ustar\0` |
| 263 | 2 | version | `00` |
| 265 | 32 | uname | only when truthy; no length limit (P12) |
| 297 | 32 | gname | only when truthy; no length limit |
| 329 | 8 | devmajor | `encode_oct(devmajor \|\| 0, 6)`, always written |
| 337 | 8 | devminor | `encode_oct(devminor \|\| 0, 6)`, always written |
| 345 | 155 | prefix | only when the split produced one |
| 148 | 8 | checksum | written last: `encode_oct(sum, 6)` where sum = all bytes with 148..155 counted as eight spaces |

`encode` returns `None` (pax fallback) when: the name is not ASCII; the name is longer than
100 bytes and cannot be split at `/` characters, moving leading segments into the prefix
one at a time, into a name of at most 100 and a prefix of at most 155 bytes; or a truthy
linkname is longer than 100 bytes. A trailing `/` is added to the name only when
`typeflag_is_5` (not for type `'directory'`, TAR-JSON-067).

Pax fallback (pack.js:205-234), four pieces: a header named `PaxHeader` with type
`pax-header` and size = record block length; the records (`path` if the name is truthy,
`linkpath` if the link name is truthy, then the caller's `pax` keys), each
`<len> <key>=<value>\n`; zero padding to 512; a second header, also named `PaxHeader`, with
the real size and type, and link name `PaxHeader` when the entry has one.

Entry body: the bytes as given, then zero padding to the next multiple of 512 (none when
the size is a multiple of 512). End of archive: 1024 zero bytes; no rounding to a 10240-byte
record. `tar.gz` is the whole tar stream in one gzip member (6.4).

