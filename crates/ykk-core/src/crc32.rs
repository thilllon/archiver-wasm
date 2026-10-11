// Port of deps/crc-32/crc32.js (buf) and
// node-archiver/node_modules/buffer-crc32/dist/index.cjs (unsigned).

// deps/crc-32/crc32.js:70-82 (PORTING.md R8)
pub fn buf(b: &[u8], seed: u32) -> u32 {
    let mut hasher = crc32fast::Hasher::new_with_initial(seed);
    hasher.update(b);
    hasher.finalize()
}

// node-archiver/node_modules/buffer-crc32/dist/index.cjs:299-301
pub fn unsigned(buf: &[u8]) -> u32 {
    self::buf(buf, 0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn buf_16384_pattern() {
        let b: Vec<u8> = (0..16384usize).map(|i| (i & 255) as u8).collect();
        assert_eq!(buf(&b, 0), 3893830384);
        assert_eq!(unsigned(&b), 3893830384);
    }

    #[test]
    fn buf_text_file() {
        assert_eq!(buf(b"this is a text file", 0), 585446183);
        assert_eq!(buf(b"test", 0), 3632233996);
        assert_eq!(unsigned(b"this is a text file"), 585446183);
        assert_eq!(unsigned(b"test"), 3632233996);
    }

    #[test]
    fn buf_seed_chaining() {
        let x: Vec<u8> = (0..300usize)
            .map(|i| (i.wrapping_mul(31).wrapping_add(7) & 255) as u8)
            .collect();
        let whole = buf(&x, 0);
        for split in 0..=x.len() {
            let (a, b) = x.split_at(split);
            assert_eq!(buf(b, buf(a, 0)), whole, "split at {split}");
        }
        assert_eq!(unsigned(&x), buf(&x, 0));
    }

    #[test]
    fn buf_empty() {
        assert_eq!(buf(&[], 0), 0);
        assert_eq!(unsigned(&[]), 0);
        assert_eq!(buf(&[], 585446183), 585446183);
    }
}
