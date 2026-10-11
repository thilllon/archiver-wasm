// Port of archiver-zip-encrypted/lib/aes/aes-hmac-etm-stream.js.

use aes::Aes256;
use ctr::cipher::{KeyIvInit, StreamCipher};
use ctr::Ctr128LE;
use hmac::{Hmac, Mac};
use sha1::Sha1;

use crate::error::ZipError;

pub const SALT_LENGTH: usize = 16;
pub const KEY_LENGTH: usize = 32;
pub const COMPOSITE_KEY_LENGTH: usize = 2 * KEY_LENGTH + 2;
pub const PBKDF2_ITERATION_COUNT: u32 = 1000;

// archiver-zip-encrypted/lib/aes/aes-hmac-etm-stream.js:56-60 (the object deriveKey returns)
pub struct CompositeKey {
    pub aes_key: [u8; 32],
    pub hmac_key: [u8; 32],
    pub password_verifier: [u8; 2],
}

// archiver-zip-encrypted/lib/aes/aes-hmac-etm-stream.js:54-61
pub fn derive_key(salt: &[u8], key: &[u8]) -> CompositeKey {
    let mut composite_key = [0u8; COMPOSITE_KEY_LENGTH];
    pbkdf2::pbkdf2_hmac::<Sha1>(key, salt, PBKDF2_ITERATION_COUNT, &mut composite_key);
    let mut aes_key = [0u8; 32];
    let mut hmac_key = [0u8; 32];
    let mut password_verifier = [0u8; 2];
    aes_key.copy_from_slice(&composite_key[0..KEY_LENGTH]);
    hmac_key.copy_from_slice(&composite_key[KEY_LENGTH..2 * KEY_LENGTH]);
    password_verifier.copy_from_slice(&composite_key[2 * KEY_LENGTH..]);
    CompositeKey {
        aes_key,
        hmac_key,
        password_verifier,
    }
}

// archiver-zip-encrypted/lib/aes/aes-hmac-etm-stream.js:27-31
// Transform stream that encodes data with AES stream and prepends additional data for authentication and verification:
// ${salt}${passwordVerifier}${encodedData}${hmac}
pub struct AesHmacEtmStream {
    salt: Vec<u8>,
    cipher: Ctr128LE<Aes256>,
    hmac: Hmac<Sha1>,
    password_verifier: Vec<u8>,
    pub header_sent: bool,
    pub total_size: u64,
}

impl AesHmacEtmStream {
    // archiver-zip-encrypted/lib/aes/aes-hmac-etm-stream.js:31-51
    pub fn new(key: &[u8], salt: &[u8]) -> Result<Self, ZipError> {
        let key = derive_key(salt, key);
        Self::from_parts(&key.aes_key, &key.hmac_key, &key.password_verifier, salt)
    }

    // archiver-zip-encrypted/lib/aes/aes-hmac-etm-stream.js:37-50 (the constructor after deriveKey, PORTING.md 5.3)
    pub fn from_parts(
        aes_key: &[u8],
        hmac_key: &[u8],
        password_verifier: &[u8],
        salt: &[u8],
    ) -> Result<Self, ZipError> {
        // apparently WinZip's AES-CTR implementation uses nonce with 1st byte set to 1 and zeroes to others
        let mut counter = [0u8; 16];
        counter[0] = 0x01;
        let cipher = Ctr128LE::<Aes256>::new_from_slices(aes_key, &counter).map_err(|_| {
            ZipError::InvalidKeyLength {
                expected: KEY_LENGTH,
                actual: aes_key.len(),
            }
        })?;
        let hmac =
            Hmac::<Sha1>::new_from_slice(hmac_key).map_err(|_| ZipError::InvalidKeyLength {
                expected: KEY_LENGTH,
                actual: hmac_key.len(),
            })?;
        Ok(AesHmacEtmStream {
            salt: salt.to_vec(),
            cipher,
            hmac,
            password_verifier: password_verifier.to_vec(),
            header_sent: false,
            total_size: 0,
        })
    }

    // archiver-zip-encrypted/lib/aes/aes-hmac-etm-stream.js:63-65
    pub fn get_total_size(&self) -> u64 {
        self.total_size
    }

    // archiver-zip-encrypted/lib/aes/aes-hmac-etm-stream.js:67-77
    pub fn ensure_header_sent(&mut self, out: &mut Vec<u8>) {
        if !self.header_sent {
            out.extend_from_slice(&self.salt);
            self.total_size += self.salt.len() as u64;

            out.extend_from_slice(&self.password_verifier);
            self.total_size += self.password_verifier.len() as u64;

            self.header_sent = true;
        }
    }

    // archiver-zip-encrypted/lib/aes/aes-hmac-etm-stream.js:79-91
    pub fn _transform(&mut self, data: &[u8], out: &mut Vec<u8>) {
        self.ensure_header_sent(out);

        let mut encoded = data.to_vec();
        self.cipher.apply_keystream(&mut encoded);

        if !encoded.is_empty() {
            self.hmac.update(&encoded);
            out.extend_from_slice(&encoded);
            self.total_size += encoded.len() as u64;
        }
    }

    // archiver-zip-encrypted/lib/aes/aes-hmac-etm-stream.js:93-103
    pub fn _flush(&mut self, out: &mut Vec<u8>) {
        // _transform is not called for non-file entries, such as directories
        self.ensure_header_sent(out);

        let digest = self.hmac.clone().finalize().into_bytes();
        let hmac_data = &digest[0..10];
        out.extend_from_slice(hmac_data);

        self.total_size += hmac_data.len() as u64;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const SALT: [u8; 16] = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15];

    fn hex(bytes: &[u8]) -> String {
        bytes.iter().map(|b| format!("{b:02x}")).collect()
    }

    fn stream(salt: &[u8]) -> AesHmacEtmStream {
        match AesHmacEtmStream::new(b"123", salt) {
            Ok(stream) => stream,
            Err(e) => panic!("{e}"),
        }
    }

    fn run(chunks: &[&[u8]]) -> (Vec<u8>, u64) {
        let mut stream = stream(&SALT);
        let mut out = Vec::new();
        for chunk in chunks {
            stream._transform(chunk, &mut out);
        }
        stream._flush(&mut out);
        (out, stream.get_total_size())
    }

    #[test]
    fn hello_with_fixed_salt() {
        let key = derive_key(&SALT, b"123");
        assert_eq!(hex(&key.password_verifier), "56d8");

        let (out, total) = run(&[b"hello"]);
        assert_eq!(hex(&out[0..16]), "000102030405060708090a0b0c0d0e0f");
        assert_eq!(hex(&out[16..18]), "56d8");
        assert_eq!(hex(&out[18..23]), "dd9090588d");
        assert_eq!(hex(&out[23..]), "073e32b0fc7af3f25cca");
        assert_eq!(total, 16 + 2 + 5 + 10);

        let (out, total) = run(&[]);
        assert_eq!(
            hex(&out),
            "000102030405060708090a0b0c0d0e0f56d8742c47b8abe1b07dfc30"
        );
        assert_eq!(total, 28);
    }

    #[test]
    fn constants() {
        assert_eq!(SALT_LENGTH, 16);
        assert_eq!(KEY_LENGTH, 32);
        assert_eq!(COMPOSITE_KEY_LENGTH, 66);
        assert_eq!(PBKDF2_ITERATION_COUNT, 1000);
    }

    #[test]
    fn derive_key_parts() {
        let key = derive_key(&SALT, b"123");
        assert_eq!(
            hex(&key.aes_key),
            "8d7060c1a4abdbd602bb7fecef6ffd5c2ed02d6f841a039c591b0eff12a0ae20"
        );
        assert_eq!(
            hex(&key.hmac_key),
            "0d50b6977bb43a4f7afc4e102158ed3fe90542d478add32e9e2e81543d524125"
        );
        assert_eq!(hex(&key.password_verifier), "56d8");
    }

    #[test]
    fn empty_chunk_sends_header_only() {
        let mut stream = stream(&SALT);
        let mut out = Vec::new();
        stream._transform(&[], &mut out);
        assert_eq!(hex(&out), "000102030405060708090a0b0c0d0e0f56d8");
        assert!(stream.header_sent);
        assert_eq!(stream.total_size, 18);
        stream._flush(&mut out);
        assert_eq!(
            hex(&out),
            "000102030405060708090a0b0c0d0e0f56d8742c47b8abe1b07dfc30"
        );
        assert_eq!(stream.get_total_size(), 28);
    }

    #[test]
    fn keystream_carries_across_chunks_and_counter_bytes() {
        let big: Vec<u8> = (0..4200).map(|i| (i & 255) as u8).collect();
        let (whole, total) = run(&[&big]);
        let (split, split_total) = run(&[&big[0..7], &big[7..4103], &big[4103..]]);
        assert_eq!(whole, split);
        assert_eq!(total, 4228);
        assert_eq!(split_total, 4228);
        assert_eq!(whole.len(), 4228);
        assert_eq!(
            hex(&whole[18 + 4080..18 + 4112]),
            "c375d2cb9fb86faf6c134751d9876354acbae3bc40251d40ffc323f8f711dd85"
        );
        assert_eq!(hex(&whole[whole.len() - 10..]), "1c89f06b1c82ba09d983");
    }

    #[test]
    fn salt_length_is_not_checked() {
        let mut stream = stream(b"abc");
        let mut out = Vec::new();
        stream._transform(b"hello", &mut out);
        stream._flush(&mut out);
        assert_eq!(hex(&out), "616263265e61418069d403adf8d2591b451d62c2");
        assert_eq!(stream.get_total_size(), 20);
    }

    #[test]
    fn from_parts_equals_new_and_checks_the_aes_key() {
        let key = derive_key(&SALT, b"123");
        let verifier = &key.password_verifier;
        let parts = AesHmacEtmStream::from_parts(&key.aes_key, &key.hmac_key, verifier, &SALT);
        let mut stream = match parts {
            Ok(stream) => stream,
            Err(e) => panic!("{e}"),
        };
        let mut out = Vec::new();
        stream._transform(b"hello", &mut out);
        stream._flush(&mut out);
        assert_eq!(
            hex(&out),
            "000102030405060708090a0b0c0d0e0f56d8dd9090588d073e32b0fc7af3f25cca"
        );

        let short = &key.aes_key[0..31];
        let short = AesHmacEtmStream::from_parts(short, &key.hmac_key, verifier, &SALT);
        assert_eq!(
            short.err(),
            Some(ZipError::InvalidKeyLength {
                expected: 32,
                actual: 31
            })
        );
    }
}
