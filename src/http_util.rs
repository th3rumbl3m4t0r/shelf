use std::time::{Duration, UNIX_EPOCH};

use axum::{
    body::Body,
    http::{header, HeaderMap, StatusCode},
    response::{IntoResponse, Response},
};
use percent_encoding::{utf8_percent_encode, AsciiSet, NON_ALPHANUMERIC};
use tokio::io::{AsyncReadExt, AsyncSeekExt, SeekFrom};
use tokio_util::io::ReaderStream;

use crate::{
    error::AppError,
    vfs::{Entry, FsError, ReadSeek, RelPath},
};

/// Raw files are served from the app's origin, so anything that could run
/// script is either downgraded to text/plain or sandboxed.
const SANDBOX: &str = "sandbox; default-src 'none'; img-src 'self' data:; media-src 'self'; style-src 'unsafe-inline'";

/// (content type, sandbox it?)
pub fn content_type(name: &str) -> (String, bool) {
    let ext = name.rsplit_once('.').map(|(_, e)| e.to_ascii_lowercase()).unwrap_or_default();
    let m = mime_guess::from_ext(&ext).first_or_octet_stream();
    let ess = m.essence_str();
    if matches!(ess, "text/html" | "application/xhtml+xml" | "text/xml" | "application/xml") {
        return ("text/plain; charset=utf-8".into(), true);
    }
    if ess == "application/pdf" {
        // browsers refuse to show a PDF in a sandboxed document
        return (ess.into(), false);
    }
    let texty = m.type_() == "text"
        || matches!(ess, "application/json" | "application/javascript" | "application/toml" | "application/x-sh")
        || matches!(ext.as_str(), "md" | "srt" | "log" | "conf" | "ini" | "yaml" | "yml" | "rs" | "ts");
    if texty {
        let t = match ext.as_str() {
            "md" => "text/markdown",
            "vtt" => "text/vtt",
            "srt" | "log" | "conf" | "ini" | "rs" | "ts" => "text/plain",
            "yaml" | "yml" => "text/yaml",
            _ => ess,
        };
        return (format!("{t}; charset=utf-8"), true);
    }
    (ess.into(), true)
}

pub fn disposition(name: &str, attachment: bool) -> String {
    let ascii: String = name
        .chars()
        .map(|c| if (c.is_ascii_graphic() || c == ' ') && c != '"' && c != '\\' { c } else { '_' })
        .collect();
    let kind = if attachment { "attachment" } else { "inline" };
    format!("{kind}; filename=\"{ascii}\"; filename*=UTF-8''{}", utf8_percent_encode(name, NON_ALPHANUMERIC))
}

const SEGMENT: &AsciiSet = &NON_ALPHANUMERIC.remove(b'-').remove(b'_').remove(b'.').remove(b'~');

/// `/a b/c` -> `/a%20b/c`; root is the empty string
pub fn encode_path(p: &RelPath) -> String {
    p.segs().iter().map(|s| format!("/{}", utf8_percent_encode(s, SEGMENT))).collect()
}

/// One `bytes=` range. None: no usable range, send everything; Err: unsatisfiable.
pub fn parse_range(h: &str, size: u64) -> Option<Result<(u64, u64), ()>> {
    let spec = h.trim().strip_prefix("bytes=")?;
    if spec.contains(',') {
        return None;
    }
    let (a, b) = spec.split_once('-')?;
    let (a, b) = (a.trim(), b.trim());
    if a.is_empty() {
        let n: u64 = b.parse().ok()?;
        if n == 0 || size == 0 {
            return Some(Err(()));
        }
        return Some(Ok((size.saturating_sub(n), size - 1)));
    }
    let start: u64 = a.parse().ok()?;
    let end = if b.is_empty() { size.saturating_sub(1) } else { b.parse::<u64>().ok()?.min(size.saturating_sub(1)) };
    if start >= size || start > end {
        return Some(Err(()));
    }
    Some(Ok((start, end)))
}

/// Stream a file with ETag / Range support (seeking in videos).
///
/// `probe`: the edge asks whether it may send its copy (`edge::probe`). The
/// answer is the response it should give, minus the body, plus the cache key
/// and the file size; the edge serves the range from its copy if the ETag
/// still matches, or fetches the body.
pub async fn serve(
    e: Entry,
    mut r: Box<dyn ReadSeek>,
    req: &HeaderMap,
    name: &str,
    attachment: bool,
    public: bool,
    probe: Option<String>,
) -> Response {
    let etag = e.etag();
    let (ctype, sandbox) = content_type(name);
    let mut b = Response::builder()
        .header(header::ETAG, &etag)
        .header(header::LAST_MODIFIED, httpdate::fmt_http_date(UNIX_EPOCH + Duration::from_secs(e.mtime.max(0) as u64)))
        .header(header::ACCEPT_RANGES, "bytes")
        // a cache may keep it, but has to revalidate
        .header(header::CACHE_CONTROL, if public { "public, no-cache" } else { "private, no-cache" })
        .header(header::CONTENT_TYPE, ctype)
        .header(header::CONTENT_DISPOSITION, disposition(name, attachment));
    if sandbox {
        b = b.header(header::CONTENT_SECURITY_POLICY, SANDBOX);
    }
    let inm = req.get(header::IF_NONE_MATCH).and_then(|v| v.to_str().ok());
    if inm.is_some_and(|v| v.split(',').any(|t| t.trim() == etag || t.trim() == "*")) {
        return b.status(StatusCode::NOT_MODIFIED).body(Body::empty()).unwrap();
    }
    // A cache asking for part of its copy, with a validator that did not match
    // above, gets the whole file: its copy is outdated. Chromium asks for its
    // copy's length this way, and would show (and hand an editor) the new
    // file cut at the old length. If-Modified-Since never gives a 304 here,
    // its seconds miss a second save within the same second.
    let outdated = inm.is_some() || req.contains_key(header::IF_MODIFIED_SINCE);
    let if_range_ok = !outdated && req.get(header::IF_RANGE).and_then(|v| v.to_str().ok()).is_none_or(|v| v == etag);
    let range = req
        .get(header::RANGE)
        .and_then(|v| v.to_str().ok())
        // an empty file has no satisfiable range; just send it
        .filter(|_| if_range_ok && e.size > 0)
        .and_then(|h| parse_range(h, e.size));
    let (status, start, len) = match range {
        None => (StatusCode::OK, 0, e.size),
        Some(Err(())) => {
            return b
                .status(StatusCode::RANGE_NOT_SATISFIABLE)
                .header(header::CONTENT_RANGE, format!("bytes */{}", e.size))
                .body(Body::empty())
                .unwrap();
        }
        Some(Ok((s, end))) => {
            b = b.header(header::CONTENT_RANGE, format!("bytes {s}-{end}/{}", e.size));
            (StatusCode::PARTIAL_CONTENT, s, end - s + 1)
        }
    };
    if let Some(key) = probe {
        return b.status(status).header("x-shelf-cache", key).header("x-shelf-size", e.size).body(Body::empty()).unwrap();
    }
    if start > 0 {
        if let Err(err) = r.seek(SeekFrom::Start(start)).await {
            return AppError::from(FsError::from(err)).into_response();
        }
    }
    let body = Body::from_stream(ReaderStream::with_capacity(r.take(len), 256 * 1024));
    b.status(status).header(header::CONTENT_LENGTH, len).body(body).unwrap()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ranges() {
        assert_eq!(parse_range("bytes=0-", 10), Some(Ok((0, 9))));
        assert_eq!(parse_range("bytes=2-4", 10), Some(Ok((2, 4))));
        assert_eq!(parse_range("bytes=5-100", 10), Some(Ok((5, 9))));
        assert_eq!(parse_range("bytes=-3", 10), Some(Ok((7, 9))));
        assert_eq!(parse_range("bytes=10-", 10), Some(Err(())));
        assert_eq!(parse_range("bytes=0-1,4-5", 10), None);
        assert_eq!(parse_range("items=0-1", 10), None);
    }

    /// What a GET of a 22-byte file answers to `headers`: status, Content-Range, body length.
    async fn get(headers: &[(header::HeaderName, &str)]) -> (StatusCode, Option<String>, usize) {
        let e = Entry { name: "n.md".into(), is_dir: false, size: 22, mtime: 1_800_000_000, nanos: 7 };
        let mut req = HeaderMap::new();
        for (k, v) in headers {
            req.insert(k, v.parse().unwrap());
        }
        let r = serve(e, Box::new(std::io::Cursor::new(vec![b'x'; 22])), &req, "n.md", false, false, None).await;
        let range = r.headers().get(header::CONTENT_RANGE).map(|v| v.to_str().unwrap().to_string());
        let status = r.status();
        let body = axum::body::to_bytes(r.into_body(), 1 << 20).await.unwrap();
        (status, range, body.len())
    }

    #[tokio::test]
    async fn an_outdated_copy_gets_the_whole_file() {
        let now = "\"16-6b49d200-7\"";
        assert_eq!(get(&[(header::RANGE, "bytes=0-19")]).await, (StatusCode::PARTIAL_CONTENT, Some("bytes 0-19/22".into()), 20));
        assert_eq!(get(&[(header::RANGE, "bytes=0-19"), (header::IF_NONE_MATCH, now)]).await.0, StatusCode::NOT_MODIFIED);
        // Chromium revalidating the first 20 bytes it kept, of a file that has grown since
        let old = [(header::RANGE, "bytes=0-19"), (header::IF_NONE_MATCH, "\"14-6b49d1f0-3\""), (header::IF_MODIFIED_SINCE, "Fri, 15 Jan 2027 08:00:00 GMT")];
        assert_eq!(get(&old).await, (StatusCode::OK, None, 22));
        assert_eq!(get(&[(header::RANGE, "bytes=0-19"), (header::IF_MODIFIED_SINCE, "Fri, 15 Jan 2027 08:00:00 GMT")]).await, (StatusCode::OK, None, 22));
        assert_eq!(get(&[(header::RANGE, "bytes=0-19"), (header::IF_RANGE, now)]).await.0, StatusCode::PARTIAL_CONTENT);
        assert_eq!(get(&[(header::RANGE, "bytes=0-19"), (header::IF_RANGE, "\"14-6b49d1f0-3\"")]).await.0, StatusCode::OK);
    }

    #[test]
    fn active_content_is_defused() {
        assert_eq!(content_type("x.html").0, "text/plain; charset=utf-8");
        assert!(content_type("x.svg").1);
        assert_eq!(content_type("a.mp4").0, "video/mp4");
        assert_eq!(content_type("n.md").0, "text/markdown; charset=utf-8");
    }
}
