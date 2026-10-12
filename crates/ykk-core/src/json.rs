// Port of the byte-derived part of node-archiver/lib/plugins/json.js (lines 59-60).

use crate::crc32;

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct JsonEntry {
    pub crc32: u32,
    pub size: u64,
}

// node-archiver/lib/plugins/json.js:59-60
pub fn append(entry: JsonEntry, chunk: &[u8]) -> JsonEntry {
    JsonEntry {
        crc32: crc32::buf(chunk, entry.crc32),
        size: entry.size + chunk.len() as u64,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn append_slices() {
        let source: Vec<u8> = (0..16384usize).map(|i| (i & 255) as u8).collect();
        let whole = append(JsonEntry::default(), &source);
        assert_eq!(
            whole,
            JsonEntry {
                crc32: 3893830384,
                size: 16384
            }
        );
        assert_eq!(whole.crc32, crc32::buf(&source, 0));
        for split in [0usize, 1, 19, 8192, 16383, 16384] {
            let (a, b) = source.split_at(split);
            let first = append(JsonEntry::default(), a);
            assert_eq!(first.size, a.len() as u64);
            let second = append(first, b);
            assert_eq!(second, whole, "split at {split}");
            assert_eq!(second.size, first.size + b.len() as u64);
        }
    }

    #[test]
    fn append_text_file_and_empty() {
        assert_eq!(
            append(JsonEntry::default(), b"this is a text file"),
            JsonEntry {
                crc32: 585446183,
                size: 19
            }
        );
        assert_eq!(
            append(JsonEntry::default(), &[]),
            JsonEntry { crc32: 0, size: 0 }
        );
    }
}
