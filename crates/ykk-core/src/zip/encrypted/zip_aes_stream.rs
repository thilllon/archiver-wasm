// Port of archiver-zip-encrypted/lib/aes/zip-aes-stream.js (the overridden methods, PORTING.md 6.9).

use crate::crc32_stream::{CRC32Stream, DeflateCRC32Stream};
use crate::error::ZipError;
use crate::zip::constants::{
    MIN_VERSION_ZIP64, SHORT_ZERO, SIG_CFH, VERSION_MADEBY, ZIP64_EXTRA_ID, ZIP64_MAGIC,
};
use crate::zip::encrypted::aes_hmac_etm_stream::AesHmacEtmStream;
use crate::zip::util::{get_eight_bytes, get_long_bytes, get_short_bytes};
use crate::zip::zip_archive_entry::ZipArchiveEntry;
use crate::zip::zip_archive_output_stream::{
    EntryOptions, EntryStatus, Process, SmartStream, ZipArchiveOutputStream,
};

pub(crate) const ZIP_AES_METHOD: i32 = 99;

// archiver-zip-encrypted/lib/aes/zip-aes-stream.js:30-40
pub(crate) fn _build_aes_extra_field(ae: &ZipArchiveEntry) -> [u8; 11] {
    let mut buffer = [0u8; 11];
    buffer[0..2].copy_from_slice(&0x9901u16.to_le_bytes()); // AES header ID
    buffer[2..4].copy_from_slice(&0x7u16.to_le_bytes()); // data size, hardcoded
    buffer[4..6].copy_from_slice(&0x1u16.to_le_bytes()); // AE-1, i.e. CRC is present
    buffer[6..8].copy_from_slice(&0x4541u16.to_le_bytes()); // vendor id, hardcoded
    buffer[8] = 0x3; // encryption strength: AES-256
    // actual compression method
    buffer[9..11].copy_from_slice(&(ae.get_method() as u16).to_le_bytes());

    buffer
}

impl ZipArchiveOutputStream {
    // archiver-zip-encrypted/lib/aes/zip-aes-stream.js:42-52
    pub(crate) fn aes_write_local_file_header(&mut self, ae: &mut ZipArchiveEntry) {
        // set AES-specific fields
        ae.get_general_purpose_bit_mut().use_encryption(true);
        let mut extra = ae.get_extra().to_vec();
        extra.extend_from_slice(&_build_aes_extra_field(ae));
        ae.set_extra(extra);
        ae.set_method(ZIP_AES_METHOD as u16);
        ae.set_version_needed_to_extract(51);

        self.base_write_local_file_header(ae);
    }

    // archiver-zip-encrypted/lib/aes/zip-aes-stream.js:54-144
    pub(crate) fn aes_write_central_file_header(&mut self, ae: &mut ZipArchiveEntry) {
        let method = ae.get_method();

        let mut size = ae.get_size();
        let mut compressed_size = ae.get_compressed_size();

        if ae.is_zip64() || ae._offsets.file > ZIP64_MAGIC {
            size = ZIP64_MAGIC;
            compressed_size = ZIP64_MAGIC;

            ae.set_version_needed_to_extract(MIN_VERSION_ZIP64);

            let mut extra_buf = Vec::with_capacity(28);
            extra_buf.extend_from_slice(&get_short_bytes(ZIP64_EXTRA_ID as u64));
            extra_buf.extend_from_slice(&get_short_bytes(24));
            extra_buf.extend_from_slice(&get_eight_bytes(ae.get_size()));
            extra_buf.extend_from_slice(&get_eight_bytes(ae.get_compressed_size()));
            extra_buf.extend_from_slice(&get_eight_bytes(ae._offsets.file));

            let mut extra = ae.get_extra().to_vec();
            extra.extend_from_slice(&extra_buf);
            ae.set_extra(extra);
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

        // archiver-zip-encrypted/lib/aes/zip-aes-stream.js:106-109 (Buffer.from(name), Buffer.from(comment): PORTING.md RS-18)
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
        if ae._offsets.file > ZIP64_MAGIC {
            self.write(&get_long_bytes(ZIP64_MAGIC));
        } else {
            self.write(&get_long_bytes(ae._offsets.file));
        }

        // name
        self.write(name);

        // extra
        self.write(extra);

        // comment
        self.write(comment);
    }

    // archiver-zip-encrypted/lib/aes/zip-aes-stream.js:146-154
    pub(crate) fn aes_append_buffer(
        &mut self,
        mut ae: ZipArchiveEntry,
        len: u64,
        crc: u32,
        opts: &EntryOptions,
    ) -> Result<EntryStatus, ZipError> {
        ae.set_size(len);
        ae.set_compressed_size(len.wrapping_add(28));
        ae.set_crc(crc);

        self._write_local_file_header(&mut ae);

        let status = self._smart_stream(&mut ae, opts);
        self._entry = Some(ae);
        status
    }

    // archiver-zip-encrypted/lib/aes/zip-aes-stream.js:159-163
    // Pass stream from compressor through encryption stream
    pub(crate) fn aes_smart_stream(
        &mut self,
        ae: &mut ZipArchiveEntry,
        opts: &EntryOptions,
    ) -> Result<EntryStatus, ZipError> {
        let extra = ae.get_extra();
        let deflate = match extra.get(9..11) {
            Some(b) => i16::from_le_bytes([b[0], b[1]]) > 0,
            None => return Err(ZipError::ExtraTooShort),
        };
        let compression_stream = if deflate {
            Process::Deflate(DeflateCRC32Stream::new(opts.level))
        } else {
            Process::Crc32(CRC32Stream::new())
        };
        let encryption_stream = AesHmacEtmStream::new(&opts.key, &opts.random)?;

        self._smart = Some(SmartStream {
            process: compression_stream,
            encryption_stream: Some(encryption_stream),
            buffered_data: Vec::new(),
            key: Vec::new(),
            random: Vec::new(),
        });
        Ok(if deflate {
            EntryStatus::OpenDeflated
        } else {
            EntryStatus::OpenStored
        })
    }

    // archiver-zip-encrypted/lib/aes/zip-aes-stream.js:179 (data flow of compressionStream.pipe(encryptionStream).pipe(this, {end: false}))
    pub(crate) fn aes_smart_stream_write(&mut self, chunk: &[u8]) -> Result<(), ZipError> {
        let smart = self._smart.as_mut().ok_or(ZipError::NoEntryOpen)?;
        let encryption_stream = smart
            .encryption_stream
            .as_mut()
            .ok_or(ZipError::NoEntryOpen)?;

        let mut compressed = Vec::new();
        match &mut smart.process {
            Process::Crc32(compression_stream) => {
                compression_stream._transform(chunk, &mut compressed)
            }
            Process::Deflate(compression_stream) => {
                compression_stream._transform(chunk, &mut compressed)?
            }
        }
        let mut encrypted = Vec::new();
        if !compressed.is_empty() {
            encryption_stream._transform(&compressed, &mut encrypted);
        }
        self.write(&encrypted);
        Ok(())
    }

    // archiver-zip-encrypted/lib/aes/zip-aes-stream.js:165-172 (onEnd, after the end of both piped streams, :179)
    pub(crate) fn aes_smart_stream_end(&mut self) -> Result<(), ZipError> {
        let mut ae = self._entry.take().ok_or(ZipError::NoEntryOpen)?;
        let mut smart = self._smart.take().ok_or(ZipError::NoEntryOpen)?;
        let mut encryption_stream = smart
            .encryption_stream
            .take()
            .ok_or(ZipError::NoEntryOpen)?;

        let mut compressed = Vec::new();
        if let Process::Deflate(compression_stream) = &mut smart.process {
            compression_stream._flush(&mut compressed)?;
        }
        let mut encrypted = Vec::new();
        if !compressed.is_empty() {
            encryption_stream._transform(&compressed, &mut encrypted);
        }
        encryption_stream._flush(&mut encrypted);
        self.write(&encrypted);

        let (digest, size) = match &smart.process {
            Process::Crc32(compression_stream) => {
                (compression_stream.digest(), compression_stream.size(false))
            }
            Process::Deflate(compression_stream) => {
                (compression_stream.digest(), compression_stream.size(false))
            }
        };
        let digest = u32::from_be_bytes(digest);
        ae.set_crc(digest);
        ae.set_size(size);
        ae.set_compressed_size(encryption_stream.get_total_size());
        self._after_append(ae);
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::crc32;
    use crate::zip::util::DateFields;
    use crate::zip::zip_archive_output_stream::{Encryption, Source};
    use crate::zip::zip_stream::{ZipEntryData, ZipStream};

    const SALT: [u8; 16] = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15];

    // 2013-01-03T14:26:38Z read with the UTC getters
    const DATE: DateFields = DateFields {
        year: 2013.0,
        month: 0.0,
        date: 3.0,
        hours: 14.0,
        minutes: 26.0,
        seconds: 38.0,
    };

    fn hex(bytes: &[u8]) -> String {
        bytes.iter().map(|b| format!("{b:02x}")).collect()
    }

    fn u16_at(buf: &[u8], offset: usize) -> u16 {
        u16::from_le_bytes([buf[offset], buf[offset + 1]])
    }

    fn u32_at(buf: &[u8], offset: usize) -> u32 {
        u32::from_le_bytes([
            buf[offset],
            buf[offset + 1],
            buf[offset + 2],
            buf[offset + 3],
        ])
    }

    fn ok<T>(result: Result<T, ZipError>) -> T {
        match result {
            Ok(value) => value,
            Err(e) => panic!("{e}"),
        }
    }

    fn opts() -> EntryOptions {
        EntryOptions {
            level: 1,
            key: b"123".to_vec(),
            random: SALT.to_vec(),
        }
    }

    fn data(name: &str, store: bool) -> ZipEntryData {
        ZipEntryData {
            name: name.to_string(),
            date: DATE,
            name_prepend_slash: false,
            store,
            comment: String::new(),
            mode: None,
        }
    }

    fn append(
        zip: &mut ZipStream,
        name: &str,
        store: bool,
        buffer: bool,
        chunks: &[&[u8]],
    ) -> (EntryStatus, Vec<u8>) {
        let source = if buffer {
            let whole = chunks.concat();
            Source::Buffer {
                len: whole.len() as u64,
                crc: crc32::buf(&whole, 0),
            }
        } else {
            Source::Stream
        };
        let status = ok(zip.entry(source, &data(name, store), &opts()));
        let mut out = zip.inner.take_output();
        for chunk in chunks {
            if !chunk.is_empty() {
                ok(zip.inner.write_data(chunk));
                out.extend_from_slice(&zip.inner.take_output());
            }
        }
        ok(zip.inner.end_data());
        out.extend_from_slice(&zip.inner.take_output());
        (status, out)
    }

    fn inflate(data: &[u8]) -> Vec<u8> {
        use std::io::Read;
        let mut out = Vec::new();
        match flate2::read::DeflateDecoder::new(data).read_to_end(&mut out) {
            Ok(_) => out,
            Err(e) => panic!("{e}"),
        }
    }

    struct Shape {
        status: EntryStatus,
        version: u16,
        flags: u16,
        method: u16,
        crc: u32,
        csize: u32,
        size: u32,
        extra: Vec<u8>,
        payload: Vec<u8>,
        descriptor: Option<(u32, u32, u32)>,
        recorded: (u32, u64, u64),
        plain: Vec<u8>,
    }

    fn shape(store: bool, buffer: bool, chunks: &[&[u8]]) -> Shape {
        let mut zip = ZipStream::new(false, Encryption::Aes256);
        let (status, out) = append(&mut zip, "a.txt", store, buffer, chunks);
        assert_eq!(u32_at(&out, 0), 0x04034b50);
        let flags = u16_at(&out, 6);
        let name_length = u16_at(&out, 26) as usize;
        let extra_length = u16_at(&out, 28) as usize;
        let contents = 30 + name_length + extra_length;
        let extra = out[30 + name_length..contents].to_vec();
        let end = if flags & 0x0008 != 0 {
            out.len() - 16
        } else {
            out.len()
        };
        let payload = out[contents..end].to_vec();
        let descriptor = if flags & 0x0008 != 0 {
            assert_eq!(u32_at(&out, end), 0x08074b50);
            Some((
                u32_at(&out, end + 4),
                u32_at(&out, end + 8),
                u32_at(&out, end + 12),
            ))
        } else {
            None
        };
        assert_eq!(hex(&payload[0..18]), "000102030405060708090a0b0c0d0e0f56d8");
        let mut decryptor = ok(AesHmacEtmStream::new(b"123", &SALT));
        let mut decrypted = Vec::new();
        decryptor._transform(&payload[18..payload.len() - 10], &mut decrypted);
        let compressed = decrypted[18..].to_vec();
        assert_eq!(payload.len(), compressed.len() + 28);
        let plain = if u16_at(&extra, 9) == 8 {
            inflate(&compressed)
        } else {
            compressed
        };
        let ae = &zip.inner._entries[0];
        Shape {
            status,
            version: u16_at(&out, 4),
            flags,
            method: u16_at(&out, 8),
            crc: u32_at(&out, 14),
            csize: u32_at(&out, 18),
            size: u32_at(&out, 22),
            extra,
            payload,
            descriptor,
            recorded: (ae.get_crc(), ae.get_compressed_size(), ae.get_size()),
            plain,
        }
    }

    #[test]
    fn aes_extra_and_shapes() {
        let mut ae = ZipArchiveEntry::new(Some("a.txt"));
        ae.set_method(8);
        assert_eq!(hex(&_build_aes_extra_field(&ae)), "0199070001004145030800");
        ae.set_method(0);
        assert_eq!(hex(&_build_aes_extra_field(&ae)), "0199070001004145030000");
        assert_eq!(ZIP_AES_METHOD, 99);

        // aes256, buffer, stored
        let s = shape(true, true, &[b"hello"]);
        assert_eq!(s.status, EntryStatus::OpenStored);
        assert_eq!((s.version, s.flags, s.method), (51, 0x0001, 99));
        assert_eq!(hex(&s.extra), "0199070001004145030000");
        assert_eq!((s.crc, s.csize, s.size), (0x3610a686, 5 + 28, 5));
        assert_eq!(s.descriptor, None);
        assert_eq!(s.payload.len(), 5 + 28);
        assert_eq!(hex(&s.payload[18..]), "dd9090588d073e32b0fc7af3f25cca");
        assert_eq!(s.recorded, (0x3610a686, 5 + 28, 5));
        assert_eq!(s.plain, b"hello");

        // aes256, buffer, stored, empty
        let s = shape(true, true, &[]);
        assert_eq!(s.status, EntryStatus::OpenStored);
        assert_eq!((s.version, s.flags, s.method), (51, 0x0001, 99));
        assert_eq!((s.crc, s.csize, s.size), (0, 28, 0));
        assert_eq!(s.descriptor, None);
        assert_eq!(hex(&s.payload[18..]), "742c47b8abe1b07dfc30");
        assert_eq!(s.recorded, (0, 28, 0));

        // aes256, buffer, deflate
        let s = shape(false, true, &[b"hello"]);
        assert_eq!(s.status, EntryStatus::OpenDeflated);
        assert_eq!((s.version, s.flags, s.method), (51, 0x0009, 99));
        assert_eq!(hex(&s.extra), "0199070001004145030800");
        assert_eq!((s.crc, s.csize, s.size), (0, 0, 0));
        assert_eq!(s.descriptor, Some((0x3610a686, s.payload.len() as u32, 5)));
        assert_eq!(s.recorded, (0x3610a686, s.payload.len() as u64, 5));
        assert_eq!(s.plain, b"hello");

        // aes256, buffer, deflate, empty
        let s = shape(false, true, &[]);
        assert_eq!(s.status, EntryStatus::OpenDeflated);
        assert_eq!((s.version, s.flags, s.method), (51, 0x0009, 99));
        assert_eq!(hex(&s.extra), "0199070001004145030800");
        assert_eq!((s.crc, s.csize, s.size), (0, 0, 0));
        assert!(s.payload.len() > 28);
        assert_eq!(s.descriptor, Some((0, s.payload.len() as u32, 0)));
        assert_eq!(s.recorded, (0, s.payload.len() as u64, 0));
        assert_eq!(s.plain, b"");

        // aes256, stream, stored
        let s = shape(true, false, &[b"hel", b"lo"]);
        assert_eq!(s.status, EntryStatus::OpenStored);
        assert_eq!((s.version, s.flags, s.method), (51, 0x0009, 99));
        assert_eq!(hex(&s.extra), "0199070001004145030000");
        assert_eq!((s.crc, s.csize, s.size), (0, 0, 0));
        assert_eq!(s.descriptor, Some((0x3610a686, 5 + 28, 5)));
        assert_eq!(hex(&s.payload[18..]), "dd9090588d073e32b0fc7af3f25cca");
        assert_eq!(s.recorded, (0x3610a686, 5 + 28, 5));

        // aes256, stream, deflate
        let s = shape(false, false, &[b"hel", b"lo"]);
        assert_eq!(s.status, EntryStatus::OpenDeflated);
        assert_eq!((s.version, s.flags, s.method), (51, 0x0009, 99));
        assert_eq!(hex(&s.extra), "0199070001004145030800");
        assert_eq!((s.crc, s.csize, s.size), (0, 0, 0));
        assert_eq!(s.descriptor, Some((0x3610a686, s.payload.len() as u32, 5)));
        assert_eq!(s.recorded, (0x3610a686, s.payload.len() as u64, 5));
        assert_eq!(s.plain, b"hello");
    }

    // Bytes written by ZipAesStream of archiver-zip-encrypted 2.0.0 for the same three entries.
    #[test]
    fn stored_archive_matches_upstream() {
        let mut zip = ZipStream::new(false, Encryption::Aes256);
        let mut archive = Vec::new();
        archive.extend_from_slice(&append(&mut zip, "a.txt", true, true, &[b"hello"]).1);
        archive.extend_from_slice(&append(&mut zip, "b.txt", true, false, &[b"hel", b"lo"]).1);
        archive.extend_from_slice(&append(&mut zip, "d/", true, true, &[]).1);
        zip.finalize();
        archive.extend_from_slice(&zip.inner.take_output());
        assert_eq!(
            hex(&archive),
            concat!(
                "504b03043300010063005373234286a61036210000000500000005000b00612e",
                "7478740199070001004145030000000102030405060708090a0b0c0d0e0f56d8",
                "dd9090588d073e32b0fc7af3f25cca504b030433000900630053732342000000",
                "00000000000000000005000b00622e7478740199070001004145030000000102",
                "030405060708090a0b0c0d0e0f56d8dd9090588d073e32b0fc7af3f25cca504b",
                "070886a610362100000005000000504b03043300010063005373234200000000",
                "1c0000000000000002000b00642f019907000100414503000000010203040506",
                "0708090a0b0c0d0e0f56d8742c47b8abe1b07dfc30504b01022d003300010063",
                "005373234286a61036210000000500000005000b000000000000000000000000",
                "000000612e7478740199070001004145030000504b01022d0033000900630053",
                "73234286a61036210000000500000005000b00000000000000000000004f0000",
                "00622e7478740199070001004145030000504b01022d00330001006300537323",
                "42000000001c0000000000000002000b0000000000000000000000ae00000064",
                "2f0199070001004145030000504b05060000000003000300b7000000f5000000",
                "0000",
            )
        );
    }

    // Bytes written by ZipAesStream.prototype._writeLocalFileHeader of archiver-zip-encrypted 2.0.0
    // for a stored buffer entry after the setSize, setCompressedSize and setCrc of _appendBuffer.
    #[test]
    fn local_file_header_zip64() {
        let local = |len: u64| {
            let mut zip = ZipStream::new(false, Encryption::Aes256);
            let source = Source::Buffer { len, crc: 0 };
            let status = ok(zip.entry(source, &data("big.bin", true), &opts()));
            assert_eq!(status, EntryStatus::OpenStored);
            hex(&zip.inner.take_output())
        };
        // len + 28 above 0xFFFFFFFF: descriptor flag forced on, version 51 replaced by 45
        assert_eq!(
            local(0x1_0000_0000),
            concat!(
                "504b03042d00090063005373234200000000000000000000000007000b006269",
                "672e62696e0199070001004145030000",
            )
        );
        assert_eq!(
            local(0xffff_ffff - 27),
            concat!(
                "504b03042d00090063005373234200000000000000000000000007000b006269",
                "672e62696e0199070001004145030000",
            )
        );
        // len + 28 == 0xFFFFFFFF is not zip64
        assert_eq!(
            local(0xffff_ffff - 28),
            concat!(
                "504b03043300010063005373234200000000ffffffffe3ffffff07000b006269",
                "672e62696e0199070001004145030000",
            )
        );
    }

    fn central(size: u64, csize: u64, file: u64) -> String {
        central_named("big.bin", "", size, csize, file)
    }

    fn central_named(name: &str, comment: &str, size: u64, csize: u64, file: u64) -> String {
        let mut zip = ZipArchiveOutputStream::new(false, Encryption::Aes256);
        let mut ae = ZipArchiveEntry::new(Some(name));
        ae.set_time(&DATE);
        if !comment.is_empty() {
            ae.set_comment(comment);
        }
        ae.set_method(ZIP_AES_METHOD as u16);
        ae.set_size(size);
        ae.set_compressed_size(csize);
        ae.set_crc(0x12345678);
        ae.set_extra(vec![0x01, 0x99, 0x07, 0x00, 0x01, 0x00, 0x41, 0x45, 0x03, 0x00, 0x00]);
        ae.set_version_needed_to_extract(51);
        ae.get_general_purpose_bit_mut().use_encryption(true);
        ae._offsets.file = file;
        zip.aes_write_central_file_header(&mut ae);
        hex(&zip.take_output())
    }

    // Bytes written by ZipAesStream.prototype._writeCentralFileHeader of archiver-zip-encrypted 2.0.0.
    #[test]
    fn central_file_header_zip64() {
        assert_eq!(
            central(5, 33, 7),
            concat!(
                "504b01022d003300010063005373234278563412210000000500000007000b00",
                "00000000000000000000070000006269672e62696e0199070001004145030000",
            )
        );
        assert_eq!(
            central(0x1_0000_0005, 0x1_0000_0005 + 28, 7),
            concat!(
                "504b01022d002d00010063005373234278563412ffffffffffffffff07002700",
                "00000000000000000000070000006269672e62696e0199070001004145030000",
                "01001800050000000100000021000000010000000700000000000000",
            )
        );
        assert_eq!(
            central(5, 33, 0x1_0000_0007),
            concat!(
                "504b01022d002d00010063005373234278563412ffffffffffffffff07002700",
                "00000000000000000000ffffffff6269672e62696e0199070001004145030000",
                "01001800050000000000000021000000000000000700000001000000",
            )
        );
        assert_eq!(
            central(0xffff_ffff, 0xffff_ffff, 0xffff_ffff),
            concat!(
                "504b01022d003300010063005373234278563412ffffffffffffffff07000b00",
                "00000000000000000000ffffffff6269672e62696e0199070001004145030000",
            )
        );
    }

    // Bytes written by ZipAesStream.prototype._writeCentralFileHeader of archiver-zip-encrypted 2.0.0
    // for the name 'é.txt' and the comment 'ü': flags 0x0801, lengths in UTF-8 bytes.
    #[test]
    fn central_file_header_utf8_name_and_comment() {
        assert_eq!(
            central_named("é.txt", "ü", 5, 33, 7),
            concat!(
                "504b01022d003300010863005373234278563412210000000500000006000b00",
                "0200000000000000000007000000c3a92e7478740199070001004145030000c3",
                "bc",
            )
        );
    }

    #[test]
    fn smart_stream_reads_the_method_from_the_extra() {
        let mut zip = ZipArchiveOutputStream::new(false, Encryption::Aes256);
        let mut ae = ZipArchiveEntry::new(Some("a.txt"));
        assert_eq!(
            zip.aes_smart_stream(&mut ae, &opts()).err(),
            Some(ZipError::ExtraTooShort)
        );
        ae.set_extra(vec![0u8; 10]);
        assert_eq!(
            zip.aes_smart_stream(&mut ae, &opts()).err(),
            Some(ZipError::ExtraTooShort)
        );
        ae.set_extra(vec![0x01, 0x99, 0x07, 0x00, 0x01, 0x00, 0x41, 0x45, 0x03, 0x08, 0x00]);
        assert_eq!(
            zip.aes_smart_stream(&mut ae, &opts()).ok(),
            Some(EntryStatus::OpenDeflated)
        );
        ae.set_extra(vec![0x01, 0x99, 0x07, 0x00, 0x01, 0x00, 0x41, 0x45, 0x03, 0x00, 0x00]);
        assert_eq!(
            zip.aes_smart_stream(&mut ae, &opts()).ok(),
            Some(EntryStatus::OpenStored)
        );
        ae.set_extra(vec![0x01, 0x99, 0x07, 0x00, 0x01, 0x00, 0x41, 0x45, 0x03, 0x00, 0x80]);
        assert_eq!(
            zip.aes_smart_stream(&mut ae, &opts()).ok(),
            Some(EntryStatus::OpenStored)
        );
    }

    #[test]
    fn steps_without_an_open_entry() {
        let mut zip = ZipArchiveOutputStream::new(false, Encryption::Aes256);
        assert_eq!(
            zip.aes_smart_stream_write(b"x").err(),
            Some(ZipError::NoEntryOpen)
        );
        assert_eq!(
            zip.aes_smart_stream_end().err(),
            Some(ZipError::NoEntryOpen)
        );
    }
}
