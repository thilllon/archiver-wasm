// The wasm-bindgen surface of archiver-core (PORTING.md 5.3). Marshalling only (5.4 to 5.6).

use wasm_bindgen::prelude::*;

use archiver_core::error::ZipError;
use archiver_core::tar::Header;
use archiver_core::zip::encrypted::aes_hmac_etm_stream::COMPOSITE_KEY_LENGTH;
use archiver_core::zip::encrypted::crypto_stream::HEADER_LENGTH;
use archiver_core::zip::{
    DateFields, Encryption, EntryOptions, Source, ZipArchiveEntry, ZipEntryData,
};

// PORTING.md 5.5
fn to_js_error<E: std::fmt::Display>(e: E) -> JsError {
    JsError::new(&e.to_string())
}

// ---------------------------------------------------------------- zip
#[wasm_bindgen]
pub struct WasmZipStream {
    inner: archiver_core::zip::ZipStream,
}

#[wasm_bindgen]
impl WasmZipStream {
    /// encryption: 0 = none, 1 = ZipCrypto ("zip20"), 2 = WinZip AES-256 ("aes256").
    // deps/compress-commons/lib/archivers/zip/zip-archive-output-stream.js:44-60
    #[wasm_bindgen(constructor)]
    pub fn new(force_zip64: bool, encryption: u8) -> Result<WasmZipStream, JsError> {
        let encryption = match encryption {
            0 => Encryption::None,
            1 => Encryption::ZipCrypto,
            2 => Encryption::Aes256,
            _ => return Err(to_js_error(ZipError::InvalidEncryption(encryption))),
        };
        Ok(WasmZipStream {
            inner: archiver_core::zip::ZipStream::new(force_zip64, encryption),
        })
    }

    // deps/compress-commons/lib/archivers/zip/zip-archive-output-stream.js:368-370
    #[wasm_bindgen(js_name = setComment)]
    pub fn set_comment(&mut self, comment: &str) {
        self.inner.inner.set_comment(comment);
    }

    /// Overwrites the writer's offset with ArchiveOutputStream.offset as TypeScript counts
    /// it (archive-output-stream.js:92-97). Called immediately before entry(), before
    /// finish() and, for ZipCrypto, before endData() (7.5).
    // deps/compress-commons/lib/archivers/archive-output-stream.js:92-97
    #[wasm_bindgen(js_name = setOffset)]
    pub fn set_offset(&mut self, offset: f64) {
        self.inner.inner.set_offset(offset as u64);
    }

    /// Starts one entry. Returns 0 = stored buffer of the plain engine: the local header is
    /// written, the caller emits the `source_len` payload bytes itself and then calls
    /// completeStored() (upstream called back synchronously here);
    /// 1 = open, payload pipeline is CRC only (stored), 2 = open, payload pipeline deflates.
    /// `is_buffer`: Buffer.isBuffer(source). `source_len` and `source_crc`: length and
    /// CRC-32 (crc32Update over the slices) of the buffer; both 0 when `is_buffer` is false.
    /// The payload itself is never an argument of this call (5.4).
    /// `key`: password bytes (empty for encryption 0). `random`: AES salt, or the 12
    /// ZipCrypto header bytes, or empty for encryption 0.
    // deps/zip-stream/index.js:101-150
    #[allow(clippy::too_many_arguments)]
    pub fn entry(
        &mut self,
        name: &str,
        year: f64,
        month: f64,
        date: f64,
        hours: f64,
        minutes: f64,
        seconds: f64,
        name_prepend_slash: bool,
        store: bool,
        comment: &str,
        has_mode: bool,
        mode: i32,
        level: i32,
        key: &[u8],
        random: &[u8],
        is_buffer: bool,
        source_len: f64,
        source_crc: u32,
    ) -> Result<u8, JsError> {
        let data = ZipEntryData {
            name: name.to_owned(),
            date: DateFields {
                year,
                month,
                date,
                hours,
                minutes,
                seconds,
            },
            name_prepend_slash,
            store,
            comment: comment.to_owned(),
            mode: if has_mode { Some(mode) } else { None },
        };
        let source = if is_buffer {
            Source::Buffer {
                len: source_len as u64,
                crc: source_crc,
            }
        } else {
            Source::Stream
        };
        let opts = EntryOptions {
            level,
            key: key.to_vec(),
            random: random.to_vec(),
        };
        let status = self
            .inner
            .entry(source, &data, &opts)
            .map_err(to_js_error)?;
        Ok(status as u8)
    }

    /// Ends an entry for which entry() returned 0, after the caller wrote the payload.
    // deps/compress-commons/lib/archivers/zip/zip-archive-output-stream.js:86-88
    #[wasm_bindgen(js_name = completeStored)]
    pub fn complete_stored(&mut self) -> Result<(), JsError> {
        self.inner.inner.complete_stored().map_err(to_js_error)
    }

    /// One payload slice of an open entry (at most MAX_CHUNK bytes, 5.4).
    // deps/compress-commons/lib/archivers/zip/zip-archive-output-stream.js:165
    #[wasm_bindgen(js_name = writeData)]
    pub fn write_data(&mut self, chunk: &[u8]) -> Result<(), JsError> {
        self.inner.inner.write_data(chunk).map_err(to_js_error)
    }

    // deps/compress-commons/lib/archivers/zip/zip-archive-output-stream.js:153-160
    #[wasm_bindgen(js_name = endData)]
    pub fn end_data(&mut self) -> Result<(), JsError> {
        self.inner.inner.end_data().map_err(to_js_error)
    }

    /// ZipCrypto only: one slice of the compressed bytes that writeData() handed out,
    /// after endData() wrote the local header (V16).
    // archiver-zip-encrypted/lib/zip20/zip-crypto-stream.js:70-72
    #[wasm_bindgen(js_name = encryptData)]
    pub fn encrypt_data(&mut self, chunk: &[u8]) -> Result<(), JsError> {
        self.inner.inner.encrypt_data(chunk).map_err(to_js_error)
    }

    // archiver-zip-encrypted/lib/zip20/zip-crypto-stream.js:73-78
    #[wasm_bindgen(js_name = encryptEnd)]
    pub fn encrypt_end(&mut self) -> Result<(), JsError> {
        self.inner.inner.encrypt_end().map_err(to_js_error)
    }

    // deps/compress-commons/lib/archivers/archive-output-stream.js:80-86
    pub fn finish(&mut self) {
        self.inner.inner.finish();
    }

    // PORTING.md 5.4
    #[wasm_bindgen(js_name = takeOutput)]
    pub fn take_output(&mut self) -> Vec<u8> {
        self.inner.inner.take_output()
    }

    // deps/compress-commons/lib/archivers/zip/zip-archive-output-stream.js:359-366
    #[wasm_bindgen(js_name = isZip64)]
    pub fn is_zip64(&self) -> bool {
        self.inner.inner.is_zip64()
    }

    // deps/compress-commons/lib/archivers/zip/zip-archive-output-stream.js:112
    #[wasm_bindgen(js_name = centralOffset)]
    pub fn central_offset(&self) -> f64 {
        self.inner.inner._archive.central_offset as f64
    }

    // deps/compress-commons/lib/archivers/zip/zip-archive-output-stream.js:118
    #[wasm_bindgen(js_name = centralLength)]
    pub fn central_length(&self) -> f64 {
        self.inner.inner._archive.central_length as f64
    }

    /// Snapshot of the most recently completed entry (`_entries.last()`), or undefined.
    // deps/compress-commons/lib/archivers/zip/zip-archive-output-stream.js:63 (PORTING.md V6)
    #[wasm_bindgen(js_name = lastEntry)]
    pub fn last_entry(&self) -> Option<WasmZipEntryInfo> {
        self.inner.inner._entries.last().map(WasmZipEntryInfo::new)
    }
}

#[wasm_bindgen]
pub struct WasmZipEntryInfo {
    name: String,
    size: f64,
    csize: f64,
    crc: u32,
    method: i32,
    time: u32,
    minver: u16,
    platform: u8,
    exattr: u32,
    inattr: u16,
    gpb: u16,
    extra: Vec<u8>,
    comment: String,
    offset_file: f64,
    offset_data: f64,
    offset_contents: f64,
}

impl WasmZipEntryInfo {
    // PORTING.md 5.3
    fn new(ae: &ZipArchiveEntry) -> WasmZipEntryInfo {
        WasmZipEntryInfo {
            name: ae.get_name().unwrap_or("").to_owned(),
            size: ae.get_size() as f64,
            csize: ae.get_compressed_size() as f64,
            crc: ae.get_crc(),
            method: ae.get_method(),
            time: ae.get_time_dos(),
            minver: ae.get_version_needed_to_extract(),
            platform: ae.get_platform(),
            exattr: ae.get_external_attributes(),
            inattr: ae.get_internal_attributes(),
            gpb: u16::from_le_bytes(ae.get_general_purpose_bit().encode()),
            extra: ae.get_extra().to_vec(),
            comment: ae.get_comment().to_owned(),
            offset_file: ae._offsets.file as f64,
            offset_data: ae._offsets.data as f64,
            offset_contents: ae._offsets.contents as f64,
        }
    }
}

#[wasm_bindgen]
impl WasmZipEntryInfo {
    // deps/compress-commons/lib/archivers/zip/zip-archive-entry.js:148-150
    #[wasm_bindgen(getter)]
    pub fn name(&self) -> String {
        self.name.clone()
    }

    // deps/compress-commons/lib/archivers/zip/zip-archive-entry.js:165-167
    #[wasm_bindgen(getter)]
    pub fn size(&self) -> f64 {
        self.size
    }

    // deps/compress-commons/lib/archivers/zip/zip-archive-entry.js:67-69
    #[wasm_bindgen(getter)]
    pub fn csize(&self) -> f64 {
        self.csize
    }

    // deps/compress-commons/lib/archivers/zip/zip-archive-entry.js:76-78
    #[wasm_bindgen(getter)]
    pub fn crc(&self) -> u32 {
        self.crc
    }

    // deps/compress-commons/lib/archivers/zip/zip-archive-entry.js:139-141
    #[wasm_bindgen(getter)]
    pub fn method(&self) -> i32 {
        self.method
    }

    // deps/compress-commons/lib/archivers/zip/zip-archive-entry.js:181-183
    #[wasm_bindgen(getter)]
    pub fn time(&self) -> u32 {
        self.time
    }

    // deps/compress-commons/lib/archivers/zip/zip-archive-entry.js:199-201
    #[wasm_bindgen(getter)]
    pub fn minver(&self) -> u16 {
        self.minver
    }

    // deps/compress-commons/lib/archivers/zip/zip-archive-entry.js:157-159
    #[wasm_bindgen(getter)]
    pub fn platform(&self) -> u8 {
        self.platform
    }

    // deps/compress-commons/lib/archivers/zip/zip-archive-entry.js:85-87
    #[wasm_bindgen(getter)]
    pub fn exattr(&self) -> u32 {
        self.exattr
    }

    // deps/compress-commons/lib/archivers/zip/zip-archive-entry.js:112-114
    #[wasm_bindgen(getter)]
    pub fn inattr(&self) -> u16 {
        self.inattr
    }

    // deps/compress-commons/lib/archivers/zip/zip-archive-entry.js:103-105
    #[wasm_bindgen(getter)]
    pub fn gpb(&self) -> u16 {
        self.gpb
    }

    // deps/compress-commons/lib/archivers/zip/zip-archive-entry.js:94-96
    #[wasm_bindgen(getter)]
    pub fn extra(&self) -> Vec<u8> {
        self.extra.clone()
    }

    // deps/compress-commons/lib/archivers/zip/zip-archive-entry.js:58-60
    #[wasm_bindgen(getter)]
    pub fn comment(&self) -> String {
        self.comment.clone()
    }

    // deps/compress-commons/lib/archivers/zip/zip-archive-output-stream.js:140-144
    #[wasm_bindgen(getter, js_name = offsetFile)]
    pub fn offset_file(&self) -> f64 {
        self.offset_file
    }

    // deps/compress-commons/lib/archivers/zip/zip-archive-output-stream.js:140-144
    #[wasm_bindgen(getter, js_name = offsetData)]
    pub fn offset_data(&self) -> f64 {
        self.offset_data
    }

    // deps/compress-commons/lib/archivers/zip/zip-archive-output-stream.js:140-144
    #[wasm_bindgen(getter, js_name = offsetContents)]
    pub fn offset_contents(&self) -> f64 {
        self.offset_contents
    }
}

// ---------------------------------------------------------------- tar
#[wasm_bindgen]
pub struct WasmPack {
    inner: archiver_core::tar::Pack,
    pax: Vec<String>,
}

#[wasm_bindgen]
impl WasmPack {
    // deps/tar-stream/pack.js:128-135
    #[wasm_bindgen(constructor)]
    pub fn new() -> WasmPack {
        WasmPack {
            inner: archiver_core::tar::Pack::new(),
            pax: Vec::new(),
        }
    }

    /// Queues one pax record body (' key=value\n', already concatenated in JS) for the
    /// next encode() call. encode() consumes and clears the queue.
    // deps/tar-stream/headers.js:24-26
    #[wasm_bindgen(js_name = paxRecord)]
    pub fn pax_record(&mut self, body: &str) {
        self.pax.push(body.to_owned());
    }

    /// Pack._encode(header). `force_pax` is `!!header.pax`. The `*_oct` arguments are
    /// `value.toString(8)` computed in JS. `mtime` is `header.mtime.getTime()`.
    /// `linkname`, `uname`, `gname` are undefined when the JS value is falsy.
    // deps/tar-stream/pack.js:194-203
    #[allow(clippy::too_many_arguments)]
    pub fn encode(
        &mut self,
        name: &str,
        typeflag_is_5: bool,
        mode: i32,
        uid_oct: &str,
        gid_oct: &str,
        size: f64,
        size_oct: &str,
        mtime: f64,
        type_: &str,
        linkname: Option<String>,
        uname: Option<String>,
        gname: Option<String>,
        devmajor_oct: &str,
        devminor_oct: &str,
        force_pax: bool,
    ) {
        let header = Header {
            name: name.to_owned(),
            typeflag_is_5,
            mode,
            uid_oct: uid_oct.to_owned(),
            gid_oct: gid_oct.to_owned(),
            size,
            size_oct: size_oct.to_owned(),
            mtime,
            type_: type_.to_owned(),
            linkname,
            uname,
            gname,
            devmajor_oct: devmajor_oct.to_owned(),
            devminor_oct: devminor_oct.to_owned(),
        };
        let records = std::mem::take(&mut self.pax);
        let pax = if force_pax {
            Some(records.as_slice())
        } else {
            None
        };
        self.inner._encode(&header, pax);
    }

    /// overflow(pack, size): zero padding to the next 512-byte boundary.
    // deps/tar-stream/pack.js:280-283
    pub fn overflow(&mut self, size: f64) {
        archiver_core::tar::overflow(&mut self.inner, size);
    }

    /// Appends END_OF_TAR (1024 zero bytes) once.
    // deps/tar-stream/pack.js:178-181
    pub fn finalize(&mut self) {
        self.inner.finalize();
    }

    // PORTING.md 5.4
    #[wasm_bindgen(js_name = takeOutput)]
    pub fn take_output(&mut self) -> Vec<u8> {
        self.inner.take_output()
    }
}

// ---------------------------------------------------------------- gzip, json
#[wasm_bindgen]
pub struct WasmGzip {
    inner: archiver_core::gzip::Gzip,
}

#[wasm_bindgen]
impl WasmGzip {
    // node-archiver/lib/plugins/tar.js:28
    #[wasm_bindgen(constructor)]
    pub fn new(level: i32, strategy: i32, os: u8) -> WasmGzip {
        WasmGzip {
            inner: archiver_core::gzip::Gzip::new(level, strategy, os),
        }
    }

    // node-archiver/lib/plugins/tar.js:28 (one write into zlib.createGzip, PORTING.md 6.4)
    pub fn write(&mut self, chunk: &[u8]) -> Result<Vec<u8>, JsError> {
        let mut out = Vec::new();
        self.inner.write(chunk, &mut out).map_err(to_js_error)?;
        Ok(out)
    }

    // node-archiver/lib/plugins/tar.js:28 (the end of zlib.createGzip, PORTING.md 6.4)
    pub fn finish(&mut self) -> Result<Vec<u8>, JsError> {
        let mut out = Vec::new();
        self.inner.finish(&mut out).map_err(to_js_error)?;
        Ok(out)
    }
}

/// buffer-crc32 `crc32.unsigned(source)` for the json plugin (json.js:60), fed in slices:
/// `seed` is the result for the previous slices, 0 for the first.
// node-archiver/lib/plugins/json.js:60
#[wasm_bindgen(js_name = jsonAppend)]
pub fn json_append(seed: u32, chunk: &[u8]) -> u32 {
    let entry = archiver_core::json::JsonEntry {
        crc32: seed,
        size: 0,
    };
    archiver_core::json::append(entry, chunk).crc32
}

/// crc-32 `buf(chunk, seed) >>> 0` (archiver_core::crc32::buf): the CRC of a zip buffer source,
/// fed in slices by TypeScript before entry() (7.5).
// deps/crc-32/crc32.js:70-82
#[wasm_bindgen(js_name = crc32Update)]
pub fn crc32_update(seed: u32, chunk: &[u8]) -> u32 {
    archiver_core::crc32::buf(chunk, seed)
}

// ---------------------------------------------------------------- encryption primitives
#[wasm_bindgen]
pub struct WasmCryptoCipher {
    inner: archiver_core::zip::encrypted::CryptoCipher,
}

#[wasm_bindgen]
impl WasmCryptoCipher {
    // archiver-zip-encrypted/lib/zip20/CryptoCipher.js:14-21
    #[wasm_bindgen(constructor)]
    pub fn new(key: &[u8]) -> WasmCryptoCipher {
        WasmCryptoCipher {
            inner: archiver_core::zip::encrypted::CryptoCipher::new(key),
        }
    }

    // archiver-zip-encrypted/lib/zip20/CryptoCipher.js:57-63
    pub fn encrypt(&mut self, data: &[u8]) -> Vec<u8> {
        self.inner.encrypt(data)
    }

    // archiver-zip-encrypted/lib/zip20/CryptoCipher.js:65-71
    pub fn decrypt(&mut self, data: &[u8]) -> Vec<u8> {
        self.inner.decrypt(data)
    }
}

#[wasm_bindgen]
pub struct WasmCryptoStream {
    inner: archiver_core::zip::encrypted::CryptoStream,
}

#[wasm_bindgen]
impl WasmCryptoStream {
    /// crc: `options.crc.readUInt16BE(0)` computed in JS. header: exactly 12 bytes.
    // archiver-zip-encrypted/lib/zip20/crypto-stream.js:13-24
    #[wasm_bindgen(constructor)]
    pub fn new(key: &[u8], crc: u16, header: &[u8]) -> Result<WasmCryptoStream, JsError> {
        let header: [u8; HEADER_LENGTH] = header.try_into().map_err(|_| {
            to_js_error(ZipError::InvalidRandomLength {
                expected: HEADER_LENGTH,
                actual: header.len(),
            })
        })?;
        Ok(WasmCryptoStream {
            inner: archiver_core::zip::encrypted::CryptoStream::new(key, crc, header),
        })
    }

    // archiver-zip-encrypted/lib/zip20/crypto-stream.js:31-50
    pub fn transform(&mut self, data: &[u8]) -> Vec<u8> {
        let mut out = Vec::new();
        self.inner._transform(data, &mut out);
        out
    }
}

#[wasm_bindgen]
pub struct WasmDecryptoStream {
    inner: archiver_core::zip::encrypted::DecryptoStream,
}

#[wasm_bindgen]
impl WasmDecryptoStream {
    // archiver-zip-encrypted/lib/zip20/decrypto-stream.js:12-25
    #[wasm_bindgen(constructor)]
    pub fn new(key: &[u8]) -> WasmDecryptoStream {
        WasmDecryptoStream {
            inner: archiver_core::zip::encrypted::DecryptoStream::new(key),
        }
    }

    // archiver-zip-encrypted/lib/zip20/decrypto-stream.js:37-60
    pub fn transform(&mut self, data: &[u8]) -> Vec<u8> {
        let mut out = Vec::new();
        self.inner._transform(data, &mut out);
        out
    }

    // archiver-zip-encrypted/lib/zip20/decrypto-stream.js:29-31
    #[wasm_bindgen(js_name = getTotalSize)]
    pub fn get_total_size(&self) -> f64 {
        self.inner.get_total_size() as f64
    }
}

#[wasm_bindgen]
pub struct WasmAesHmacEtmStream {
    inner: archiver_core::zip::encrypted::AesHmacEtmStream,
}

#[wasm_bindgen]
impl WasmAesHmacEtmStream {
    /// Takes the already derived key parts (what deriveKey returned) and the salt.
    // archiver-zip-encrypted/lib/aes/aes-hmac-etm-stream.js:31-51
    #[wasm_bindgen(constructor)]
    pub fn new(
        aes_key: &[u8],
        hmac_key: &[u8],
        password_verifier: &[u8],
        salt: &[u8],
    ) -> Result<WasmAesHmacEtmStream, JsError> {
        let inner = archiver_core::zip::encrypted::AesHmacEtmStream::from_parts(
            aes_key,
            hmac_key,
            password_verifier,
            salt,
        )
        .map_err(to_js_error)?;
        Ok(WasmAesHmacEtmStream { inner })
    }

    /// PBKDF2-HMAC-SHA1(key, salt, 1000, 66). Returns 66 bytes: aesKey | hmacKey | verifier.
    // archiver-zip-encrypted/lib/aes/aes-hmac-etm-stream.js:54-61
    #[wasm_bindgen(js_name = deriveKey)]
    pub fn derive_key(salt: &[u8], key: &[u8]) -> Vec<u8> {
        let composite = archiver_core::zip::encrypted::derive_key(salt, key);
        let mut out = Vec::with_capacity(COMPOSITE_KEY_LENGTH);
        out.extend_from_slice(&composite.aes_key);
        out.extend_from_slice(&composite.hmac_key);
        out.extend_from_slice(&composite.password_verifier);
        out
    }

    // archiver-zip-encrypted/lib/aes/aes-hmac-etm-stream.js:79-91
    pub fn transform(&mut self, data: &[u8]) -> Vec<u8> {
        let mut out = Vec::new();
        self.inner._transform(data, &mut out);
        out
    }

    // archiver-zip-encrypted/lib/aes/aes-hmac-etm-stream.js:93-103
    pub fn flush(&mut self) -> Vec<u8> {
        let mut out = Vec::new();
        self.inner._flush(&mut out);
        out
    }

    // archiver-zip-encrypted/lib/aes/aes-hmac-etm-stream.js:63-65
    #[wasm_bindgen(js_name = getTotalSize)]
    pub fn get_total_size(&self) -> f64 {
        self.inner.get_total_size() as f64
    }
}

// Native tests take the Ok arm only: JsError cannot be constructed off wasm32.
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn crc32_update_slices() {
        assert_eq!(crc32_update(0, b"test"), 3632233996);
        assert_eq!(crc32_update(0, b"this is a text file"), 585446183);
        assert_eq!(
            crc32_update(crc32_update(0, b"this is a "), b"text file"),
            585446183
        );
        assert_eq!(crc32_update(0, b""), 0);
    }

    #[test]
    fn json_append_slices() {
        let source: Vec<u8> = (0..16384usize).map(|i| (i & 255) as u8).collect();
        assert_eq!(json_append(0, &source), 3893830384);
        assert_eq!(
            json_append(json_append(0, &source[..5000]), &source[5000..]),
            3893830384
        );
        assert_eq!(json_append(0, b""), 0);
    }

    #[test]
    fn zip_empty_archive() {
        let Ok(mut zip) = WasmZipStream::new(false, 0) else {
            panic!("encryption 0 is valid");
        };
        assert!(zip.last_entry().is_none());
        zip.finish();
        let mut expected = vec![0x50, 0x4b, 0x05, 0x06];
        expected.extend_from_slice(&[0u8; 18]);
        assert_eq!(zip.take_output(), expected);
        assert_eq!(zip.take_output(), Vec::<u8>::new());
        assert_eq!(zip.inner.inner.offset, 22);
        assert_eq!(zip.central_offset(), 0.0);
        assert_eq!(zip.central_length(), 0.0);
        assert!(!zip.is_zip64());
    }

    #[test]
    fn zip_stored_buffer_entry_snapshot() {
        let Ok(mut zip) = WasmZipStream::new(false, 0) else {
            panic!("encryption 0 is valid");
        };
        let source = b"this is a text file";
        let crc = crc32_update(0, source);
        let Ok(status) = zip.entry(
            "a.txt",
            2013.0,
            0.0,
            3.0,
            14.0,
            26.0,
            38.0,
            false,
            true,
            "",
            true,
            420,
            1,
            &[],
            &[],
            true,
            source.len() as f64,
            crc,
        ) else {
            panic!("a stored buffer entry is accepted");
        };
        assert_eq!(status, 0);
        let header = zip.take_output();
        assert_eq!(header.len(), 30 + 5);
        assert_eq!(&header[..4], &[0x50, 0x4b, 0x03, 0x04]);
        assert!(zip.complete_stored().is_ok());
        let Some(info) = zip.last_entry() else {
            panic!("the entry was completed");
        };
        assert_eq!(info.name(), "a.txt");
        assert_eq!(info.size(), 19.0);
        assert_eq!(info.csize(), 19.0);
        assert_eq!(info.crc(), 585446183);
        assert_eq!(info.method(), 0);
        assert_eq!(info.platform(), 3);
        assert_eq!(info.exattr(), 0x81a4_0020);
        assert_eq!(info.inattr(), 0);
        assert_eq!(info.gpb(), 0);
        assert_eq!(info.extra(), Vec::<u8>::new());
        assert_eq!(info.comment(), "");
        assert_eq!(info.offset_file(), 0.0);
        assert_eq!(info.offset_data(), 14.0);
        assert_eq!(info.offset_contents(), 35.0);
        assert_eq!(zip.inner.inner.offset, 54);
    }

    const SOURCE: &[u8] = b"this is a text file";

    // 'a.txt' dated 2013-01-03T14:26:38Z, level 1, no comment, mode 420 when `has_mode`.
    fn entry(
        zip: &mut WasmZipStream,
        store: bool,
        has_mode: bool,
        key: &[u8],
        random: &[u8],
        is_buffer: bool,
    ) -> u8 {
        let (source_len, source_crc) = if is_buffer {
            (SOURCE.len() as f64, crc32_update(0, SOURCE))
        } else {
            (0.0, 0)
        };
        let Ok(status) = zip.entry(
            "a.txt",
            2013.0,
            0.0,
            3.0,
            14.0,
            26.0,
            38.0,
            false,
            store,
            "",
            has_mode,
            if has_mode { 420 } else { 0 },
            1,
            key,
            random,
            is_buffer,
            source_len,
            source_crc,
        ) else {
            panic!("the entry is accepted");
        };
        status
    }

    fn payload(zip: &mut WasmZipStream) -> WasmZipEntryInfo {
        assert!(zip.write_data(SOURCE).is_ok());
        assert!(zip.end_data().is_ok());
        let Some(info) = zip.last_entry() else {
            panic!("the entry was completed");
        };
        info
    }

    #[test]
    fn zip_stream_entry_without_mode() {
        let Ok(mut zip) = WasmZipStream::new(false, 0) else {
            panic!("encryption 0 is valid");
        };
        assert_eq!(entry(&mut zip, true, false, &[], &[], false), 1);
        let info = payload(&mut zip);
        assert_eq!(info.size(), 19.0);
        assert_eq!(info.csize(), 19.0);
        assert_eq!(info.crc(), 585446183);
        assert_eq!(info.method(), 0);
        assert_eq!(info.time(), 1109619539);
        assert_eq!(info.minver(), 20);
        assert_eq!(info.platform(), 0);
        assert_eq!(info.exattr(), 0);
        assert_eq!(info.gpb(), 8);
        assert_eq!(info.offset_file(), 0.0);
        assert_eq!(info.offset_data(), 14.0);
        assert_eq!(info.offset_contents(), 35.0);
        assert_eq!(zip.inner.inner.offset, 70);
        zip.finish();
        assert_eq!(zip.central_offset(), 70.0);
        assert_eq!(zip.central_length(), 51.0);
        assert_eq!(zip.inner.inner.offset, 143);
    }

    #[test]
    fn zip_deflated_stream_entry_status() {
        let Ok(mut zip) = WasmZipStream::new(false, 0) else {
            panic!("encryption 0 is valid");
        };
        assert_eq!(entry(&mut zip, false, false, &[], &[], false), 2);
        let info = payload(&mut zip);
        assert_eq!(info.size(), 19.0);
        assert_eq!(info.crc(), 585446183);
        assert_eq!(info.method(), 8);
    }

    #[test]
    fn zip_set_offset_and_set_comment() {
        let Ok(mut zip) = WasmZipStream::new(false, 0) else {
            panic!("encryption 0 is valid");
        };
        zip.set_comment("archive");
        zip.set_offset(6.0);
        assert_eq!(entry(&mut zip, true, false, &[], &[], false), 1);
        let info = payload(&mut zip);
        assert_eq!(info.offset_file(), 6.0);
        assert_eq!(info.offset_data(), 20.0);
        assert_eq!(info.offset_contents(), 41.0);
        assert_eq!(zip.inner.inner.offset, 76);
        zip.finish();
        assert_eq!(zip.central_offset(), 76.0);
        assert_eq!(zip.central_length(), 51.0);
        assert_eq!(zip.inner.inner.offset, 156);
        let output = zip.take_output();
        assert_eq!(output.len(), 150);
        assert_eq!(&output[output.len() - 9..], b"\x07\0archive");
    }

    #[test]
    fn zip_encryption_methods() {
        let Ok(mut zip) = WasmZipStream::new(false, 1) else {
            panic!("encryption 1 is valid");
        };
        assert_eq!(entry(&mut zip, true, true, b"123", &[7u8; 12], true), 1);
        assert!(zip.write_data(SOURCE).is_ok());
        assert_eq!(zip.take_output(), SOURCE);
        assert_eq!(zip.inner.inner.offset, 0);
        assert!(zip.end_data().is_ok());
        assert_eq!(zip.take_output().len(), 35);
        assert!(zip.encrypt_data(SOURCE).is_ok());
        assert!(zip.encrypt_end().is_ok());
        assert_eq!(zip.take_output().len(), 19 + 12);
        let Some(info) = zip.last_entry() else {
            panic!("the entry was completed");
        };
        assert_eq!(info.size(), 19.0);
        assert_eq!(info.csize(), 19.0 + 12.0);
        assert_eq!(info.crc(), 585446183);
        assert_eq!(info.method(), 0);
        assert_eq!(info.minver(), 10);
        assert_eq!(info.gpb(), 1);
        assert_eq!(info.extra(), Vec::<u8>::new());
        assert_eq!(info.offset_contents(), 35.0);
        assert_eq!(zip.inner.inner.offset, 66);

        let Ok(mut zip) = WasmZipStream::new(false, 2) else {
            panic!("encryption 2 is valid");
        };
        assert_eq!(entry(&mut zip, true, true, b"123", &[1u8; 16], true), 1);
        let info = payload(&mut zip);
        assert_eq!(info.size(), 19.0);
        assert_eq!(info.csize(), 19.0 + 28.0);
        assert_eq!(info.crc(), 585446183);
        assert_eq!(info.method(), 99);
        assert_eq!(info.minver(), 51);
        assert_eq!(info.gpb(), 1);
        assert_eq!(
            info.extra(),
            vec![0x01, 0x99, 0x07, 0x00, 0x01, 0x00, 0x41, 0x45, 0x03, 0x00, 0x00]
        );
        assert_eq!(info.offset_contents(), 46.0);
        assert_eq!(zip.inner.inner.offset, 93);
    }

    #[test]
    fn pack_overflow_and_finalize() {
        let mut pack = WasmPack::new();
        pack.overflow(19.0);
        assert_eq!(pack.take_output(), vec![0u8; 493]);
        pack.overflow(1024.0);
        assert_eq!(pack.take_output(), Vec::<u8>::new());
        pack.finalize();
        pack.finalize();
        assert_eq!(pack.take_output(), vec![0u8; 1024]);
    }

    #[test]
    fn pack_encode_consumes_pax_queue() {
        let mut pack = WasmPack::new();
        pack.pax_record(" comment=x\n");
        pack.encode(
            "a.txt", false, 420, "0", "0", 0.0, "0", 0.0, "file", None, None, None, "0", "0", true,
        );
        let blocks = pack.take_output();
        assert_eq!(blocks.len(), 3 * 512);
        assert_eq!(&blocks[512..540], b"14 path=a.txt\n13 comment=x\n\0");
        pack.encode(
            "a.txt", false, 420, "0", "0", 0.0, "0", 0.0, "file", None, None, None, "0", "0", true,
        );
        let blocks = pack.take_output();
        assert_eq!(blocks.len(), 3 * 512);
        assert_eq!(&blocks[512..527], b"14 path=a.txt\n\0");
        pack.encode(
            "a.txt", false, 420, "0", "0", 0.0, "0", 0.0, "file", None, None, None, "0", "0", false,
        );
        let block = pack.take_output();
        assert_eq!(block.len(), 512);
        assert_eq!(&block[..6], b"a.txt\0");
        assert_eq!(block[157], 0);
        assert_eq!(&block[257..263], b"ustar\0");
    }

    #[test]
    fn pack_encode_optional_strings() {
        let mut pack = WasmPack::new();
        pack.encode(
            "link",
            false,
            420,
            "0",
            "0",
            0.0,
            "0",
            0.0,
            "symlink",
            Some("a.txt".to_owned()),
            Some("user".to_owned()),
            Some("group".to_owned()),
            "0",
            "0",
            false,
        );
        let block = pack.take_output();
        assert_eq!(block.len(), 512);
        assert_eq!(&block[..5], b"link\0");
        assert_eq!(block[156], b'2');
        assert_eq!(&block[157..163], b"a.txt\0");
        assert_eq!(&block[265..270], b"user\0");
        assert_eq!(&block[297..303], b"group\0");
    }

    #[test]
    fn gzip_empty_member() {
        let mut gzip = WasmGzip::new(-1, 0, 3);
        let Ok(member) = gzip.finish() else {
            panic!("an empty member is produced");
        };
        assert_eq!(&member[..10], &[0x1f, 0x8b, 0x08, 0, 0, 0, 0, 0, 0, 3]);
        assert_eq!(&member[member.len() - 8..], &[0u8; 8]);
    }

    #[test]
    fn gzip_write_then_finish() {
        let mut gzip = WasmGzip::new(1, 0, 3);
        let Ok(mut member) = gzip.write(b"this is a text file") else {
            panic!("a write is accepted");
        };
        let Ok(end) = gzip.finish() else {
            panic!("the member is ended");
        };
        member.extend_from_slice(&end);
        assert_eq!(&member[..10], &[0x1f, 0x8b, 0x08, 0, 0, 0, 0, 0, 4, 3]);
        assert_eq!(
            &member[member.len() - 8..],
            &[0x27, 0x33, 0xe5, 0x22, 19, 0, 0, 0]
        );
    }

    #[test]
    fn crypto_stream_and_decrypto_stream_round_trip() {
        let key = b"password";
        let header = [7u8; 12];
        let Ok(mut encrypt) = WasmCryptoStream::new(key, 0x1234, &header) else {
            panic!("a 12 byte header is accepted");
        };
        let ciphertext = encrypt.transform(b"this is a text file");
        assert_eq!(ciphertext.len(), 12 + 19);
        let mut decrypt = WasmDecryptoStream::new(key);
        assert_eq!(decrypt.transform(&ciphertext), b"this is a text file");
        assert_eq!(decrypt.get_total_size(), 19.0);
        let mut cipher = WasmCryptoCipher::new(key);
        let encrypted = cipher.encrypt(b"abc");
        let mut cipher = WasmCryptoCipher::new(key);
        assert_eq!(cipher.decrypt(&encrypted), b"abc");
    }

    #[test]
    fn aes_derive_key_and_framing() {
        let salt = [1u8; 16];
        let composite = WasmAesHmacEtmStream::derive_key(&salt, b"password");
        assert_eq!(composite.len(), 66);
        let Ok(mut stream) = WasmAesHmacEtmStream::new(
            &composite[..32],
            &composite[32..64],
            &composite[64..],
            &salt,
        ) else {
            panic!("a 32 byte key is accepted");
        };
        let mut out = stream.transform(b"this is a text file");
        out.extend_from_slice(&stream.flush());
        assert_eq!(out.len(), 16 + 2 + 19 + 10);
        assert_eq!(&out[..16], &salt);
        assert_eq!(&out[16..18], &composite[64..]);
        assert_eq!(stream.get_total_size(), 47.0);
    }
}
