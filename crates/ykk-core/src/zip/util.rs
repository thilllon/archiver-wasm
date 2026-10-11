// Port of deps/compress-commons/lib/archivers/zip/util.js.
use crate::numeric::to_int32;

/// Calendar fields read from a JS Date by TypeScript with the UTC or the local getter
/// family. NaN in every field for an Invalid Date.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct DateFields {
    pub year: f64,
    pub month: f64,
    pub date: f64,
    pub hours: f64,
    pub minutes: f64,
    pub seconds: f64,
}

// deps/compress-commons/lib/archivers/zip/util.js:1-25
pub fn date_to_dos(d: &DateFields) -> u32 {
    let year = d.year;
    if year < 1980.0 {
        return 2162688; // 1980-1-1 00:00:00
    } else if year >= 2044.0 {
        return 2141175677; // 2043-12-31 23:59:58
    }
    ((to_int32(year - 1980.0) << 25)
        | (to_int32(d.month + 1.0) << 21)
        | (to_int32(d.date) << 16)
        | (to_int32(d.hours) << 11)
        | (to_int32(d.minutes) << 5)
        | to_int32(d.seconds / 2.0)) as u32
}

// deps/compress-commons/lib/archivers/zip/util.js:26-35
pub fn dos_to_date(dos: u32) -> DateFields {
    let dos = dos as i32;
    DateFields {
        year: (((dos >> 25) & 0x7f) + 1980) as f64,
        month: (((dos >> 21) & 0x0f) - 1) as f64,
        date: ((dos >> 16) & 0x1f) as f64,
        hours: ((dos >> 11) & 0x1f) as f64,
        minutes: ((dos >> 5) & 0x3f) as f64,
        seconds: ((dos & 0x1f) << 1) as f64,
    }
}

// deps/compress-commons/lib/archivers/zip/util.js:36-38
pub fn from_dos_time(buf: &[u8]) -> Option<DateFields> {
    Some(dos_to_date(get_long_bytes_value(buf, 0)?))
}

// deps/compress-commons/lib/archivers/zip/util.js:39-44
pub fn get_eight_bytes(v: u64) -> [u8; 8] {
    let mut buf = [0u8; 8];
    buf[0..4].copy_from_slice(&((v % 0x0100000000) as u32).to_le_bytes());
    buf[4..8].copy_from_slice(&((v / 0x0100000000) as u32).to_le_bytes());
    buf
}

// deps/compress-commons/lib/archivers/zip/util.js:45-49
pub fn get_short_bytes(v: u64) -> [u8; 2] {
    let mut buf = [0u8; 2];
    buf[0..2].copy_from_slice(&(v as u16).to_le_bytes());
    buf
}

// deps/compress-commons/lib/archivers/zip/util.js:50-52
pub fn get_short_bytes_value(buf: &[u8], offset: usize) -> Option<u16> {
    let b = buf.get(offset..offset.checked_add(2)?)?;
    Some(u16::from_le_bytes([b[0], b[1]]))
}

// deps/compress-commons/lib/archivers/zip/util.js:53-57
pub fn get_long_bytes(v: u64) -> [u8; 4] {
    let mut buf = [0u8; 4];
    buf[0..4].copy_from_slice(&(v as u32).to_le_bytes());
    buf
}

// deps/compress-commons/lib/archivers/zip/util.js:58-60
pub fn get_long_bytes_value(buf: &[u8], offset: usize) -> Option<u32> {
    let b = buf.get(offset..offset.checked_add(4)?)?;
    Some(u32::from_le_bytes([b[0], b[1], b[2], b[3]]))
}

// toDosTime (deps/compress-commons/lib/archivers/zip/util.js:61-63): not ported, PORTING.md N1.

#[cfg(test)]
mod tests {
    use super::*;

    fn fields(
        year: f64,
        month: f64,
        date: f64,
        hours: f64,
        minutes: f64,
        seconds: f64,
    ) -> DateFields {
        DateFields {
            year,
            month,
            date,
            hours,
            minutes,
            seconds,
        }
    }

    #[test]
    fn date_to_dos_vectors() {
        // 2013-01-03T14:26:38Z
        let dos = date_to_dos(&fields(2013.0, 0.0, 3.0, 14.0, 26.0, 38.0));
        assert_eq!(dos, 1109619539);
        assert_eq!(dos >> 16, 16931);
        assert_eq!(dos & 0xffff, 29523);
        assert_eq!(get_long_bytes(dos as u64), [0x53, 0x73, 0x23, 0x42]);

        assert_eq!(
            date_to_dos(&fields(1979.0, 11.0, 31.0, 23.0, 59.0, 59.0)),
            2162688
        );
        assert_eq!(
            date_to_dos(&fields(2044.0, 0.0, 1.0, 0.0, 0.0, 0.0)),
            2141175677
        );

        let nan = f64::NAN;
        assert_eq!(date_to_dos(&fields(nan, nan, nan, nan, nan, nan)), 0);
        assert_eq!(get_long_bytes(0), [0, 0, 0, 0]);
    }

    #[test]
    fn date_to_dos_clamp_edges() {
        assert_eq!(
            date_to_dos(&fields(1980.0, 0.0, 1.0, 0.0, 0.0, 0.0)),
            0x00210000
        );
        assert_eq!(
            date_to_dos(&fields(2043.0, 11.0, 31.0, 23.0, 59.0, 58.0)),
            0x7F9FBF7D
        );
    }

    #[test]
    fn date_to_dos_halves_seconds_with_truncation() {
        let even = date_to_dos(&fields(2013.0, 0.0, 3.0, 14.0, 26.0, 58.0));
        let odd = date_to_dos(&fields(2013.0, 0.0, 3.0, 14.0, 26.0, 59.0));
        assert_eq!(even & 0x1f, 29);
        assert_eq!(odd, even);
    }

    #[test]
    fn dos_to_date_unpacks_fields() {
        assert_eq!(
            dos_to_date(1109619539),
            fields(2013.0, 0.0, 3.0, 14.0, 26.0, 38.0)
        );
        assert_eq!(dos_to_date(0), fields(1980.0, -1.0, 0.0, 0.0, 0.0, 0.0));
        assert_eq!(
            dos_to_date(0xffffffff),
            fields(2107.0, 14.0, 31.0, 31.0, 63.0, 62.0)
        );
    }

    #[test]
    fn from_dos_time_reads_le_or_none() {
        assert_eq!(
            from_dos_time(&[0x53, 0x73, 0x23, 0x42, 0xff]),
            Some(fields(2013.0, 0.0, 3.0, 14.0, 26.0, 38.0))
        );
        assert_eq!(from_dos_time(&[0x53, 0x73, 0x23]), None);
        assert_eq!(from_dos_time(&[]), None);
    }

    #[test]
    fn eight_bytes_low_then_high_word() {
        assert_eq!(get_eight_bytes(0), [0; 8]);
        assert_eq!(
            get_eight_bytes(0x0000_0123_4567_89ab),
            [0xab, 0x89, 0x67, 0x45, 0x23, 0x01, 0x00, 0x00]
        );
        assert_eq!(get_eight_bytes(0x1_0000_0000), [0, 0, 0, 0, 1, 0, 0, 0]);
        assert_eq!(
            get_eight_bytes(0xffff_ffff),
            [0xff, 0xff, 0xff, 0xff, 0, 0, 0, 0]
        );
    }

    #[test]
    fn short_and_long_bytes_wrap() {
        assert_eq!(get_short_bytes(0x0403), [0x03, 0x04]);
        assert_eq!(get_short_bytes(65535), [0xff, 0xff]);
        assert_eq!(get_short_bytes(65536), [0, 0]);
        assert_eq!(get_short_bytes(65541), [5, 0]);
        assert_eq!(get_long_bytes(0x04034b50), [0x50, 0x4b, 0x03, 0x04]);
        assert_eq!(get_long_bytes(0xffff_ffff), [0xff, 0xff, 0xff, 0xff]);
        assert_eq!(get_long_bytes(0x1_0000_0001), [1, 0, 0, 0]);
    }

    #[test]
    fn bytes_value_reads_at_offset_or_none() {
        let buf = [0x00, 0x50, 0x4b, 0x03, 0x04];
        assert_eq!(get_short_bytes_value(&buf, 1), Some(0x4b50));
        assert_eq!(get_short_bytes_value(&buf, 3), Some(0x0403));
        assert_eq!(get_short_bytes_value(&buf, 4), None);
        assert_eq!(get_short_bytes_value(&buf, usize::MAX), None);
        assert_eq!(get_long_bytes_value(&buf, 1), Some(0x04034b50));
        assert_eq!(get_long_bytes_value(&buf, 2), None);
        assert_eq!(get_long_bytes_value(&buf, usize::MAX), None);
    }
}
