// Port of deps/compress-commons/lib/archivers/zip/general-purpose-bit.js.
use super::util::{get_short_bytes, get_short_bytes_value};

const DATA_DESCRIPTOR_FLAG: u16 = 1 << 3;
const ENCRYPTION_FLAG: u16 = 1 << 0;
const NUMBER_OF_SHANNON_FANO_TREES_FLAG: u16 = 1 << 2;
const SLIDING_DICTIONARY_SIZE_FLAG: u16 = 1 << 1;
const STRONG_ENCRYPTION_FLAG: u16 = 1 << 6;
const UFT8_NAMES_FLAG: u16 = 1 << 11;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GeneralPurposeBit {
    pub descriptor: bool,
    pub encryption: bool,
    pub utf8: bool,
    pub number_of_shannon_fano_trees: u32,
    pub strong_encryption: bool,
    pub sliding_dictionary_size: u32,
}

impl GeneralPurposeBit {
    // deps/compress-commons/lib/archivers/zip/general-purpose-bit.js:11-19
    pub fn new() -> Self {
        GeneralPurposeBit {
            descriptor: false,
            encryption: false,
            utf8: false,
            number_of_shannon_fano_trees: 0,
            strong_encryption: false,
            sliding_dictionary_size: 0,
        }
    }

    // deps/compress-commons/lib/archivers/zip/general-purpose-bit.js:20-27
    pub fn encode(&self) -> [u8; 2] {
        get_short_bytes(
            ((if self.descriptor {
                DATA_DESCRIPTOR_FLAG
            } else {
                0
            }) | (if self.utf8 { UFT8_NAMES_FLAG } else { 0 })
                | (if self.encryption { ENCRYPTION_FLAG } else { 0 })
                | (if self.strong_encryption {
                    STRONG_ENCRYPTION_FLAG
                } else {
                    0
                })) as u64,
        )
    }

    // deps/compress-commons/lib/archivers/zip/general-purpose-bit.js:28-42
    pub fn parse(buf: &[u8], offset: usize) -> Option<GeneralPurposeBit> {
        let flag = get_short_bytes_value(buf, offset)?;
        let mut gbp = GeneralPurposeBit::new();
        gbp.use_data_descriptor((flag & DATA_DESCRIPTOR_FLAG) != 0);
        gbp.use_utf8_for_names((flag & UFT8_NAMES_FLAG) != 0);
        gbp.use_strong_encryption((flag & STRONG_ENCRYPTION_FLAG) != 0);
        gbp.use_encryption((flag & ENCRYPTION_FLAG) != 0);
        gbp.set_sliding_dictionary_size(if (flag & SLIDING_DICTIONARY_SIZE_FLAG) != 0 {
            8192
        } else {
            4096
        });
        gbp.set_number_of_shannon_fano_trees(if (flag & NUMBER_OF_SHANNON_FANO_TREES_FLAG) != 0 {
            3
        } else {
            2
        });
        Some(gbp)
    }

    // deps/compress-commons/lib/archivers/zip/general-purpose-bit.js:43-45
    pub fn set_number_of_shannon_fano_trees(&mut self, n: u32) {
        self.number_of_shannon_fano_trees = n;
    }

    // deps/compress-commons/lib/archivers/zip/general-purpose-bit.js:46-48
    pub fn get_number_of_shannon_fano_trees(&self) -> u32 {
        self.number_of_shannon_fano_trees
    }

    // deps/compress-commons/lib/archivers/zip/general-purpose-bit.js:49-51
    pub fn set_sliding_dictionary_size(&mut self, n: u32) {
        self.sliding_dictionary_size = n;
    }

    // deps/compress-commons/lib/archivers/zip/general-purpose-bit.js:52-54
    pub fn get_sliding_dictionary_size(&self) -> u32 {
        self.sliding_dictionary_size
    }

    // deps/compress-commons/lib/archivers/zip/general-purpose-bit.js:55-57
    pub fn use_data_descriptor(&mut self, b: bool) {
        self.descriptor = b;
    }

    // deps/compress-commons/lib/archivers/zip/general-purpose-bit.js:58-60
    pub fn uses_data_descriptor(&self) -> bool {
        self.descriptor
    }

    // deps/compress-commons/lib/archivers/zip/general-purpose-bit.js:61-63
    pub fn use_encryption(&mut self, b: bool) {
        self.encryption = b;
    }

    // deps/compress-commons/lib/archivers/zip/general-purpose-bit.js:64-66
    pub fn uses_encryption(&self) -> bool {
        self.encryption
    }

    // deps/compress-commons/lib/archivers/zip/general-purpose-bit.js:67-69
    pub fn use_strong_encryption(&mut self, b: bool) {
        self.strong_encryption = b;
    }

    // deps/compress-commons/lib/archivers/zip/general-purpose-bit.js:70-72
    pub fn uses_strong_encryption(&self) -> bool {
        self.strong_encryption
    }

    // deps/compress-commons/lib/archivers/zip/general-purpose-bit.js:73-75
    pub fn use_utf8_for_names(&mut self, b: bool) {
        self.utf8 = b;
    }

    // deps/compress-commons/lib/archivers/zip/general-purpose-bit.js:76-78
    pub fn uses_utf8_for_names(&self) -> bool {
        self.utf8
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn encode_bits() {
        let mut gpb = GeneralPurposeBit::new();
        assert_eq!(gpb.encode(), [0x00, 0x00]);

        gpb.use_data_descriptor(true);
        assert_eq!(gpb.encode(), [0x08, 0x00]);

        let mut gpb = GeneralPurposeBit::new();
        gpb.use_utf8_for_names(true);
        assert_eq!(gpb.encode(), [0x00, 0x08]);

        let mut gpb = GeneralPurposeBit::new();
        gpb.use_encryption(true);
        assert_eq!(gpb.encode(), [0x01, 0x00]);

        let mut gpb = GeneralPurposeBit::new();
        gpb.use_data_descriptor(true);
        gpb.use_utf8_for_names(true);
        assert_eq!(gpb.encode(), [0x08, 0x08]);

        let mut gpb = GeneralPurposeBit::new();
        gpb.use_data_descriptor(true);
        gpb.use_encryption(true);
        assert_eq!(gpb.encode(), [0x09, 0x00]);

        let mut gpb = GeneralPurposeBit::new();
        gpb.use_utf8_for_names(true);
        gpb.use_encryption(true);
        assert_eq!(gpb.encode(), [0x01, 0x08]);

        let mut gpb = GeneralPurposeBit::new();
        gpb.use_data_descriptor(true);
        gpb.use_utf8_for_names(true);
        gpb.use_encryption(true);
        assert_eq!(gpb.encode(), [0x09, 0x08]);

        gpb.use_strong_encryption(true);
        assert_eq!(gpb.encode(), [0x49, 0x08]);
    }

    #[test]
    fn encode_never_emits_bits_1_and_2() {
        let mut gpb = GeneralPurposeBit::new();
        gpb.set_sliding_dictionary_size(8192);
        gpb.set_number_of_shannon_fano_trees(3);
        assert_eq!(gpb.encode(), [0x00, 0x00]);
    }

    #[test]
    fn new_defaults() {
        let gpb = GeneralPurposeBit::new();
        assert!(!gpb.uses_data_descriptor());
        assert!(!gpb.uses_encryption());
        assert!(!gpb.uses_utf8_for_names());
        assert!(!gpb.uses_strong_encryption());
        assert_eq!(gpb.get_number_of_shannon_fano_trees(), 0);
        assert_eq!(gpb.get_sliding_dictionary_size(), 0);
    }

    #[test]
    fn parse_reads_flags_at_offset() {
        let gpb = GeneralPurposeBit::parse(&[0xaa, 0x4f, 0x08], 1).unwrap();
        assert!(gpb.uses_data_descriptor());
        assert!(gpb.uses_utf8_for_names());
        assert!(gpb.uses_strong_encryption());
        assert!(gpb.uses_encryption());
        assert_eq!(gpb.get_sliding_dictionary_size(), 8192);
        assert_eq!(gpb.get_number_of_shannon_fano_trees(), 3);
        assert_eq!(gpb.encode(), [0x49, 0x08]);

        let gpb = GeneralPurposeBit::parse(&[0x00, 0x00], 0).unwrap();
        assert!(!gpb.uses_data_descriptor());
        assert!(!gpb.uses_utf8_for_names());
        assert!(!gpb.uses_strong_encryption());
        assert!(!gpb.uses_encryption());
        assert_eq!(gpb.get_sliding_dictionary_size(), 4096);
        assert_eq!(gpb.get_number_of_shannon_fano_trees(), 2);
    }

    #[test]
    fn parse_out_of_range_is_none() {
        assert_eq!(GeneralPurposeBit::parse(&[0x08], 0), None);
        assert_eq!(GeneralPurposeBit::parse(&[0x08, 0x00], 1), None);
        assert_eq!(GeneralPurposeBit::parse(&[], usize::MAX), None);
    }
}
