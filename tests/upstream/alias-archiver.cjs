const Module = require('node:module');
const path = require('node:path');
const target = path.resolve(__dirname, '../../dist/index.cjs');
const resolveFilename = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
  return request === 'archiver' ? target : resolveFilename.call(this, request, ...rest);
};
