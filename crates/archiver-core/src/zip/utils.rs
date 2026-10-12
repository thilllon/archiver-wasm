// Port of node-archiver/node_modules/normalize-path/index.js and of sanitizePath in
// deps/zip-stream/utils.js. dateify (deps/zip-stream/utils.js:3-15) is TypeScript.
use crate::numeric::utf16_len;

// node-archiver/node_modules/normalize-path/index.js:8-35
pub fn normalize_path(path: &str, strip_trailing: bool) -> String {
    let mut path = path;

    if path == "\\" || path == "/" {
        return "/".to_owned();
    }

    let len = utf16_len(path);
    if len <= 1 {
        return path.to_owned();
    }

    // ensure that win32 namespaces has two leading slashes, so that the path is
    // handled properly by the win32 version of path.parse() after being normalized
    // https://msdn.microsoft.com/library/windows/desktop/aa365247(v=vs.85).aspx#namespaces
    let mut prefix = "";
    if len > 4 && path.as_bytes().get(3) == Some(&b'\\') {
        let ch = path.as_bytes().get(2);
        if (ch == Some(&b'?') || ch == Some(&b'.')) && path.starts_with("\\\\") {
            path = &path[2..];
            prefix = "//";
        }
    }

    // path.split(/[/\\]+/)
    let mut segs: Vec<&str> = Vec::new();
    let mut start = 0;
    let mut in_separators = false;
    for (i, c) in path.char_indices() {
        if c == '/' || c == '\\' {
            if !in_separators {
                segs.push(&path[start..i]);
            }
            in_separators = true;
            start = i + 1;
        } else {
            in_separators = false;
        }
    }
    segs.push(&path[start..]);
    if strip_trailing && segs.last() == Some(&"") {
        segs.pop();
    }
    prefix.to_owned() + &segs.join("/")
}

// deps/zip-stream/utils.js:17-21
pub fn sanitize_path(filepath: &str) -> String {
    let normalized = normalize_path(filepath, false);
    let mut name = normalized.as_str();

    // .replace(/^\w+:/, "")
    let word = name
        .bytes()
        .take_while(|b| b.is_ascii_alphanumeric() || *b == b'_')
        .count();
    if word > 0 && name.as_bytes().get(word) == Some(&b':') {
        name = &name[word + 1..];
    }

    // .replace(/^(\.\.\/|\/)+/, "")
    loop {
        if let Some(rest) = name.strip_prefix("../") {
            name = rest;
        } else if let Some(rest) = name.strip_prefix('/') {
            name = rest;
        } else {
            break;
        }
    }

    name.to_owned()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sanitize_not_idempotent() {
        assert_eq!(sanitize_path("c:c:/x"), "c:/x");
        assert_eq!(sanitize_path("c:/x"), "x");
        assert_eq!(sanitize_path(&sanitize_path("c:c:/x")), "x");
    }

    // Every row was produced by running the upstream functions:
    // [input, normalizePath(input, false), normalizePath(input), sanitizePath(input)].
    const VECTORS: &[(&str, &str, &str, &str)] = &[
        ("c:c:/x", "c:c:/x", "c:c:/x", "c:/x"),
        ("c:/x", "c:/x", "c:/x", "x"),
        ("\\\\?\\C:\\foo", "//?/C:/foo", "//?/C:/foo", "?/C:/foo"),
        ("\\\\.\\x", "//./x", "//./x", "./x"),
        ("\\\\?\\a", "//?/a", "//?/a", "?/a"),
        ("\\\\?\\", "/?/", "/?", "?/"),
        ("a\\\\b//c/", "a/b/c/", "a/b/c", "a/b/c/"),
        ("//", "/", "", ""),
        ("\\\\", "/", "", ""),
        ("/", "/", "/", ""),
        ("\\", "/", "/", ""),
        ("", "", "", ""),
        ("a", "a", "a", "a"),
        ("é", "é", "é", "é"),
        ("..", "..", "..", ".."),
        ("../../a/../b", "../../a/../b", "../../a/../b", "a/../b"),
        ("./a", "./a", "./a", "./a"),
        ("/../..//x", "/../../x", "/../../x", "x"),
        ("..//../x", "../../x", "../../x", "x"),
        ("..a/b", "..a/b", "..a/b", "..a/b"),
        ("_w9:/q", "_w9:/q", "_w9:/q", "q"),
        (":a", ":a", ":a", ":a"),
        ("http://x/y", "http:/x/y", "http:/x/y", "x/y"),
        ("a/..", "a/..", "a/..", "a/.."),
        ("é:/x", "é:/x", "é:/x", "é:/x"),
        ("a b:/x", "a b:/x", "a b:/x", "a b:/x"),
        ("C:", "C:", "C:", ""),
        ("C:\\", "C:/", "C:", ""),
        ("/c:/x", "/c:/x", "/c:/x", "c:/x"),
        ("../c:/x", "../c:/x", "../c:/x", "c:/x"),
    ];

    #[test]
    fn normalize_path_vectors() {
        for &(input, keep_trailing, strip_trailing, _) in VECTORS {
            assert_eq!(normalize_path(input, false), keep_trailing, "{input:?}");
            assert_eq!(normalize_path(input, true), strip_trailing, "{input:?}");
        }
    }

    #[test]
    fn sanitize_path_vectors() {
        for &(input, _, _, sanitized) in VECTORS {
            assert_eq!(sanitize_path(input), sanitized, "{input:?}");
        }
    }

    #[test]
    fn non_ascii_never_panics() {
        assert_eq!(normalize_path("éé\\x\\", false), "éé/x/");
        assert_eq!(normalize_path("\\é?\\é\\", false), "/é?/é/");
        assert_eq!(normalize_path("😀", false), "😀");
        assert_eq!(sanitize_path("é😀:\\..\\x"), "é😀:/../x");
    }
}
