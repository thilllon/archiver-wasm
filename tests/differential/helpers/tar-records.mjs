// tests/differential/helpers/tar-records.mjs
// Tar block parser for the differential tests (PORTING.md 14.2, layout of 17.3). Pure JavaScript
// apart from Node's zlib, which splitGzip uses to inflate a tar.gz.
//
//   parseTar(buffer) -> {
//     entries,   [{ offset, name, pax, header, body, padding, bytes }] in archive order
//     trailer,   the bytes after the last entry (1024 zero bytes for a finalized archive)
//   }
//     header: { offset, bytes, raw: { <field>: Buffer }, name, mode, uid, gid, size, mtime, checksum,
//               checksumValid, typeflag, linkname, magic, version, uname, gname, devmajor, devminor, prefix }
//     pax:    null, or { header, records: [{ length, key, value, bytes }], values, body, padding }
//             for the pax header block and the record blocks in front of the real header
//   splitGzip(buffer) -> { header, payload, trailer, crc, size }   one gzip member (tar.gz)

import zlib from 'node:zlib';

const BLOCK = 512;

// offset, width (17.3)
const FIELDS = {
  name: [0, 100],
  mode: [100, 8],
  uid: [108, 8],
  gid: [116, 8],
  size: [124, 12],
  mtime: [136, 12],
  checksum: [148, 8],
  typeflag: [156, 1],
  linkname: [157, 100],
  magic: [257, 6],
  version: [263, 2],
  uname: [265, 32],
  gname: [297, 32],
  devmajor: [329, 8],
  devminor: [337, 8],
  prefix: [345, 155],
};

const STRING_FIELDS = ['name', 'linkname', 'magic', 'uname', 'gname', 'prefix'];
const OCTAL_FIELDS = ['mode', 'uid', 'gid', 'mtime', 'checksum', 'devmajor', 'devminor'];

function overflow(size) {
  size &= BLOCK - 1;
  return size ? BLOCK - size : 0;
}

function isZeroBlock(buffer, offset) {
  for (let i = offset; i < offset + BLOCK; i++) {
    if (buffer[i] !== 0) return false;
  }
  return true;
}

function text(field) {
  const end = field.indexOf(0);
  return field.toString('utf8', 0, end === -1 ? field.length : end);
}

function octal(field) {
  const digits = text(field).trim();
  return digits === '' ? 0 : parseInt(digits, 8);
}

// 11 octal digits and a space, or base-256 with a leading 0x80
function size(field) {
  if ((field[0] & 0x80) === 0) {
    return octal(field);
  }
  let value = 0;
  for (let i = 1; i < field.length; i++) {
    value = value * 256 + field[i];
  }
  return value;
}

function checksum(block) {
  let sum = 8 * 32;
  for (let i = 0; i < 148; i++) sum += block[i];
  for (let i = 156; i < BLOCK; i++) sum += block[i];
  return sum;
}

function parseHeader(buffer, offset) {
  const bytes = buffer.subarray(offset, offset + BLOCK);
  const raw = {};
  for (const key of Object.keys(FIELDS)) {
    const [start, width] = FIELDS[key];
    raw[key] = bytes.subarray(start, start + width);
  }
  const header = { offset, bytes, raw };
  for (const key of STRING_FIELDS) header[key] = text(raw[key]);
  for (const key of OCTAL_FIELDS) header[key] = octal(raw[key]);
  header.size = size(raw.size);
  header.typeflag = raw.typeflag.toString('latin1');
  header.version = raw.version.toString('latin1');
  header.checksumValid = header.checksum === checksum(bytes);
  return header;
}

// `<len> <key>=<value>\n`, the length counting the whole record in bytes
function parsePaxRecords(body) {
  const records = [];
  let offset = 0;
  while (offset < body.length) {
    const space = body.indexOf(0x20, offset);
    if (space === -1) break;
    const length = parseInt(body.toString('latin1', offset, space), 10);
    if (!(length > 0) || offset + length > body.length) break;
    const bytes = body.subarray(offset, offset + length);
    const pair = body.toString('utf8', space + 1, offset + length - 1);
    const equals = pair.indexOf('=');
    records.push({
      length,
      key: equals === -1 ? pair : pair.slice(0, equals),
      value: equals === -1 ? '' : pair.slice(equals + 1),
      bytes,
    });
    offset += length;
  }
  return records;
}

function readBody(buffer, header) {
  const start = header.offset + BLOCK;
  if (start + header.size > buffer.length) {
    throw new Error(
      `tar-records: body of the header at ${header.offset} needs ${header.size} bytes, buffer has ${buffer.length - start}`
    );
  }
  const body = buffer.subarray(start, start + header.size);
  const padding = buffer.subarray(start + header.size, start + header.size + overflow(header.size));
  return { body, padding, end: start + header.size + padding.length };
}

export function parseTar(input) {
  const buffer = Buffer.isBuffer(input) ? input : Buffer.from(input);
  const entries = [];
  let offset = 0;
  while (offset + BLOCK <= buffer.length && !isZeroBlock(buffer, offset)) {
    const start = offset;
    let header = parseHeader(buffer, offset);
    let pax = null;
    if (header.typeflag === 'x') {
      const block = readBody(buffer, header);
      const records = parsePaxRecords(block.body);
      const values = {};
      for (const record of records) values[record.key] = record.value;
      pax = { header, records, values, body: block.body, padding: block.padding };
      offset = block.end;
      if (offset + BLOCK > buffer.length) {
        throw new Error(`tar-records: pax header at ${start} is not followed by a header block`);
      }
      header = parseHeader(buffer, offset);
    }
    const block = readBody(buffer, header);
    const ustarName = header.prefix ? header.prefix + '/' + header.name : header.name;
    entries.push({
      offset: start,
      name: pax && pax.values.path !== undefined ? pax.values.path : ustarName,
      pax,
      header,
      body: block.body,
      padding: block.padding,
      bytes: buffer.subarray(start, block.end),
    });
    offset = block.end;
  }
  return { buffer, entries, trailer: buffer.subarray(offset) };
}

// 10-byte header (no FEXTRA, FNAME or FCOMMENT: the member the port and zlib.createGzip write), deflate
// stream, 8-byte trailer (CRC-32 and ISIZE, little-endian)
export function splitGzip(input) {
  const buffer = Buffer.isBuffer(input) ? input : Buffer.from(input);
  if (buffer.length < 18) {
    throw new Error(`tar-records: a gzip member needs 18 bytes, buffer has ${buffer.length}`);
  }
  const header = buffer.subarray(0, 10);
  const deflated = buffer.subarray(10, buffer.length - 8);
  const trailer = buffer.subarray(buffer.length - 8);
  return {
    header,
    payload: zlib.inflateRawSync(deflated),
    trailer,
    crc: trailer.readUInt32LE(0),
    size: trailer.readUInt32LE(4),
  };
}
