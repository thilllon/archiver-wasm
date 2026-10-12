// PORTING.md 14.3 (shared sanitizer vectors, R6): the rows of tests/vectors/sanitize-path.json
// were produced by the upstream functions; the three TypeScript copies must reproduce them.
import assert from 'node:assert';
import { readFileSync } from 'node:fs';

import normalizePath from '../../src/normalize-path.ts';
import { sanitizePath as coreSanitizePath } from '../../src/utils.ts';
import { sanitizePath as zipStreamSanitizePath } from '../../src/zip-stream/utils.ts';

// [input, normalizePath(input), sanitizePath(input)]
type Vector = [string, string, string];

const vectors: Vector[] = JSON.parse(
  readFileSync(new URL('../vectors/sanitize-path.json', import.meta.url), 'utf8'),
);

describe('sanitize-path vectors', function () {
  it('has rows', function () {
    assert.ok(vectors.length > 0);
    for (const row of vectors) {
      assert.strictEqual(row.length, 3);
    }
  });

  it('src/normalize-path.ts normalizePath(input)', function () {
    for (const [input, normalized] of vectors) {
      assert.strictEqual(normalizePath(input), normalized, JSON.stringify(input));
    }
  });

  it('src/utils.ts sanitizePath', function () {
    for (const [input, , sanitized] of vectors) {
      assert.strictEqual(coreSanitizePath(input), sanitized, JSON.stringify(input));
    }
  });

  it('src/zip-stream/utils.ts sanitizePath', function () {
    for (const [input, , sanitized] of vectors) {
      assert.strictEqual(zipStreamSanitizePath(input), sanitized, JSON.stringify(input));
    }
  });
});
