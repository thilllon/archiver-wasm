// Port of deps/compress-commons/lib/archivers/archive-entry.js.
use super::util::DateFields;

// deps/compress-commons/lib/archivers/archive-entry.js:1-6 (the instanceof marker becomes a trait, PORTING.md 6.7)
pub trait ArchiveEntry {
    fn get_name(&self) -> Option<&str>;
    fn get_size(&self) -> u64;
    fn get_last_modified_date(&self) -> Option<DateFields>;
    fn is_directory(&self) -> bool;
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::zip::zip_archive_entry::ZipArchiveEntry;

    #[test]
    fn zip_archive_entry_is_an_archive_entry() {
        let mut entry = ZipArchiveEntry::new(Some("dir/"));
        entry.set_size(7);
        let ae: &dyn ArchiveEntry = &entry;
        assert_eq!(ae.get_name(), Some("dir/"));
        assert_eq!(ae.get_size(), 7);
        assert_eq!(ae.get_last_modified_date(), None);
        assert!(ae.is_directory());

        entry.set_time(&DateFields {
            year: 2013.0,
            month: 0.0,
            date: 3.0,
            hours: 14.0,
            minutes: 26.0,
            seconds: 38.0,
        });
        let ae: &dyn ArchiveEntry = &entry;
        assert_eq!(ae.get_last_modified_date(), entry.get_time());
        assert!(ae.get_last_modified_date().is_some());
    }

    #[test]
    fn unnamed_entry_through_the_trait() {
        let entry = ZipArchiveEntry::new(None);
        let ae: &dyn ArchiveEntry = &entry;
        assert_eq!(ae.get_name(), None);
        assert_eq!(ae.get_size(), 0);
        assert!(!ae.is_directory());
    }
}
