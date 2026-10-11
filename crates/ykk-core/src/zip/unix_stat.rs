// Port of deps/compress-commons/lib/archivers/zip/unix-stat.js:1-8.
pub const PERM_MASK: u32 = 4095;
pub const FILE_TYPE_FLAG: u32 = 61440;
pub const LINK_FLAG: u32 = 40960;
pub const FILE_FLAG: u32 = 32768;
pub const DIR_FLAG: u32 = 16384;
pub const DEFAULT_LINK_PERM: u32 = 511;
pub const DEFAULT_DIR_PERM: u32 = 493;
pub const DEFAULT_FILE_PERM: u32 = 420; // 0644

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn octal_values() {
        assert_eq!(PERM_MASK, 0o7777);
        assert_eq!(FILE_TYPE_FLAG, 0o170000);
        assert_eq!(LINK_FLAG, 0o120000);
        assert_eq!(FILE_FLAG, 0o100000);
        assert_eq!(DIR_FLAG, 0o040000);
        assert_eq!(DEFAULT_LINK_PERM, 0o777);
        assert_eq!(DEFAULT_DIR_PERM, 0o755);
        assert_eq!(DEFAULT_FILE_PERM, 0o644);
    }
}
