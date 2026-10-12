// Port of deps/compress-commons/lib/archivers/zip/general-purpose-bit.js.
use super::util::get_short_bytes;

const DATA_DESCRIPTOR_FLAG: u16 = 1 << 3;
const ENCRYPTION_FLAG: u16 = 1 << 0;
const UFT8_NAMES_FLAG: u16 = 1 << 11;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GeneralPurposeBit {
    pub descriptor: bool,
    pub encryption: bool,
    pub utf8: bool,
}

impl GeneralPurposeBit {
    // deps/compress-commons/lib/archivers/zip/general-purpose-bit.js:11-19
    pub fn new() -> Self {
        GeneralPurposeBit {
            descriptor: false,
            encryption: false,
            utf8: false,
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
                | (if self.encryption { ENCRYPTION_FLAG } else { 0 })) as u64,
        )
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

    // deps/compress-commons/lib/archivers/zip/general-purpose-bit.js:73-75
    pub fn use_utf8_for_names(&mut self, b: bool) {
        self.utf8 = b;
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
    }

    #[test]
    fn new_defaults() {
        let gpb = GeneralPurposeBit::new();
        assert!(!gpb.uses_data_descriptor());
        assert!(!gpb.encryption);
        assert!(!gpb.utf8);
    }
}
