// Port of archiver-zip-encrypted/lib/zip20/crc.js.

// archiver-zip-encrypted/lib/zip20/crc.js:4-15
pub const CRC_TABLE: [u32; 256] = build_crc_table();

// archiver-zip-encrypted/lib/zip20/crc.js:5-15 (the loop that fills CRC_TABLE at module load)
const fn build_crc_table() -> [u32; 256] {
    let mut table = [0u32; 256];
    let mut i = 0;
    while i < 256 {
        let mut r = i as u32;
        let mut j = 0;
        while j < 8 {
            if (r & 1) == 1 {
                r = (r >> 1) ^ 0xedb88320;
            } else {
                r >>= 1;
            }
            j += 1;
        }
        table[i] = r;
        i += 1;
    }
    table
}

// archiver-zip-encrypted/lib/zip20/crc.js:17-19
pub fn crc32(old_crc: u32, char_at: u8) -> u32 {
    (old_crc >> 8) ^ CRC_TABLE[((old_crc ^ char_at as u32) & 0xff) as usize]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn table_spot_values() {
        assert_eq!(CRC_TABLE[0], 0);
        assert_eq!(CRC_TABLE[1], 0x77073096);
        assert_eq!(CRC_TABLE[255], 0x2d02ef8d);
    }

    // Expected values were read from upstream by calling lib/zip20/crc.js under node.
    #[test]
    fn crc32_single_byte_without_inversion() {
        assert_eq!(crc32(0x12345678, 0x31), 0x0f12cd62);
        assert_eq!(crc32(0, 0), 0);
        assert_eq!(crc32(0xffffffff, 0xff), 0x00ffffff);
        assert_eq!(crc32(0x80000000, 1), 0x77873096);
    }
}
