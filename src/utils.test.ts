// PORTING.md 14.3 (shared sanitizer vectors, R6): the rows of tests/vectors/sanitize-path.json
// were produced by the upstream functions; this copy must reproduce them.
import assert from 'node:assert';
import { readFileSync } from 'node:fs';

import { sanitizePath } from './utils.js';

// [input, normalizePath(input), sanitizePath(input)]
type Vector = [string, string, string];

const vectors: Vector[] = JSON.parse(
  readFileSync(new URL('../tests/vectors/sanitize-path.json', import.meta.url), 'utf8'),
);

describe('sanitizePath', function () {
  it('has rows', function () {
    assert.ok(vectors.length > 0);
    for (const row of vectors) {
      assert.strictEqual(row.length, 3);
    }
  });

  it('reproduces the upstream vectors', function () {
    for (const [input, , expected] of vectors) {
      assert.strictEqual(sanitizePath(input), expected, JSON.stringify(input));
    }
  });
});
