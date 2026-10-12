// Port of the Rust part of archiver-zip-encrypted/lib/zip20/zip-crypto-stream.js (PORTING.md 5.2, 6.9).
use super::crypto_stream::{CryptoStream, HEADER_LENGTH};
use crate::crc32_stream::{CRC32Stream, DeflateCRC32Stream};
use crate::error::ZipError;
use crate::zip::constants::{METHOD_DEFLATED, MIN_VERSION_DATA_DESCRIPTOR};
use crate::zip::zip_archive_entry::ZipArchiveEntry;
use crate::zip::zip_archive_output_stream::{
    EntryOptions, EntryStatus, Process, SmartStream, ZipArchiveOutputStream,
};

impl ZipArchiveOutputStream {
    // archiver-zip-encrypted/lib/zip20/zip-crypto-stream.js:27-31
    pub(crate) fn zip20_write_local_file_header(&mut self, ae: &mut ZipArchiveEntry) {
        // set encryption
        ae.get_general_purpose_bit_mut().use_encryption(true);
        self.base_write_local_file_header(ae);
    }

    // archiver-zip-encrypted/lib/zip20/zip-crypto-stream.js:42-46
    pub(crate) fn zip20_smart_stream(
        &mut self,
        ae: &mut ZipArchiveEntry,
        opts: &EntryOptions,
    ) -> Result<EntryStatus, ZipError> {
        let deflate = ae.get_method() == METHOD_DEFLATED;
        let compression_stream = if deflate {
            Process::Deflate(DeflateCRC32Stream::new(opts.level))
        } else {
            Process::Crc32(CRC32Stream::new())
        };
        if opts.random.len() != HEADER_LENGTH {
            return Err(ZipError::InvalidRandomLength {
                expected: HEADER_LENGTH,
                actual: opts.random.len(),
            });
        }
        self._smart = Some(SmartStream {
            process: compression_stream,
            encryption_stream: None,
            buffered_data: Vec::new(),
            encrypt: None,
            key: opts.key.clone(),
            random: opts.random.clone(),
        });

        Ok(if deflate {
            EntryStatus::OpenDeflated
        } else {
            EntryStatus::OpenStored
        })
    }

    // archiver-zip-encrypted/lib/zip20/zip-crypto-stream.js:52-54 (bufferedData is kept by TypeScript, PORTING.md V16)
    pub(crate) fn zip20_smart_stream_write(&mut self, chunk: &[u8]) -> Result<(), ZipError> {
        let smart = self._smart.as_mut().ok_or(ZipError::NoEntryOpen)?;
        if smart.encrypt.is_some() {
            return Err(ZipError::NoEntryOpen);
        }
        let mut data = Vec::new();
        match &mut smart.process {
            Process::Crc32(compression_stream) => compression_stream._transform(chunk, &mut data),
            Process::Deflate(compression_stream) => {
                compression_stream._transform(chunk, &mut data)?
            }
        }
        self.out.extend_from_slice(&data);
        Ok(())
    }

    // archiver-zip-encrypted/lib/zip20/zip-crypto-stream.js:56-68
    pub(crate) fn zip20_smart_stream_end(&mut self) -> Result<(), ZipError> {
        if self._smart.as_ref().is_some_and(|s| s.encrypt.is_some()) {
            return Err(ZipError::NoEntryOpen);
        }
        let mut smart = self._smart.take().ok_or(ZipError::NoEntryOpen)?;
        let mut ae = self._entry.take().ok_or(ZipError::NoEntryOpen)?;
        // the last 'data' of the compression stream stays here until encrypt_end
        if let Process::Deflate(compression_stream) = &mut smart.process {
            compression_stream._flush(&mut smart.buffered_data)?;
        }

        let crc = match &smart.process {
            Process::Crc32(compression_stream) => compression_stream.digest(),
            Process::Deflate(compression_stream) => compression_stream.digest(),
        };

        // gather complete information for CRC and sizes
        ae.set_crc(u32::from_be_bytes(crc));
        ae.set_size(match &smart.process {
            Process::Crc32(compression_stream) => compression_stream.size(false),
            Process::Deflate(compression_stream) => compression_stream.size(false),
        });
        ae.set_compressed_size(
            match &smart.process {
                Process::Crc32(compression_stream) => compression_stream.size(true),
                Process::Deflate(compression_stream) => compression_stream.size(true),
            } + 12,
        );

        // write local header now
        self._write_local_file_header(&mut ae);

        // write all buffered data to encrypt stream
        let header = <[u8; 12]>::try_from(smart.random.as_slice()).map_err(|_| {
            ZipError::InvalidRandomLength {
                expected: HEADER_LENGTH,
                actual: smart.random.len(),
            }
        })?;
        smart.encrypt = Some(CryptoStream::new(
            &smart.key,
            u16::from_be_bytes([crc[0], crc[1]]),
            header,
        ));
        self._smart = Some(smart);
        self._entry = Some(ae);
        Ok(())
    }

    // archiver-zip-encrypted/lib/zip20/zip-crypto-stream.js:70-72 (one chunk of bufferedData)
    pub fn encrypt_data(&mut self, chunk: &[u8]) -> Result<(), ZipError> {
        let smart = self._smart.as_mut().ok_or(ZipError::NoEntryOpen)?;
        let encrypt = smart.encrypt.as_mut().ok_or(ZipError::NoEntryOpen)?;
        let mut encrypted = Vec::new();
        encrypt._transform(chunk, &mut encrypted);
        self.write(&encrypted);
        Ok(())
    }

    // archiver-zip-encrypted/lib/zip20/zip-crypto-stream.js:73-78
    pub fn encrypt_end(&mut self) -> Result<(), ZipError> {
        let mut smart = self._smart.take().ok_or(ZipError::NoEntryOpen)?;
        let Some(mut encrypt) = smart.encrypt.take() else {
            self._smart = Some(smart);
            return Err(ZipError::NoEntryOpen);
        };
        let ae = self._entry.take().ok_or(ZipError::NoEntryOpen)?;
        if !smart.buffered_data.is_empty() {
            let mut encrypted = Vec::new();
            encrypt._transform(&smart.buffered_data, &mut encrypted);
            self.write(&encrypted);
        }

        self._after_append(ae);
        Ok(())
    }

    // archiver-zip-encrypted/lib/zip20/zip-crypto-stream.js:89-100
    pub(crate) fn zip20_append_buffer(
        &mut self,
        mut ae: ZipArchiveEntry,
        len: u64,
        _crc: u32,
        opts: &EntryOptions,
    ) -> Result<EntryStatus, ZipError> {
        ae.set_size(len);
        ae.set_compressed_size(len);
        ae.get_general_purpose_bit_mut().use_data_descriptor(false);

        let status = self._smart_stream(&mut ae, opts);
        self._entry = Some(ae);
        status
    }

    // archiver-zip-encrypted/lib/zip20/zip-crypto-stream.js:102-117
    pub(crate) fn zip20_append_stream(
        &mut self,
        mut ae: ZipArchiveEntry,
        opts: &EntryOptions,
    ) -> Result<EntryStatus, ZipError> {
        ae.set_version_needed_to_extract(MIN_VERSION_DATA_DESCRIPTOR);

        ae.get_general_purpose_bit_mut().use_data_descriptor(false);

        let status = self._smart_stream(&mut ae, opts);
        self._entry = Some(ae);
        status
    }
}

#[cfg(test)]
mod tests {
    use std::io::Read;

    use flate2::read::DeflateDecoder;

    use super::super::crypto_cipher::CryptoCipher;
    use super::super::decrypto_stream::DecryptoStream;
    use super::*;
    use crate::crc32;
    use crate::zip::constants::{METHOD_STORED, SIG_CFH, SIG_LFH};
    use crate::zip::util::DateFields;
    use crate::zip::zip_archive_output_stream::{Encryption, Source};

    const KEY: &[u8] = b"123";
    const HEADER: [u8; 12] = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11];

    fn date() -> DateFields {
        // 2013-01-03T14:26:38Z read with the getUTC* family
        DateFields {
            year: 2013.0,
            month: 0.0,
            date: 3.0,
            hours: 14.0,
            minutes: 26.0,
            seconds: 38.0,
        }
    }

    fn opts(level: i32) -> EntryOptions {
        EntryOptions {
            level,
            key: KEY.to_vec(),
            random: HEADER.to_vec(),
        }
    }

    fn hex(bytes: &[u8]) -> String {
        bytes.iter().map(|b| format!("{b:02x}")).collect()
    }

    fn short(b: &[u8], offset: usize) -> u16 {
        u16::from_le_bytes([b[offset], b[offset + 1]])
    }

    fn long(b: &[u8], offset: usize) -> u32 {
        u32::from_le_bytes([b[offset], b[offset + 1], b[offset + 2], b[offset + 3]])
    }

    fn inflate(data: &[u8]) -> Vec<u8> {
        let mut decoder = DeflateDecoder::new(data);
        let mut out = Vec::new();
        decoder.read_to_end(&mut out).unwrap();
        assert_eq!(decoder.total_in(), data.len() as u64);
        out
    }

    fn sample(len: usize) -> Vec<u8> {
        (0..len).map(|i| ((i * 31) % 251) as u8).collect()
    }

    enum Payload<'a> {
        Buffer(&'a [u8]),
        Stream(&'a [&'a [u8]]),
    }

    struct Shape {
        version: u16,
        flags: u16,
        method: u16,
        crc: u32,
        csize: u32,
        size: u32,
        extra_len: u16,
        data: Vec<u8>,
    }

    /// Appends one entry and returns the fields of its local header and the bytes that
    /// follow it. The central header must repeat them.
    fn entry(name: &str, store: bool, payload: Payload, level: i32) -> (EntryStatus, Shape) {
        let mut zip = ZipArchiveOutputStream::new(false, Encryption::ZipCrypto);
        let mut ae = ZipArchiveEntry::new(Some(name));
        ae.set_time(&date());
        if store {
            ae.set_method(METHOD_STORED as u16);
        }
        let status = match payload {
            Payload::Buffer(source) => {
                let status = zip
                    .entry(
                        ae,
                        Source::Buffer {
                            len: source.len() as u64,
                            crc: crc32::buf(source, 0),
                        },
                        &opts(level),
                        &date(),
                    )
                    .unwrap();
                if !source.is_empty() {
                    zip.write_data(source).unwrap();
                }
                status
            }
            Payload::Stream(chunks) => {
                let status = zip
                    .entry(ae, Source::Stream, &opts(level), &date())
                    .unwrap();
                for chunk in chunks {
                    zip.write_data(chunk).unwrap();
                }
                status
            }
        };
        // nothing reaches the archive before the entry ends (ENCRYPTED-041)
        let buffered_data = zip.take_output();
        assert_eq!(zip.offset, 0);
        assert!(zip._archive.processing);
        zip.end_data().unwrap();
        assert!(zip._archive.processing);
        for chunk in buffered_data.chunks(7) {
            zip.encrypt_data(chunk).unwrap();
        }
        zip.encrypt_end().unwrap();
        assert!(!zip._archive.processing);
        assert!(zip._entry.is_none());
        assert_eq!(zip._entries.len(), 1);
        let record = zip.take_output();
        assert_eq!(zip.offset, record.len() as u64);
        zip.finish();
        let central = zip.take_output();

        assert_eq!(long(&record, 0), SIG_LFH);
        assert_eq!(long(&record, 10), 1109619539);
        assert_eq!(short(&record, 26) as usize, name.len());
        let contents = 30 + name.len();
        assert_eq!(&record[30..contents], name.as_bytes());
        let shape = Shape {
            version: short(&record, 4),
            flags: short(&record, 6),
            method: short(&record, 8),
            crc: long(&record, 14),
            csize: long(&record, 18),
            size: long(&record, 22),
            extra_len: short(&record, 28),
            data: record[contents..].to_vec(),
        };

        assert_eq!(long(&central, 0), SIG_CFH);
        assert_eq!(short(&central, 6), shape.version);
        assert_eq!(short(&central, 8), shape.flags);
        assert_eq!(short(&central, 10), shape.method);
        assert_eq!(long(&central, 16), shape.crc);
        assert_eq!(long(&central, 20), shape.csize);
        assert_eq!(long(&central, 24), shape.size);
        assert_eq!(short(&central, 30), 0);
        assert_eq!(long(&central, 42), 0);
        (status, shape)
    }

    /// Checks the 12 header bytes and returns the decrypted payload.
    fn decrypt(shape: &Shape) -> Vec<u8> {
        let mut cipher = CryptoCipher::new(KEY);
        let header = cipher.decrypt(&shape.data[..12]);
        assert_eq!(&header[..10], &HEADER[..10]);
        assert_eq!(header[10], (shape.crc >> 16) as u8);
        assert_eq!(header[11], (shape.crc >> 24) as u8);

        let mut stream = DecryptoStream::new(KEY);
        let mut out = Vec::new();
        stream._transform(&shape.data, &mut out);
        out
    }

    #[test]
    fn zip20_entry_shapes() {
        // zip20, buffer, stored. The payload bytes were read from upstream by running
        // lib/zip20/crypto-stream.js under node (key '123', crc 3610A686, the header above).
        let (status, shape) = entry("a.txt", true, Payload::Buffer(b"hello"), 6);
        assert_eq!(status, EntryStatus::OpenStored);
        assert_eq!((shape.version, shape.flags, shape.method), (10, 0x0001, 0));
        assert_eq!((shape.crc, shape.csize, shape.size), (0x3610a686, 17, 5));
        assert_eq!(shape.extra_len, 0);
        assert_eq!(hex(&shape.data), "40cfd1f3872ef08929a034a53133b1b255");
        assert_eq!(decrypt(&shape), b"hello");

        // zip20, buffer, deflate
        let payload = sample(4000);
        let (status, shape) = entry("a.txt", false, Payload::Buffer(&payload), 6);
        assert_eq!(status, EntryStatus::OpenDeflated);
        assert_eq!((shape.version, shape.flags, shape.method), (20, 0x0001, 8));
        assert_eq!((shape.crc, shape.size), (crc32::buf(&payload, 0), 4000));
        assert_eq!(shape.csize as usize, shape.data.len());
        let deflated = decrypt(&shape);
        assert_eq!(shape.csize as usize, deflated.len() + 12);
        assert_eq!(inflate(&deflated), payload);

        // zip20, buffer, deflate, empty: not switched to stored (ENCRYPTED-049)
        let (status, shape) = entry("empty.txt", false, Payload::Buffer(b""), 1);
        assert_eq!(status, EntryStatus::OpenDeflated);
        assert_eq!((shape.version, shape.flags, shape.method), (20, 0x0001, 8));
        assert_eq!((shape.crc, shape.size), (0, 0));
        assert_eq!(shape.csize as usize, shape.data.len());
        let deflated = decrypt(&shape);
        assert!(!deflated.is_empty());
        assert_eq!(shape.csize as usize, deflated.len() + 12);
        assert_eq!(inflate(&deflated), b"");

        // zip20, stream, stored
        let chunks: [&[u8]; 2] = [b"this is ", b"a text file"];
        let (status, shape) = entry("s.txt", true, Payload::Stream(&chunks), 6);
        assert_eq!(status, EntryStatus::OpenStored);
        assert_eq!((shape.version, shape.flags, shape.method), (20, 0x0001, 0));
        assert_eq!((shape.crc, shape.csize, shape.size), (585446183, 31, 19));
        assert_eq!(shape.data.len(), 31);
        assert_eq!(decrypt(&shape), b"this is a text file");

        // zip20, stream, deflate
        let chunks: [&[u8]; 3] = [&payload[..1], &payload[1..3000], &payload[3000..]];
        let (status, shape) = entry("s.txt", false, Payload::Stream(&chunks), 9);
        assert_eq!(status, EntryStatus::OpenDeflated);
        assert_eq!((shape.version, shape.flags, shape.method), (20, 0x0001, 8));
        assert_eq!((shape.crc, shape.size), (crc32::buf(&payload, 0), 4000));
        assert_eq!(shape.csize as usize, shape.data.len());
        let deflated = decrypt(&shape);
        assert_eq!(shape.csize as usize, deflated.len() + 12);
        assert_eq!(inflate(&deflated), payload);

        // zip20, any, stored, zero data bytes (P17): csize 12 declared, nothing written
        let (status, shape) = entry("d/", true, Payload::Buffer(b""), 6);
        assert_eq!(status, EntryStatus::OpenStored);
        assert_eq!((shape.version, shape.flags, shape.method), (10, 0x0001, 0));
        assert_eq!((shape.crc, shape.csize, shape.size), (0, 12, 0));
        assert!(shape.data.is_empty());

        let (status, shape) = entry("e.txt", true, Payload::Stream(&[]), 6);
        assert_eq!(status, EntryStatus::OpenStored);
        assert_eq!((shape.version, shape.flags, shape.method), (20, 0x0001, 0));
        assert_eq!((shape.crc, shape.csize, shape.size), (0, 12, 0));
        assert!(shape.data.is_empty());

        let (_, shape) = entry("e.txt", true, Payload::Stream(&[b""]), 6);
        assert_eq!((shape.crc, shape.csize, shape.size), (0, 12, 0));
        assert!(shape.data.is_empty());
    }

    // archiver-zip-encrypted/lib/zip20/zip-crypto-stream.js:65 (the header is written late, at the offset of that moment)
    #[test]
    fn local_header_offset_follows_the_previous_entry() {
        let mut zip = ZipArchiveOutputStream::new(false, Encryption::ZipCrypto);
        let mut ae = ZipArchiveEntry::new(Some("d/"));
        ae.set_method(METHOD_STORED as u16);
        zip.entry(ae, Source::Buffer { len: 0, crc: 0 }, &opts(6), &date())
            .unwrap();
        zip.end_data().unwrap();
        zip.encrypt_end().unwrap();
        assert_eq!(zip.offset, 32);

        let mut ae = ZipArchiveEntry::new(Some("a.txt"));
        ae.set_method(METHOD_STORED as u16);
        zip.entry(ae, Source::Stream, &opts(6), &date()).unwrap();
        let out = zip.take_output();
        zip.write_data(b"hel").unwrap();
        zip.write_data(b"lo").unwrap();
        assert_eq!(zip.take_output(), b"hello");
        zip.end_data().unwrap();
        zip.encrypt_data(b"hello").unwrap();
        zip.encrypt_end().unwrap();
        assert_eq!(zip.offset, 32 + 35 + 17);
        assert_eq!(zip._entries[0]._offsets.file, 0);
        assert_eq!(zip._entries[1]._offsets.file, 32);
        assert_eq!(zip._entries[1]._offsets.contents, 32 + 35);

        assert_eq!(out.len(), 32);
        let out = zip.take_output();
        assert_eq!(long(&out, 0), SIG_LFH);
        assert_eq!(hex(&out[35..]), "40cfd1f3872ef08929a034a53133b1b255");
    }

    #[test]
    fn random_must_be_twelve_bytes() {
        let mut zip = ZipArchiveOutputStream::new(false, Encryption::ZipCrypto);
        let options = EntryOptions {
            level: 6,
            key: KEY.to_vec(),
            random: vec![0; 11],
        };
        assert_eq!(
            zip.entry(
                ZipArchiveEntry::new(Some("a.txt")),
                Source::Stream,
                &options,
                &date(),
            ),
            Err(ZipError::InvalidRandomLength {
                expected: 12,
                actual: 11,
            })
        );
        assert!(zip._archive.processing);
        assert!(zip.take_output().is_empty());
    }

    #[test]
    fn data_without_an_open_entry() {
        let mut zip = ZipArchiveOutputStream::new(false, Encryption::ZipCrypto);
        assert_eq!(zip.write_data(b"x"), Err(ZipError::NoEntryOpen));
        assert_eq!(zip.end_data(), Err(ZipError::NoEntryOpen));
        assert_eq!(zip.encrypt_data(b"x"), Err(ZipError::NoEntryOpen));
        assert_eq!(zip.encrypt_end(), Err(ZipError::NoEntryOpen));

        // the encryption stream exists between end_data and encrypt_end only
        zip.entry(
            ZipArchiveEntry::new(Some("a.txt")),
            Source::Stream,
            &opts(6),
            &date(),
        )
        .unwrap();
        assert_eq!(zip.encrypt_data(b"x"), Err(ZipError::NoEntryOpen));
        assert_eq!(zip.encrypt_end(), Err(ZipError::NoEntryOpen));
        zip.end_data().unwrap();
        assert_eq!(zip.write_data(b"x"), Err(ZipError::NoEntryOpen));
        assert_eq!(zip.end_data(), Err(ZipError::NoEntryOpen));
        assert!(zip._archive.processing);
        zip.encrypt_end().unwrap();
        assert_eq!(zip.encrypt_end(), Err(ZipError::NoEntryOpen));
        assert_eq!(zip._entries.len(), 1);
    }
}
