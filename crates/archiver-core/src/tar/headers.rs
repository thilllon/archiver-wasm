// Writer side of deps/tar-stream/headers.js (the reader side is not ported, PORTING.md N3).

use crate::numeric::{i64_to_string_radix8, to_int32, truthy_str, utf16_len, write_at};

const ZEROS: &str = "0000000000000000000";
const SEVENS: &str = "7777777777777777777";
const ZERO_OFFSET: u8 = b'0';
const USTAR_MAGIC: [u8; 6] = [0x75, 0x73, 0x74, 0x61, 0x72, 0x00]; // ustar\x00
const USTAR_VER: [u8; 2] = [ZERO_OFFSET, ZERO_OFFSET];
const MASK: i32 = 0o7777;
const MAGIC_OFFSET: usize = 257;
const VERSION_OFFSET: usize = 263;

/// The `opts` object of headers.encode, already marshalled (5.6).
#[derive(Debug, Clone)]
pub struct Header {
    pub name: String,
    pub typeflag_is_5: bool,      // opts.typeflag === 5
    pub mode: i32,                // ToInt32(opts.mode)
    pub uid_oct: String,          // opts.uid.toString(8)
    pub gid_oct: String,          // opts.gid.toString(8)
    pub size: f64,                // opts.size
    pub size_oct: String,         // opts.size.toString(8)
    pub mtime: f64,               // opts.mtime.getTime(), NaN for an Invalid Date
    pub type_: String,            // opts.type
    pub linkname: Option<String>, // truthiness: read through numeric::truthy_str
    pub uname: Option<String>,
    pub gname: Option<String>,
    pub devmajor_oct: String, // (opts.devmajor || 0).toString(8)
    pub devminor_oct: String, // (opts.devminor || 0).toString(8)
}

// deps/tar-stream/headers.js:18-29
pub fn encode_pax(name: &str, linkname: Option<&str>, pax: Option<&[String]>) -> Vec<u8> {
    let mut result = String::new();
    if !name.is_empty() {
        result += &add_length(&format!(" path={name}\n"));
    }
    if let Some(linkname) = linkname.filter(|linkname| !linkname.is_empty()) {
        result += &add_length(&format!(" linkpath={linkname}\n"));
    }
    if let Some(pax) = pax {
        for record in pax {
            result += &add_length(record);
        }
    }
    result.into_bytes()
}

// deps/tar-stream/headers.js:51-92
pub fn encode(opts: &Header) -> Option<[u8; 512]> {
    let mut buf = [0u8; 512];
    let mut name = opts.name.clone();
    let mut prefix = String::new();

    if opts.typeflag_is_5 && !name.ends_with('/') {
        name += "/";
    }
    if !name.is_ascii() {
        return None; // utf-8
    }

    while name.len() > 100 {
        let i = name.find('/')?;
        prefix += &if !prefix.is_empty() {
            format!("/{}", &name[..i])
        } else {
            name[..i].to_owned()
        };
        name = name[i + 1..].to_owned();
    }

    if name.len() > 100 || prefix.len() > 155 {
        return None;
    }
    if truthy_str(&opts.linkname).is_some_and(|linkname| linkname.len() > 100) {
        return None;
    }

    write_at(&mut buf, &name, 0);
    write_at(
        &mut buf,
        &encode_oct(&i64_to_string_radix8((opts.mode & MASK) as i64), 6),
        100,
    );
    write_at(&mut buf, &encode_oct(&opts.uid_oct, 6), 108);
    write_at(&mut buf, &encode_oct(&opts.gid_oct, 6), 116);
    encode_size(opts.size, &opts.size_oct, &mut buf, 124);
    write_at(
        &mut buf,
        &encode_oct(
            &i64_to_string_radix8(to_int32(opts.mtime / 1000.0) as i64),
            11,
        ),
        136,
    );

    buf[156] = ZERO_OFFSET + to_typeflag(&opts.type_);

    if let Some(linkname) = truthy_str(&opts.linkname) {
        write_at(&mut buf, linkname, 157);
    }

    buf[MAGIC_OFFSET..MAGIC_OFFSET + USTAR_MAGIC.len()].copy_from_slice(&USTAR_MAGIC);
    buf[VERSION_OFFSET..VERSION_OFFSET + USTAR_VER.len()].copy_from_slice(&USTAR_VER);
    if let Some(uname) = truthy_str(&opts.uname) {
        write_at(&mut buf, uname, 265);
    }
    if let Some(gname) = truthy_str(&opts.gname) {
        write_at(&mut buf, gname, 297);
    }
    write_at(&mut buf, &encode_oct(&opts.devmajor_oct, 6), 329);
    write_at(&mut buf, &encode_oct(&opts.devminor_oct, 6), 337);

    if !prefix.is_empty() {
        write_at(&mut buf, &prefix, 345);
    }

    let sum = format!("{:o}", cksum(&buf));
    write_at(&mut buf, &encode_oct(&sum, 6), 148);

    Some(buf)
}

// deps/tar-stream/headers.js:203-226
pub(crate) fn to_typeflag(flag: &str) -> u8 {
    match flag {
        "file" => 0,
        "link" => 1,
        "symlink" => 2,
        "character-device" => 3,
        "block-device" => 4,
        "directory" => 5,
        "fifo" => 6,
        "contiguous-file" => 7,
        "pax-header" => 72,
        _ => 0,
    }
}

// deps/tar-stream/headers.js:235-240
pub(crate) fn cksum(block: &[u8; 512]) -> u32 {
    let mut sum: u32 = 8 * 32;
    for i in 0..148 {
        sum += block[i] as u32;
    }
    for j in 156..512 {
        sum += block[j] as u32;
    }
    sum
}

// deps/tar-stream/headers.js:242-246 (val is val.toString(8), computed by the caller)
pub(crate) fn encode_oct(val: &str, n: usize) -> String {
    if utf16_len(val) > n {
        return SEVENS.get(..n).unwrap_or(SEVENS).to_owned() + " ";
    }
    ZEROS.get(..n - utf16_len(val)).unwrap_or(ZEROS).to_owned() + val + " "
}

// deps/tar-stream/headers.js:248-254
pub(crate) fn encode_size_bin(mut num: f64, buf: &mut [u8; 512], off: usize) {
    buf[off] = 0x80;
    for i in (1..=11).rev() {
        buf[off + i] = (to_int32(num) & 0xff) as u8;
        num = (num / 256.0).floor();
    }
}

// deps/tar-stream/headers.js:256-262 (num_oct is num.toString(8), computed by the caller)
pub(crate) fn encode_size(num: f64, num_oct: &str, buf: &mut [u8; 512], off: usize) {
    if utf16_len(num_oct) > 11 {
        encode_size_bin(num, buf, off);
    } else {
        write_at(buf, &encode_oct(num_oct, 11), off);
    }
}

// deps/tar-stream/headers.js:316-322 (integer arithmetic, PORTING.md 11.6)
pub(crate) fn add_length(str: &str) -> String {
    let len = str.len() as u64;
    let mut digits: u32 = 0;
    let mut rest = len;
    while rest > 0 {
        digits += 1;
        rest /= 10;
    }
    if len + digits as u64 >= 10u64.pow(digits) {
        digits += 1;
    }

    format!("{}{}", len + digits as u64, str)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn base() -> Header {
        Header {
            name: "a.txt".to_owned(),
            typeflag_is_5: false,
            mode: 0o644,
            uid_oct: "0".to_owned(),
            gid_oct: "0".to_owned(),
            size: 0.0,
            size_oct: "0".to_owned(),
            mtime: 0.0,
            type_: "file".to_owned(),
            linkname: None,
            uname: None,
            gname: None,
            devmajor_oct: "0".to_owned(),
            devminor_oct: "0".to_owned(),
        }
    }

    fn named(name: &str) -> Header {
        Header {
            name: name.to_owned(),
            ..base()
        }
    }

    fn field(block: &[u8; 512], start: usize, end: usize) -> &[u8] {
        let field = &block[start..end];
        let len = field.iter().position(|&b| b == 0).unwrap_or(field.len());
        &field[..len]
    }

    #[test]
    fn mtime_table() {
        let rows: [(f64, &str); 8] = [
            (1357223198999.0, "12071312436 "), // 2013-01-03T14:26:38.999Z
            (2147483647000.0, "17777777777 "), // 2038-01-19T03:14:07Z
            (2147483648000.0, "77777777777 "), // 2038-01-19T03:14:08Z
            (3471292800000.0, "-6106043200 "), // 2080-01-01T00:00:00Z
            (4323283200000.0, "00154010400 "), // 2107-01-01T00:00:00Z
            (-1000.0, "000000000-1 "),         // 1969-12-31T23:59:59Z
            (-500.0, "00000000000 "),
            (f64::NAN, "00000000000 "), // Invalid Date
        ];
        for (mtime, expected) in rows {
            let block = encode(&Header { mtime, ..base() }).unwrap();
            assert_eq!(&block[136..148], expected.as_bytes(), "mtime {mtime}");
        }
    }

    #[test]
    fn name_split() {
        let a = "a".repeat(60);
        let b = "b".repeat(60);
        let c = "c".repeat(60);
        let block = encode(&named(&format!("{a}/{b}/{c}"))).unwrap();
        assert_eq!(field(&block, 0, 100), c.as_bytes());
        assert_eq!(field(&block, 345, 500), format!("{a}/{b}").as_bytes());

        // TAR-JSON-070: an empty first segment leaves the prefix empty
        let block = encode(&named(&format!("/{}/{}", "x".repeat(50), "y".repeat(60)))).unwrap();
        assert_eq!(field(&block, 0, 100), "y".repeat(60).as_bytes());
        assert_eq!(field(&block, 345, 500), "x".repeat(50).as_bytes());

        // TAR-JSON-070: the only slash is the trailing one
        let block = encode(&named(&format!("{}/", "d".repeat(120)))).unwrap();
        assert_eq!(field(&block, 0, 100), b"");
        assert_eq!(field(&block, 345, 500), "d".repeat(120).as_bytes());

        // TAR-JSON-071: full-width fields are legal, one byte more is not
        let block = encode(&named(&"n".repeat(100))).unwrap();
        assert_eq!(&block[0..100], "n".repeat(100).as_bytes());
        assert_eq!(field(&block, 345, 500), b"");
        assert!(encode(&named(&"n".repeat(101))).is_none());
        let block = encode(&named(&format!("{}/{}", "p".repeat(155), "n".repeat(100)))).unwrap();
        assert_eq!(&block[0..100], "n".repeat(100).as_bytes());
        assert_eq!(&block[345..500], "p".repeat(155).as_bytes());
        assert!(encode(&named(&format!("{}/{}", "p".repeat(156), "n".repeat(100)))).is_none());
    }

    #[test]
    fn pax_record() {
        assert_eq!(
            encode_pax("é.txt", None, None),
            "15 path=é.txt\n".as_bytes()
        );
        assert_eq!(
            encode_pax("é.txt", Some("x"), Some(&[" comment=x\n".to_owned()])),
            "15 path=é.txt\n14 linkpath=x\n13 comment=x\n".as_bytes()
        );
        assert_eq!(encode_pax("", Some(""), None), b"");
    }

    #[test]
    fn add_length_powers_of_ten() {
        let rows: [(usize, &str); 9] = [
            (7, "8"),
            (8, "9"),
            (9, "11"),
            (96, "98"),
            (97, "99"),
            (98, "101"),
            (995, "998"),
            (996, "999"),
            (997, "1001"),
        ];
        for (len, expected) in rows {
            let body = format!(" k={}\n", "v".repeat(len - 4));
            assert_eq!(body.len(), len);
            assert_eq!(add_length(&body), format!("{expected}{body}"));
        }
    }

    #[test]
    fn directory_slash_and_non_ascii() {
        // TAR-JSON-067: only typeflag 5 adds the slash, type 'directory' does not
        let dir = |name: &str, typeflag_is_5: bool, type_: &str| Header {
            typeflag_is_5,
            type_: type_.to_owned(),
            ..named(name)
        };
        let block = encode(&dir("dir", true, "file")).unwrap();
        assert_eq!(field(&block, 0, 100), b"dir/");
        let block = encode(&dir("dir/", true, "file")).unwrap();
        assert_eq!(field(&block, 0, 100), b"dir/");
        let block = encode(&dir("", true, "file")).unwrap();
        assert_eq!(field(&block, 0, 100), b"/");
        let block = encode(&dir("dir", false, "directory")).unwrap();
        assert_eq!(field(&block, 0, 100), b"dir");
        assert_eq!(block[156], b'5');
        // TAR-JSON-068
        assert!(encode(&named("é.txt")).is_none());
    }

    #[test]
    fn linkname_limits() {
        let link = |linkname: &str| Header {
            linkname: Some(linkname.to_owned()),
            ..base()
        };
        let block = encode(&link(&"l".repeat(100))).unwrap();
        assert_eq!(&block[157..257], "l".repeat(100).as_bytes());
        assert!(encode(&link(&"l".repeat(101))).is_none());
        // TAR-JSON-072: no ASCII check
        let block = encode(&link("é")).unwrap();
        assert_eq!(field(&block, 157, 257), "é".as_bytes());
        // TAR-JSON-085: an empty string is falsy
        let block = encode(&link("")).unwrap();
        assert_eq!(field(&block, 157, 257), b"");
    }

    #[test]
    fn header_fields() {
        let block = encode(&Header {
            mode: 0o100644,
            uid_oct: "1750".to_owned(),
            gid_oct: "1751".to_owned(),
            size: 19.0,
            size_oct: "23".to_owned(),
            mtime: 1357223198000.0,
            uname: Some("user".to_owned()),
            gname: Some("group".to_owned()),
            devmajor_oct: "10".to_owned(),
            ..base()
        })
        .unwrap();
        assert_eq!(field(&block, 0, 100), b"a.txt");
        assert_eq!(
            &block[100..157],
            b"000644 \x00001750 \x00001751 \x0000000000023 12071312436 012207 \x000"
        );
        assert_eq!(field(&block, 157, 257), b"");
        assert_eq!(&block[257..265], b"ustar\x0000");
        assert_eq!(field(&block, 265, 297), b"user");
        assert_eq!(field(&block, 297, 329), b"group");
        assert_eq!(&block[329..345], b"000010 \x00000000 \0");
        assert!(block[345..].iter().all(|&b| b == 0));

        let block = encode(&base()).unwrap();
        assert_eq!(&block[148..156], b"010134 \0");
    }

    #[test]
    fn uname_gname_overflow() {
        // TAR-JSON-088 (P12)
        let block = encode(&Header {
            uname: Some("u".repeat(40)),
            gname: Some("g".repeat(60)),
            ..base()
        })
        .unwrap();
        let expected = format!(
            "{}{}000000 g000000 {}",
            "u".repeat(32),
            "g".repeat(32),
            "g".repeat(13)
        );
        assert_eq!(&block[265..357], expected.as_bytes());
        assert_eq!(block[357], 0);
        assert_eq!(&block[148..156], b"030576 \0");

        // Buffer.write stops at the end of the block
        let block = encode(&Header {
            uname: Some("u".repeat(300)),
            ..base()
        })
        .unwrap();
        assert_eq!(&block[500..512], b"uuuuuuuuuuuu");
        assert_eq!(&block[148..156], b"075331 \0");
    }

    #[test]
    fn to_typeflag_vectors() {
        let rows: [(&str, u8); 11] = [
            ("file", 48),
            ("link", 49),
            ("symlink", 50),
            ("character-device", 51),
            ("block-device", 52),
            ("directory", 53),
            ("fifo", 54),
            ("contiguous-file", 55),
            ("pax-header", 120),
            ("pax-global-header", 48),
            ("", 48),
        ];
        for (type_, expected) in rows {
            let block = encode(&Header {
                type_: type_.to_owned(),
                ..base()
            })
            .unwrap();
            assert_eq!(block[156], expected, "type {type_}");
        }
    }

    #[test]
    fn encode_oct_vectors() {
        assert_eq!(encode_oct("644", 6), "000644 ");
        assert_eq!(encode_oct("777777", 6), "777777 ");
        assert_eq!(encode_oct("1000000", 6), "777777 ");
        assert_eq!(encode_oct("-1", 11), "000000000-1 ");
        assert_eq!(encode_oct("-20000000000", 11), "77777777777 ");
        assert_eq!(encode_oct("1.4", 6), "0001.4 ");
    }

    #[test]
    fn encode_size_vectors() {
        // TAR-JSON-076: 8589934591 is the largest octal size
        let block = encode(&Header {
            size: 8589934591.0,
            size_oct: "77777777777".to_owned(),
            ..base()
        })
        .unwrap();
        assert_eq!(&block[124..136], b"77777777777 ");
        // TAR-JSON-077
        let block = encode(&Header {
            size: 8589934597.0,
            size_oct: "100000000005".to_owned(),
            ..base()
        })
        .unwrap();
        assert_eq!(
            &block[124..136],
            &[0x80u8, 0, 0, 0, 0, 0, 0, 0x02, 0, 0, 0, 0x05]
        );

        let mut buf = [0u8; 512];
        encode_size_bin(8589934597.0, &mut buf, 124);
        assert_eq!(
            &buf[124..136],
            &[0x80u8, 0, 0, 0, 0, 0, 0, 0x02, 0, 0, 0, 0x05]
        );
    }

    #[test]
    fn cksum_skips_its_own_field() {
        let mut block = [0u8; 512];
        assert_eq!(cksum(&block), 256);
        block[0] = 1;
        block[147] = 2;
        block[148] = 0xff;
        block[155] = 0xff;
        block[156] = 3;
        block[511] = 0xff;
        assert_eq!(cksum(&block), 256 + 1 + 2 + 3 + 255);
    }
}
