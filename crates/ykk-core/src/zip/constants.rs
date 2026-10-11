// Port of deps/compress-commons/lib/archivers/zip/constants.js:1-49.
pub const WORD: usize = 4;
pub const DWORD: usize = 8;
pub const EMPTY: &[u8] = &[];
pub const SHORT: usize = 2;
pub const SHORT_MASK: u32 = 0xffff;
pub const SHORT_SHIFT: u32 = 16;
pub const SHORT_ZERO: [u8; 2] = [0; 2];
pub const LONG: usize = 4;
pub const LONG_ZERO: [u8; 4] = [0; 4];
pub const MIN_VERSION_INITIAL: u16 = 10;
pub const MIN_VERSION_DATA_DESCRIPTOR: u16 = 20;
pub const MIN_VERSION_ZIP64: u16 = 45;
pub const VERSION_MADEBY: u16 = 45;
pub const METHOD_STORED: i32 = 0;
pub const METHOD_DEFLATED: i32 = 8;
pub const PLATFORM_UNIX: u8 = 3;
pub const PLATFORM_FAT: u8 = 0;
pub const SIG_LFH: u32 = 0x04034b50;
pub const SIG_DD: u32 = 0x08074b50;
pub const SIG_CFH: u32 = 0x02014b50;
pub const SIG_EOCD: u32 = 0x06054b50;
pub const SIG_ZIP64_EOCD: u32 = 0x06064b50;
pub const SIG_ZIP64_EOCD_LOC: u32 = 0x07064b50;
pub const ZIP64_MAGIC_SHORT: u64 = 0xffff;
pub const ZIP64_MAGIC: u64 = 0xffffffff;
pub const ZIP64_EXTRA_ID: u16 = 0x0001;
pub const ZLIB_NO_COMPRESSION: i32 = 0;
pub const ZLIB_BEST_SPEED: i32 = 1;
pub const ZLIB_BEST_COMPRESSION: i32 = 9;
pub const ZLIB_DEFAULT_COMPRESSION: i32 = -1;
pub const MODE_MASK: i32 = 0xfff;
pub const DEFAULT_FILE_MODE: i32 = 33188;
pub const DEFAULT_DIR_MODE: i32 = 16877;
pub const EXT_FILE_ATTR_DIR: u32 = 1106051088;
pub const EXT_FILE_ATTR_FILE: u32 = 2175008800;
pub const S_IFMT: i32 = 61440;
pub const S_IFIFO: i32 = 4096;
pub const S_IFCHR: i32 = 8192;
pub const S_IFDIR: i32 = 16384;
pub const S_IFBLK: i32 = 24576;
pub const S_IFREG: i32 = 32768;
pub const S_IFLNK: i32 = 40960;
pub const S_IFSOCK: i32 = 49152;
pub const S_DOS_A: i32 = 32;
pub const S_DOS_D: i32 = 16;
pub const S_DOS_V: i32 = 8;
pub const S_DOS_S: i32 = 4;
pub const S_DOS_H: i32 = 2;
pub const S_DOS_R: i32 = 1; // 01 Read Only

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn widths_and_zero_buffers() {
        assert_eq!((WORD, DWORD, SHORT, LONG), (4, 8, 2, 4));
        assert_eq!(EMPTY.len(), 0);
        assert_eq!(SHORT_ZERO, [0u8, 0]);
        assert_eq!(LONG_ZERO, [0u8, 0, 0, 0]);
        assert_eq!((SHORT_MASK, SHORT_SHIFT), (65535, 16));
    }

    #[test]
    fn signatures_are_pk_records() {
        assert_eq!(SIG_LFH.to_le_bytes(), *b"PK\x03\x04");
        assert_eq!(SIG_DD.to_le_bytes(), *b"PK\x07\x08");
        assert_eq!(SIG_CFH.to_le_bytes(), *b"PK\x01\x02");
        assert_eq!(SIG_EOCD.to_le_bytes(), *b"PK\x05\x06");
        assert_eq!(SIG_ZIP64_EOCD.to_le_bytes(), *b"PK\x06\x06");
        assert_eq!(SIG_ZIP64_EOCD_LOC.to_le_bytes(), *b"PK\x06\x07");
    }

    #[test]
    fn versions_methods_platforms_and_zip64() {
        assert_eq!(MIN_VERSION_INITIAL, 10);
        assert_eq!(MIN_VERSION_DATA_DESCRIPTOR, 20);
        assert_eq!(MIN_VERSION_ZIP64, 45);
        assert_eq!(VERSION_MADEBY, 45);
        assert_eq!((METHOD_STORED, METHOD_DEFLATED), (0, 8));
        assert_eq!((PLATFORM_UNIX, PLATFORM_FAT), (3, 0));
        assert_eq!(ZIP64_MAGIC_SHORT, 65535);
        assert_eq!(ZIP64_MAGIC, 4294967295);
        assert_eq!(ZIP64_EXTRA_ID, 1);
        assert_eq!(ZLIB_NO_COMPRESSION, 0);
        assert_eq!(ZLIB_BEST_SPEED, 1);
        assert_eq!(ZLIB_BEST_COMPRESSION, 9);
        assert_eq!(ZLIB_DEFAULT_COMPRESSION, -1);
    }

    #[test]
    fn modes_and_attributes() {
        assert_eq!(MODE_MASK, 4095);
        assert_eq!(DEFAULT_FILE_MODE, 0o100644);
        assert_eq!(DEFAULT_DIR_MODE, 0o40755);
        assert_eq!(EXT_FILE_ATTR_DIR, 0x41ED0010);
        assert_eq!(EXT_FILE_ATTR_FILE, 0x81A40020);
        assert_eq!(S_IFMT, 0o170000);
        assert_eq!(S_IFIFO, 0o010000);
        assert_eq!(S_IFCHR, 0o020000);
        assert_eq!(S_IFDIR, 0o040000);
        assert_eq!(S_IFBLK, 0o060000);
        assert_eq!(S_IFREG, 0o100000);
        assert_eq!(S_IFLNK, 0o120000);
        assert_eq!(S_IFSOCK, 0o140000);
        assert_eq!(
            [S_DOS_A, S_DOS_D, S_DOS_V, S_DOS_S, S_DOS_H, S_DOS_R],
            [32, 16, 8, 4, 2, 1]
        );
    }
}
