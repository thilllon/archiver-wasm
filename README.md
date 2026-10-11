# ykk

[node-archiver](https://github.com/archiverjs/node-archiver) ported to Rust and WebAssembly for Node.js, with the ZIP encryption of [archiver-zip-encrypted](https://github.com/artem-karpenko/archiver-zip-encrypted) built in and TypeScript types included.

- Same API as archiver 8: `ZipArchive`, `TarArchive`, `JsonArchive`, `append`, `file`, `directory`, `glob`, `symlink`, `finalize`, `abort`, `pointer`, and the same events.
- The archiver 7 factory is also there: `archiver('zip', options)`, `create`, `registerFormat`, `isRegisteredFormat`.
- `ZipEncrypted` adds AES-256 (WinZip AE-1) and legacy ZipCrypto.
- The bytes of every archive are produced in Rust (`crates/ykk-core`) and compiled to WebAssembly. Streams, the file system and callbacks stay in TypeScript.
- ESM and CommonJS, strict types, no native addon, Node.js 18 or newer.

## Install

```sh
npm install @thilllon/ykk
```

## Usage

```ts
import { createWriteStream } from "node:fs";
import { ZipArchive } from "@thilllon/ykk";

const archive = new ZipArchive({ zlib: { level: 9 } });
archive.pipe(createWriteStream("out.zip"));

archive.append("hello", { name: "hello.txt" });
archive.file("README.md", { name: "docs/README.md" });
archive.directory("src/", "src");
archive.glob("**/*.json", { cwd: "config" });

await archive.finalize();
```

Tar and gzipped tar:

```ts
import { TarArchive } from "@thilllon/ykk";

const archive = new TarArchive({ gzip: true, gzipOptions: { level: 6 } });
```

Encrypted ZIP:

```ts
import archiver, { ZipEncrypted } from "@thilllon/ykk";

archiver.registerFormat("zip-encrypted", ZipEncrypted);

const archive = archiver.create("zip-encrypted", {
  zlib: { level: 8 },
  encryptionMethod: "aes256", // or "zip20"
  password: "secret",
});
```

CommonJS works the same way: `const { ZipArchive } = require("@thilllon/ykk")`.

`import` and `require` share one implementation. A format registered through one is visible through the other.

## Compatibility with upstream

The port follows upstream statement by statement, so behavior matches archiver 8.0.0 and archiver-zip-encrypted 2.0.0.

- Tar, JSON and stored ZIP output is byte-identical to upstream for the same input.
- Deflated data is produced by `miniz_oxide`, not zlib, so compressed bytes can differ. The data always inflates to the same content and every other field of the archive matches.
- At zlib level 1, which is the ZIP default, `miniz_oxide` compresses less than zlib. Measured archives were 9 to 19 percent larger than upstream's (15.4 MB of JavaScript source: 3,499,632 bytes upstream, 4,127,264 bytes here). At levels 2, 6 and 9 the sizes were within about 1 percent of zlib's or smaller. Pass `zlib: { level: 2 }` or higher if size matters.
- Known upstream defects are preserved on purpose. They are listed in section 3.3 of `PORTING.md`.

## Security notes

ykk reproduces upstream here too. It does not validate what you pass in. If any of these values come from an untrusted source, check them before you call ykk.

- **Entry names and prefixes.** Only a leading `../`, a leading `/` and a leading drive letter are stripped. An interior `..` stays (`a/../../b` is written as is), and a drive letter after a non-empty `prefix` stays. Reject names that contain a `..` segment.
- **`symlink()` names and targets.** The name passed to `symlink()` is not sanitized in tar and JSON output, and no link target is ever checked. Reject absolute paths and `..` segments in both. `directory()` and `glob()` store the links they find with their targets unchanged, including targets outside the tree.
- **NUL characters.** A NUL in a tar entry name or link name is written as is. Readers cut the name there, so the name you validated is not the name that gets extracted. Reject names that contain `\0`.
- **Length of names and comments in ZIP.** A name, entry comment or archive comment longer than 65535 bytes gets a length field that wraps around while all the bytes are still written. The archive is then inconsistent and no error is raised. Limit these to 65535 UTF-8 bytes.
- **Tar `uname` and `gname`.** They have no length limit. More than 32 bytes spill into the next header fields and can set the path prefix that readers put in front of the entry name. Limit both to 32 bytes.
- **Very long tar names.** A name with many thousands of `/` separators takes quadratic time to encode and blocks the event loop. Limit the length of names.
- **`glob()` with `follow: true`.** Symlink cycles are not detected. A few links that point back into the tree make the walk and the archive grow without bound. Do not use `follow: true` on a tree that others can write to.
- **Format names.** `archiver.create()`, `registerFormat()` and `isRegisteredFormat()` treat `constructor`, `toString` and other `Object.prototype` keys as registered formats. Do not pass a format name from user input without an allow list.

Other inherited behavior to know about:

- AES entries are WinZip AE-1, as in archiver-zip-encrypted. AE-1 stores the CRC-32 of each file's plaintext unencrypted in the ZIP headers. Someone who holds the archive can confirm a guessed content, or recover a very short file, without the password.
- ZipCrypto (`zip20`) is a legacy cipher and is weak. With it, directories and empty stored files are written in a way that 7z and unzip report as a wrong password.
- In a tar archive, a file whose size changes between `stat` and read fails with `Size mismatch`, and the error is also thrown outside any handler. Do not archive files that are being written.
- `archive.destroy()` while a file is being read leaves that file descriptor open. Use `archive.abort()` to stop early.
- `abort()` called one macrotask after an entry completed, for example from a `setImmediate` callback, can leave the archive without `'end'` and `'close'`. Call `archive.destroy()` after `abort()` if you wait for those events.

## How it was built

The port copies the method described in [the Bun write-up of its port to Rust](https://bun.com/blog/bun-in-rust): a porting guide written before any code, a mechanical all-at-once port unit by unit, one implementer with two adversarial reviewers and one fixer per unit, compiler errors used as a work queue, and the upstream test suites as the oracle with no test skipped or deleted.

- `PORTING.md` is the guide.
- `BEHAVIORS.tsv` is the inventory of upstream behavior.
- `PORTMAP.tsv` maps every upstream file to its Rust or TypeScript target.

## Development

Requires the Rust toolchain of `rust-toolchain.toml`, the `wasm32-unknown-unknown` target, wasm-pack 0.15.0, Node.js 18 or newer and 7z.

```sh
npm ci
npm run build
npm test
```

`npm test` runs the Rust tests, the unmodified test suites of both upstream packages against this package, and differential tests that compare its output with the upstream packages.

## License

MIT. Portions derive from node-archiver, archiver-zip-encrypted, zip-stream, compress-commons, tar-stream, crc32-stream and readdir-glob. See `THIRD_PARTY_NOTICES.md`.
