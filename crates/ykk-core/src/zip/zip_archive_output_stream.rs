// Port of deps/compress-commons/lib/archivers/zip/zip-archive-output-stream.js (the Rust part, PORTING.md 5.2).

use crate::crc32_stream::{CRC32Stream, DeflateCRC32Stream};
use crate::error::{DeflateError, ZipError};

use super::constants::{
    LONG_ZERO, METHOD_DEFLATED, METHOD_STORED, MIN_VERSION_DATA_DESCRIPTOR, MIN_VERSION_ZIP64,
    SHORT_ZERO, SIG_CFH, SIG_DD, SIG_EOCD, SIG_LFH, SIG_ZIP64_EOCD, SIG_ZIP64_EOCD_LOC,
    VERSION_MADEBY, ZIP64_EXTRA_ID, ZIP64_MAGIC, ZIP64_MAGIC_SHORT,
};
use super::encrypted::aes_hmac_etm_stream::AesHmacEtmStream;
use super::encrypted::crypto_stream::CryptoStream;
use super::util::{get_eight_bytes, get_long_bytes, get_short_bytes, DateFields};
use super::zip_archive_entry::{Offsets, ZipArchiveEntry};

// deps/compress-commons/lib/archivers/zip/zip-archive-output-stream.js:43 (which subclass this writer is, PORTING.md 6.9)
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Encryption {
    None,
    ZipCrypto,
    Aes256,
}

// deps/compress-commons/lib/archivers/archive-output-stream.js:66-69 (Buffer.isBuffer(source) or isStream(source))
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Source {
    Buffer { len: u64, crc: u32 },
    Stream,
}

// deps/compress-commons/lib/archivers/zip/zip-archive-output-stream.js:150 (what an entry reads from `this`, PORTING.md 6.8)
#[derive(Debug, Clone, Default)]
pub struct EntryOptions {
    pub level: i32,
    pub key: Vec<u8>,
    pub random: Vec<u8>,
}

// deps/compress-commons/lib/archivers/zip/zip-archive-output-stream.js:85-92 (how the entry goes on after entry(), PORTING.md 6.8)
#[repr(u8)]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EntryStatus {
    StoredBuffer = 0,
    OpenStored = 1,
    OpenDeflated = 2,
}

// deps/compress-commons/lib/archivers/zip/zip-archive-output-stream.js:50-59
#[derive(Debug, Clone)]
pub struct Archive {
    pub central_length: u64,
    pub central_offset: u64,
    pub comment: String,
    pub finish: bool,
    pub finished: bool,
    pub processing: bool,
    pub force_zip64: bool,
}

// deps/compress-commons/lib/archivers/zip/zip-archive-output-stream.js:149-151
pub(crate) enum Process {
    Crc32(CRC32Stream),
    Deflate(DeflateCRC32Stream),
}

impl Process {
    // deps/compress-commons/lib/archivers/zip/zip-archive-output-stream.js:108 (source.pipe(smart): a write into the chosen processor)
    pub(crate) fn _transform(
        &mut self,
        chunk: &[u8],
        out: &mut Vec<u8>,
    ) -> Result<(), DeflateError> {
        match self {
            Process::Crc32(process) => {
                process._transform(chunk, out);
                Ok(())
            }
            Process::Deflate(process) => process._transform(chunk, out),
        }
    }

    // deps/compress-commons/lib/archivers/zip/zip-archive-output-stream.js:91 (smart.end(): the end of the chosen processor)
    pub(crate) fn _flush(&mut self, out: &mut Vec<u8>) -> Result<(), DeflateError> {
        match self {
            Process::Crc32(_) => Ok(()),
            Process::Deflate(process) => process._flush(out),
        }
    }

    // deps/compress-commons/lib/archivers/zip/zip-archive-output-stream.js:154 (process.digest())
    pub(crate) fn digest(&self) -> [u8; 4] {
        match self {
            Process::Crc32(process) => process.digest(),
            Process::Deflate(process) => process.digest(),
        }
    }

    // deps/compress-commons/lib/archivers/zip/zip-archive-output-stream.js:156-157 (process.size())
    pub(crate) fn size(&self, compressed: bool) -> u64 {
        match self {
            Process::Crc32(process) => process.size(compressed),
            Process::Deflate(process) => process.size(compressed),
        }
    }
}

// deps/compress-commons/lib/archivers/zip/zip-archive-output-stream.js:147-167 (the per-entry pipeline, PORTING.md 6.8)
pub(crate) struct SmartStream {
    pub process: Process,
    pub encryption_stream: Option<AesHmacEtmStream>,
    pub buffered_data: Vec<u8>,
    pub encrypt: Option<CryptoStream>,
    pub key: Vec<u8>,
    pub random: Vec<u8>,
}

// deps/compress-commons/lib/archivers/zip/zip-archive-output-stream.js:43
pub struct ZipArchiveOutputStream {
    pub offset: u64,
    pub(crate) out: Vec<u8>,
    pub encryption: Encryption,
    pub _entry: Option<ZipArchiveEntry>,
    pub _entries: Vec<ZipArchiveEntry>,
    pub _archive: Archive,
    pub(crate) _smart: Option<SmartStream>,
}

impl ZipArchiveOutputStream {
    // deps/compress-commons/lib/archivers/zip/zip-archive-output-stream.js:44-60
    pub fn new(force_zip64: bool, encryption: Encryption) -> Self {
        ZipArchiveOutputStream {
            offset: 0,
            out: Vec::new(),
            encryption,
            _entry: None,
            _entries: Vec::new(),
            _archive: Archive {
                central_length: 0,
                central_offset: 0,
                comment: String::new(),
                finish: false,
                finished: false,
                processing: false,
                force_zip64,
            },
            _smart: None,
        }
    }

    // deps/compress-commons/lib/archivers/zip/zip-archive-output-stream.js:62-72
    pub fn _after_append(&mut self, ae: ZipArchiveEntry) {
        if ae.get_general_purpose_bit().uses_data_descriptor() {
            self._write_data_descriptor(&ae);
        }
        self._entries.push(ae);
        self._archive.processing = false;
        self._entry = None;
        if self._archive.finish && !self._archive.finished {
            self._finish();
        }
    }

    // deps/compress-commons/lib/archivers/zip/zip-archive-output-stream.js:74 (dispatcher, PORTING.md 6.9)
    pub fn _append_buffer(
        &mut self,
        ae: ZipArchiveEntry,
        len: u64,
        crc: u32,
        opts: &EntryOptions,
    ) -> Result<EntryStatus, ZipError> {
        match self.encryption {
            Encryption::None => self.base_append_buffer(ae, len, crc, opts),
            Encryption::ZipCrypto => self.zip20_append_buffer(ae, len, crc, opts),
            Encryption::Aes256 => self.aes_append_buffer(ae, len, crc, opts),
        }
    }

    // deps/compress-commons/lib/archivers/zip/zip-archive-output-stream.js:74-97
    pub fn base_append_buffer(
        &mut self,
        mut ae: ZipArchiveEntry,
        len: u64,
        crc: u32,
        opts: &EntryOptions,
    ) -> Result<EntryStatus, ZipError> {
        if len == 0 {
            ae.set_method(METHOD_STORED as u16);
        }
        let method = ae.get_method();
        if method == METHOD_STORED {
            ae.set_size(len);
            ae.set_compressed_size(len);
            ae.set_crc(crc);
        }
        self._write_local_file_header(&mut ae);
        if method == METHOD_STORED {
            self._entry = Some(ae);
            Ok(EntryStatus::StoredBuffer)
        } else if method == METHOD_DEFLATED {
            let status = self._smart_stream(&mut ae, opts);
            self._entry = Some(ae);
            status
        } else {
            self._entry = Some(ae);
            Err(ZipError::MethodNotImplemented(method))
        }
    }

    // deps/compress-commons/lib/archivers/zip/zip-archive-output-stream.js:86-88 (after the caller wrote the stored payload, PORTING.md 6.8)
    pub fn complete_stored(&mut self) -> Result<(), ZipError> {
        if self._smart.is_some() {
            return Err(ZipError::NoEntryOpen);
        }
        let ae = self._entry.take().ok_or(ZipError::NoEntryOpen)?;
        // :85 only the plain stored arm of _appendBuffer leaves the payload to the caller
        if self.encryption != Encryption::None || ae.get_method() != METHOD_STORED {
            self._entry = Some(ae);
            return Err(ZipError::NoEntryOpen);
        }
        self.offset = self.offset.wrapping_add(ae.get_size());
        self._after_append(ae);
        Ok(())
    }

    // deps/compress-commons/lib/archivers/zip/zip-archive-output-stream.js:99 (dispatcher, PORTING.md 6.9)
    pub fn _append_stream(
        &mut self,
        ae: ZipArchiveEntry,
        opts: &EntryOptions,
    ) -> Result<EntryStatus, ZipError> {
        match self.encryption {
            Encryption::None => self.base_append_stream(ae, opts),
            Encryption::ZipCrypto => self.zip20_append_stream(ae, opts),
            Encryption::Aes256 => self.base_append_stream(ae, opts),
        }
    }

    // deps/compress-commons/lib/archivers/zip/zip-archive-output-stream.js:99-109
    pub fn base_append_stream(
        &mut self,
        mut ae: ZipArchiveEntry,
        opts: &EntryOptions,
    ) -> Result<EntryStatus, ZipError> {
        ae.get_general_purpose_bit_mut().use_data_descriptor(true);
        ae.set_version_needed_to_extract(MIN_VERSION_DATA_DESCRIPTOR);
        self._write_local_file_header(&mut ae);
        let status = self._smart_stream(&mut ae, opts);
        self._entry = Some(ae);
        status
    }

    // deps/compress-commons/lib/archivers/zip/zip-archive-output-stream.js:111-127
    pub fn _finish(&mut self) {
        self._archive.central_offset = self.offset;
        let mut entries = std::mem::take(&mut self._entries);
        for ae in &mut entries {
            self._write_central_file_header(ae);
        }
        self._entries = entries;
        self._archive.central_length = self.offset.wrapping_sub(self._archive.central_offset);
        if self.is_zip64() {
            self._write_central_directory_zip64();
        }
        self._write_central_directory_end();
        self._archive.processing = false;
        self._archive.finish = true;
        self._archive.finished = true;
    }

    // deps/compress-commons/lib/archivers/zip/zip-archive-output-stream.js:129-145
    pub fn _normalize_entry(&mut self, ae: &mut ZipArchiveEntry, now: &DateFields) {
        if ae.get_method() == -1 {
            ae.set_method(METHOD_DEFLATED as u16);
        }
        if ae.get_method() == METHOD_DEFLATED {
            ae.get_general_purpose_bit_mut().use_data_descriptor(true);
            ae.set_version_needed_to_extract(MIN_VERSION_DATA_DESCRIPTOR);
        }
        if ae.get_time().is_none() {
            ae.set_time(now);
        }
        ae._offsets = Offsets::default();
    }

    // deps/compress-commons/lib/archivers/zip/zip-archive-output-stream.js:147 (dispatcher, PORTING.md 6.9)
    pub fn _smart_stream(
        &mut self,
        ae: &mut ZipArchiveEntry,
        opts: &EntryOptions,
    ) -> Result<EntryStatus, ZipError> {
        match self.encryption {
            Encryption::None => self.base_smart_stream(ae, opts),
            Encryption::ZipCrypto => self.zip20_smart_stream(ae, opts),
            Encryption::Aes256 => self.aes_smart_stream(ae, opts),
        }
    }

    // deps/compress-commons/lib/archivers/zip/zip-archive-output-stream.js:148-151
    pub fn base_smart_stream(
        &mut self,
        ae: &mut ZipArchiveEntry,
        opts: &EntryOptions,
    ) -> Result<EntryStatus, ZipError> {
        let deflate = ae.get_method() == METHOD_DEFLATED;
        let process = if deflate {
            Process::Deflate(DeflateCRC32Stream::new(opts.level))
        } else {
            Process::Crc32(CRC32Stream::new())
        };
        self._smart = Some(SmartStream {
            process,
            encryption_stream: None,
            buffered_data: Vec::new(),
            encrypt: None,
            key: Vec::new(),
            random: Vec::new(),
        });
        if deflate {
            Ok(EntryStatus::OpenDeflated)
        } else {
            Ok(EntryStatus::OpenStored)
        }
    }

    // deps/compress-commons/lib/archivers/zip/zip-archive-output-stream.js:108 (source.pipe(smart): dispatcher, PORTING.md 6.9)
    pub fn write_data(&mut self, chunk: &[u8]) -> Result<(), ZipError> {
        match self.encryption {
            Encryption::None => self.base_smart_stream_write(chunk),
            Encryption::ZipCrypto => self.zip20_smart_stream_write(chunk),
            Encryption::Aes256 => self.aes_smart_stream_write(chunk),
        }
    }

    // deps/compress-commons/lib/archivers/zip/zip-archive-output-stream.js:165
    pub fn base_smart_stream_write(&mut self, chunk: &[u8]) -> Result<(), ZipError> {
        let smart = self._smart.as_mut().ok_or(ZipError::NoEntryOpen)?;
        let mut tmp = Vec::new();
        smart.process._transform(chunk, &mut tmp)?;
        self.write(&tmp);
        Ok(())
    }

    // deps/compress-commons/lib/archivers/zip/zip-archive-output-stream.js:91 (smart.end() and the 'end' handler: dispatcher, PORTING.md 6.9)
    pub fn end_data(&mut self) -> Result<(), ZipError> {
        match self.encryption {
            Encryption::None => self.base_smart_stream_end(),
            Encryption::ZipCrypto => self.zip20_smart_stream_end(),
            Encryption::Aes256 => self.aes_smart_stream_end(),
        }
    }

    // deps/compress-commons/lib/archivers/zip/zip-archive-output-stream.js:153-160
    pub fn base_smart_stream_end(&mut self) -> Result<(), ZipError> {
        let mut ae = self._entry.take().ok_or(ZipError::NoEntryOpen)?;
        let Some(mut smart) = self._smart.take() else {
            self._entry = Some(ae);
            return Err(ZipError::NoEntryOpen);
        };
        let mut tmp = Vec::new();
        if let Err(err) = smart.process._flush(&mut tmp) {
            self._smart = Some(smart);
            self._entry = Some(ae);
            return Err(err.into());
        }
        self.write(&tmp);
        let digest = u32::from_be_bytes(smart.process.digest());
        ae.set_crc(digest);
        ae.set_size(smart.process.size(false));
        ae.set_compressed_size(smart.process.size(true));
        self._after_append(ae);
        Ok(())
    }

    // deps/compress-commons/lib/archivers/zip/zip-archive-output-stream.js:169-194
    pub fn _write_central_directory_end(&mut self) {
        let mut records = self._entries.len() as u64;
        let mut size = self._archive.central_length;
        let mut offset = self._archive.central_offset;
        if self.is_zip64() {
            records = ZIP64_MAGIC_SHORT;
            size = ZIP64_MAGIC;
            offset = ZIP64_MAGIC;
        }
        // signature
        self.write(&get_long_bytes(SIG_EOCD as u64));
        // disk numbers
        self.write(&SHORT_ZERO);
        self.write(&SHORT_ZERO);
        // number of entries
        self.write(&get_short_bytes(records));
        self.write(&get_short_bytes(records));
        // length and location of CD
        self.write(&get_long_bytes(size));
        self.write(&get_long_bytes(offset));
        // archive comment
        let comment = self.get_comment().to_owned();
        let comment_length = comment.len();
        self.write(&get_short_bytes(comment_length as u64));
        self.write(comment.as_bytes()); // PORTING.md V5
    }

    // deps/compress-commons/lib/archivers/zip/zip-archive-output-stream.js:196-226
    pub fn _write_central_directory_zip64(&mut self) {
        // signature
        self.write(&get_long_bytes(SIG_ZIP64_EOCD as u64));
        // size of the ZIP64 EOCD record
        self.write(&get_eight_bytes(44));
        // version made by
        self.write(&get_short_bytes(MIN_VERSION_ZIP64 as u64));
        // version to extract
        self.write(&get_short_bytes(MIN_VERSION_ZIP64 as u64));
        // disk numbers
        self.write(&LONG_ZERO);
        self.write(&LONG_ZERO);
        // number of entries
        self.write(&get_eight_bytes(self._entries.len() as u64));
        self.write(&get_eight_bytes(self._entries.len() as u64));
        // length and location of CD
        self.write(&get_eight_bytes(self._archive.central_length));
        self.write(&get_eight_bytes(self._archive.central_offset));
        // extensible data sector
        // not implemented at this time
        // end of central directory locator
        self.write(&get_long_bytes(SIG_ZIP64_EOCD_LOC as u64));
        // disk number holding the ZIP64 EOCD record
        self.write(&LONG_ZERO);
        // relative offset of the ZIP64 EOCD record
        self.write(&get_eight_bytes(
            self._archive
                .central_offset
                .wrapping_add(self._archive.central_length),
        ));
        // total number of disks
        self.write(&get_long_bytes(1));
    }

    // deps/compress-commons/lib/archivers/zip/zip-archive-output-stream.js:228 (dispatcher, PORTING.md 6.9)
    pub fn _write_central_file_header(&mut self, ae: &mut ZipArchiveEntry) {
        match self.encryption {
            Encryption::None => self.base_write_central_file_header(ae),
            Encryption::ZipCrypto => self.base_write_central_file_header(ae),
            Encryption::Aes256 => self.aes_write_central_file_header(ae),
        }
    }

    // deps/compress-commons/lib/archivers/zip/zip-archive-output-stream.js:228-294
    pub fn base_write_central_file_header(&mut self, ae: &mut ZipArchiveEntry) {
        let method = ae.get_method();
        let mut file_offset = ae._offsets.file;
        let mut size = ae.get_size();
        let mut compressed_size = ae.get_compressed_size();
        if ae.is_zip64() || file_offset > ZIP64_MAGIC {
            size = ZIP64_MAGIC;
            compressed_size = ZIP64_MAGIC;
            file_offset = ZIP64_MAGIC;
            ae.set_version_needed_to_extract(MIN_VERSION_ZIP64);
            let mut extra_buf = Vec::with_capacity(28);
            extra_buf.extend_from_slice(&get_short_bytes(ZIP64_EXTRA_ID as u64));
            extra_buf.extend_from_slice(&get_short_bytes(24));
            extra_buf.extend_from_slice(&get_eight_bytes(ae.get_size()));
            extra_buf.extend_from_slice(&get_eight_bytes(ae.get_compressed_size()));
            extra_buf.extend_from_slice(&get_eight_bytes(ae._offsets.file));
            ae.set_extra(extra_buf);
        }
        // signature
        self.write(&get_long_bytes(SIG_CFH as u64));
        // version made by
        self.write(&get_short_bytes(
            (((ae.get_platform() as u16) << 8) | VERSION_MADEBY) as u64,
        ));
        // version to extract and general bit flag
        self.write(&get_short_bytes(ae.get_version_needed_to_extract() as u64));
        self.write(&ae.get_general_purpose_bit().encode());
        // compression method
        self.write(&get_short_bytes(method as u16 as u64));
        // datetime
        self.write(&get_long_bytes(ae.get_time_dos() as u64));
        // crc32 checksum
        self.write(&get_long_bytes(ae.get_crc() as u64));
        // sizes
        self.write(&get_long_bytes(compressed_size));
        self.write(&get_long_bytes(size));
        // :270-273 Buffer.from(name), Buffer.from(comment): the UTF-8 bytes either way (PORTING.md RS-18)
        let name = ae.get_name().unwrap_or("").as_bytes();
        let comment = ae.get_comment().as_bytes();
        let extra = ae.get_central_directory_extra();
        // name length
        self.write(&get_short_bytes(name.len() as u64));
        // extra length
        self.write(&get_short_bytes(extra.len() as u64));
        // comments length
        self.write(&get_short_bytes(comment.len() as u64));
        // disk number start
        self.write(&SHORT_ZERO);
        // internal attributes
        self.write(&get_short_bytes(ae.get_internal_attributes() as u64));
        // external attributes
        self.write(&get_long_bytes(ae.get_external_attributes() as u64));
        // relative offset of LFH
        self.write(&get_long_bytes(file_offset));
        // name
        self.write(name);
        // extra
        self.write(extra);
        // comment
        self.write(comment);
    }

    // deps/compress-commons/lib/archivers/zip/zip-archive-output-stream.js:296-309
    pub fn _write_data_descriptor(&mut self, ae: &ZipArchiveEntry) {
        // signature
        self.write(&get_long_bytes(SIG_DD as u64));
        // crc32 checksum
        self.write(&get_long_bytes(ae.get_crc() as u64));
        // sizes
        if ae.is_zip64() {
            self.write(&get_eight_bytes(ae.get_compressed_size()));
            self.write(&get_eight_bytes(ae.get_size()));
        } else {
            self.write(&get_long_bytes(ae.get_compressed_size()));
            self.write(&get_long_bytes(ae.get_size()));
        }
    }

    // deps/compress-commons/lib/archivers/zip/zip-archive-output-stream.js:311 (dispatcher, PORTING.md 6.9)
    pub fn _write_local_file_header(&mut self, ae: &mut ZipArchiveEntry) {
        match self.encryption {
            Encryption::None => self.base_write_local_file_header(ae),
            Encryption::ZipCrypto => self.zip20_write_local_file_header(ae),
            Encryption::Aes256 => self.aes_write_local_file_header(ae),
        }
    }

    // deps/compress-commons/lib/archivers/zip/zip-archive-output-stream.js:311-353
    pub fn base_write_local_file_header(&mut self, ae: &mut ZipArchiveEntry) {
        let method = ae.get_method();
        let name = ae.get_name().unwrap_or("").to_owned();
        let extra = ae.get_local_file_data_extra().to_vec();
        if ae.is_zip64() {
            ae.get_general_purpose_bit_mut().use_data_descriptor(true);
            ae.set_version_needed_to_extract(MIN_VERSION_ZIP64);
        }
        // :320-322 Buffer.from(name): the UTF-8 bytes either way (PORTING.md RS-18)
        let name = name.as_bytes();
        ae._offsets.file = self.offset;
        // signature
        self.write(&get_long_bytes(SIG_LFH as u64));
        // version to extract and general bit flag
        self.write(&get_short_bytes(ae.get_version_needed_to_extract() as u64));
        self.write(&ae.get_general_purpose_bit().encode());
        // compression method
        self.write(&get_short_bytes(method as u16 as u64));
        // datetime
        self.write(&get_long_bytes(ae.get_time_dos() as u64));
        ae._offsets.data = self.offset;
        // crc32 checksum and sizes
        if ae.get_general_purpose_bit().uses_data_descriptor() {
            self.write(&LONG_ZERO);
            self.write(&LONG_ZERO);
            self.write(&LONG_ZERO);
        } else {
            self.write(&get_long_bytes(ae.get_crc() as u64));
            self.write(&get_long_bytes(ae.get_compressed_size()));
            self.write(&get_long_bytes(ae.get_size()));
        }
        // name length
        self.write(&get_short_bytes(name.len() as u64));
        // extra length
        self.write(&get_short_bytes(extra.len() as u64));
        // name
        self.write(name);
        // extra
        self.write(&extra);
        ae._offsets.contents = self.offset;
    }

    // deps/compress-commons/lib/archivers/zip/zip-archive-output-stream.js:355-357
    pub fn get_comment(&self) -> &str {
        &self._archive.comment
    }

    // deps/compress-commons/lib/archivers/zip/zip-archive-output-stream.js:359-366
    pub fn is_zip64(&self) -> bool {
        self._archive.force_zip64
            || self._entries.len() as u64 > ZIP64_MAGIC_SHORT
            || self._archive.central_length > ZIP64_MAGIC
            || self._archive.central_offset > ZIP64_MAGIC
    }

    // deps/compress-commons/lib/archivers/zip/zip-archive-output-stream.js:368-370
    pub fn set_comment(&mut self, comment: &str) {
        self._archive.comment = comment.to_owned();
    }

    // PORTING.md 5.4
    pub fn take_output(&mut self) -> Vec<u8> {
        std::mem::take(&mut self.out)
    }
}

#[cfg(test)]
mod tests {
    use std::io::Read;

    use super::*;
    use crate::crc32;

    // Captured from compress-commons 7.0.1 (the engine driven directly), every entry dated
    // 2013-01-03T14:26:38Z. STORED: a.txt (stored buffer 'this is a text file', mode 420),
    // empty.txt (empty buffer, default method), stream.txt (stored stream 'this is ' +
    // 'a text file'), é.txt (stored buffer 'test', comment 'ü'), archive comment 'archive ü'.
    // 472 bytes
    const STORED: &str = concat!(
        "504b03040a0000000000537323422733e522130000001300000005000000612e7478747468697320",
        "6973206120746578742066696c65504b030414000800000053732342000000000000000000000000",
        "09000000656d7074792e747874504b0708000000000000000000000000504b030414000800000053",
        "7323420000000000000000000000000a00000073747265616d2e7478747468697320697320612074",
        "6578742066696c65504b07082733e5221300000013000000504b03040a0000080000537323420c7e",
        "7fd8040000000400000006000000c3a92e74787474657374504b01022d030a000000000053732342",
        "2733e5221300000013000000050000000000000000002000a48100000000612e747874504b01022d",
        "00140008000000537323420000000000000000000000000900000000000000000000000000360000",
        "00656d7074792e747874504b01022d00140008000000537323422733e52213000000130000000a00",
        "0000000000000000000000006d00000073747265616d2e747874504b01022d000a00000800005373",
        "23420c7e7fd804000000040000000600000002000000000000000000b8000000c3a92e747874c3bc",
        "504b05060000000004000400d8000000e00000000a006172636869766520c3bc",
    );
    // BIG: big.bin, stored, size and compressed size 2^32, CRC 0x12345678, written with
    // _writeLocalFileHeader, offset += 2^32, _afterAppend, finish(); the payload is absent.
    // 240 bytes
    const BIG: &str = concat!(
        "504b03042d000800000053732342000000000000000000000000070000006269672e62696e504b07",
        "087856341200000000010000000000000001000000504b01022d002d000800000053732342785634",
        "12ffffffffffffffff07001c0000000000000000000000ffffffff6269672e62696e010018000000",
        "00000100000000000000010000000000000000000000504b06062c000000000000002d002d000000",
        "0000000000000100000000000000010000000000000051000000000000003d00000001000000504b",
        "0607000000008e0000000100000001000000504b050600000000ffffffffffffffffffffffff0000",
    );
    // FORCE64: no entries, forceZip64.
    // 98 bytes
    const FORCE64: &str = concat!(
        "504b06062c000000000000002d002d00000000000000000000000000000000000000000000000000",
        "00000000000000000000000000000000504b060700000000000000000000000001000000504b0506",
        "00000000ffffffffffffffffffffffff0000",
    );
    // EMPTY: no entries.
    // 22 bytes
    const EMPTY: &str = "504b0506000000000000000000000000000000000000";

    fn hex(s: &str) -> Vec<u8> {
        (0..s.len())
            .step_by(2)
            .map(|i| u8::from_str_radix(&s[i..i + 2], 16).unwrap())
            .collect()
    }

    fn inflate(data: &[u8]) -> Vec<u8> {
        let mut out = Vec::new();
        flate2::read::DeflateDecoder::new(data)
            .read_to_end(&mut out)
            .unwrap();
        out
    }

    fn u16le(buf: &[u8], offset: usize) -> u16 {
        u16::from_le_bytes([buf[offset], buf[offset + 1]])
    }

    fn u32le(buf: &[u8], offset: usize) -> u32 {
        u32::from_le_bytes([
            buf[offset],
            buf[offset + 1],
            buf[offset + 2],
            buf[offset + 3],
        ])
    }

    // (version needed, flags, method, crc, compressed size, size) of a local file header
    fn lfh(buf: &[u8]) -> (u16, u16, u16, u32, u32, u32) {
        assert_eq!(&buf[..4], b"PK\x03\x04");
        assert_eq!(u32le(buf, 10), 0x42237353);
        assert_eq!(u16le(buf, 28), 0);
        assert_eq!(buf.len(), 30 + u16le(buf, 26) as usize);
        (
            u16le(buf, 4),
            u16le(buf, 6),
            u16le(buf, 8),
            u32le(buf, 14),
            u32le(buf, 18),
            u32le(buf, 22),
        )
    }

    // (crc, compressed size, size) of a 16-byte data descriptor
    fn dd(buf: &[u8]) -> (u32, u32, u32) {
        assert_eq!(buf.len(), 16);
        assert_eq!(&buf[..4], b"PK\x07\x08");
        (u32le(buf, 4), u32le(buf, 8), u32le(buf, 12))
    }

    fn date() -> DateFields {
        DateFields {
            year: 2013.0,
            month: 0.0,
            date: 3.0,
            hours: 14.0,
            minutes: 26.0,
            seconds: 38.0,
        }
    }

    fn opts() -> EntryOptions {
        EntryOptions {
            level: 1,
            key: Vec::new(),
            random: Vec::new(),
        }
    }

    fn entry(name: &str) -> ZipArchiveEntry {
        let mut ae = ZipArchiveEntry::new(Some(name));
        ae.set_time(&date());
        ae
    }

    #[test]
    fn plain_entry_shapes() {
        let text = b"this is a text file";
        let mut zip = ZipArchiveOutputStream::new(false, Encryption::None);
        let mut archive = Vec::new();

        // buffer, stored: version 10, no flags, real CRC and sizes, no descriptor
        let mut ae = entry("a.txt");
        ae.set_method(0);
        ae.set_unix_mode(420);
        let source = Source::Buffer {
            len: 19,
            crc: crc32::buf(text, 0),
        };
        assert_eq!(
            zip.entry(ae, source, &opts(), &date()),
            Ok(EntryStatus::StoredBuffer)
        );
        let out = zip.take_output();
        assert_eq!(lfh(&out), (10, 0, 0, 585446183, 19, 19));
        archive.extend_from_slice(&out);
        archive.extend_from_slice(text);
        assert_eq!(zip.complete_stored(), Ok(()));
        assert!(zip.take_output().is_empty());

        // buffer, empty, default method: stored, version 20, descriptor of zeros (P14)
        let source = Source::Buffer { len: 0, crc: 0 };
        assert_eq!(
            zip.entry(entry("empty.txt"), source, &opts(), &date()),
            Ok(EntryStatus::StoredBuffer)
        );
        let out = zip.take_output();
        assert_eq!(lfh(&out), (20, 0x0008, 0, 0, 0, 0));
        archive.extend_from_slice(&out);
        assert_eq!(zip.complete_stored(), Ok(()));
        let out = zip.take_output();
        assert_eq!(dd(&out), (0, 0, 0));
        archive.extend_from_slice(&out);

        // stream, stored: version 20, descriptor, compressed size n
        let mut ae = entry("stream.txt");
        ae.set_method(0);
        assert_eq!(
            zip.entry(ae, Source::Stream, &opts(), &date()),
            Ok(EntryStatus::OpenStored)
        );
        let out = zip.take_output();
        assert_eq!(lfh(&out), (20, 0x0008, 0, 0, 0, 0));
        archive.extend_from_slice(&out);
        assert_eq!(zip.write_data(b"this is "), Ok(()));
        assert_eq!(zip.take_output(), b"this is ");
        assert_eq!(zip.write_data(b"a text file"), Ok(()));
        assert_eq!(zip.take_output(), b"a text file");
        archive.extend_from_slice(text);
        assert_eq!(zip.end_data(), Ok(()));
        let out = zip.take_output();
        assert_eq!(dd(&out), (585446183, 19, 19));
        archive.extend_from_slice(&out);

        // buffer, stored, name and comment not ASCII: flag bit 11
        let mut ae = entry("é.txt");
        ae.set_method(0);
        ae.set_comment("ü");
        let source = Source::Buffer {
            len: 4,
            crc: crc32::buf(b"test", 0),
        };
        assert_eq!(
            zip.entry(ae, source, &opts(), &date()),
            Ok(EntryStatus::StoredBuffer)
        );
        let out = zip.take_output();
        assert_eq!(lfh(&out), (10, 0x0800, 0, 3632233996, 4, 4));
        archive.extend_from_slice(&out);
        archive.extend_from_slice(b"test");
        assert_eq!(zip.complete_stored(), Ok(()));
        assert!(zip.take_output().is_empty());

        zip.set_comment("archive ü");
        assert_eq!(zip.get_comment(), "archive ü");
        zip.finish();
        archive.extend_from_slice(&zip.take_output());
        assert_eq!(archive, hex(STORED));
        assert_eq!(zip._entries.len(), 4);
        assert!(zip._entry.is_none());
        assert!(zip._archive.finish);
        assert!(zip._archive.finished);
        assert!(!zip._archive.processing);
        assert_eq!(zip._archive.central_offset, 224);
        assert_eq!(zip._archive.central_length, 216);
        // PORTING.md V5
        assert_eq!(zip.offset, 472);

        // buffer, deflate: version 20, descriptor, zeros in the local header
        let payload: Vec<u8> = (0..4000).map(|i| b'a' + (i % 7) as u8).collect();
        let crc = crc32::buf(&payload, 0);
        let mut zip = ZipArchiveOutputStream::new(false, Encryption::None);
        let source = Source::Buffer { len: 4000, crc };
        assert_eq!(
            zip.entry(entry("buffer.txt"), source, &opts(), &date()),
            Ok(EntryStatus::OpenDeflated)
        );
        assert_eq!(lfh(&zip.take_output()), (20, 0x0008, 8, 0, 0, 0));
        assert_eq!(zip.write_data(&payload), Ok(()));
        assert_eq!(zip.end_data(), Ok(()));
        let out = zip.take_output();
        let buffer_csize = out.len() - 16;
        assert!(buffer_csize > 0);
        assert_eq!(dd(&out[buffer_csize..]), (crc, buffer_csize as u32, 4000));
        assert_eq!(inflate(&out[..buffer_csize]), payload);

        // stream, deflate: the same shape
        assert_eq!(
            zip.entry(entry("stream.txt"), Source::Stream, &opts(), &date()),
            Ok(EntryStatus::OpenDeflated)
        );
        assert_eq!(lfh(&zip.take_output()), (20, 0x0008, 8, 0, 0, 0));
        let mut out = Vec::new();
        for chunk in payload.chunks(1000) {
            assert_eq!(zip.write_data(chunk), Ok(()));
            out.extend_from_slice(&zip.take_output());
        }
        assert_eq!(zip.end_data(), Ok(()));
        out.extend_from_slice(&zip.take_output());
        let stream_csize = out.len() - 16;
        assert!(stream_csize > 0);
        assert_eq!(dd(&out[stream_csize..]), (crc, stream_csize as u32, 4000));
        assert_eq!(inflate(&out[..stream_csize]), payload);

        // stream, deflate, no data: still a deflate stream of its own
        assert_eq!(
            zip.entry(entry("none.txt"), Source::Stream, &opts(), &date()),
            Ok(EntryStatus::OpenDeflated)
        );
        assert_eq!(lfh(&zip.take_output()), (20, 0x0008, 8, 0, 0, 0));
        assert_eq!(zip.end_data(), Ok(()));
        let out = zip.take_output();
        let none_csize = out.len() - 16;
        assert!(none_csize > 0);
        assert_eq!(dd(&out[none_csize..]), (0, none_csize as u32, 0));
        assert_eq!(inflate(&out[..none_csize]), b"");

        zip.finish();
        let out = zip.take_output();
        assert_eq!(out.len(), (46 + 10) + (46 + 10) + (46 + 8) + 22);
        assert_eq!(&out[..4], b"PK\x01\x02");
        assert_eq!(u16le(&out, 4), 0x002d);
        assert_eq!(u16le(&out, 6), 20);
        assert_eq!(u16le(&out, 8), 0x0008);
        assert_eq!(u16le(&out, 10), 8);
        assert_eq!(u32le(&out, 12), 0x42237353);
        assert_eq!(u32le(&out, 16), crc);
        assert_eq!(u32le(&out, 20), buffer_csize as u32);
        assert_eq!(u32le(&out, 24), 4000);
        assert_eq!(u16le(&out, 28), 10);
        assert_eq!(u16le(&out, 30), 0);
        assert_eq!(u16le(&out, 32), 0);
        assert_eq!(u32le(&out, 38), 0);
        assert_eq!(u32le(&out, 42), 0);
        assert_eq!(&out[46..56], b"buffer.txt");
        assert_eq!(&out[56..60], b"PK\x01\x02");
        assert_eq!(u32le(&out, 56 + 20), stream_csize as u32);
        assert_eq!(u32le(&out, 56 + 42), (40 + buffer_csize + 16) as u32);
        let eocd = out.len() - 22;
        assert_eq!(&out[eocd..eocd + 4], b"PK\x05\x06");
        assert_eq!(u16le(&out, eocd + 8), 3);
        assert_eq!(u16le(&out, eocd + 10), 3);
        assert_eq!(u32le(&out, eocd + 12), eocd as u32);

        // stored buffer above 4 GiB: version 45, descriptor with 8-byte sizes, no payload fed
        let mut zip = ZipArchiveOutputStream::new(false, Encryption::None);
        let mut ae = entry("big.bin");
        ae.set_method(0);
        let source = Source::Buffer {
            len: 0x1_0000_0000,
            crc: 0x12345678,
        };
        assert_eq!(
            zip.entry(ae, source, &opts(), &date()),
            Ok(EntryStatus::StoredBuffer)
        );
        let mut archive = zip.take_output();
        assert_eq!(lfh(&archive), (45, 0x0008, 0, 0, 0, 0));
        assert_eq!(zip.complete_stored(), Ok(()));
        let out = zip.take_output();
        assert_eq!(out.len(), 24);
        archive.extend_from_slice(&out);
        zip.finish();
        archive.extend_from_slice(&zip.take_output());
        assert_eq!(archive, hex(BIG));
        assert!(zip.is_zip64());
        assert_eq!(zip.offset, 240 + 0x1_0000_0000);
    }

    #[test]
    fn empty_archive_and_force_zip64() {
        let mut zip = ZipArchiveOutputStream::new(false, Encryption::None);
        assert!(!zip.is_zip64());
        zip.finish();
        assert_eq!(zip.take_output(), hex(EMPTY));
        assert!(zip._archive.finished);

        let mut zip = ZipArchiveOutputStream::new(true, Encryption::None);
        assert!(zip.is_zip64());
        zip.finish();
        assert_eq!(zip.take_output(), hex(FORCE64));
        assert_eq!(zip.offset, 98);
    }

    #[test]
    fn is_zip64_thresholds() {
        let mut zip = ZipArchiveOutputStream::new(false, Encryption::None);
        zip._archive.central_length = 0xffff_ffff;
        zip._archive.central_offset = 0xffff_ffff;
        zip._entries = vec![ZipArchiveEntry::new(None); 65535];
        assert!(!zip.is_zip64());
        zip._entries.push(ZipArchiveEntry::new(None));
        assert!(zip.is_zip64());
        zip._entries.clear();
        zip._archive.central_length = 0x1_0000_0000;
        assert!(zip.is_zip64());
        zip._archive.central_length = 0;
        zip._archive.central_offset = 0x1_0000_0000;
        assert!(zip.is_zip64());
        zip._archive.central_offset = 0;
        assert!(!zip.is_zip64());
    }

    #[test]
    fn normalize_entry_defaults() {
        let mut zip = ZipArchiveOutputStream::new(false, Encryption::None);
        let mut ae = ZipArchiveEntry::new(Some("a.txt"));
        ae._offsets = Offsets {
            file: 1,
            data: 2,
            contents: 3,
        };
        zip._normalize_entry(&mut ae, &date());
        assert_eq!(ae.get_method(), METHOD_DEFLATED);
        assert!(ae.get_general_purpose_bit().uses_data_descriptor());
        assert_eq!(ae.get_version_needed_to_extract(), 20);
        assert_eq!(ae.get_time_dos(), 0x42237353);
        assert_eq!(ae._offsets, Offsets::default());

        let invalid = DateFields {
            year: f64::NAN,
            month: f64::NAN,
            date: f64::NAN,
            hours: f64::NAN,
            minutes: f64::NAN,
            seconds: f64::NAN,
        };
        let mut ae = ZipArchiveEntry::new(Some("a.txt"));
        ae.set_method(0);
        ae.set_time(&invalid);
        zip._normalize_entry(&mut ae, &date());
        assert_eq!(ae.get_method(), METHOD_STORED);
        assert!(!ae.get_general_purpose_bit().uses_data_descriptor());
        assert_eq!(ae.get_version_needed_to_extract(), 10);
        assert_eq!(ae.time, Some(0));
    }

    #[test]
    fn local_header_offsets() {
        let mut zip = ZipArchiveOutputStream::new(false, Encryption::None);
        zip.set_offset(100);
        assert_eq!(
            zip.entry(entry("a.txt"), Source::Stream, &opts(), &date()),
            Ok(EntryStatus::OpenDeflated)
        );
        assert_eq!(
            zip._entry.as_ref().map(|ae| ae._offsets.clone()),
            Some(Offsets {
                file: 100,
                data: 114,
                contents: 135,
            })
        );
    }

    #[test]
    fn method_not_implemented_poisons() {
        let mut zip = ZipArchiveOutputStream::new(false, Encryption::None);
        let mut ae = entry("a.txt");
        ae.set_method(99);
        let source = Source::Buffer { len: 1, crc: 0 };
        let result = zip.entry(ae, source, &opts(), &date());
        assert_eq!(result, Err(ZipError::MethodNotImplemented(99)));
        assert_eq!(
            ZipError::MethodNotImplemented(99).to_string(),
            "compression method 99 not implemented"
        );
        assert_eq!(zip.take_output().len(), 30 + 5);
        assert!(zip._archive.processing);
        assert!(zip._entry.is_some());
        assert!(zip._entries.is_empty());
        assert_eq!(zip.complete_stored(), Err(ZipError::NoEntryOpen));
        assert_eq!(zip.write_data(b"x"), Err(ZipError::NoEntryOpen));
        assert_eq!(zip.end_data(), Err(ZipError::NoEntryOpen));
        assert!(zip._archive.processing);
        assert!(zip._entry.is_some());
        assert!(zip._entries.is_empty());
        assert!(zip.take_output().is_empty());
        assert_eq!(
            zip.entry(entry("b.txt"), Source::Stream, &opts(), &date()),
            Err(ZipError::AlreadyProcessing)
        );
        zip.finish();
        assert!(zip._archive.finish);
        assert!(!zip._archive.finished);
        assert!(zip.take_output().is_empty());
    }

    #[test]
    fn calls_out_of_order() {
        let mut zip = ZipArchiveOutputStream::new(false, Encryption::None);
        assert_eq!(zip.write_data(b"x"), Err(ZipError::NoEntryOpen));
        assert_eq!(zip.end_data(), Err(ZipError::NoEntryOpen));
        assert_eq!(zip.complete_stored(), Err(ZipError::NoEntryOpen));

        let mut ae = entry("a.txt");
        ae.set_method(0);
        let source = Source::Buffer { len: 1, crc: 0 };
        assert_eq!(
            zip.entry(ae, source, &opts(), &date()),
            Ok(EntryStatus::StoredBuffer)
        );
        assert_eq!(zip.write_data(b"x"), Err(ZipError::NoEntryOpen));
        assert_eq!(zip.end_data(), Err(ZipError::NoEntryOpen));
        assert!(zip._entry.is_some());
        assert_eq!(zip.complete_stored(), Ok(()));
        assert_eq!(zip.complete_stored(), Err(ZipError::NoEntryOpen));
        assert_eq!(zip._entries.len(), 1);

        assert_eq!(
            zip.entry(entry("b.txt"), Source::Stream, &opts(), &date()),
            Ok(EntryStatus::OpenDeflated)
        );
        assert_eq!(zip.complete_stored(), Err(ZipError::NoEntryOpen));
        assert!(zip._entry.is_some());
        assert_eq!(zip.end_data(), Ok(()));
        assert_eq!(zip.end_data(), Err(ZipError::NoEntryOpen));
        assert_eq!(zip._entries.len(), 2);
    }
}
