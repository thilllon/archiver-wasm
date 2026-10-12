// Rust part of deps/tar-stream/pack.js (Sink and the streamx side of Pack: PORTING.md 5.2).

use super::headers::{self, Header};
use crate::numeric::{to_int32, truthy_str};

pub const END_OF_TAR: [u8; 1024] = [0u8; 1024];

// deps/tar-stream/pack.js:127
pub struct Pack {
    pub(crate) out: Vec<u8>,
    pub _finalized: bool,
}

impl Pack {
    // deps/tar-stream/pack.js:128-135
    pub fn new() -> Self {
        Pack {
            out: Vec::new(),
            _finalized: false,
        }
    }

    // deps/tar-stream/pack.js:198 (this.push of bytes, PORTING.md 6.12)
    pub fn push(&mut self, data: &[u8]) {
        self.out.extend_from_slice(data);
    }

    // deps/tar-stream/pack.js:178-181
    pub fn finalize(&mut self) {
        if self._finalized {
            return;
        }
        self._finalized = true;

        self.push(&END_OF_TAR);
    }

    // deps/tar-stream/pack.js:194-203
    pub fn _encode(&mut self, header: &Header, pax: Option<&[String]>) {
        if pax.is_none() {
            let buf = headers::encode(header);
            if let Some(buf) = buf {
                self.push(&buf);
                return;
            }
        }
        self._encode_pax(header, pax);
    }

    // deps/tar-stream/pack.js:205-234
    pub fn _encode_pax(&mut self, header: &Header, pax: Option<&[String]>) {
        let pax_header = headers::encode_pax(&header.name, header.linkname.as_deref(), pax);

        let mut new_header = Header {
            name: "PaxHeader".to_owned(),
            typeflag_is_5: false,
            mode: header.mode,
            uid_oct: header.uid_oct.clone(),
            gid_oct: header.gid_oct.clone(),
            size: pax_header.len() as f64,
            size_oct: format!("{:o}", pax_header.len()),
            mtime: header.mtime,
            type_: "pax-header".to_owned(),
            linkname: truthy_str(&header.linkname).map(|_| "PaxHeader".to_owned()),
            uname: header.uname.clone(),
            gname: header.gname.clone(),
            devmajor_oct: header.devmajor_oct.clone(),
            devminor_oct: header.devminor_oct.clone(),
        };

        if let Some(buf) = headers::encode(&new_header) {
            self.push(&buf);
        }
        self.push(&pax_header);
        overflow(self, pax_header.len() as f64);

        new_header.size = header.size;
        new_header.size_oct = header.size_oct.clone();
        new_header.type_ = header.type_.clone();
        if let Some(buf) = headers::encode(&new_header) {
            self.push(&buf);
        }
    }

    // PORTING.md 5.4
    pub fn take_output(&mut self) -> Vec<u8> {
        std::mem::take(&mut self.out)
    }
}

// deps/tar-stream/pack.js:280-283
pub fn overflow(pack: &mut Pack, size: f64) {
    let size = to_int32(size) & 511;
    if size != 0 {
        pack.push(&END_OF_TAR[..(512 - size) as usize]);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn header(name: &str, type_: &str, linkname: Option<&str>) -> Header {
        Header {
            name: name.to_owned(),
            typeflag_is_5: false,
            mode: 0o644,
            uid_oct: "0".to_owned(),
            gid_oct: "0".to_owned(),
            size: 0.0,
            size_oct: "0".to_owned(),
            mtime: 1357223198000.0,
            type_: type_.to_owned(),
            linkname: linkname.map(str::to_owned),
            uname: None,
            gname: None,
            devmajor_oct: "0".to_owned(),
            devminor_oct: "0".to_owned(),
        }
    }

    #[test]
    fn overflow_and_end() {
        let mut pack = Pack::new();
        overflow(&mut pack, 0.0);
        assert_eq!(pack.take_output(), b"");
        overflow(&mut pack, 512.0);
        assert_eq!(pack.take_output(), b"");
        overflow(&mut pack, 513.0);
        assert_eq!(pack.take_output(), vec![0u8; 511]);
        // ToInt32 keeps the low 9 bits of a size above 2^31
        overflow(&mut pack, 8589934597.0);
        assert_eq!(pack.take_output(), vec![0u8; 507]);

        assert!(!pack._finalized);
        pack.finalize();
        assert!(pack._finalized);
        assert_eq!(pack.take_output(), vec![0u8; 1024]);
        pack.finalize();
        assert_eq!(pack.take_output(), b"");
        assert_eq!(END_OF_TAR.len(), 1024);
    }

    #[test]
    fn encode_ustar() {
        let mut pack = Pack::new();
        let mut file = header("a.txt", "file", None);
        file.size = 2.0;
        file.size_oct = "2".to_owned();
        pack._encode(&file, None);
        pack.push(b"hi");
        overflow(&mut pack, file.size);
        pack.finalize();
        let out = pack.take_output();
        assert_eq!(out.len(), 2048);
        assert_eq!(&out[0..6], b"a.txt\0");
        assert_eq!(&out[148..157], b"010174 \x000");
        assert_eq!(&out[512..514], b"hi");
        assert!(out[514..].iter().all(|&b| b == 0));
    }

    #[test]
    fn encode_pax_fallback() {
        // TAR-JSON-057: a non-ASCII name with body 'hi' gives 3072 bytes
        let mut pack = Pack::new();
        let mut file = header("é.txt", "file", None);
        file.size = 2.0;
        file.size_oct = "2".to_owned();
        pack._encode(&file, None);
        pack.push(b"hi");
        overflow(&mut pack, file.size);
        pack.finalize();
        let out = pack.take_output();
        assert_eq!(out.len(), 3072);
        assert_eq!(&out[0..10], b"PaxHeader\0");
        assert_eq!(&out[124..136], b"00000000017 ");
        assert_eq!(&out[148..157], b"011115 \0x");
        assert_eq!(out[157], 0);
        assert_eq!(&out[512..527], "15 path=é.txt\n".as_bytes());
        assert!(out[527..1024].iter().all(|&b| b == 0));
        assert_eq!(&out[1024..1034], b"PaxHeader\0");
        assert_eq!(&out[1148..1160], b"00000000002 ");
        assert_eq!(&out[1172..1181], b"010777 \x000");
        assert_eq!(out[1181], 0);
        assert_eq!(&out[1536..1538], b"hi");
        assert!(out[1538..].iter().all(|&b| b == 0));
    }

    #[test]
    fn encode_forced_pax_with_linkname() {
        // TAR-JSON-056, TAR-JSON-059: pax forced; both headers carry linkname PaxHeader
        let mut pack = Pack::new();
        let link = header("s", "symlink", Some("t"));
        pack._encode(&link, Some(&[" comment=x\n".to_owned()]));
        overflow(&mut pack, link.size);
        pack.finalize();
        let out = pack.take_output();
        assert_eq!(out.len(), 2560);
        assert_eq!(&out[0..10], b"PaxHeader\0");
        assert_eq!(&out[124..136], b"00000000044 ");
        assert_eq!(&out[148..157], b"012677 \0x");
        assert_eq!(&out[157..167], b"PaxHeader\0");
        assert_eq!(&out[512..548], b"9 path=s\n14 linkpath=t\n13 comment=x\n");
        assert!(out[548..1024].iter().all(|&b| b == 0));
        assert_eq!(&out[1024..1034], b"PaxHeader\0");
        assert_eq!(&out[1148..1160], b"00000000000 ");
        assert_eq!(&out[1172..1181], b"012561 \x002");
        assert_eq!(&out[1181..1191], b"PaxHeader\0");

        // an empty pax list is still Some: the pax path is taken
        let mut pack = Pack::new();
        pack._encode(&header("a.txt", "file", None), Some(&[]));
        assert_eq!(pack.take_output().len(), 1536);
    }
}
