// Port of archiver-zip-encrypted/lib/zip20/CryptoCipher.js.
use super::crc::crc32;

// archiver-zip-encrypted/lib/zip20/CryptoCipher.js:14
pub struct CryptoCipher {
    pub key: Vec<u8>,
    pub key0: u32,
    pub key1: u32,
    pub key2: u32,
}

impl CryptoCipher {
    // archiver-zip-encrypted/lib/zip20/CryptoCipher.js:14-21
    pub fn new(key: &[u8]) -> Self {
        let mut cipher = CryptoCipher {
            key: key.to_vec(),
            key0: 0,
            key1: 0,
            key2: 0,
        };

        cipher._init();
        cipher
    }

    // archiver-zip-encrypted/lib/zip20/CryptoCipher.js:23-31
    pub fn _init(&mut self) {
        self.key0 = 0x12345678;
        self.key1 = 0x23456789;
        self.key2 = 0x34567890;

        let key = std::mem::take(&mut self.key);
        for &b in &key {
            self._update_keys(b);
        }
        self.key = key;
    }

    // archiver-zip-encrypted/lib/zip20/CryptoCipher.js:33-38
    pub fn _update_keys(&mut self, b: u8) {
        self.key0 = crc32(self.key0, b);
        self.key1 = self.key1.wrapping_add(self.key0 & 0xFF);
        self.key1 = self.key1.wrapping_mul(134775813).wrapping_add(1);
        self.key2 = crc32(self.key2, (self.key1 >> 24) as u8);
    }

    // archiver-zip-encrypted/lib/zip20/CryptoCipher.js:40-43
    pub fn _stream_byte(&self) -> u8 {
        let tmp = self.key2 | 2;
        (tmp.wrapping_mul(tmp ^ 1) >> 8) as u8
    }

    // archiver-zip-encrypted/lib/zip20/CryptoCipher.js:45-49
    pub fn _encrypt_byte(&mut self, b: u8) -> u8 {
        let encrypted_byte = self._stream_byte() ^ b;
        self._update_keys(b);
        encrypted_byte
    }

    // archiver-zip-encrypted/lib/zip20/CryptoCipher.js:51-55
    pub fn _decrypt_byte(&mut self, b: u8) -> u8 {
        let decrypted_byte = self._stream_byte() ^ b;
        self._update_keys(decrypted_byte);
        decrypted_byte
    }

    // archiver-zip-encrypted/lib/zip20/CryptoCipher.js:57-63
    pub fn encrypt(&mut self, data: &[u8]) -> Vec<u8> {
        let mut encrypted_data = Vec::with_capacity(data.len());
        for &b in data {
            encrypted_data.push(self._encrypt_byte(b));
        }
        encrypted_data
    }

    // archiver-zip-encrypted/lib/zip20/CryptoCipher.js:65-71
    pub fn decrypt(&mut self, data: &[u8]) -> Vec<u8> {
        let mut decrypted_data = Vec::with_capacity(data.len());
        for &b in data {
            decrypted_data.push(self._decrypt_byte(b));
        }
        decrypted_data
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn hex(bytes: &[u8]) -> String {
        bytes.iter().map(|b| format!("{b:02x}")).collect()
    }

    fn keys(cipher: &CryptoCipher) -> [u32; 3] {
        [cipher.key0, cipher.key1, cipher.key2]
    }

    #[test]
    fn keys_after_init_123() {
        let mut cipher = CryptoCipher::new(b"123");
        assert_eq!(cipher.key, b"123");
        assert_eq!(keys(&cipher), [0xe0be8d5d, 0x70bb3140, 0x7e983fff]);
        assert_eq!(
            hex(&cipher.encrypt(b"hello world!")),
            "28f94f360b86831bd528b11a"
        );
    }

    // Expected values were read from upstream by running lib/zip20/CryptoCipher.js under node.
    #[test]
    fn state_persists_across_calls() {
        let mut cipher = CryptoCipher::new(b"123");
        assert_eq!(cipher._stream_byte(), 0x40);
        let mut out = cipher.encrypt(b"hello ");
        assert_eq!(cipher.encrypt(&[]), Vec::<u8>::new());
        out.extend_from_slice(&cipher.encrypt(b"world!"));
        assert_eq!(hex(&out), "28f94f360b86831bd528b11a");
        assert_eq!(keys(&cipher), [0xccc91d19, 0x2043bf69, 0x54771781]);

        let mut cipher = CryptoCipher::new(b"123");
        assert_eq!(cipher.decrypt(&out), b"hello world!");
        assert_eq!(keys(&cipher), [0xccc91d19, 0x2043bf69, 0x54771781]);
    }

    #[test]
    fn init_restarts_from_the_key() {
        let mut cipher = CryptoCipher::new(b"123");
        cipher.encrypt(b"hello world!");
        cipher._init();
        assert_eq!(cipher.key, b"123");
        assert_eq!(keys(&cipher), [0xe0be8d5d, 0x70bb3140, 0x7e983fff]);
    }

    #[test]
    fn empty_and_binary_keys() {
        let mut cipher = CryptoCipher::new(b"");
        assert_eq!(keys(&cipher), [0x12345678, 0x23456789, 0x34567890]);
        assert_eq!(hex(&cipher.encrypt(&[0, 255, 128])), "abe5c9");

        let mut cipher = CryptoCipher::new(&[0xff, 0x00, 0x80, 0xe9]);
        assert_eq!(keys(&cipher), [0xb2799ca8, 0xb1fd3847, 0xbebf8dff]);
        assert_eq!(
            hex(&cipher.encrypt(&[0xff, 0xfe, 0x00, 0x80, 0x7f])),
            "a956234dc3"
        );
    }
}
