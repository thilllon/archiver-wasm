// Port of deps/compress-commons/lib/archivers/archive-output-stream.js (the Rust part, PORTING.md 5.2).

use crate::error::ZipError;

use super::util::DateFields;
use super::zip_archive_entry::ZipArchiveEntry;
use super::zip_archive_output_stream::{EntryOptions, EntryStatus, Source, ZipArchiveOutputStream};

impl ZipArchiveOutputStream {
    // deps/compress-commons/lib/archivers/archive-output-stream.js:45-78
    pub fn entry(
        &mut self,
        mut ae: ZipArchiveEntry,
        source: Source,
        opts: &EntryOptions,
        now: &DateFields,
    ) -> Result<EntryStatus, ZipError> {
        if self._archive.finish || self._archive.finished {
            return Err(ZipError::EntryAfterFinish);
        }
        if self._archive.processing {
            return Err(ZipError::AlreadyProcessing);
        }
        self._archive.processing = true;
        self._normalize_entry(&mut ae, now);
        match source {
            Source::Buffer { len, crc } => self._append_buffer(ae, len, crc, opts),
            Source::Stream => self._append_stream(ae, opts),
        }
    }

    // deps/compress-commons/lib/archivers/archive-output-stream.js:80-86
    pub fn finish(&mut self) {
        if self._archive.processing {
            self._archive.finish = true;
            return;
        }
        self._finish();
    }

    // deps/compress-commons/lib/archivers/archive-output-stream.js:88-90
    pub fn get_bytes_written(&self) -> u64 {
        self.offset
    }

    // deps/compress-commons/lib/archivers/archive-output-stream.js:92-97
    pub fn write(&mut self, chunk: &[u8]) {
        self.offset = self.offset.wrapping_add(chunk.len() as u64);
        self.out.extend_from_slice(chunk);
    }

    // deps/compress-commons/lib/archivers/archive-output-stream.js:11 (this.offset as the stream layer counted it, PORTING.md 6.8)
    pub fn set_offset(&mut self, offset: u64) {
        self.offset = offset;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::zip::zip_archive_output_stream::Encryption;

    // Captured from compress-commons 7.0.1: "abcdef" written into the engine, then a.txt
    // (stored buffer 'this is a text file', 2013-01-03T14:26:38Z), then finish().
    // 133 bytes
    const OFFSET6: &str = concat!(
        "616263646566504b03040a0000000000537323422733e522130000001300000005000000612e7478",
        "7474686973206973206120746578742066696c65504b01022d000a0000000000537323422733e522",
        "1300000013000000050000000000000000000000000006000000612e747874504b05060000000001",
        "000100330000003c0000000000",
    );

    fn hex(s: &str) -> Vec<u8> {
        (0..s.len())
            .step_by(2)
            .map(|i| u8::from_str_radix(&s[i..i + 2], 16).unwrap())
            .collect()
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

    fn stored(name: &str) -> ZipArchiveEntry {
        let mut ae = ZipArchiveEntry::new(Some(name));
        ae.set_time(&date());
        ae.set_method(0);
        ae
    }

    #[test]
    fn guards_and_set_offset() {
        let mut zip = ZipArchiveOutputStream::new(false, Encryption::None);
        assert_eq!(
            zip.entry(stored("a.txt"), Source::Stream, &opts(), &date()),
            Ok(EntryStatus::OpenStored)
        );
        assert_eq!(
            zip.entry(stored("b.txt"), Source::Stream, &opts(), &date()),
            Err(ZipError::AlreadyProcessing)
        );
        assert_eq!(
            ZipError::AlreadyProcessing.to_string(),
            "already processing an entry"
        );
        assert_eq!(zip.end_data(), Ok(()));
        zip.finish();
        assert_eq!(
            zip.entry(stored("c.txt"), Source::Stream, &opts(), &date()),
            Err(ZipError::EntryAfterFinish)
        );
        assert_eq!(
            ZipError::EntryAfterFinish.to_string(),
            "unacceptable entry after finish"
        );

        let expected = hex(OFFSET6);
        let mut zip = ZipArchiveOutputStream::new(false, Encryption::None);
        let mut archive = b"abcdef".to_vec();
        zip.set_offset(6);
        assert_eq!(
            zip.entry(
                stored("a.txt"),
                Source::Buffer {
                    len: 19,
                    crc: 585446183
                },
                &opts(),
                &date()
            ),
            Ok(EntryStatus::StoredBuffer)
        );
        archive.extend_from_slice(&zip.take_output());
        archive.extend_from_slice(b"this is a text file");
        assert_eq!(zip.complete_stored(), Ok(()));
        zip.finish();
        archive.extend_from_slice(&zip.take_output());
        assert_eq!(archive, expected);
        let cfh = 6 + 35 + 19;
        assert_eq!(&archive[cfh..cfh + 4], b"PK\x01\x02");
        assert_eq!(&archive[cfh + 42..cfh + 46], &[6, 0, 0, 0]);
        let eocd = archive.len() - 22;
        assert_eq!(&archive[eocd..eocd + 4], b"PK\x05\x06");
        assert_eq!(&archive[eocd + 16..eocd + 20], &[54 + 6, 0, 0, 0]);
        assert_eq!(zip.get_bytes_written(), 133);
    }

    #[test]
    fn entry_after_finish_requested() {
        let mut zip = ZipArchiveOutputStream::new(false, Encryption::None);
        assert_eq!(
            zip.entry(stored("a.txt"), Source::Stream, &opts(), &date()),
            Ok(EntryStatus::OpenStored)
        );
        zip.finish();
        assert_eq!(
            zip.entry(stored("b.txt"), Source::Stream, &opts(), &date()),
            Err(ZipError::EntryAfterFinish)
        );
    }

    #[test]
    fn finish_while_processing() {
        let mut zip = ZipArchiveOutputStream::new(false, Encryption::None);
        assert_eq!(
            zip.entry(stored("a.txt"), Source::Stream, &opts(), &date()),
            Ok(EntryStatus::OpenStored)
        );
        assert_eq!(zip.take_output().len(), 30 + 5);
        zip.finish();
        assert!(zip._archive.finish);
        assert!(!zip._archive.finished);
        assert!(zip._archive.processing);
        assert!(zip.take_output().is_empty());
        assert_eq!(zip.write_data(b"test"), Ok(()));
        assert_eq!(zip.end_data(), Ok(()));
        assert!(zip._archive.finished);
        assert!(!zip._archive.processing);
        let out = zip.take_output();
        assert_eq!(out.len(), 4 + 16 + (46 + 5) + 22);
        assert_eq!(&out[..4], b"test");
        assert_eq!(&out[4..8], b"PK\x07\x08");
        assert_eq!(&out[20..24], b"PK\x01\x02");
        assert_eq!(&out[71..75], b"PK\x05\x06");
    }

    #[test]
    fn write_and_get_bytes_written() {
        let mut zip = ZipArchiveOutputStream::new(false, Encryption::None);
        assert_eq!(zip.get_bytes_written(), 0);
        zip.write(b"abc");
        zip.write(b"");
        zip.write(b"de");
        assert_eq!(zip.get_bytes_written(), 5);
        assert_eq!(zip.take_output(), b"abcde");
        assert_eq!(zip.get_bytes_written(), 5);
        zip.set_offset(0x1_0000_0000);
        zip.write(b"f");
        assert_eq!(zip.get_bytes_written(), 0x1_0000_0001);
        assert_eq!(zip.take_output(), b"f");
    }
}
