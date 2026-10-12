// Golden byte tests and the shared sanitizer vectors (PORTING.md 14.3). The expected bytes
// and tables under golden/ are written by scripts/capture-golden.mjs from the upstream
// packages; nothing here is obtained by running the port.

use std::io::Read;

use flate2::read::DeflateDecoder;
use ykk_core::crc32;
use ykk_core::tar::{overflow, Header, Pack};
use ykk_core::zip::utils::{normalize_path, sanitize_path};
use ykk_core::zip::{
    DateFields, Encryption, EntryOptions, EntryStatus, Source, ZipEntryData, ZipStream,
};

#[rustfmt::skip]
#[path = "golden/scenarios.rs"]
mod scenarios;
#[rustfmt::skip]
#[path = "golden/sanitize_path_vectors.rs"]
mod sanitize_path_vectors;

use sanitize_path_vectors::SANITIZE_PATH_VECTORS;
use scenarios::{TAR_SCENARIOS, UPSTREAM_VERSIONS, ZIP_SCENARIOS};

pub enum Payload {
    Buffer(&'static [u8]),
    Stream(&'static [&'static [u8]]), // fed with one write_data per chunk
}

pub enum Compare {
    Bytes,
    Structure, // headers equal, payload compared after inflating
}

pub struct ZipEntry {
    pub name: &'static str,
    pub date: [f64; 6], // DateFields in declaration order; f64::NAN for an Invalid Date
    pub name_prepend_slash: bool,
    pub store: bool,
    pub comment: &'static str,
    pub mode: Option<i32>,
    pub payload: Payload,
}

pub struct ZipScenario {
    pub name: &'static str, // file stem of the .bin
    pub encryption: u8,     // 0, 1, 2 as WasmZipStream::new
    pub force_zip64: bool,
    pub level: i32,
    pub archive_comment: &'static str,
    pub key: &'static [u8],
    pub random: &'static [u8], // the same for every entry of the scenario
    pub entries: &'static [ZipEntry],
    pub compare: Compare,
    pub expected: &'static [u8], // include_bytes!("<name>.bin")
}

// field for field ykk_core::tar::Header
pub struct TarHeader {
    pub name: &'static str,
    pub typeflag_is_5: bool,
    pub mode: i32,
    pub uid_oct: &'static str,
    pub gid_oct: &'static str,
    pub size: f64,
    pub size_oct: &'static str,
    pub mtime: f64,
    pub type_: &'static str,
    pub linkname: Option<&'static str>,
    pub uname: Option<&'static str>,
    pub gname: Option<&'static str>,
    pub devmajor_oct: &'static str,
    pub devminor_oct: &'static str,
}

pub struct TarEntry {
    pub header: TarHeader,
    pub pax: Option<&'static [&'static str]>,
    pub body: &'static [u8],
}

pub struct TarScenario {
    pub name: &'static str,
    pub entries: &'static [TarEntry],
    pub expected: &'static [u8],
}

// PORTING.md 14.3 (Compare::Bytes)
fn assert_same_bytes(name: &str, got: &[u8], expected: &[u8]) {
    let first = got.iter().zip(expected).position(|(g, e)| g != e);
    assert!(
        got == expected,
        "{name}: {} bytes, upstream wrote {} bytes, first difference at {:?} (upstream: {:?})",
        got.len(),
        expected.len(),
        first,
        UPSTREAM_VERSIONS,
    );
}

// PORTING.md 17.1 (little-endian field reads)
fn u16_at(buf: &[u8], pos: usize) -> usize {
    u16::from_le_bytes([buf[pos], buf[pos + 1]]) as usize
}

// PORTING.md 17.1 (little-endian field reads)
fn u32_at(buf: &[u8], pos: usize) -> u64 {
    u32::from_le_bytes([buf[pos], buf[pos + 1], buf[pos + 2], buf[pos + 3]]) as u64
}

// PORTING.md 17.1 (little-endian field reads)
fn u64_at(buf: &[u8], pos: usize) -> u64 {
    let mut bytes = [0u8; 8];
    bytes.copy_from_slice(&buf[pos..pos + 8]);
    u64::from_le_bytes(bytes)
}

// One entry of a zip archive, PORTING.md 17.1. `central` has the compressed size and the
// local header offset zeroed, also inside a zip64 extra.
struct Record<'a> {
    local: &'a [u8],
    payload: &'a [u8],
    descriptor: &'a [u8],
    central: Vec<u8>,
    flags: usize,
    method: usize,
}

// `end` is every record after the central directory, with the central directory size and
// offset zeroed.
struct Records<'a> {
    records: Vec<Record<'a>>,
    end: Vec<u8>,
}

struct CentralHeader {
    bytes: Vec<u8>,
    flags: usize,
    method: usize,
    compressed_size: usize,
    offset: usize,
}

// PORTING.md 14.2 (deflated zip: parse both archives entry by entry), 17.1
fn parse_zip(buf: &[u8]) -> Records<'_> {
    let eocd = (0..=buf.len().saturating_sub(22))
        .rev()
        .find(|&pos| {
            buf[pos..pos + 4] == [0x50, 0x4b, 0x05, 0x06]
                && pos + 22 + u16_at(buf, pos + 20) == buf.len()
        })
        .expect("end of central directory record");
    let mut count = u16_at(buf, eocd + 10) as u64;
    let mut central_size = u32_at(buf, eocd + 12);
    let mut central_offset = u32_at(buf, eocd + 16);
    let mut zip64_eocd = None;
    if count == 0xffff || central_size == 0xffff_ffff || central_offset == 0xffff_ffff {
        let locator = eocd - 20;
        assert_eq!(buf[locator..locator + 4], [0x50, 0x4b, 0x06, 0x07]);
        let pos = u64_at(buf, locator + 8) as usize;
        assert_eq!(buf[pos..pos + 4], [0x50, 0x4b, 0x06, 0x06]);
        count = u64_at(buf, pos + 32);
        central_size = u64_at(buf, pos + 40);
        central_offset = u64_at(buf, pos + 48);
        zip64_eocd = Some((pos, locator));
    }
    let central_start = central_offset as usize;
    let central_end = central_start + central_size as usize;

    let mut end = buf[central_end..].to_vec();
    end[eocd - central_end + 12..eocd - central_end + 20].fill(0);
    if let Some((pos, locator)) = zip64_eocd {
        end[pos - central_end + 40..pos - central_end + 56].fill(0);
        end[locator - central_end + 8..locator - central_end + 16].fill(0);
    }

    let mut headers = Vec::new();
    let mut pos = central_start;
    for _ in 0..count {
        assert_eq!(buf[pos..pos + 4], [0x50, 0x4b, 0x01, 0x02]);
        let name_len = u16_at(buf, pos + 28);
        let extra_len = u16_at(buf, pos + 30);
        let comment_len = u16_at(buf, pos + 32);
        let len = 46 + name_len + extra_len + comment_len;
        let mut compressed_size = u32_at(buf, pos + 20);
        let mut offset = u32_at(buf, pos + 42);
        let mut bytes = buf[pos..pos + len].to_vec();
        bytes[20..24].fill(0);
        bytes[42..46].fill(0);
        let mut field = 46 + name_len;
        let extra_end = field + extra_len;
        while field + 4 <= extra_end {
            let id = u16_at(buf, pos + field);
            let size = u16_at(buf, pos + field + 2);
            if id == 0x0001 && size == 24 {
                compressed_size = u64_at(buf, pos + field + 12);
                offset = u64_at(buf, pos + field + 20);
                bytes[field + 12..field + 28].fill(0);
            }
            field += 4 + size;
        }
        headers.push(CentralHeader {
            bytes,
            flags: u16_at(buf, pos + 8),
            method: u16_at(buf, pos + 10),
            compressed_size: compressed_size as usize,
            offset: offset as usize,
        });
        pos += len;
    }
    assert_eq!(pos, central_end);

    let starts: Vec<usize> = headers
        .iter()
        .map(|header| header.offset)
        .chain([central_start])
        .collect();
    let mut records = Vec::new();
    for (i, header) in headers.into_iter().enumerate() {
        let start = header.offset;
        assert_eq!(buf[start..start + 4], [0x50, 0x4b, 0x03, 0x04]);
        let data = start + 30 + u16_at(buf, start + 26) + u16_at(buf, start + 28);
        let data_end = data + header.compressed_size;
        records.push(Record {
            local: &buf[start..data],
            payload: &buf[data..data_end],
            descriptor: &buf[data_end..starts[i + 1]],
            central: header.bytes,
            flags: header.flags,
            method: header.method,
        });
    }
    Records { records, end }
}

// PORTING.md 14.2 (deflated zip: equal inflated payload, csize == payload length)
fn inflate(payload: &[u8]) -> Vec<u8> {
    let mut out = Vec::new();
    let mut decoder = DeflateDecoder::new(payload);
    decoder
        .read_to_end(&mut out)
        .expect("a complete deflate stream");
    assert_eq!(
        decoder.total_in(),
        payload.len() as u64,
        "bytes after the final deflate block"
    );
    out
}

// PORTING.md 14.2 (the deflated-zip rule)
fn assert_same_structure(name: &str, got: &[u8], expected: &[u8]) {
    let got = parse_zip(got);
    let expected = parse_zip(expected);
    assert_eq!(
        got.records.len(),
        expected.records.len(),
        "{name}: entry count"
    );
    for (i, (g, e)) in got.records.iter().zip(&expected.records).enumerate() {
        assert_eq!(g.local, e.local, "{name}: local header of entry {i}");
        if e.method == 8 {
            assert_eq!(g.method, 8, "{name}: method of entry {i}");
            assert!(
                inflate(g.payload) == inflate(e.payload),
                "{name}: inflated payload of entry {i}"
            );
        } else {
            assert!(g.payload == e.payload, "{name}: payload of entry {i}");
        }
        if e.flags & 0x0008 != 0 {
            let width = match e.descriptor.len() {
                16 => 4,
                24 => 8,
                len => panic!("{name}: upstream data descriptor of entry {i} has {len} bytes"),
            };
            assert_eq!(
                g.descriptor.len(),
                e.descriptor.len(),
                "{name}: data descriptor length of entry {i}"
            );
            assert_eq!(
                g.descriptor[..8],
                e.descriptor[..8],
                "{name}: data descriptor signature and CRC of entry {i}"
            );
            assert_eq!(
                g.descriptor[8 + width..],
                e.descriptor[8 + width..],
                "{name}: data descriptor size of entry {i}"
            );
            let compressed_size = if width == 4 {
                u32_at(g.descriptor, 8)
            } else {
                u64_at(g.descriptor, 8)
            };
            assert_eq!(
                compressed_size,
                g.payload.len() as u64,
                "{name}: data descriptor compressed size of entry {i}"
            );
        } else {
            assert_eq!(
                g.descriptor, e.descriptor,
                "{name}: bytes after the payload of entry {i}"
            );
        }
        assert_eq!(g.central, e.central, "{name}: central header of entry {i}");
    }
    assert_eq!(got.end, expected.end, "{name}: end records");
}

// PORTING.md 7.5 (SmartStream._flush: ZipCrypto hands its compressed bytes out and takes them back after the local header)
fn end_data(zip: &mut ZipStream, encryption: Encryption, result: &mut Vec<u8>) {
    if encryption != Encryption::ZipCrypto {
        zip.inner.end_data().unwrap();
        return;
    }
    let buffered_data = zip.inner.take_output();
    zip.inner.end_data().unwrap();
    result.extend_from_slice(&zip.inner.take_output());
    if !buffered_data.is_empty() {
        zip.inner.encrypt_data(&buffered_data).unwrap();
    }
    zip.inner.encrypt_end().unwrap();
}

// PORTING.md 14.3 (a zip scenario is replayed through ZipStream)
fn replay_zip(scenario: &ZipScenario) -> Vec<u8> {
    let encryption = match scenario.encryption {
        0 => Encryption::None,
        1 => Encryption::ZipCrypto,
        2 => Encryption::Aes256,
        other => panic!("{}: unknown encryption {other}", scenario.name),
    };
    let mut zip = ZipStream::new(scenario.force_zip64, encryption);
    let opts = EntryOptions {
        level: scenario.level,
        key: scenario.key.to_vec(),
        random: scenario.random.to_vec(),
    };
    let mut result = Vec::new();
    for entry in scenario.entries {
        let data = ZipEntryData {
            name: entry.name.to_owned(),
            date: DateFields {
                year: entry.date[0],
                month: entry.date[1],
                date: entry.date[2],
                hours: entry.date[3],
                minutes: entry.date[4],
                seconds: entry.date[5],
            },
            name_prepend_slash: entry.name_prepend_slash,
            store: entry.store,
            comment: entry.comment.to_owned(),
            mode: entry.mode,
        };
        match entry.payload {
            Payload::Buffer(payload) => {
                let source = Source::Buffer {
                    len: payload.len() as u64,
                    crc: crc32::buf(payload, 0),
                };
                let status = zip.entry(source, &data, &opts).unwrap();
                if status == EntryStatus::StoredBuffer {
                    result.extend_from_slice(&zip.inner.take_output());
                    result.extend_from_slice(payload);
                    zip.inner.complete_stored().unwrap();
                } else {
                    result.extend_from_slice(&zip.inner.take_output());
                    if !payload.is_empty() {
                        zip.inner.write_data(payload).unwrap();
                    }
                    end_data(&mut zip, encryption, &mut result);
                }
            }
            Payload::Stream(chunks) => {
                zip.entry(Source::Stream, &data, &opts).unwrap();
                result.extend_from_slice(&zip.inner.take_output());
                for chunk in chunks {
                    zip.inner.write_data(chunk).unwrap();
                }
                end_data(&mut zip, encryption, &mut result);
            }
        }
    }
    zip.inner.set_comment(scenario.archive_comment);
    zip.inner.finish();
    result.extend_from_slice(&zip.inner.take_output());
    result
}

// PORTING.md 14.3 (a tar scenario is replayed through Pack)
fn replay_tar(scenario: &TarScenario) -> Vec<u8> {
    let mut pack = Pack::new();
    for entry in scenario.entries {
        let header = Header {
            name: entry.header.name.to_owned(),
            typeflag_is_5: entry.header.typeflag_is_5,
            mode: entry.header.mode,
            uid_oct: entry.header.uid_oct.to_owned(),
            gid_oct: entry.header.gid_oct.to_owned(),
            size: entry.header.size,
            size_oct: entry.header.size_oct.to_owned(),
            mtime: entry.header.mtime,
            type_: entry.header.type_.to_owned(),
            linkname: entry.header.linkname.map(str::to_owned),
            uname: entry.header.uname.map(str::to_owned),
            gname: entry.header.gname.map(str::to_owned),
            devmajor_oct: entry.header.devmajor_oct.to_owned(),
            devminor_oct: entry.header.devminor_oct.to_owned(),
        };
        let pax: Option<Vec<String>> = entry
            .pax
            .map(|records| records.iter().map(|record| (*record).to_owned()).collect());
        pack._encode(&header, pax.as_deref());
        pack.push(entry.body);
        overflow(&mut pack, header.size);
    }
    pack.finalize();
    pack.take_output()
}

#[test]
fn zip_scenarios() {
    assert!(!ZIP_SCENARIOS.is_empty());
    for scenario in ZIP_SCENARIOS {
        let got = replay_zip(scenario);
        match scenario.compare {
            Compare::Bytes => assert_same_bytes(scenario.name, &got, scenario.expected),
            Compare::Structure => {
                assert_eq!(
                    scenario.encryption, 0,
                    "{}: a structure comparison reads the payload without decrypting it",
                    scenario.name
                );
                assert_same_structure(scenario.name, &got, scenario.expected);
            }
        }
    }
}

#[test]
fn tar_scenarios() {
    assert!(!TAR_SCENARIOS.is_empty());
    for scenario in TAR_SCENARIOS {
        let got = replay_tar(scenario);
        assert_same_bytes(scenario.name, &got, scenario.expected);
    }
}

#[test]
fn sanitize_path_vectors() {
    assert!(!SANITIZE_PATH_VECTORS.is_empty());
    for &(input, normalized, sanitized) in SANITIZE_PATH_VECTORS {
        assert_eq!(
            normalize_path(input, false),
            normalized,
            "normalize_path({input:?}, false)"
        );
        assert_eq!(sanitize_path(input), sanitized, "sanitize_path({input:?})");
    }
}
