// Port of the Rust part of archiver-zip-encrypted/lib/zip20/decrypto-stream.js (PORTING.md 5.2, 6.11).
use super::crypto_cipher::CryptoCipher;

const HEADER_LENGTH: usize = 12;

// archiver-zip-encrypted/lib/zip20/decrypto-stream.js:12
pub struct DecryptoStream {
    pub key: Vec<u8>,
    pub cipher: CryptoCipher,
    pub header: Vec<u8>,
    pub header_processed: bool,
    pub total_size: u64,
}

impl DecryptoStream {
    // archiver-zip-encrypted/lib/zip20/decrypto-stream.js:12-25
    pub fn new(key: &[u8]) -> Self {
        DecryptoStream {
            key: key.to_vec(),
            cipher: CryptoCipher::new(key),

            header: Vec::new(),
            header_processed: false,
            total_size: 0,
        }
    }

    // archiver-zip-encrypted/lib/zip20/decrypto-stream.js:29-31
    pub fn get_total_size(&self) -> u64 {
        self.total_size
    }

    // archiver-zip-encrypted/lib/zip20/decrypto-stream.js:33-35
    pub fn _decrypt(&mut self, data: &[u8]) -> Vec<u8> {
        self.cipher.decrypt(data)
    }

    // archiver-zip-encrypted/lib/zip20/decrypto-stream.js:37-60
    pub fn _transform(&mut self, data: &[u8], out: &mut Vec<u8>) {
        let mut data = data;
        if !self.header_processed {
            self.header.extend_from_slice(data);
            if self.header.len() > HEADER_LENGTH {
                let keep = self.header.len() - HEADER_LENGTH; // > 0 on this branch
                data = &data[data.len() - keep..]; // keep <= data.len(): header grew by data.len() in this call
                self.header.truncate(HEADER_LENGTH);

                let header = self.header.clone();
                self._decrypt(&header);

                self.header_processed = true;
            } else {
                data = &[];
            }
        }

        let decrypted = self._decrypt(data);

        if !decrypted.is_empty() {
            out.extend_from_slice(&decrypted);
            self.total_size += decrypted.len() as u64;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::super::crypto_stream::CryptoStream;
    use super::*;

    const HEADER: [u8; 12] = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11];

    fn sample() -> Vec<u8> {
        (0..100u32).map(|i| (i * 7 + 3) as u8).collect()
    }

    fn encrypt(x: &[u8]) -> Vec<u8> {
        let mut stream = CryptoStream::new(b"123", 0xABF0, HEADER);
        let mut out = Vec::new();
        stream._transform(x, &mut out);
        out
    }

    #[test]
    fn roundtrip_across_splits() {
        let x = sample();
        let encrypted = encrypt(&x);
        assert_eq!(encrypted.len(), x.len() + 12);
        for split in [1, 11, 12, 13] {
            let mut stream = DecryptoStream::new(b"123");
            let mut out = Vec::new();
            stream._transform(&encrypted[..split], &mut out);
            assert_eq!(stream.header_processed, split > 12, "split {split}");
            assert_eq!(out.len(), split.saturating_sub(12), "split {split}");
            stream._transform(&encrypted[split..], &mut out);
            assert!(stream.header_processed);
            assert_eq!(out, x, "split {split}");
            assert_eq!(stream.get_total_size(), x.len() as u64);
            assert_eq!(stream.header.len(), 12);
        }
    }

    #[test]
    fn roundtrip_byte_by_byte_and_whole() {
        let x = sample();
        let encrypted = encrypt(&x);

        let mut stream = DecryptoStream::new(b"123");
        let mut out = vec![0xEE];
        for chunk in encrypted.chunks(1) {
            stream._transform(chunk, &mut out);
        }
        assert_eq!(&out[1..], &x[..]);
        assert_eq!(stream.total_size, x.len() as u64);

        let mut stream = DecryptoStream::new(b"123");
        let mut out = Vec::new();
        stream._transform(&encrypted, &mut out);
        stream._transform(&[], &mut out);
        assert_eq!(out, x);
    }

    // archiver-zip-encrypted/lib/zip20/decrypto-stream.js:40 (the strict >)
    #[test]
    fn exactly_twelve_bytes_never_process_the_header() {
        let encrypted = encrypt(b"hello");
        let mut stream = DecryptoStream::new(b"123");
        let mut out = Vec::new();
        stream._transform(&encrypted[..12], &mut out);
        stream._transform(&[], &mut out);
        assert!(out.is_empty());
        assert!(!stream.header_processed);
        assert_eq!(stream.header, &encrypted[..12]);
        assert_eq!(stream.get_total_size(), 0);
        assert_eq!(stream.key, b"123");

        stream._transform(&encrypted[12..], &mut out);
        assert_eq!(out, b"hello");
        assert_eq!(stream.get_total_size(), 5);
    }
}
