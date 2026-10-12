use std::fmt;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DeflateError(pub String); // "deflate error: {0}"  ykk

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ZipError {
    EntryAfterFinish, // "unacceptable entry after finish"  upstream archive-output-stream.js:55
    AlreadyProcessing, // "already processing an entry"  upstream archive-output-stream.js:59
    MethodNotImplemented(i32), // "compression method {0} not implemented"  upstream zip-archive-output-stream.js:94
    EntryNameRequired, // "entry name must be a non-empty string value"  upstream zip-stream/index.js:115
    NoEntryOpen, // "no entry is being processed"  ykk (write_data / end_data without an open entry)
    ExtraTooShort, // "entry extra field is shorter than 11 bytes"  ykk (stands in for readInt16LE RangeError, zip-aes-stream.js:160)
    InvalidRandomLength { expected: usize, actual: usize }, // "expected {expected} random bytes, got {actual}"  ykk
    InvalidKeyLength { expected: usize, actual: usize }, // "expected a {expected} byte key, got {actual}"  ykk
    InvalidEncryption(u8),                               // "unknown encryption method {0}"  ykk
    Deflate(String),                                     // "deflate error: {0}"  ykk
}

impl fmt::Display for DeflateError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "deflate error: {}", self.0)
    }
}

impl fmt::Display for ZipError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            ZipError::EntryAfterFinish => f.write_str("unacceptable entry after finish"),
            ZipError::AlreadyProcessing => f.write_str("already processing an entry"),
            ZipError::MethodNotImplemented(method) => {
                write!(f, "compression method {method} not implemented")
            }
            ZipError::EntryNameRequired => {
                f.write_str("entry name must be a non-empty string value")
            }
            ZipError::NoEntryOpen => f.write_str("no entry is being processed"),
            ZipError::ExtraTooShort => f.write_str("entry extra field is shorter than 11 bytes"),
            ZipError::InvalidRandomLength { expected, actual } => {
                write!(f, "expected {expected} random bytes, got {actual}")
            }
            ZipError::InvalidKeyLength { expected, actual } => {
                write!(f, "expected a {expected} byte key, got {actual}")
            }
            ZipError::InvalidEncryption(method) => write!(f, "unknown encryption method {method}"),
            ZipError::Deflate(text) => write!(f, "deflate error: {text}"),
        }
    }
}

impl From<DeflateError> for ZipError {
    fn from(e: DeflateError) -> Self {
        ZipError::Deflate(e.0)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn display_strings() {
        assert_eq!(
            ZipError::EntryAfterFinish.to_string(),
            "unacceptable entry after finish"
        );
        assert_eq!(
            ZipError::AlreadyProcessing.to_string(),
            "already processing an entry"
        );
        assert_eq!(
            ZipError::MethodNotImplemented(99).to_string(),
            "compression method 99 not implemented"
        );
        assert_eq!(
            ZipError::MethodNotImplemented(-1).to_string(),
            "compression method -1 not implemented"
        );
        assert_eq!(
            ZipError::EntryNameRequired.to_string(),
            "entry name must be a non-empty string value"
        );
        assert_eq!(
            ZipError::NoEntryOpen.to_string(),
            "no entry is being processed"
        );
        assert_eq!(
            ZipError::ExtraTooShort.to_string(),
            "entry extra field is shorter than 11 bytes"
        );
        assert_eq!(
            ZipError::InvalidRandomLength {
                expected: 12,
                actual: 11
            }
            .to_string(),
            "expected 12 random bytes, got 11"
        );
        assert_eq!(
            ZipError::InvalidKeyLength {
                expected: 32,
                actual: 31
            }
            .to_string(),
            "expected a 32 byte key, got 31"
        );
        assert_eq!(
            ZipError::InvalidEncryption(3).to_string(),
            "unknown encryption method 3"
        );
        assert_eq!(
            ZipError::Deflate("x".to_string()).to_string(),
            "deflate error: x"
        );
        assert_eq!(
            DeflateError("x".to_string()).to_string(),
            "deflate error: x"
        );
    }

    #[test]
    fn deflate_error_converts() {
        let e: ZipError = DeflateError("bad".to_string()).into();
        assert_eq!(e, ZipError::Deflate("bad".to_string()));
    }
}
