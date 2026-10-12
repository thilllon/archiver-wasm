import streamx from 'streamx'
import type { ReadableOptions } from 'streamx'

import constants from './constants.js'
import { wasm, toBuffer, wasmString } from '../wasm.js'
import type { YkkWasm } from '../wasm.js'

const { Readable, Writable, getStreamError } = streamx

type Callback = (err?: Error | null) => void
// The callback streamx hands to its hooks (_open, _write, _final, _destroy, _read).
type StreamCallback = (err: Error | null) => void

interface Header {
  name?: string | null
  type?: string
  typeflag?: number
  mode?: number | null
  uid?: number
  gid?: number
  size?: number
  mtime?: Date
  linkname?: string
  uname?: string
  gname?: string
  devmajor?: number
  devminor?: number
  pax?: { [key: string]: unknown } | null
  [key: string]: unknown
}

// deps/tar-stream/pack.js:147-152 (the header after Pack.entry wrote its defaults into it)
interface EncodableHeader extends Header {
  size: number
  type: string
  mode: number
  uid: number
  gid: number
  mtime: Date
}

const DMODE = 0o755
const FMODE = 0o644

class Sink extends Writable {
  written: number
  header: EncodableHeader
  _callback: Callback | null
  _linkname: Buffer | null
  _isLinkname: boolean
  _isVoid: boolean
  _finished: boolean
  _pack: Pack
  _openCallback: StreamCallback | null

  // deps/tar-stream/pack.js:13
  constructor (pack: Pack, header: EncodableHeader, callback: Callback) {
    super({ mapWritable, eagerOpen: true })

    this.written = 0
    this.header = header

    this._callback = callback
    this._linkname = null
    this._isLinkname = header.type === 'symlink' && !header.linkname
    this._isVoid = header.type !== 'file' && header.type !== 'contiguous-file'
    this._finished = false
    this._pack = pack
    this._openCallback = null

    if (this._pack._stream === null) this._pack._stream = this
    else this._pack._pending.push(this)
  }

  // deps/tar-stream/pack.js:31
  _open (cb: StreamCallback) {
    this._openCallback = cb
    if (this._pack._stream === this) this._continueOpen()
  }

  // deps/tar-stream/pack.js:36
  _continuePack (err: Error | null) {
    if (this._callback === null) return

    const callback = this._callback
    this._callback = null

    callback(err)
  }

  // deps/tar-stream/pack.js:45
  _continueOpen () {
    if (this._pack._stream === null) this._pack._stream = this

    const cb = this._openCallback
    this._openCallback = null
    if (cb === null) return

    if (this._pack.destroying) return cb(new Error('pack stream destroyed'))
    if (this._pack._finalized) return cb(new Error('pack stream is already finalized'))

    this._pack._stream = this

    if (!this._isLinkname) {
      this._pack._encode(this.header)
    }

    if (this._isVoid) {
      this._finish()
      this._continuePack(null)
    }

    cb(null)
  }

  // deps/tar-stream/pack.js:69
  _write (data: Buffer, cb: StreamCallback) {
    if (this._isLinkname) {
      this._linkname = this._linkname ? Buffer.concat([this._linkname, data]) : data
      return cb(null)
    }

    if (this._isVoid) {
      if (data.byteLength > 0) {
        return cb(new Error('No body allowed for this entry'))
      }
      return cb(null)
    }

    this.written += data.byteLength
    if (this._pack.push(data)) return cb(null)
    this._pack._drain = cb
  }

  // deps/tar-stream/pack.js:87
  _finish () {
    if (this._finished) return
    this._finished = true

    if (this._isLinkname) {
      this.header.linkname = this._linkname ? Buffer.from(this._linkname.buffer, this._linkname.byteOffset, this._linkname.byteLength).toString('utf-8') : ''
      this._pack._encode(this.header)
    }

    overflow(this._pack, this.header.size)

    this._pack._done(this)
  }

  // deps/tar-stream/pack.js:101
  _final (cb: StreamCallback) {
    if (this.written !== this.header.size) { // corrupting tar
      return cb(new Error('Size mismatch'))
    }

    this._finish()
    cb(null)
  }

  // deps/tar-stream/pack.js:110
  _getError () {
    return getStreamError(this) || new Error('tar entry destroyed')
  }

  // deps/tar-stream/pack.js:114
  _predestroy () {
    this._pack.destroy(this._getError())
  }

  // deps/tar-stream/pack.js:118
  _destroy (cb: StreamCallback) {
    this._pack._done(this)

    this._continuePack(this._finished ? null : this._getError())

    cb(null)
  }
}

class Pack extends Readable {
  _drain: StreamCallback
  _finalized: boolean
  _finalizing: boolean
  _pending: Sink[]
  _stream: Sink | null
  _wasm: InstanceType<YkkWasm['WasmPack']>

  // deps/tar-stream/pack.js:128
  constructor (opts?: ReadableOptions) {
    super(opts)
    this._drain = noop
    this._finalized = false
    this._finalizing = false
    this._pending = []
    this._stream = null
    this._wasm = new wasm.WasmPack()
  }

  // PORTING.md 5.4 (lifetime of the encoder; upstream Pack has no _destroy)
  _destroy (cb: StreamCallback) {
    this._wasm.free()
    cb(null)
  }

  // deps/tar-stream/pack.js:137
  entry (header: Header, buffer?: Buffer | Uint8Array | string | Callback | null, callback?: Callback) {
    if (this._finalized || this.destroying) throw new Error('already finalized or destroyed')

    if (typeof buffer === 'function') {
      callback = buffer
      buffer = null
    }

    if (!callback) callback = noop

    if (!header.size || header.type === 'symlink') header.size = 0
    if (!header.type) header.type = modeToType(header.mode as number)
    if (!header.mode) header.mode = header.type === 'directory' ? DMODE : FMODE
    if (!header.uid) header.uid = 0
    if (!header.gid) header.gid = 0
    if (!header.mtime) header.mtime = new Date()

    if (typeof buffer === 'string') buffer = Buffer.from(buffer)

    const sink = new Sink(this, header as EncodableHeader, callback)

    if (Buffer.isBuffer(buffer) || buffer instanceof Uint8Array) {
      header.size = buffer.byteLength
      sink.write(buffer)
      ;(sink as unknown as { end: () => unknown }).end()
      return sink
    }

    return sink
  }

  // deps/tar-stream/pack.js:172
  finalize () {
    if (this._stream || this._pending.length > 0) {
      this._finalizing = true
      return
    }

    if (this._finalized) return
    this._finalized = true

    if (!this.destroying) { // PORTING.md V17
      this._wasm.finalize()
      this.push(toBuffer(this._wasm.takeOutput()))
    }
    this.push(null)
  }

  // deps/tar-stream/pack.js:185
  _done (stream: Sink) {
    if (stream !== this._stream) return

    this._stream = null

    if (this._finalizing) this.finalize()
    if (this._pending.length) (this._pending.shift() as Sink)._continueOpen()
  }

  // deps/tar-stream/pack.js:194-234 (_encode and _encodePax run in Rust; toString(8) and the pax records are deps/tar-stream/headers.js:242-243, 257, 24-26; the octal digits and, with pax, the linkname are only concatenated, headers.js:244, 21)
  _encode (header: EncodableHeader) {
    const pax = header.pax
    if (pax) {
      for (const key in pax) this._wasm.paxRecord(' ' + key + '=' + pax[key] + '\n')
    }
    this._wasm.encode(
      wasmString(header.name), header.typeflag === 5, header.mode,
      '' + header.uid.toString(8), '' + header.gid.toString(8),
      header.size, wasmString(header.size.toString(8)),
      header.mtime.getTime(),
      typeof header.type === 'string' ? header.type : '',
      header.linkname ? (pax ? '' + header.linkname : wasmString(header.linkname)) : undefined,
      header.uname ? wasmString(header.uname) : undefined,
      header.gname ? wasmString(header.gname) : undefined,
      '' + (header.devmajor || 0).toString(8), '' + (header.devminor || 0).toString(8),
      !!pax)
    this.push(toBuffer(this._wasm.takeOutput()))
  }

  // deps/tar-stream/pack.js:236
  _doDrain () {
    const drain = this._drain
    this._drain = noop
    drain(null)
  }

  // deps/tar-stream/pack.js:242
  _predestroy () {
    const err = getStreamError(this)

    if (this._stream) this._stream.destroy(err)

    while (this._pending.length) {
      const stream = this._pending.shift() as Sink
      stream.destroy(err)
      stream._continueOpen()
    }

    this._doDrain()
  }

  // deps/tar-stream/pack.js:256
  _read (cb: StreamCallback) {
    this._doDrain()
    cb(null)
  }
}

// deps/tar-stream/pack.js:262
export default function pack (opts?: ReadableOptions) {
  return new Pack(opts)
}

export type { Pack }

// deps/tar-stream/pack.js:266
function modeToType (mode: number) {
  switch (mode & constants.S_IFMT) {
    case constants.S_IFBLK: return 'block-device'
    case constants.S_IFCHR: return 'character-device'
    case constants.S_IFDIR: return 'directory'
    case constants.S_IFIFO: return 'fifo'
    case constants.S_IFLNK: return 'symlink'
  }

  return 'file'
}

// deps/tar-stream/pack.js:278
function noop () {}

// deps/tar-stream/pack.js:280
function overflow (self: Pack, size: number) {
  self._wasm.overflow(size)
  const out = self._wasm.takeOutput()
  if (out.length > 0) self.push(toBuffer(out))
}

// deps/tar-stream/pack.js:285
function mapWritable (buf: unknown) {
  return (Buffer.isBuffer(buf) || buf instanceof Uint8Array) ? buf : Buffer.from(buf as string)
}
