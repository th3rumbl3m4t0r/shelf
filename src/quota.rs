//! Storage limits. An account with a limit (`users.quota`, bytes) gets that much
//! room in its home, counted the way the file list counts folder sizes; storage
//! over SFTP is the user's own and does not count. The places list then shows
//! used / limit for the home instead of the disk's, and a write that would grow
//! the home past its limit is refused (507). Bytes are counted as they arrive,
//! so uploads side by side cannot overshoot together; a write that does not
//! grow the home (saving an edited file) always goes through. A refused upload
//! is still read to its end, so the client gets the answer, not a cut
//! connection (browsers report that as a network error).

use std::{
    collections::HashMap,
    io,
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering::Relaxed},
        Arc, Mutex, MutexGuard,
    },
    time::{Duration, Instant},
};

use axum::http::{header, HeaderMap, StatusCode};
use bytes::Bytes;
use futures_util::{future, stream, StreamExt};

use crate::{
    error::{AppError, Res},
    files,
    vfs::{ByteStream, FsError, RelPath},
    App,
};

/// A home is added up again after this; what shelf writes meanwhile is added as it goes.
const KEEP: Duration = Duration::from_secs(120);

/// user id -> what is known of the bytes in their home
#[derive(Default)]
pub struct Quotas(Mutex<HashMap<i64, Usage>>);

#[derive(Default)]
struct Usage {
    /// when added up, and the bytes then plus what shelf stored since
    counted: Option<(Instant, u64)>,
    /// bytes of writes under way
    pending: u64,
}

pub fn over() -> AppError {
    AppError::new(StatusCode::INSUFFICIENT_STORAGE, "this does not fit within the storage limit")
}

/// The limit of a user's home, if it has one.
pub fn limit(app: &App, user: i64) -> Res<Option<u64>> {
    let q = app.db.opt(|c| c.query_row("SELECT quota FROM users WHERE id = ?1", [user], |r| r.get::<_, Option<i64>>(0)))?;
    Ok(q.flatten().map(|q| q.max(0) as u64))
}

/// "50G", "500M", "1.5T", "2 GiB" (binary units, as the UI shows sizes); "" is no limit.
pub fn parse(s: &str) -> Res<Option<u64>> {
    let s = s.trim().to_ascii_uppercase();
    if s.is_empty() || s == "NONE" {
        return Ok(None);
    }
    let bad = || AppError::bad("a size like 50G, 500M or 1.5T, or empty for no limit");
    let t = s.trim_end_matches('B').trim_end_matches('I');
    if !t.is_ascii() || t.len() < 2 {
        return Err(bad());
    }
    let (num, unit) = t.split_at(t.len() - 1);
    let shift = match unit {
        "K" => 10,
        "M" => 20,
        "G" => 30,
        "T" => 40,
        _ => return Err(bad()),
    };
    let n: f64 = num.trim().replace(',', ".").parse().map_err(|_| bad())?;
    if !n.is_finite() || n <= 0.0 {
        return Err(bad());
    }
    Ok(Some(((n * (1u64 << shift) as f64) as u64).clamp(1, i64::MAX as u64)))
}

/// The request's Content-Length, when it says one.
pub fn length(h: &HeaderMap) -> Option<u64> {
    h.get(header::CONTENT_LENGTH)?.to_str().ok()?.parse().ok()
}

impl Quotas {
    fn lock(&self) -> MutexGuard<'_, HashMap<i64, Usage>> {
        self.0.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// Bytes in a user's home.
    pub async fn used(&self, app: &App, user: i64) -> Res<u64> {
        if let Some((t, n)) = self.lock().get(&user).and_then(|u| u.counted) {
            if t.elapsed() < KEEP {
                return Ok(n);
            }
        }
        let name: String = app.db.with(|c| c.query_row("SELECT username FROM users WHERE id = ?1", [user], |r| r.get(0)))?;
        let n = files::home_backend(app, &name).du(&RelPath::root()).await?;
        self.lock().entry(user).or_default().counted = Some((Instant::now(), n));
        Ok(n)
    }

    /// Something left a home: add it up again next time.
    pub fn forget(&self, user: i64) {
        if let Some(u) = self.lock().get_mut(&user) {
            u.counted = None;
        }
    }
}

/// A write into a home with a limit. `wrap` counts its bytes; dropping it
/// settles the count, so a write that fails half way leaves nothing behind.
pub struct Write {
    app: Arc<App>,
    user: i64,
    limit: u64,
    /// size of the file it replaces
    replaces: u64,
    /// the home when the write began
    base: u64,
    written: Arc<AtomicU64>,
    over: Arc<AtomicBool>,
    stored: bool,
}

/// Before writing `size` bytes (when known) into the storage of (`owner`,
/// `mount`) over a file of `replaces` bytes; `None` when it has no limit.
pub async fn start(app: &Arc<App>, owner: i64, mount: Option<i64>, replaces: u64, size: Option<u64>) -> Res<Option<Write>> {
    if mount.is_some() {
        return Ok(None);
    }
    let Some(limit) = limit(app, owner)? else { return Ok(None) };
    let base = app.quotas.used(app, owner).await?;
    // a length that cannot fit: nothing is kept from the start
    let pending = app.quotas.lock().get(&owner).map_or(0, |u| u.pending);
    let too_big = size.is_some_and(|s| s > replaces && (base + pending + s).saturating_sub(replaces) > limit);
    Ok(Some(Write {
        app: app.clone(),
        user: owner,
        limit,
        replaces,
        base,
        written: Default::default(),
        over: Arc::new(AtomicBool::new(too_big)),
        stored: false,
    }))
}

impl Write {
    /// The bytes to write; once past the limit the rest is read and dropped, and the end is an error.
    pub fn wrap(&self, data: ByteStream) -> ByteStream {
        let (app, user, limit, replaces, base) = (self.app.clone(), self.user, self.limit, self.replaces, self.base);
        let (written, over, at_end) = (self.written.clone(), self.over.clone(), self.over.clone());
        let kept = data.filter_map(move |chunk| {
            let keep = |chunk: Bytes| {
                if over.load(Relaxed) {
                    return None;
                }
                let n = chunk.len() as u64;
                let mine = written.fetch_add(n, Relaxed) + n;
                let mut m = app.quotas.lock();
                let u = m.entry(user).or_default();
                u.pending += n;
                let home = u.counted.map_or(base, |c| c.1);
                if mine > replaces && (home + u.pending).saturating_sub(replaces) > limit {
                    over.store(true, Relaxed);
                    return None;
                }
                Some(Ok(chunk))
            };
            future::ready(match chunk {
                Ok(c) => keep(c),
                Err(e) => Some(Err(e)),
            })
        });
        let end = stream::once(future::ready(()))
            .filter_map(move |()| future::ready(at_end.load(Relaxed).then(|| Err(io::Error::other("over the storage limit")))));
        Box::pin(kept.chain(end))
    }

    /// The file is in place: its bytes count from now on.
    pub fn stored(mut self) {
        self.stored = true;
    }
}

impl Drop for Write {
    fn drop(&mut self) {
        let n = self.written.load(Relaxed);
        let mut m = self.app.quotas.lock();
        let u = m.entry(self.user).or_default();
        u.pending = u.pending.saturating_sub(n);
        if let (true, Some((_, c))) = (self.stored, u.counted.as_mut()) {
            *c = (*c + n).saturating_sub(self.replaces);
        }
    }
}

/// A failed write: the limit's answer when the limit stopped it.
pub fn why(w: &Option<Write>, e: FsError) -> AppError {
    match w {
        Some(w) if w.over.load(Relaxed) => over(),
        _ => e.into(),
    }
}

#[cfg(test)]
mod tests {
    use super::parse;

    #[test]
    fn sizes() {
        assert_eq!(parse("").unwrap(), None);
        assert_eq!(parse(" none ").unwrap(), None);
        assert_eq!(parse("50G").unwrap(), Some(50 << 30));
        assert_eq!(parse("50 gib").unwrap(), Some(50 << 30));
        assert_eq!(parse("50GB").unwrap(), Some(50 << 30));
        assert_eq!(parse("1.5T").unwrap(), Some(3 << 39));
        assert_eq!(parse("1,5t").unwrap(), Some(3 << 39));
        assert_eq!(parse("500M").unwrap(), Some(500 << 20));
        assert!(parse("50").is_err());
        assert!(parse("0G").is_err());
        assert!(parse("-1G").is_err());
        assert!(parse("lotsG").is_err());
        assert!(parse("5Ž").is_err());
        assert!(parse("G").is_err());
    }
}
