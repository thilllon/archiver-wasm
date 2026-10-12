import ArchiveEntry from "./archive-entry.js";
import { EMPTY, toBuffer } from "../wasm.js";
import type { WasmZipEntryInfo } from "../wasm.js";
import type { DateFields } from "../types.js";

// deps/compress-commons/lib/archivers/zip/constants.js:5-6, 16, 25
const SHORT_MASK = 0xffff;
const SHORT_SHIFT = 16;
const PLATFORM_UNIX = 3;
const ZIP64_MAGIC = 0xffffffff;

// deps/compress-commons/lib/archivers/zip/unix-stat.js:2-3
const FILE_TYPE_FLAG = 61440;
const LINK_FLAG = 40960;

// deps/compress-commons/lib/archivers/zip/general-purpose-bit.js:3-4, 7-8
var DATA_DESCRIPTOR_FLAG = 1 << 3;
var ENCRYPTION_FLAG = 1 << 0;
var STRONG_ENCRYPTION_FLAG = 1 << 6;
var UFT8_NAMES_FLAG = 1 << 11;

/** A plain copy of every WasmZipEntryInfo getter (PORTING.md 7.6). */
interface ZipEntryInfo {
  name: string;
  size: number;
  csize: number;
  crc: number;
  method: number;
  time: number;
  minver: number;
  platform: number;
  exattr: number;
  inattr: number;
  gpb: number;
  extra: Buffer;
  comment: string;
  offsetFile: number;
  offsetData: number;
  offsetContents: number;
}

// deps/compress-commons/lib/archivers/zip/util.js:2-16 (the getter selection of dateToDos; the packing is Rust, PORTING.md 10.5)
function dateFields(d: Date, forceLocalTime?: boolean): DateFields {
  forceLocalTime = forceLocalTime || false;
  var year = forceLocalTime ? d.getFullYear() : d.getUTCFullYear();
  var val = {
    year: year,
    month: forceLocalTime ? d.getMonth() : d.getUTCMonth(),
    date: forceLocalTime ? d.getDate() : d.getUTCDate(),
    hours: forceLocalTime ? d.getHours() : d.getUTCHours(),
    minutes: forceLocalTime ? d.getMinutes() : d.getUTCMinutes(),
    seconds: forceLocalTime ? d.getSeconds() : d.getUTCSeconds(),
  };
  return val;
}

// deps/compress-commons/lib/archivers/zip/util.js:26
function dosToDate(dos: number): Date {
  return new Date(
    ((dos >> 25) & 0x7f) + 1980,
    ((dos >> 21) & 0x0f) - 1,
    (dos >> 16) & 0x1f,
    (dos >> 11) & 0x1f,
    (dos >> 5) & 0x3f,
    (dos & 0x1f) << 1,
  );
}

export default class ZipArchiveEntry extends ArchiveEntry {
  // recorded by ZipStream.entry
  name!: string;
  date!: DateFields;
  namePrependSlash = false;
  store = false;
  comment = "";
  mode: number | undefined = undefined;
  // filled when the entry completes
  _info: ZipEntryInfo | null = null;

  // deps/compress-commons/lib/archivers/zip/zip-archive-entry.js:23
  constructor(name: string) {
    super();
    if (name) {
      this.setName(name);
    }
  }

  // deps/compress-commons/lib/archivers/zip/zip-archive-entry.js:49
  getCentralDirectoryExtra(): Buffer {
    return this.getExtra();
  }

  // deps/compress-commons/lib/archivers/zip/zip-archive-entry.js:58
  getComment(): string {
    return this._info !== null ? this._info.comment : this.comment;
  }

  // deps/compress-commons/lib/archivers/zip/zip-archive-entry.js:67
  getCompressedSize(): number {
    return this._info !== null ? this._info.csize : 0;
  }

  // deps/compress-commons/lib/archivers/zip/zip-archive-entry.js:76
  getCrc(): number {
    return this._info !== null ? this._info.crc : 0;
  }

  // deps/compress-commons/lib/archivers/zip/zip-archive-entry.js:85
  getExternalAttributes = function (this: ZipArchiveEntry): number {
    return this._info !== null ? this._info.exattr : 0;
  };

  // deps/compress-commons/lib/archivers/zip/zip-archive-entry.js:94
  getExtra(): Buffer {
    return this._info !== null ? this._info.extra : EMPTY;
  }

  // deps/compress-commons/lib/archivers/zip/zip-archive-entry.js:103 (the four readers of general-purpose-bit.js:58-78 over the encoded flags)
  getGeneralPurposeBit(): { usesDataDescriptor(): boolean; usesUTF8ForNames(): boolean; usesEncryption(): boolean; usesStrongEncryption(): boolean } {
    const flag = this._info !== null ? this._info.gpb : 0;
    return {
      usesDataDescriptor() {
        return (flag & DATA_DESCRIPTOR_FLAG) !== 0;
      },
      usesUTF8ForNames() {
        return (flag & UFT8_NAMES_FLAG) !== 0;
      },
      usesEncryption() {
        return (flag & ENCRYPTION_FLAG) !== 0;
      },
      usesStrongEncryption() {
        return (flag & STRONG_ENCRYPTION_FLAG) !== 0;
      },
    };
  }

  // deps/compress-commons/lib/archivers/zip/zip-archive-entry.js:112
  getInternalAttributes(): number {
    return this._info !== null ? this._info.inattr : 0;
  }

  // deps/compress-commons/lib/archivers/zip/zip-archive-entry.js:121
  getLastModifiedDate(): Date | number {
    return this.getTime();
  }

  // deps/compress-commons/lib/archivers/zip/zip-archive-entry.js:130
  getLocalFileDataExtra(): Buffer {
    return this.getExtra();
  }

  // deps/compress-commons/lib/archivers/zip/zip-archive-entry.js:139
  getMethod(): number {
    return this._info !== null ? this._info.method : 0;
  }

  // deps/compress-commons/lib/archivers/zip/zip-archive-entry.js:148
  getName(): string {
    return this._info !== null ? this._info.name : this.name;
  }

  // deps/compress-commons/lib/archivers/zip/zip-archive-entry.js:157
  getPlatform(): number {
    return this._info !== null ? this._info.platform : 0;
  }

  // deps/compress-commons/lib/archivers/zip/zip-archive-entry.js:165
  getSize(): number {
    return this._info !== null ? this._info.size : 0;
  }

  // deps/compress-commons/lib/archivers/zip/zip-archive-entry.js:173
  getTime(): Date | number {
    return this._info !== null ? dosToDate(this._info.time) : -1;
  }

  // deps/compress-commons/lib/archivers/zip/zip-archive-entry.js:181
  getTimeDos(): number {
    return this._info !== null ? this._info.time : 0;
  }

  // deps/compress-commons/lib/archivers/zip/zip-archive-entry.js:189
  getUnixMode(): number {
    return this.getPlatform() !== PLATFORM_UNIX
      ? 0
      : (this.getExternalAttributes() >> SHORT_SHIFT) & SHORT_MASK;
  }

  // deps/compress-commons/lib/archivers/zip/zip-archive-entry.js:199
  getVersionNeededToExtract(): number {
    return this._info !== null ? this._info.minver : 0;
  }

  // deps/compress-commons/lib/archivers/zip/zip-archive-entry.js:207
  setComment(comment: string): void {
    this.comment = comment;
  }

  // deps/compress-commons/lib/archivers/zip/zip-archive-entry.js:275
  setMethod(method: number): void {
    if (method < 0) {
      throw new Error("invalid entry compression method");
    }
    this.store = method === 0;
  }

  // deps/compress-commons/lib/archivers/zip/zip-archive-entry.js:287
  setName(name: string, prependSlash = false): void {
    this.name = name;
    this.namePrependSlash = !!prependSlash;
  }

  // deps/compress-commons/lib/archivers/zip/zip-archive-entry.js:324
  setTime(time: Date, forceLocalTime?: boolean): void {
    if (!(time instanceof Date)) {
      throw new Error("invalid entry time");
    }
    this.date = dateFields(time, forceLocalTime);
  }

  // deps/compress-commons/lib/archivers/zip/zip-archive-entry.js:335
  setUnixMode(mode: number): void {
    this.mode = mode;
  }

  // deps/compress-commons/lib/archivers/zip/zip-archive-entry.js:356
  isDirectory(): boolean {
    return this.getName().slice(-1) === "/";
  }

  // deps/compress-commons/lib/archivers/zip/zip-archive-entry.js:366
  isUnixSymlink(): boolean {
    return (
      (this.getUnixMode() & FILE_TYPE_FLAG) === LINK_FLAG
    );
  }

  // deps/compress-commons/lib/archivers/zip/zip-archive-entry.js:377
  isZip64(): boolean {
    return this.getCompressedSize() > ZIP64_MAGIC || this.getSize() > ZIP64_MAGIC;
  }

  // deps/compress-commons/lib/archivers/zip/zip-archive-output-stream.js:140-144 (the ad hoc `_offsets` property, as the completed entry recorded it)
  get _offsets(): { file: number; data: number; contents: number } {
    return {
      file: this._info !== null ? this._info.offsetFile : 0,
      data: this._info !== null ? this._info.offsetData : 0,
      contents: this._info !== null ? this._info.offsetContents : 0,
    };
  }

  // deps/compress-commons/lib/archivers/zip/zip-archive-output-stream.js:154-157 (the completed entry, copied out of wasm and freed, PORTING.md 7.6)
  _setInfo(info: WasmZipEntryInfo | undefined): void {
    if (info === undefined) {
      return;
    }
    this._info = {
      name: info.name,
      size: info.size,
      csize: info.csize,
      crc: info.crc,
      method: info.method,
      time: info.time,
      minver: info.minver,
      platform: info.platform,
      exattr: info.exattr,
      inattr: info.inattr,
      gpb: info.gpb,
      extra: toBuffer(info.extra),
      comment: info.comment,
      offsetFile: info.offsetFile,
      offsetData: info.offsetData,
      offsetContents: info.offsetContents,
    };
    info.free();
  }
}
