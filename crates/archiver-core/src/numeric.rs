/// ECMAScript ToInt32: NaN and infinities give 0; otherwise truncate toward zero, reduce
/// modulo 2^32, reinterpret as i32. Never use `as i32` on an f64 for this (it saturates).
pub fn to_int32(v: f64) -> i32 {
    to_uint32(v) as i32
}

/// ECMAScript ToUint32.
pub fn to_uint32(v: f64) -> u32 {
    if !v.is_finite() {
        return 0;
    }
    let mut m = v.trunc() % 4294967296.0;
    if m < 0.0 {
        m += 4294967296.0;
    }
    m as u32
}

/// JS `Number.prototype.toString(8)` for an integer: sign followed by magnitude
/// (-1 gives "-1", not "37777777777").
pub fn i64_to_string_radix8(v: i64) -> String {
    if v < 0 {
        format!("-{:o}", v.unsigned_abs())
    } else {
        format!("{v:o}")
    }
}

/// JS `str.length` (UTF-16 code units).
pub fn utf16_len(s: &str) -> usize {
    s.encode_utf16().count()
}

/// JS truthiness of an optional string: `Some("")` and `None` are both falsy.
pub fn truthy_str(s: &Option<String>) -> Option<&str> {
    match s {
        Some(v) if !v.is_empty() => Some(v.as_str()),
        _ => None,
    }
}

/// `Buffer.write(string, offset)`: copies the longest prefix of `s` that fits before the end
/// of `buf` and ends on a UTF-8 character boundary. Never panics, never grows `buf`.
pub fn write_at(buf: &mut [u8], s: &str, offset: usize) {
    let room = buf.len().saturating_sub(offset);
    let mut n = s.len().min(room);
    while !s.is_char_boundary(n) {
        n -= 1;
    }
    let end = offset.saturating_add(n);
    if let (Some(dst), Some(src)) = (buf.get_mut(offset..end), s.as_bytes().get(..n)) {
        dst.copy_from_slice(src);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn to_int32_vectors() {
        assert_eq!(to_int32(f64::NAN), 0);
        assert_eq!(to_int32(f64::INFINITY), 0);
        assert_eq!(to_int32(f64::NEG_INFINITY), 0);
        assert_eq!(to_int32(2147483648.0), -2147483648);
        assert_eq!(to_int32(-0.5), 0);
        assert_eq!(to_int32(4294967297.0), 1);
        assert_eq!(to_int32(0.0), 0);
        assert_eq!(to_int32(-0.0), 0);
        assert_eq!(to_int32(2147483647.0), 2147483647);
        assert_eq!(to_int32(-2147483648.0), -2147483648);
        assert_eq!(to_int32(-2147483649.0), 2147483647);
        assert_eq!(to_int32(4294967295.0), -1);
        assert_eq!(to_int32(-1.9), -1);
        assert_eq!(to_int32(1.9), 1);
        assert_eq!(to_int32(29.5), 29);
        assert_eq!(to_int32(1e21), -559939584);
        assert_eq!(to_int32(-1e21), 559939584);
    }

    #[test]
    fn to_uint32_vectors() {
        assert_eq!(to_uint32(f64::NAN), 0);
        assert_eq!(to_uint32(f64::INFINITY), 0);
        assert_eq!(to_uint32(f64::NEG_INFINITY), 0);
        assert_eq!(to_uint32(-1.0), 4294967295);
        assert_eq!(to_uint32(-0.5), 0);
        assert_eq!(to_uint32(4294967296.0), 0);
        assert_eq!(to_uint32(4294967297.5), 1);
        assert_eq!(to_uint32(2147483648.0), 2147483648);
    }

    #[test]
    fn radix8_sign_magnitude() {
        assert_eq!(i64_to_string_radix8(-1), "-1");
        assert_eq!(i64_to_string_radix8(8), "10");
        assert_eq!(i64_to_string_radix8(0), "0");
        assert_eq!(i64_to_string_radix8(0o7777), "7777");
        assert_eq!(i64_to_string_radix8(2147483647), "17777777777");
        assert_eq!(i64_to_string_radix8(-2147483648), "-20000000000");
        assert_eq!(i64_to_string_radix8(i64::MIN), "-1000000000000000000000");
        // PORTING.md 10.6: (mtime.getTime() / 1000) | 0, then toString(8)
        assert_eq!(
            i64_to_string_radix8(to_int32(1357223198999.0 / 1000.0) as i64),
            "12071312436"
        );
        assert_eq!(
            i64_to_string_radix8(to_int32(3471292800000.0 / 1000.0) as i64),
            "-6106043200"
        );
        assert_eq!(
            i64_to_string_radix8(to_int32(4323283200000.0 / 1000.0) as i64),
            "154010400"
        );
        assert_eq!(
            i64_to_string_radix8(to_int32(-1000.0 / 1000.0) as i64),
            "-1"
        );
        assert_eq!(i64_to_string_radix8(to_int32(-500.0 / 1000.0) as i64), "0");
    }

    #[test]
    fn utf16_len_counts_code_units() {
        assert_eq!(utf16_len(""), 0);
        assert_eq!(utf16_len("abc"), 3);
        assert_eq!(utf16_len("é"), 1);
        assert_eq!(utf16_len("\u{1F600}"), 2);
        assert_eq!("\u{1F600}".len(), 4);
    }

    #[test]
    fn truthy_str_empty_is_falsy() {
        assert_eq!(truthy_str(&None), None);
        assert_eq!(truthy_str(&Some(String::new())), None);
        assert_eq!(truthy_str(&Some("0".to_string())), Some("0"));
        assert_eq!(truthy_str(&Some("root".to_string())), Some("root"));
    }

    #[test]
    fn write_at_bounds() {
        let mut buf = [0u8; 8];
        write_at(&mut buf, "abc", 2);
        assert_eq!(&buf, b"\0\0abc\0\0\0");

        // longer than the rest of the buffer: cut at the end
        let mut buf = [0u8; 8];
        write_at(&mut buf, "0123456789", 5);
        assert_eq!(&buf, &[0, 0, 0, 0, 0, b'0', b'1', b'2']);

        // cut on a character boundary: 'é' is two bytes and does not fit in the last byte
        let mut buf = [b'.'; 4];
        write_at(&mut buf, "abcé", 0);
        assert_eq!(&buf, b"abc.");
        let mut buf = [b'.'; 5];
        write_at(&mut buf, "abcé", 0);
        assert_eq!(&buf, "abcé".as_bytes());
        let mut buf = [b'.'; 3];
        write_at(&mut buf, "\u{1F600}", 0);
        assert_eq!(&buf, b"...");

        // offsets at and past the end, and an empty buffer: nothing is written, no panic
        let mut buf = [b'.'; 4];
        write_at(&mut buf, "abc", 4);
        write_at(&mut buf, "abc", 5);
        write_at(&mut buf, "abc", usize::MAX);
        write_at(&mut buf, "", 0);
        assert_eq!(&buf, b"....");
        let mut empty: [u8; 0] = [];
        write_at(&mut empty, "abc", 0);

        // a 300-byte name written at offset 265 of a 512-byte block stops at byte 511 (P12)
        let mut block = [0u8; 512];
        let long = "u".repeat(300);
        write_at(&mut block, &long, 265);
        assert_eq!(block[264], 0);
        assert!(block[265..].iter().all(|b| *b == b'u'));
    }
}
