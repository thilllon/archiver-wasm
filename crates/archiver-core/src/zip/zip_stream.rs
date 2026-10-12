// Port of the Rust part of deps/zip-stream/index.js (PORTING.md 5.2, 6.10).
use super::util::DateFields;
use super::zip_archive_entry::ZipArchiveEntry;
use super::zip_archive_output_stream::{
    Encryption, EntryOptions, EntryStatus, Source, ZipArchiveOutputStream,
};
use crate::error::ZipError;

/// What ZipStream.entry (zip-stream/index.js:101-150) hands to the entry object after the
/// TypeScript layer has normalized and validated the JS data.
#[derive(Debug, Clone)]
pub struct ZipEntryData {
    pub name: String,             // data.name after _normalizeFileData
    pub date: DateFields,         // data.date read with the forceLocalTime getter family
    pub name_prepend_slash: bool, // truthiness of data.namePrependSlash
    pub store: bool,              // truthiness of data.store
    pub comment: String,          // data.comment ("" when data.comment.length is 0)
    pub mode: Option<i32>, // Some iff typeof data.mode === 'number' (after the symlink adjustment)
}

pub struct ZipStream {
    pub inner: ZipArchiveOutputStream,
}

impl ZipStream {
    // deps/zip-stream/index.js:42 (super(options); the option handling of 23-47 is TypeScript)
    pub fn new(force_zip64: bool, encryption: Encryption) -> Self {
        ZipStream {
            inner: ZipArchiveOutputStream::new(force_zip64, encryption),
        }
    }

    // deps/zip-stream/index.js:114-116, 126-136, 140-145, 149
    pub fn entry(
        &mut self,
        source: Source,
        data: &ZipEntryData,
        opts: &EntryOptions,
    ) -> Result<EntryStatus, ZipError> {
        if data.name.is_empty() {
            return Err(ZipError::EntryNameRequired);
        }
        let mut entry = ZipArchiveEntry::new(Some(&data.name));
        entry.set_time(&data.date);
        if data.name_prepend_slash {
            entry.set_name(&data.name, true);
        }
        if data.store {
            entry.set_method(0);
        }
        if !data.comment.is_empty() {
            entry.set_comment(&data.comment);
        }
        if let Some(mode) = data.mode {
            entry.set_unix_mode(mode);
        }
        self.inner.entry(entry, source, opts, &data.date)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::zip::constants::{METHOD_DEFLATED, METHOD_STORED, PLATFORM_FAT, PLATFORM_UNIX};

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

    fn opts() -> EntryOptions {
        EntryOptions {
            level: 6,
            key: Vec::new(),
            random: Vec::new(),
        }
    }

    // Expected values were read from upstream by replaying index.js:126-145 on
    // compress-commons 7.0.1 ZipArchiveEntry with data.name 'c:c:/x/'.
    #[test]
    fn entry_replay_order() {
        let mut zip = ZipStream::new(false, Encryption::None);
        let data = ZipEntryData {
            name: "c:c:/x/".to_owned(),
            date: date(),
            name_prepend_slash: true,
            store: true,
            comment: "ü".to_owned(),
            mode: Some(493),
        };
        let status = zip
            .entry(
                Source::Buffer {
                    len: 5,
                    crc: 0x3610a686,
                },
                &data,
                &opts(),
            )
            .unwrap();
        assert_eq!(status, EntryStatus::StoredBuffer);

        let entry = zip.inner._entry.as_ref().unwrap();
        // :126 sanitizes data.name to 'c:/x/'; :129 sanitizes data.name again, not the
        // stored name, and prepends the slash afterwards.
        assert_eq!(entry.get_name(), Some("/c:/x/"));
        assert_eq!(entry.get_time_dos(), 1109619539);
        assert_eq!(entry.get_method(), METHOD_STORED);
        assert_eq!(entry.get_comment(), "ü");
        assert!(entry.get_general_purpose_bit().utf8);
        // :144 runs last and reads isDirectory() of the final name.
        assert_eq!(entry.get_platform(), PLATFORM_UNIX);
        assert_eq!(entry.get_external_attributes(), 1106051088);
        assert_eq!(entry.mode, Some(493));
        assert_eq!(entry.get_size(), 5);
        assert_eq!(entry.get_compressed_size(), 5);
        assert_eq!(entry.get_crc(), 0x3610a686);
    }

    #[test]
    fn entry_without_optional_steps() {
        let mut zip = ZipStream::new(false, Encryption::None);
        let data = ZipEntryData {
            name: "c:c:/x".to_owned(),
            date: date(),
            name_prepend_slash: false,
            store: false,
            comment: String::new(),
            mode: None,
        };
        let status = zip.entry(Source::Stream, &data, &opts()).unwrap();
        assert_eq!(status, EntryStatus::OpenDeflated);

        let entry = zip.inner._entry.as_ref().unwrap();
        assert_eq!(entry.get_name(), Some("c:/x"));
        assert_eq!(entry.get_time_dos(), 1109619539);
        assert_eq!(entry.get_method(), METHOD_DEFLATED);
        assert_eq!(entry.get_comment(), "");
        assert!(!entry.get_general_purpose_bit().utf8);
        assert_eq!(entry.get_platform(), PLATFORM_FAT);
        assert_eq!(entry.get_external_attributes(), 0);
        assert_eq!(entry.mode, None);
    }

    #[test]
    fn empty_name_is_rejected_before_the_writer_is_touched() {
        let mut zip = ZipStream::new(false, Encryption::None);
        let data = ZipEntryData {
            name: String::new(),
            date: date(),
            name_prepend_slash: true,
            store: true,
            comment: String::new(),
            mode: Some(420),
        };
        let err = zip.entry(Source::Stream, &data, &opts()).unwrap_err();
        assert_eq!(err, ZipError::EntryNameRequired);
        assert_eq!(
            err.to_string(),
            "entry name must be a non-empty string value"
        );
        assert!(zip.inner._entry.is_none());
        assert!(!zip.inner._archive.processing);
        assert_eq!(zip.inner.offset, 0);
    }
}
