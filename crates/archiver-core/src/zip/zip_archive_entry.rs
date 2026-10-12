// Port of deps/compress-commons/lib/archivers/zip/zip-archive-entry.js.
use super::constants::{
    EMPTY, MIN_VERSION_INITIAL, MODE_MASK, PLATFORM_FAT, PLATFORM_UNIX, SHORT_SHIFT, S_DOS_A,
    S_DOS_D, S_IFDIR, S_IFREG, ZIP64_MAGIC,
};
use super::general_purpose_bit::GeneralPurposeBit;
use super::util::{date_to_dos, dos_to_date, DateFields};
use super::utils::sanitize_path;

// deps/compress-commons/lib/archivers/zip/zip-archive-output-stream.js:140-144
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Offsets {
    pub file: u64,
    pub data: u64,
    pub contents: u64,
}

#[derive(Debug, Clone)]
pub struct ZipArchiveEntry {
    pub platform: u8,
    pub method: Option<u16>,
    pub name: Option<String>,
    pub size: u64,
    pub csize: u64,
    pub gpb: GeneralPurposeBit,
    pub crc: u32,
    pub time: Option<u32>,
    pub minver: u16,
    pub mode: Option<u32>,
    pub extra: Option<Vec<u8>>,
    pub exattr: u32,
    pub inattr: u16,
    pub comment: Option<String>,
    pub _offsets: Offsets,
}

impl ZipArchiveEntry {
    // deps/compress-commons/lib/archivers/zip/zip-archive-entry.js:23-42
    pub fn new(name: Option<&str>) -> Self {
        let mut entry = ZipArchiveEntry {
            platform: PLATFORM_FAT,
            method: None,
            name: None,
            size: 0,
            csize: 0,
            gpb: GeneralPurposeBit::new(),
            crc: 0,
            time: None,
            minver: MIN_VERSION_INITIAL,
            mode: None,
            extra: None,
            exattr: 0,
            inattr: 0,
            comment: None,
            _offsets: Offsets::default(),
        };
        if let Some(name) = name.filter(|name| !name.is_empty()) {
            entry.set_name(name, false);
        }
        entry
    }

    // deps/compress-commons/lib/archivers/zip/zip-archive-entry.js:49-51
    pub fn get_central_directory_extra(&self) -> &[u8] {
        self.get_extra()
    }

    // deps/compress-commons/lib/archivers/zip/zip-archive-entry.js:58-60
    pub fn get_comment(&self) -> &str {
        self.comment.as_deref().unwrap_or("")
    }

    // deps/compress-commons/lib/archivers/zip/zip-archive-entry.js:67-69
    pub fn get_compressed_size(&self) -> u64 {
        self.csize
    }

    // deps/compress-commons/lib/archivers/zip/zip-archive-entry.js:76-78
    pub fn get_crc(&self) -> u32 {
        self.crc
    }

    // deps/compress-commons/lib/archivers/zip/zip-archive-entry.js:85-87
    pub fn get_external_attributes(&self) -> u32 {
        self.exattr
    }

    // deps/compress-commons/lib/archivers/zip/zip-archive-entry.js:94-96
    pub fn get_extra(&self) -> &[u8] {
        self.extra.as_deref().unwrap_or(EMPTY)
    }

    // deps/compress-commons/lib/archivers/zip/zip-archive-entry.js:103-105
    pub fn get_general_purpose_bit(&self) -> &GeneralPurposeBit {
        &self.gpb
    }

    // deps/compress-commons/lib/archivers/zip/zip-archive-entry.js:103-105 (the same getter, for callers that mutate the result)
    pub fn get_general_purpose_bit_mut(&mut self) -> &mut GeneralPurposeBit {
        &mut self.gpb
    }

    // deps/compress-commons/lib/archivers/zip/zip-archive-entry.js:112-114
    pub fn get_internal_attributes(&self) -> u16 {
        self.inattr
    }

    // deps/compress-commons/lib/archivers/zip/zip-archive-entry.js:130-132
    pub fn get_local_file_data_extra(&self) -> &[u8] {
        self.get_extra()
    }

    // deps/compress-commons/lib/archivers/zip/zip-archive-entry.js:139-141
    pub fn get_method(&self) -> i32 {
        self.method.map_or(-1, i32::from)
    }

    // deps/compress-commons/lib/archivers/zip/zip-archive-entry.js:148-150
    pub fn get_name(&self) -> Option<&str> {
        self.name.as_deref()
    }

    // deps/compress-commons/lib/archivers/zip/zip-archive-entry.js:157-159
    pub fn get_platform(&self) -> u8 {
        self.platform
    }

    // deps/compress-commons/lib/archivers/zip/zip-archive-entry.js:165-167
    pub fn get_size(&self) -> u64 {
        self.size
    }

    // deps/compress-commons/lib/archivers/zip/zip-archive-entry.js:173-175
    pub fn get_time(&self) -> Option<DateFields> {
        self.time.map(dos_to_date)
    }

    // deps/compress-commons/lib/archivers/zip/zip-archive-entry.js:181-183
    pub fn get_time_dos(&self) -> u32 {
        self.time.unwrap_or(0)
    }

    // deps/compress-commons/lib/archivers/zip/zip-archive-entry.js:199-201
    pub fn get_version_needed_to_extract(&self) -> u16 {
        self.minver
    }

    // deps/compress-commons/lib/archivers/zip/zip-archive-entry.js:207-212
    pub fn set_comment(&mut self, comment: &str) {
        if !comment.is_ascii() {
            self.get_general_purpose_bit_mut().use_utf8_for_names(true);
        }
        self.comment = Some(comment.to_owned());
    }

    // deps/compress-commons/lib/archivers/zip/zip-archive-entry.js:218-223 (PORTING.md V7)
    pub fn set_compressed_size(&mut self, size: u64) {
        self.csize = size;
    }

    // deps/compress-commons/lib/archivers/zip/zip-archive-entry.js:229-234 (PORTING.md V7)
    pub fn set_crc(&mut self, crc: u32) {
        self.crc = crc;
    }

    // deps/compress-commons/lib/archivers/zip/zip-archive-entry.js:240-242
    pub fn set_external_attributes(&mut self, attr: u32) {
        self.exattr = attr;
    }

    // deps/compress-commons/lib/archivers/zip/zip-archive-entry.js:248-250
    pub fn set_extra(&mut self, extra: Vec<u8>) {
        self.extra = Some(extra);
    }

    // deps/compress-commons/lib/archivers/zip/zip-archive-entry.js:275-280 (PORTING.md V7)
    pub fn set_method(&mut self, method: u16) {
        self.method = Some(method);
    }

    // deps/compress-commons/lib/archivers/zip/zip-archive-entry.js:287-298
    pub fn set_name(&mut self, name: &str, prepend_slash: bool) {
        let mut name = sanitize_path(name);
        if prepend_slash {
            name = format!("/{name}");
        }
        if !name.is_ascii() {
            self.get_general_purpose_bit_mut().use_utf8_for_names(true);
        }
        self.name = Some(name);
    }

    // deps/compress-commons/lib/archivers/zip/zip-archive-entry.js:312-317 (PORTING.md V7)
    pub fn set_size(&mut self, size: u64) {
        self.size = size;
    }

    // deps/compress-commons/lib/archivers/zip/zip-archive-entry.js:324-329
    pub fn set_time(&mut self, time: &DateFields) {
        self.time = Some(date_to_dos(time));
    }

    // deps/compress-commons/lib/archivers/zip/zip-archive-entry.js:335-342
    pub fn set_unix_mode(&mut self, mut mode: i32) {
        mode |= if self.is_directory() {
            S_IFDIR
        } else {
            S_IFREG
        };
        let mut extattr: i32 = 0;
        extattr |= (mode << SHORT_SHIFT)
            | (if self.is_directory() {
                S_DOS_D
            } else {
                S_DOS_A
            });
        self.set_external_attributes(extattr as u32);
        self.mode = Some((mode & MODE_MASK) as u32);
        self.platform = PLATFORM_UNIX;
    }

    // deps/compress-commons/lib/archivers/zip/zip-archive-entry.js:348-350
    pub fn set_version_needed_to_extract(&mut self, minver: u16) {
        self.minver = minver;
    }

    // deps/compress-commons/lib/archivers/zip/zip-archive-entry.js:356-358
    pub fn is_directory(&self) -> bool {
        self.get_name().is_some_and(|name| name.ends_with('/'))
    }

    // deps/compress-commons/lib/archivers/zip/zip-archive-entry.js:377-379
    pub fn is_zip64(&self) -> bool {
        self.csize > ZIP64_MAGIC || self.size > ZIP64_MAGIC
    }
}

// Every expected value in this module was read from compress-commons 7.0.1 by running
// the upstream class under node.
#[cfg(test)]
mod tests {
    use super::*;

    fn with_mode(name: &str, mode: i32) -> ZipArchiveEntry {
        let mut entry = ZipArchiveEntry::new(Some(name));
        entry.set_unix_mode(mode);
        entry
    }

    #[test]
    fn unix_mode_exattr() {
        // file 0644
        let entry = with_mode("a.txt", 420);
        assert_eq!(entry.get_external_attributes(), 0x81A40020);
        assert_eq!(entry.get_external_attributes(), 2175008800);
        assert_eq!(entry.mode, Some(420));
        assert_eq!(entry.get_platform(), PLATFORM_UNIX);

        // file 0777
        let entry = with_mode("executable.sh", 511);
        assert_eq!(entry.get_external_attributes(), 0x81FF0020);
        assert_eq!(entry.get_external_attributes(), 2180972576);
        assert_eq!((entry.get_external_attributes() >> 16) & 0xfff, 511);
        assert_eq!(entry.mode, Some(511));

        // directory 0755
        let entry = with_mode("directory/subdir/", 493);
        assert_eq!(entry.get_external_attributes(), 0x41ED0010);
        assert_eq!(entry.get_external_attributes(), 1106051088);
        assert_eq!((entry.get_external_attributes() >> 16) & 0xfff, 493);
        assert_eq!(entry.mode, Some(493));

        // symlink with no permission bits
        let entry = with_mode("manual-link.txt", 40960);
        assert_eq!(entry.get_external_attributes(), 0xA0000020);
        assert_eq!(entry.get_external_attributes(), 2684354592);
        assert_eq!(entry.mode, Some(0));
    }

    #[test]
    fn unix_mode_type_bits_are_or_ed_and_shift_is_32_bit() {
        // a symlink named like a directory: 0xA000 | 0x4000, DOS directory bit
        let entry = with_mode("x/", 40960);
        assert_eq!(entry.get_external_attributes(), 3758096400);

        // setuid survives in `mode`
        let entry = with_mode("a", 0o104755);
        assert_eq!(entry.get_external_attributes(), 2314010656);
        assert_eq!(entry.mode, Some(2541));

        let entry = with_mode("a", -1);
        assert_eq!(entry.get_external_attributes(), 4294901792);
        assert_eq!(entry.mode, Some(4095));

        // bits above the low 16 fall off the top of the shift
        let entry = with_mode("a", 65536 + 420);
        assert_eq!(entry.get_external_attributes(), 2175008800);
        assert_eq!(entry.mode, Some(420));
    }

    #[test]
    fn constructor_defaults() {
        let entry = ZipArchiveEntry::new(Some("a"));
        assert_eq!(entry.get_platform(), PLATFORM_FAT);
        assert_eq!(entry.method, None);
        assert_eq!(entry.get_method(), -1);
        assert_eq!(entry.get_name(), Some("a"));
        assert_eq!(entry.get_size(), 0);
        assert_eq!(entry.get_compressed_size(), 0);
        assert_eq!(*entry.get_general_purpose_bit(), GeneralPurposeBit::new());
        assert_eq!(entry.get_crc(), 0);
        assert_eq!(entry.time, None);
        assert_eq!(entry.get_time(), None);
        assert_eq!(entry.get_time_dos(), 0);
        assert_eq!(entry.get_version_needed_to_extract(), 10);
        assert_eq!(entry.mode, None);
        assert_eq!(entry.extra, None);
        assert_eq!(entry.get_extra(), EMPTY);
        assert_eq!(entry.get_local_file_data_extra(), EMPTY);
        assert_eq!(entry.get_central_directory_extra(), EMPTY);
        assert_eq!(entry.get_external_attributes(), 0);
        assert_eq!(entry.get_internal_attributes(), 0);
        assert_eq!(entry.comment, None);
        assert_eq!(entry.get_comment(), "");
        assert_eq!(entry._offsets, Offsets::default());
        assert!(!entry.is_zip64());
        assert!(!entry.is_directory());
    }

    #[test]
    fn constructor_name_truthiness() {
        // `if (name)`: no name and '' both leave the name null
        assert_eq!(ZipArchiveEntry::new(None).get_name(), None);
        assert_eq!(ZipArchiveEntry::new(Some("")).get_name(), None);
        assert!(!ZipArchiveEntry::new(None).is_directory());
        // a truthy name that sanitizes to '' is stored as ''
        assert_eq!(ZipArchiveEntry::new(Some("C:")).get_name(), Some(""));
    }

    // [input, name after new ZipArchiveEntry(input), name after setName(input, true)]
    const NAMES: &[(&str, &str, &str)] = &[
        ("c:c:/x", "c:/x", "/c:/x"),
        ("\\\\?\\C:\\foo", "?/C:/foo", "/?/C:/foo"),
        ("../../a/../b", "a/../b", "/a/../b"),
        ("é.txt", "é.txt", "/é.txt"),
        ("/abs//p\\q/", "abs/p/q/", "/abs/p/q/"),
        ("C:", "", "/"),
    ];

    #[test]
    fn set_name_vectors() {
        for &(input, plain, slashed) in NAMES {
            let entry = ZipArchiveEntry::new(Some(input));
            assert_eq!(entry.get_name(), Some(plain), "{input:?}");
            assert_eq!(
                entry.get_general_purpose_bit().utf8,
                !plain.is_ascii(),
                "{input:?}"
            );

            let mut entry = ZipArchiveEntry::new(None);
            entry.set_name(input, true);
            assert_eq!(entry.get_name(), Some(slashed), "{input:?}");
            assert_eq!(
                entry.get_general_purpose_bit().utf8,
                !slashed.is_ascii(),
                "{input:?}"
            );
        }

        let mut entry = ZipArchiveEntry::new(None);
        entry.set_name("", true);
        assert_eq!(entry.get_name(), Some("/"));
        assert!(entry.is_directory());
    }

    #[test]
    fn utf8_flag_is_sticky() {
        let mut entry = ZipArchiveEntry::new(Some("é"));
        entry.set_name("a", false);
        assert_eq!(entry.get_name(), Some("a"));
        assert!(entry.get_general_purpose_bit().utf8);

        let mut entry = ZipArchiveEntry::new(Some("a"));
        assert!(!entry.get_general_purpose_bit().utf8);
        entry.set_comment("ü");
        assert_eq!(entry.get_comment(), "ü");
        assert!(entry.get_general_purpose_bit().utf8);
        entry.set_comment("x");
        assert_eq!(entry.get_comment(), "x");
        assert!(entry.get_general_purpose_bit().utf8);
    }

    #[test]
    fn time_roundtrip() {
        let mut entry = ZipArchiveEntry::new(Some("a"));
        entry.set_time(&DateFields {
            year: 2013.0,
            month: 0.0,
            date: 3.0,
            hours: 14.0,
            minutes: 26.0,
            seconds: 38.0,
        });
        assert_eq!(entry.time, Some(1109619539));
        assert_eq!(entry.get_time_dos(), 1109619539);
        assert_eq!(entry.get_time_dos().to_le_bytes(), [0x53, 0x73, 0x23, 0x42]);
        let expected = Some(DateFields {
            year: 2013.0,
            month: 0.0,
            date: 3.0,
            hours: 14.0,
            minutes: 26.0,
            seconds: 38.0,
        });
        assert_eq!(entry.get_time(), expected);

        // an Invalid Date is accepted and packs to 0, which is a set time
        entry.set_time(&DateFields {
            year: f64::NAN,
            month: f64::NAN,
            date: f64::NAN,
            hours: f64::NAN,
            minutes: f64::NAN,
            seconds: f64::NAN,
        });
        assert_eq!(entry.time, Some(0));
        assert_eq!(entry.get_time_dos(), 0);
        assert!(entry.get_time().is_some());
    }

    #[test]
    fn zip64_is_strictly_greater() {
        let mut entry = ZipArchiveEntry::new(Some("a"));
        entry.set_size(0xffffffff);
        assert!(!entry.is_zip64());
        entry.set_size(0x100000000);
        assert!(entry.is_zip64());
        entry.set_size(0);
        entry.set_compressed_size(0xffffffff);
        assert!(!entry.is_zip64());
        entry.set_compressed_size(0x100000000);
        assert!(entry.is_zip64());
        assert_eq!(entry.get_compressed_size(), 0x100000000);
    }

    #[test]
    fn plain_setters() {
        let mut entry = ZipArchiveEntry::new(Some("a"));
        entry.set_method(8);
        assert_eq!(entry.get_method(), 8);
        entry.set_method(99);
        assert_eq!(entry.get_method(), 99);
        entry.set_crc(0xffffffff);
        assert_eq!(entry.get_crc(), 4294967295);
        entry.set_version_needed_to_extract(45);
        assert_eq!(entry.get_version_needed_to_extract(), 45);
        entry.set_extra(vec![1, 0, 0, 0]);
        assert_eq!(entry.get_extra(), [1, 0, 0, 0]);
        assert_eq!(entry.get_local_file_data_extra(), [1, 0, 0, 0]);
        assert_eq!(entry.get_central_directory_extra(), [1, 0, 0, 0]);

        entry
            .get_general_purpose_bit_mut()
            .use_data_descriptor(true);
        assert!(entry.get_general_purpose_bit().uses_data_descriptor());
        entry.get_general_purpose_bit_mut().use_encryption(true);
        assert!(entry.get_general_purpose_bit().encryption);
    }
}
