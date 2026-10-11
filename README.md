# ykk

[node-archiver](https://github.com/archiverjs/node-archiver) ported to Rust and WebAssembly for Node.js, with the ZIP encryption of [archiver-zip-encrypted](https://github.com/artem-karpenko/archiver-zip-encrypted) built in and TypeScript types included.

- Same API as archiver 8: `ZipArchive`, `TarArchive`, `JsonArchive`, `append`, `file`, `directory`, `glob`, `symlink`, `finalize`, `abort`, `pointer`, and the same events.
- The archiver 7 factory is also there: `archiver('zip', options)`, `create`, `registerFormat`, `isRegisteredFormat`.
- `ZipEncrypted` adds AES-256 (WinZip AE-2) and legacy ZipCrypto.
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

## Compatibility with upstream

The port follows upstream statement by statement, so behavior matches archiver 8.0.0 and archiver-zip-encrypted 2.0.0.

- Tar, JSON and stored ZIP output is byte-identical to upstream for the same input.
- Deflated data is produced by `miniz_oxide`, not zlib, so compressed bytes can differ. The data always inflates to the same content and every other field of the archive matches.
- Known upstream defects are preserved on purpose. They are listed in section 3.3 of `PORTING.md`.

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
