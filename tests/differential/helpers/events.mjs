// tests/differential/helpers/events.mjs
// Event recorder and payload summaries for the differential tests (PORTING.md 14.2).
//
//   recordEvents(emitter, { events, into })  attach listeners, return the array of { event, payload }
//   summarize(value)                         payload summary (rules of PORTING.md 14.2, "helpers/events.mjs")
//   summarizeError(err)                      { name, code, message, data }
//   selectEvents(events, names)              keep the named events (default: the four compared ones)
//   omitV15Keys(events)                      drop the 'entry' payload keys only the archiver 7 stack writes;
//                                            a link target and the date and mode of a symlink read from disk
//                                            are on both stacks and stay
//   sortEvents(events)                       canonical order, for the multiset comparison of class N

import crypto from 'node:crypto';
import fs from 'node:fs';
import { types } from 'node:util';

export const EVENTS = ['entry', 'progress', 'warning', 'error', 'end', 'close'];
export const COMPARED_EVENTS = ['entry', 'progress', 'warning', 'error'];

// PORTING.md 3.2 V15 (a)
export const V15_ENTRY_KEYS = ['namePrependSlash', 'linkname', 'store', 'comment'];
export const V15_SYMLINK_ENTRY_KEYS = ['date', 'mode', 'store'];

function isError(value) {
  return types.isNativeError(value) || value instanceof Error;
}

function isStats(value) {
  return (
    value instanceof fs.Stats ||
    (typeof value.isFile === 'function' && typeof value.isDirectory === 'function' && 'size' in value)
  );
}

function statsType(stats) {
  if (stats.isFile()) return 'file';
  if (stats.isDirectory()) return 'directory';
  if (typeof stats.isSymbolicLink === 'function' && stats.isSymbolicLink()) return 'symlink';
  if (typeof stats.isFIFO === 'function' && stats.isFIFO()) return 'fifo';
  if (typeof stats.isSocket === 'function' && stats.isSocket()) return 'socket';
  if (typeof stats.isBlockDevice === 'function' && stats.isBlockDevice()) return 'block-device';
  if (typeof stats.isCharacterDevice === 'function' && stats.isCharacterDevice()) return 'character-device';
  return 'unknown';
}

export function summarizeError(err, seen = new WeakSet()) {
  if (err === null || typeof err !== 'object') {
    return summarize(err, seen);
  }
  return {
    name: err.name,
    code: err.code,
    message: err.message,
    data: summarize(err.data, seen),
  };
}

export function summarize(value, seen = new WeakSet()) {
  if (typeof value === 'function') return '[Function]';
  if (typeof value === 'bigint') return `${value}n`;
  if (typeof value === 'symbol') return value.toString();
  if (value === null || typeof value !== 'object') return value;

  if (types.isDate(value)) {
    return Number.isNaN(value.getTime()) ? 'Invalid Date' : value.toISOString();
  }
  if (ArrayBuffer.isView(value)) {
    const bytes = Buffer.from(value.buffer, value.byteOffset, value.byteLength);
    return { type: 'Buffer', length: bytes.length, sha1: crypto.createHash('sha1').update(bytes).digest('hex') };
  }
  if (seen.has(value)) return '[Circular]';
  seen.add(value);

  let summary;
  if (isError(value)) {
    summary = summarizeError(value, seen);
  } else if (isStats(value)) {
    summary = { size: value.size, type: statsType(value) };
  } else if (typeof value.pipe === 'function') {
    summary = { type: 'Stream' };
  } else if (Array.isArray(value)) {
    summary = value.map((item) => summarize(item, seen));
  } else {
    summary = {};
    for (const key of Object.keys(value)) {
      summary[key] = summarize(value[key], seen);
    }
  }
  seen.delete(value);
  return summary;
}

export function recordEvents(emitter, { events = EVENTS, into = [] } = {}) {
  for (const event of events) {
    emitter.on(event, (payload) => {
      into.push({ event, payload: summarize(payload) });
    });
  }
  return into;
}

export function selectEvents(events, names = COMPARED_EVENTS) {
  return events.filter((record) => names.includes(record.event));
}

export function omitV15Keys(events) {
  return events.map((record) => {
    if (record.event !== 'entry' || record.payload === null || typeof record.payload !== 'object') {
      return record;
    }
    // symlink() queues its data without stats; zip-stream 6 then defaults date, mode and store onto it
    const omitted =
      record.payload.type === 'symlink' && !record.payload.stats
        ? [...V15_ENTRY_KEYS, ...V15_SYMLINK_ENTRY_KEYS]
        : V15_ENTRY_KEYS;
    const payload = {};
    for (const key of Object.keys(record.payload)) {
      // archiver core writes the target of a symlink on both stacks; zip-stream 6 defaults the rest to null
      const kept = key === 'linkname' && typeof record.payload[key] === 'string';
      if (kept || !omitted.includes(key)) {
        payload[key] = record.payload[key];
      }
    }
    return { event: record.event, payload };
  });
}

function sortKey(record) {
  return JSON.stringify(record, (key, value) => (value === undefined ? '[undefined]' : value));
}

export function sortEvents(events) {
  return events
    .map((record) => ({ record, key: sortKey(record) }))
    .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
    .map((item) => item.record);
}
