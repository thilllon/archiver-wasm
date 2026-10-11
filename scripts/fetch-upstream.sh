#!/usr/bin/env bash
# Fetches the pinned upstream sources this port is derived from into .upstream/ (gitignored).
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p .upstream/deps
clone() { # name url sha
  rm -rf ".upstream/$1"; git clone -q "$2" ".upstream/$1"; git -C ".upstream/$1" checkout -q "$3"; rm -rf ".upstream/$1/.git"
}
clone node-archiver https://github.com/archiverjs/node-archiver 52d1d349dfa2bf17956ecab56f477736688a9c5e
clone archiver-zip-encrypted https://github.com/artem-karpenko/archiver-zip-encrypted 0be6b0e6cbc2c4fbd15342a4b1389862679d7668
for p in zip-stream@7.0.5 compress-commons@7.0.0 tar-stream@3.2.0 crc32-stream@7.0.1 readdir-glob@3.0.0 crc-32@1.2.2; do
  f=$(cd .upstream/deps && npm pack "$p" --ignore-scripts -s); n=${f%-*.tgz}
  rm -rf ".upstream/deps/$n"; mkdir -p ".upstream/deps/$n"; tar xzf ".upstream/deps/$f" -C ".upstream/deps/$n" --strip-components=1; rm ".upstream/deps/$f"
done
