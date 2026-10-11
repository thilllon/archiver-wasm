// Port of the Rust part of archiver-zip-encrypted/lib/zip20/crypto-stream.js (PORTING.md 5.2, 6.11).
use super::crypto_cipher::CryptoCipher;

pub const HEADER_LENGTH: usize = 12;

// archiver-zip-encrypted/lib/zip20/crypto-stream.js:13
pub struct CryptoStream {
    pub key: Vec<u8>,
    pub crc: u16,
    pub cipher: CryptoCipher,
    pub header_sent: bool,
    pub header: [u8; 12],
}

impl CryptoStream {
    // archiver-zip-encrypted/lib/zip20/crypto-stream.js:13-24
    pub fn new(key: &[u8], crc: u16, header: [u8; 12]) -> Self {
        CryptoStream {
            key: key.to_vec(),
            crc,
            cipher: CryptoCipher::new(key),

            header_sent: false,
            header, // PORTING.md V10
        }
    }

    // archiver-zip-encrypted/lib/zip20/crypto-stream.js:27-29
    pub fn _encrypt(&mut self, data: &[u8]) -> Vec<u8> {
        self.cipher.encrypt(data)
    }

    // archiver-zip-encrypted/lib/zip20/crypto-stream.js:31-50
    pub fn _transform(&mut self, data: &[u8], out: &mut Vec<u8>) {
        if !self.header_sent {
            let mut header = self.header; // PORTING.md V10
            header[HEADER_LENGTH - 2..].copy_from_slice(&self.crc.to_le_bytes());

            let encrypted_header = self._encrypt(&header);

            out.extend_from_slice(&encrypted_header);

            self.header_sent = true;
        }

        let encrypted = self._encrypt(data);

        if !encrypted.is_empty() {
            out.extend_from_slice(&encrypted);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const HEADER: [u8; 12] = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11];

    fn hex(bytes: &[u8]) -> String {
        bytes.iter().map(|b| format!("{b:02x}")).collect()
    }

    // Expected ciphertext was read from upstream by running lib/zip20/crypto-stream.js under
    // node with key '123', crc ABF033D8 and crypto.randomBytes returning HEADER.
    #[test]
    fn header_check_bytes() {
        let mut stream = CryptoStream::new(b"123", 0xABF0, HEADER);
        assert_eq!(stream.key, b"123");
        assert!(!stream.header_sent);
        let mut out = Vec::new();
        stream._transform(b"hello", &mut out);
        assert!(stream.header_sent);
        assert_eq!(hex(&out), "40cfd1f3872ef08929a0d42a417ac4cf8a");

        let mut cipher = CryptoCipher::new(b"123");
        let header = cipher.decrypt(&out[..HEADER_LENGTH]);
        assert_eq!(header, [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 0xF0, 0xAB]);
        assert_eq!(cipher.decrypt(&out[HEADER_LENGTH..]), b"hello");
        // the injected header itself is not modified
        assert_eq!(stream.header, HEADER);
    }

    #[test]
    fn header_is_lazy_and_sent_once() {
        // no _transform call: nothing is emitted (there is no _flush)
        let stream = CryptoStream::new(b"123", 0xABF0, HEADER);
        assert!(!stream.header_sent);

        // an empty first chunk still emits the header, and only the header
        let mut stream = CryptoStream::new(b"123", 0xABF0, HEADER);
        let mut out = Vec::new();
        stream._transform(&[], &mut out);
        assert_eq!(hex(&out), "40cfd1f3872ef08929a0d42a");
        assert!(stream.header_sent);
        stream._transform(&[], &mut out);
        assert_eq!(out.len(), HEADER_LENGTH);
    }

    // Expected ciphertext: the same upstream run with crc 3610A686 and the chunks 'he', 'llo'.
    #[test]
    fn chunks_append_to_out() {
        let mut stream = CryptoStream::new(b"123", 0x3610, HEADER);
        let mut out = vec![0xEE];
        stream._transform(b"he", &mut out);
        assert_eq!(hex(&out), "ee40cfd1f3872ef08929a034a53133");
        stream._transform(b"llo", &mut out);
        assert_eq!(hex(&out), "ee40cfd1f3872ef08929a034a53133b1b255");
        assert_eq!(hex(&stream._encrypt(&[])), "");
    }
}
