import * as fs from 'node:fs'

// deps/tar-stream/constants.js:1-8
const constants = { // just for envs without fs
  S_IFMT: 61440,
  S_IFDIR: 16384,
  S_IFCHR: 8192,
  S_IFBLK: 24576,
  S_IFIFO: 4096,
  S_IFLNK: 40960
}

// deps/tar-stream/constants.js:10-14
export default fs.constants || constants
