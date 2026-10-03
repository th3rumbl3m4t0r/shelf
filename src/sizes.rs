//! Folder sizes for the file list: everything inside, all the way down. Kept
//! two minutes; a change made through shelf drops what it touches, one made
//! around shelf shows once the two minutes are up.

use std::{
    collections::HashMap,
    sync::{Mutex, MutexGuard},
    time::{Duration, Instant},
};

use crate::vfs::{Backend, FsError, RelPath};

const KEEP: Duration = Duration::from_secs(120);

/// (store, path) -> when added up, bytes; store as in `files::store_id`
#[derive(Default)]
pub struct Sizes(Mutex<HashMap<(String, String), (Instant, u64)>>);

impl Sizes {
    pub async fn get(&self, store: &str, b: &dyn Backend, p: &RelPath) -> Result<u64, FsError> {
        let key = (store.to_string(), p.to_string());
        if let Some((t, n)) = self.lock().get(&key) {
            if t.elapsed() < KEEP {
                return Ok(*n);
            }
        }
        let n = b.du(p).await?;
        let mut m = self.lock();
        if m.len() > 4096 {
            m.retain(|_, (t, _)| t.elapsed() < KEEP);
        }
        m.insert(key, (Instant::now(), n));
        Ok(n)
    }

    /// Something at `p` changed: its size, its parents' and whatever is kept below it are stale.
    pub fn touch(&self, store: &str, p: &RelPath) {
        let p = p.to_string();
        self.lock().retain(|(s, k), _| s != store || !(inside(k, &p) || inside(&p, k)));
    }

    fn lock(&self) -> MutexGuard<'_, HashMap<(String, String), (Instant, u64)>> {
        self.0.lock().unwrap_or_else(|e| e.into_inner())
    }
}

/// `a` is `b` or somewhere under it (paths as `RelPath` displays them)
fn inside(a: &str, b: &str) -> bool {
    a == b || b == "/" || a.strip_prefix(b).is_some_and(|r| r.starts_with('/'))
}

#[cfg(test)]
mod tests {
    use super::inside;

    #[test]
    fn paths() {
        assert!(inside("/a/b", "/a"));
        assert!(inside("/a", "/a"));
        assert!(inside("/a", "/"));
        assert!(!inside("/ab", "/a"));
        assert!(!inside("/a", "/a/b"));
    }
}
