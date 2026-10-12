// tests/differential/helpers/zip-records.mjs
// Zip record parser for the differential tests (PORTING.md 14.2, layouts of 17.1). Pure JavaScript.
//
//   parseZip(buffer) -> {
//     end,           EOCD: offset, bytes, entriesOnDisk, entries,
//                    centralSize, centralOffset, commentLength, comment
//     zip64End,      zip64 EOCD or null: offset, bytes, versionMadeBy, versionNeeded,
//                    entriesOnDisk, entries, centralSize, centralOffset
//     zip64Locator,  zip64 locator or null: offset, bytes, zip64EndOffset
//     centralOffset, centralSize     the values in effect (zip64 where the 32-bit field is all ones)
//     prefix,        the bytes before the first local header
//     central,       central headers in directory order
//     entries,       [{ name, central, local, payload, descriptor }] in directory order
//   }
//   maskLocal(local, fields)       copy of the local header bytes with the named fields zeroed; by default
//                                  the compressed size of a deflated entry without descriptor (zip20), V1
//   maskCentral(central, fields)   copy of the central header bytes with the named fields zeroed
//   maskDescriptor(descriptor, fields)
//   maskEndRecords(zip, fields)    zip64 EOCD + locator + EOCD bytes with the named fields zeroed
//
// The payload of an entry is delimited by the records around it, never by a compressed size
// field, so that a declared size can be compared with the bytes really written (P17).

const SIG_LFH = 0x04034b50;
const SIG_DD = 0x08074b50;
const SIG_CFH = 0x02014b50;
const SIG_EOCD = 0x06054b50;
const SIG_ZIP64_EOCD = 0x06064b50;
const SIG_ZIP64_EOCD_LOC = 0x07064b50;
const ZIP64_MAGIC_SHORT = 0xffff;
const ZIP64_MAGIC = 0xffffffff;
const ZIP64_EXTRA_ID = 0x0001;
const AES_EXTRA_ID = 0x9901;

const LFH_LENGTH = 30;
const CFH_LENGTH = 46;
const EOCD_LENGTH = 22;
const ZIP64_EOCD_LENGTH = 56;
const ZIP64_EOCD_LOC_LENGTH = 20;

function readUInt64LE(buffer, offset) {
  return Number(buffer.readBigUInt64LE(offset));
}

function need(buffer, offset, length, what) {
  if (offset < 0 || offset + length > buffer.length) {
    throw new Error(`zip-records: ${what} at ${offset} needs ${length} bytes, buffer has ${buffer.length}`);
  }
}

function expectSignature(buffer, offset, signature, what) {
  need(buffer, offset, 4, what);
  const found = buffer.readUInt32LE(offset);
  if (found !== signature) {
    throw new Error(
      `zip-records: no ${what} at ${offset}: found 0x${found.toString(16).padStart(8, '0')}`
    );
  }
}

function parseExtra(extra) {
  const fields = [];
  let offset = 0;
  while (offset + 4 <= extra.length) {
    const id = extra.readUInt16LE(offset);
    const size = extra.readUInt16LE(offset + 2);
    const dataOffset = offset + 4;
    fields.push({ id, size, offset, dataOffset, data: extra.subarray(dataOffset, dataOffset + size) });
    offset = dataOffset + size;
  }
  return fields;
}

// 17.1: size (8), compressed size (8), local header offset (8), as the writers emit it
function parseZip64Extra(field) {
  const data = field.data;
  return {
    dataOffset: field.dataOffset,
    size: data.length >= 8 ? readUInt64LE(data, 0) : null,
    compressedSize: data.length >= 16 ? readUInt64LE(data, 8) : null,
    localHeaderOffset: data.length >= 24 ? readUInt64LE(data, 16) : null,
  };
}

// 17.2: 01 99 07 00 | version (2) | vendor 'AE' | strength (1) | real method (2)
function parseAesExtra(field) {
  const data = field.data;
  if (data.length < 7) {
    return { dataOffset: field.dataOffset, version: null, method: null };
  }
  return {
    dataOffset: field.dataOffset,
    version: data.readUInt16LE(0),
    method: data.readUInt16LE(5),
  };
}

function describeExtra(extra) {
  const extraFields = parseExtra(extra);
  const zip64Field = extraFields.find((field) => field.id === ZIP64_EXTRA_ID);
  const aesField = extraFields.find((field) => field.id === AES_EXTRA_ID);
  return {
    zip64: zip64Field ? parseZip64Extra(zip64Field) : null,
    aes: aesField ? parseAesExtra(aesField) : null,
  };
}

function parseEnd(buffer) {
  for (let offset = buffer.length - EOCD_LENGTH; offset >= 0; offset--) {
    if (buffer.readUInt32LE(offset) !== SIG_EOCD) {
      continue;
    }
    const commentLength = buffer.readUInt16LE(offset + 20);
    if (offset + EOCD_LENGTH + commentLength !== buffer.length) {
      continue;
    }
    return {
      offset,
      bytes: buffer.subarray(offset),
      entriesOnDisk: buffer.readUInt16LE(offset + 8),
      entries: buffer.readUInt16LE(offset + 10),
      centralSize: buffer.readUInt32LE(offset + 12),
      centralOffset: buffer.readUInt32LE(offset + 16),
      commentLength,
      comment: buffer.subarray(offset + EOCD_LENGTH),
    };
  }
  throw new Error('zip-records: no end of central directory record');
}

function parseZip64Locator(buffer, end) {
  const offset = end.offset - ZIP64_EOCD_LOC_LENGTH;
  if (offset < 0 || buffer.readUInt32LE(offset) !== SIG_ZIP64_EOCD_LOC) {
    return null;
  }
  return {
    offset,
    bytes: buffer.subarray(offset, offset + ZIP64_EOCD_LOC_LENGTH),
    zip64EndOffset: readUInt64LE(buffer, offset + 8),
  };
}

function parseZip64End(buffer, locator) {
  // the record sits directly in front of its locator; the locator's own offset field is data to compare
  const offset = locator.offset - ZIP64_EOCD_LENGTH;
  expectSignature(buffer, offset, SIG_ZIP64_EOCD, 'zip64 end of central directory record');
  return {
    offset,
    bytes: buffer.subarray(offset, offset + ZIP64_EOCD_LENGTH),
    versionMadeBy: buffer.readUInt16LE(offset + 12),
    versionNeeded: buffer.readUInt16LE(offset + 14),
    entriesOnDisk: readUInt64LE(buffer, offset + 24),
    entries: readUInt64LE(buffer, offset + 32),
    centralSize: readUInt64LE(buffer, offset + 40),
    centralOffset: readUInt64LE(buffer, offset + 48),
  };
}

function parseCentralHeader(buffer, offset) {
  expectSignature(buffer, offset, SIG_CFH, 'central file header');
  need(buffer, offset, CFH_LENGTH, 'central file header');
  const nameLength = buffer.readUInt16LE(offset + 28);
  const extraLength = buffer.readUInt16LE(offset + 30);
  const commentLength = buffer.readUInt16LE(offset + 32);
  const length = CFH_LENGTH + nameLength + extraLength + commentLength;
  need(buffer, offset, length, 'central file header');
  const nameBytes = buffer.subarray(offset + CFH_LENGTH, offset + CFH_LENGTH + nameLength);
  const extraOffset = CFH_LENGTH + nameLength;
  const extra = buffer.subarray(offset + extraOffset, offset + extraOffset + extraLength);
  const comment = buffer.subarray(offset + extraOffset + extraLength, offset + length);
  const header = {
    offset,
    length,
    bytes: buffer.subarray(offset, offset + length),
    versionMadeBy: buffer.readUInt16LE(offset + 4),
    versionNeeded: buffer.readUInt16LE(offset + 6),
    flags: buffer.readUInt16LE(offset + 8),
    method: buffer.readUInt16LE(offset + 10),
    dosTime: buffer.readUInt32LE(offset + 12),
    crc: buffer.readUInt32LE(offset + 16),
    compressedSize: buffer.readUInt32LE(offset + 20),
    size: buffer.readUInt32LE(offset + 24),
    extraLength,
    commentLength,
    externalAttributes: buffer.readUInt32LE(offset + 38),
    localHeaderOffset: buffer.readUInt32LE(offset + 42),
    name: nameBytes.toString('utf8'),
    extraOffset,
    extra,
    comment,
    ...describeExtra(extra),
  };
  const zip64 = header.zip64;
  header.effective = {
    size: header.size === ZIP64_MAGIC && zip64 && zip64.size !== null ? zip64.size : header.size,
    compressedSize:
      header.compressedSize === ZIP64_MAGIC && zip64 && zip64.compressedSize !== null
        ? zip64.compressedSize
        : header.compressedSize,
    localHeaderOffset:
      header.localHeaderOffset === ZIP64_MAGIC && zip64 && zip64.localHeaderOffset !== null
        ? zip64.localHeaderOffset
        : header.localHeaderOffset,
  };
  return header;
}

function parseLocalHeader(buffer, offset) {
  expectSignature(buffer, offset, SIG_LFH, 'local file header');
  need(buffer, offset, LFH_LENGTH, 'local file header');
  const nameLength = buffer.readUInt16LE(offset + 26);
  const extraLength = buffer.readUInt16LE(offset + 28);
  const length = LFH_LENGTH + nameLength + extraLength;
  need(buffer, offset, length, 'local file header');
  const nameBytes = buffer.subarray(offset + LFH_LENGTH, offset + LFH_LENGTH + nameLength);
  const extra = buffer.subarray(offset + LFH_LENGTH + nameLength, offset + length);
  return {
    offset,
    length,
    bytes: buffer.subarray(offset, offset + length),
    versionNeeded: buffer.readUInt16LE(offset + 4),
    flags: buffer.readUInt16LE(offset + 6),
    method: buffer.readUInt16LE(offset + 8),
    dosTime: buffer.readUInt32LE(offset + 10),
    crc: buffer.readUInt32LE(offset + 14),
    compressedSize: buffer.readUInt32LE(offset + 18),
    size: buffer.readUInt32LE(offset + 22),
    extraLength,
    name: nameBytes.toString('utf8'),
    extra,
    ...describeExtra(extra),
  };
}

function descriptorAt(buffer, offset, zip64) {
  const length = zip64 ? 24 : 16;
  return {
    offset,
    length,
    zip64,
    bytes: buffer.subarray(offset, offset + length),
    crc: buffer.readUInt32LE(offset + 4),
    compressedSize: zip64 ? readUInt64LE(buffer, offset + 8) : buffer.readUInt32LE(offset + 8),
    size: zip64 ? readUInt64LE(buffer, offset + 16) : buffer.readUInt32LE(offset + 12),
  };
}

// 17.1: written iff flag bit 3 is set; 16 bytes, or 24 when the entry is zip64
function parseDescriptor(buffer, start, end, central) {
  const short = end - 16 >= start && buffer.readUInt32LE(end - 16) === SIG_DD;
  const long = end - 24 >= start && buffer.readUInt32LE(end - 24) === SIG_DD;
  if (short && long) {
    return end - 24 - start === central.effective.compressedSize
      ? descriptorAt(buffer, end - 24, true)
      : descriptorAt(buffer, end - 16, false);
  }
  if (short) return descriptorAt(buffer, end - 16, false);
  if (long) return descriptorAt(buffer, end - 24, true);
  return null;
}

export function parseZip(input) {
  const buffer = Buffer.isBuffer(input) ? input : Buffer.from(input);
  const end = parseEnd(buffer);
  const zip64Locator = parseZip64Locator(buffer, end);
  const zip64End = zip64Locator ? parseZip64End(buffer, zip64Locator) : null;

  const entryCount = end.entries === ZIP64_MAGIC_SHORT && zip64End ? zip64End.entries : end.entries;
  const centralSize = end.centralSize === ZIP64_MAGIC && zip64End ? zip64End.centralSize : end.centralSize;
  const centralOffset =
    end.centralOffset === ZIP64_MAGIC && zip64End ? zip64End.centralOffset : end.centralOffset;

  const central = [];
  let offset = centralOffset;
  for (let i = 0; i < entryCount; i++) {
    const header = parseCentralHeader(buffer, offset);
    central.push(header);
    offset += header.length;
  }
  const centralEnd = offset;

  const locals = central.map((header) => parseLocalHeader(buffer, header.effective.localHeaderOffset));
  const starts = [...new Set(locals.map((local) => local.offset))].sort((a, b) => a - b);
  const regionEnds = new Map(
    starts.map((start, i) => [start, i + 1 < starts.length ? starts[i + 1] : centralOffset])
  );

  const entries = central.map((header, i) => {
    const local = locals[i];
    const dataStart = local.offset + local.length;
    const regionEnd = regionEnds.get(local.offset);
    const descriptor = (local.flags & 0x0008) !== 0 ? parseDescriptor(buffer, dataStart, regionEnd, header) : null;
    const dataEnd = descriptor ? descriptor.offset : regionEnd;
    return {
      name: header.name,
      central: header,
      local,
      payload: buffer.subarray(dataStart, dataEnd),
      descriptor,
    };
  });

  return {
    buffer,
    end,
    zip64End,
    zip64Locator,
    centralSize,
    centralOffset,
    centralEnd,
    prefix: buffer.subarray(0, starts.length > 0 ? starts[0] : centralOffset),
    central,
    entries,
  };
}

function zero(bytes, offset, length) {
  bytes.fill(0, offset, offset + length);
}

// fields: { crc, compressedSize, size }
export function maskLocal(local, fields = { compressedSize: local.method === 8 && (local.flags & 0x0008) === 0 }) {
  const bytes = Buffer.from(local.bytes);
  if (fields.crc) zero(bytes, 14, 4);
  if (fields.compressedSize) zero(bytes, 18, 4);
  if (fields.size) zero(bytes, 22, 4);
  return bytes;
}

// fields: { compressedSize, localHeaderOffset }; the same values inside a zip64 extra are zeroed with them
export function maskCentral(central, fields = { compressedSize: true, localHeaderOffset: true }) {
  const bytes = Buffer.from(central.bytes);
  const zip64 = central.zip64;
  const zip64Data = zip64 ? central.extraOffset + zip64.dataOffset : 0;
  if (fields.compressedSize) {
    zero(bytes, 20, 4);
    if (zip64 && zip64.compressedSize !== null) zero(bytes, zip64Data + 8, 8);
  }
  if (fields.localHeaderOffset) {
    zero(bytes, 42, 4);
    if (zip64 && zip64.localHeaderOffset !== null) zero(bytes, zip64Data + 16, 8);
  }
  return bytes;
}

// fields: { compressedSize }
export function maskDescriptor(descriptor, fields = { compressedSize: true }) {
  const bytes = Buffer.from(descriptor.bytes);
  if (fields.compressedSize) zero(bytes, 8, descriptor.zip64 ? 8 : 4);
  return bytes;
}

// fields: { centralSize, centralOffset }; the locator's offset of the zip64 EOCD is their sum (17.1)
export function maskEndRecords(zip, fields = { centralSize: true, centralOffset: true }) {
  const parts = [];
  if (zip.zip64End) {
    const bytes = Buffer.from(zip.zip64End.bytes);
    if (fields.centralSize) zero(bytes, 40, 8);
    if (fields.centralOffset) zero(bytes, 48, 8);
    parts.push(bytes);
  }
  if (zip.zip64Locator) {
    const bytes = Buffer.from(zip.zip64Locator.bytes);
    if (fields.centralSize || fields.centralOffset) zero(bytes, 8, 8);
    parts.push(bytes);
  }
  const bytes = Buffer.from(zip.end.bytes);
  if (fields.centralSize) zero(bytes, 12, 4);
  if (fields.centralOffset) zero(bytes, 16, 4);
  parts.push(bytes);
  return Buffer.concat(parts);
}
