// cjs/index.cjs (scaffold unit, verbatim)
'use strict';
const m = require('../dist/index.cjs');
const archiver = m.default;
for (const key of Object.keys(m)) {
  if (key !== 'default') { archiver[key] = m[key]; }
}
archiver.default = archiver;
module.exports = archiver;
