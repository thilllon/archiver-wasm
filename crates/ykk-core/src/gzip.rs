// The gzip member that zlib.createGzip produced (node-archiver/lib/plugins/tar.js:28).

use flate2::{Compress, FlushCompress};

use crate::crc32;
use crate::crc32_stream::{deflate, zlib_level};
use crate::error::DeflateError;

// node-archiver/lib/plugins/tar.js:28 (zlib.createGzip)
pub struct Gzip {
    compress: Compress,
    crc: u32,
    input_length: u32,
    header_sent: bool,
    xfl: u8,
    os: u8,
}

impl Gzip {
    // node-archiver/lib/plugins/tar.js:28 (zlib.createGzip(options.gzipOptions))
    pub fn new(level: i32, strategy: i32, os: u8) -> Self {
        let l = zlib_level(level).level();
        let xfl = if l == 9 {
            2
        } else if strategy >= 2 || l < 2 {
            4
        } else {
            0
        };
        Gzip {
            compress: Compress::new(zlib_level(level), false),
            crc: 0,
            input_length: 0,
            header_sent: false,
            xfl,
            os,
        }
    }

    // node-archiver/lib/plugins/tar.js:28 (the 10-byte header zlib.createGzip writes, PORTING.md 6.4, R14)
    fn header(&mut self, out: &mut Vec<u8>) {
        if !self.header_sent {
            out.extend_from_slice(&[
                0x1f, 0x8b, 0x08, 0x00, 0x00, 0x00, 0x00, 0x00, self.xfl, self.os,
            ]);
            self.header_sent = true;
        }
    }

    // node-archiver/lib/plugins/tar.js:28 (write into the zlib.createGzip stream)
    pub fn write(&mut self, chunk: &[u8], out: &mut Vec<u8>) -> Result<(), DeflateError> {
        self.header(out);
        self.crc = crc32::buf(chunk, self.crc);
        self.input_length = self.input_length.wrapping_add(chunk.len() as u32);
        deflate(&mut self.compress, chunk, out, FlushCompress::None)
    }

    // node-archiver/lib/plugins/tar.js:28 (end of the zlib.createGzip stream)
    pub fn finish(&mut self, out: &mut Vec<u8>) -> Result<(), DeflateError> {
        self.header(out);
        deflate(&mut self.compress, &[], out, FlushCompress::Finish)?;
        out.extend_from_slice(&self.crc.to_le_bytes());
        out.extend_from_slice(&self.input_length.to_le_bytes());
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use std::io::Read;

    use flate2::read::{DeflateDecoder, GzDecoder};

    use super::*;

    fn member(level: i32, strategy: i32, os: u8, chunks: &[&[u8]]) -> Vec<u8> {
        let mut gzip = Gzip::new(level, strategy, os);
        let mut out = Vec::new();
        for chunk in chunks {
            gzip.write(chunk, &mut out).unwrap();
        }
        gzip.finish(&mut out).unwrap();
        out
    }

    fn inflate(data: &[u8]) -> Vec<u8> {
        let mut decoder = DeflateDecoder::new(data);
        let mut out = Vec::new();
        decoder.read_to_end(&mut out).unwrap();
        assert_eq!(decoder.total_in(), data.len() as u64);
        out
    }

    #[test]
    fn header_and_trailer() {
        let input: Vec<u8> = (0..100_000usize).map(|i| (i % 251) as u8).collect();
        let (a, b) = input.split_at(33_333);
        for (level, strategy, os, xfl) in [
            (9, 0, 3u8, 2u8),
            (1, 0, 3, 4),
            (6, 0, 3, 0),
            (6, 2, 3, 4),
            (-1, 0, 19, 0),
            (0, 0, 10, 4),
            (9, 2, 3, 2),
        ] {
            let out = member(level, strategy, os, &[a, b]);
            assert_eq!(
                &out[..10],
                &[0x1f, 0x8b, 0x08, 0x00, 0x00, 0x00, 0x00, 0x00, xfl, os],
                "level {level} strategy {strategy}"
            );
            let trailer = out.len() - 8;
            assert_eq!(
                &out[trailer..trailer + 4],
                &crc32::buf(&input, 0).to_le_bytes()
            );
            assert_eq!(&out[trailer + 4..], &(input.len() as u32).to_le_bytes());
            assert_eq!(inflate(&out[10..trailer]), input);

            let mut decoded = Vec::new();
            GzDecoder::new(&out[..]).read_to_end(&mut decoded).unwrap();
            assert_eq!(decoded, input);
        }

        let empty = member(6, 0, 3, &[]);
        assert_eq!(
            &empty[..10],
            &[0x1f, 0x8b, 0x08, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x03]
        );
        assert!(empty.len() > 18);
        let trailer = empty.len() - 8;
        assert_eq!(&empty[trailer..], &[0u8; 8]);
        assert_eq!(inflate(&empty[10..trailer]), Vec::<u8>::new());
    }

    #[test]
    fn calls_after_finish() {
        // PORTING.md 6.4: calls out of order
        let mut gzip = Gzip::new(6, 0, 3);
        let mut out = Vec::new();
        gzip.write(b"this is a text file", &mut out).unwrap();
        gzip.finish(&mut out).unwrap();
        let len = out.len();
        assert_eq!(
            gzip.write(b"zz", &mut out),
            Err(DeflateError("no progress".to_string()))
        );
        assert_eq!(out.len(), len);
        assert_eq!(gzip.write(&[], &mut out), Ok(()));
        assert_eq!(out.len(), len);

        let mut gzip = Gzip::new(6, 0, 3);
        let mut out = Vec::new();
        gzip.write(b"this is a text file", &mut out).unwrap();
        gzip.finish(&mut out).unwrap();
        let len = out.len();
        assert_eq!(gzip.finish(&mut out), Ok(()));
        assert_eq!(out.len(), len + 8);
        assert_eq!(&out[len..], &out[len - 8..len]);
    }

    #[test]
    fn header_with_first_write_only() {
        let mut gzip = Gzip::new(6, 0, 3);
        let mut out = Vec::new();
        gzip.write(&[], &mut out).unwrap();
        assert_eq!(
            out,
            [0x1f, 0x8b, 0x08, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x03]
        );
        gzip.write(b"this is a text file", &mut out).unwrap();
        gzip.finish(&mut out).unwrap();
        let trailer = out.len() - 8;
        assert_eq!(&out[trailer..trailer + 4], &585446183u32.to_le_bytes());
        assert_eq!(&out[trailer + 4..], &19u32.to_le_bytes());
        assert_eq!(inflate(&out[10..trailer]), b"this is a text file");
    }
}
