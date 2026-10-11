// Port of deps/crc32-stream/lib/crc32-stream.js, deflate-crc32-stream.js and index.js.

use flate2::{Compress, Compression, FlushCompress, Status};

use crate::crc32;
use crate::error::DeflateError;

const DEFLATE_SPARE: usize = 32 * 1024;

// deps/crc32-stream/lib/deflate-crc32-stream.js:6 (zlib level given to zlib.DeflateRaw), PORTING.md 6.4
pub fn zlib_level(level: i32) -> Compression {
    if level < 0 {
        Compression::new(6)
    } else if level > 9 {
        Compression::new(9)
    } else {
        Compression::new(level as u32)
    }
}

// deps/crc32-stream/lib/deflate-crc32-stream.js:23 (zlib write loop behind DeflateRaw and createGzip), PORTING.md 6.4
pub(crate) fn deflate(
    compress: &mut Compress,
    mut input: &[u8],
    out: &mut Vec<u8>,
    flush: FlushCompress,
) -> Result<(), DeflateError> {
    loop {
        out.reserve(DEFLATE_SPARE);
        let total_in = compress.total_in();
        let produced = out.len();
        let status = compress
            .compress_vec(input, out, flush)
            .map_err(|e| DeflateError(e.to_string()))?;
        let consumed = (compress.total_in() - total_in) as usize;
        input = input.get(consumed..).unwrap_or(&[]);
        let ended = match flush {
            FlushCompress::Finish => matches!(status, Status::StreamEnd),
            _ => out.len() < out.capacity(),
        };
        if input.is_empty() && ended {
            return Ok(());
        }
        if consumed == 0 && out.len() == produced {
            return Err(DeflateError("no progress".to_string()));
        }
    }
}

// deps/crc32-stream/lib/crc32-stream.js:4
pub struct CRC32Stream {
    pub checksum: u32,
    pub raw_size: u64,
}

impl CRC32Stream {
    // deps/crc32-stream/lib/crc32-stream.js:5-10
    pub fn new() -> Self {
        CRC32Stream {
            checksum: 0,
            raw_size: 0,
        }
    }

    // deps/crc32-stream/lib/crc32-stream.js:11-17
    pub fn _transform(&mut self, chunk: &[u8], out: &mut Vec<u8>) {
        self.checksum = crc32::buf(chunk, self.checksum);
        self.raw_size += chunk.len() as u64;
        out.extend_from_slice(chunk);
    }

    // deps/crc32-stream/lib/crc32-stream.js:18-22
    pub fn digest(&self) -> [u8; 4] {
        self.checksum.to_be_bytes()
    }

    // deps/crc32-stream/lib/crc32-stream.js:23-25
    pub fn hex(&self) -> String {
        format!("{:08X}", self.checksum)
    }

    // deps/crc32-stream/lib/crc32-stream.js:26-28
    pub fn size(&self, _compressed: bool) -> u64 {
        self.raw_size
    }
}

// deps/crc32-stream/lib/deflate-crc32-stream.js:4
pub struct DeflateCRC32Stream {
    compress: Compress,
    pub checksum: u32,
    pub raw_size: u64,
    pub compressed_size: u64,
}

impl DeflateCRC32Stream {
    // deps/crc32-stream/lib/deflate-crc32-stream.js:5-11
    pub fn new(level: i32) -> Self {
        DeflateCRC32Stream {
            compress: Compress::new(zlib_level(level), false),
            checksum: 0,
            raw_size: 0,
            compressed_size: 0,
        }
    }

    // deps/crc32-stream/lib/deflate-crc32-stream.js:12-17
    fn push(&mut self, chunk: &[u8]) {
        self.compressed_size += chunk.len() as u64;
    }

    // deps/crc32-stream/lib/deflate-crc32-stream.js:18-24
    pub fn _transform(&mut self, chunk: &[u8], out: &mut Vec<u8>) -> Result<(), DeflateError> {
        self.checksum = crc32::buf(chunk, self.checksum);
        self.raw_size += chunk.len() as u64;
        let start = out.len();
        let result = deflate(&mut self.compress, chunk, out, FlushCompress::None);
        self.push(out.get(start..).unwrap_or(&[]));
        result
    }

    // zlib end of the DeflateRaw that deps/crc32-stream/lib/deflate-crc32-stream.js:4 extends
    pub fn _flush(&mut self, out: &mut Vec<u8>) -> Result<(), DeflateError> {
        let start = out.len();
        let result = deflate(&mut self.compress, &[], out, FlushCompress::Finish);
        self.push(out.get(start..).unwrap_or(&[]));
        result
    }

    // deps/crc32-stream/lib/deflate-crc32-stream.js:25-29
    pub fn digest(&self) -> [u8; 4] {
        self.checksum.to_be_bytes()
    }

    // deps/crc32-stream/lib/deflate-crc32-stream.js:30-32
    pub fn hex(&self) -> String {
        format!("{:08X}", self.checksum)
    }

    // deps/crc32-stream/lib/deflate-crc32-stream.js:33-39
    pub fn size(&self, compressed: bool) -> u64 {
        if compressed {
            self.compressed_size
        } else {
            self.raw_size
        }
    }
}

#[cfg(test)]
mod tests {
    use std::io::Read;

    use flate2::read::DeflateDecoder;

    use super::*;

    fn inflate(data: &[u8]) -> Vec<u8> {
        let mut decoder = DeflateDecoder::new(data);
        let mut out = Vec::new();
        decoder.read_to_end(&mut out).unwrap();
        assert_eq!(decoder.total_in(), data.len() as u64);
        out
    }

    fn sample(len: usize) -> Vec<u8> {
        let mut state: u32 = 12345;
        (0..len)
            .map(|i| {
                state = state.wrapping_mul(1664525).wrapping_add(1013904223);
                if (i / 4096) % 2 == 0 {
                    (state >> 24) as u8
                } else {
                    (i & 255) as u8
                }
            })
            .collect()
    }

    #[test]
    fn zlib_level_mapping() {
        assert_eq!(zlib_level(-1).level(), 6);
        assert_eq!(zlib_level(-5).level(), 6);
        assert_eq!(zlib_level(10).level(), 9);
        for level in 0..=9 {
            assert_eq!(zlib_level(level).level(), level as u32);
        }
    }

    #[test]
    fn deflate_counts_and_roundtrip() {
        let input = sample(300_000);
        for level in [-1, 0, 1, 6, 9] {
            let mut stream = DeflateCRC32Stream::new(level);
            let mut out = Vec::new();
            for chunk in input.chunks(70_001) {
                stream._transform(chunk, &mut out).unwrap();
                assert_eq!(stream.compressed_size, out.len() as u64);
            }
            stream._flush(&mut out).unwrap();
            assert_eq!(stream.compressed_size, out.len() as u64);
            assert_eq!(stream.size(true), out.len() as u64);
            assert_eq!(stream.size(false), input.len() as u64);
            assert_eq!(stream.raw_size, input.len() as u64);
            assert_eq!(stream.checksum, crc32::buf(&input, 0));
            assert_eq!(stream.digest(), crc32::buf(&input, 0).to_be_bytes());
            assert_eq!(inflate(&out), input, "level {level}");
        }

        for level in [0, 1, 6] {
            let mut stream = DeflateCRC32Stream::new(level);
            let mut out = Vec::new();
            stream._flush(&mut out).unwrap();
            assert!(!out.is_empty());
            assert_eq!(stream.compressed_size, out.len() as u64);
            assert_eq!(stream.size(false), 0);
            assert_eq!(stream.checksum, 0);
            assert_eq!(inflate(&out), Vec::<u8>::new());
        }
    }

    #[test]
    fn deflate_appends_to_out() {
        let mut stream = DeflateCRC32Stream::new(1);
        let mut out = vec![0xAA, 0xBB];
        stream._transform(b"this is a text file", &mut out).unwrap();
        stream._transform(&[], &mut out).unwrap();
        stream._flush(&mut out).unwrap();
        assert_eq!(out.get(..2), Some(&[0xAA, 0xBB][..]));
        assert_eq!(stream.compressed_size, out.len() as u64 - 2);
        assert_eq!(inflate(&out[2..]), b"this is a text file");
        assert_eq!(stream.hex(), "22E53327");
        assert_eq!(stream.digest(), [0x22, 0xE5, 0x33, 0x27]);
    }

    #[test]
    fn crc32_stream_passthrough() {
        let mut stream = CRC32Stream::new();
        assert_eq!(stream.digest(), [0, 0, 0, 0]);
        assert_eq!(stream.hex(), "00000000");
        let mut out = vec![1u8];
        stream._transform(b"this is ", &mut out);
        stream._transform(b"a text file", &mut out);
        assert_eq!(out, b"\x01this is a text file");
        assert_eq!(stream.checksum, 585446183);
        assert_eq!(stream.raw_size, 19);
        assert_eq!(stream.size(false), 19);
        assert_eq!(stream.size(true), 19);
        assert_eq!(stream.digest(), 585446183u32.to_be_bytes());
        assert_eq!(stream.hex(), "22E53327");
    }
}
