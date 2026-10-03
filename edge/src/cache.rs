//! Copies of file bodies on local disk, named by shelf's opaque cache key:
//! `objects/<ab>/<key>` holds the bytes, `<key>.meta` is "etag\nsize\n" and its
//! mtime says when the copy was last used. The least recently used copies go
//! when the total passes the limit.

use std::{
    collections::{HashMap, HashSet},
    fs,
    path::PathBuf,
    sync::{Arc, Mutex},
    time::SystemTime,
};

use tokio::io::AsyncWriteExt;

pub struct Cache {
    dir: PathBuf,
    max: u64,
    state: Mutex<State>,
}

#[derive(Default)]
struct State {
    items: HashMap<String, Item>,
    total: u64,
    /// keys being filled right now
    filling: HashSet<String>,
}

struct Item {
    etag: String,
    size: u64,
    used: SystemTime,
}

/// shelf's keys are sha256 hex; anything else never becomes a file name
fn valid(key: &str) -> bool {
    key.len() == 64 && key.bytes().all(|b| b.is_ascii_hexdigit())
}

impl Cache {
    pub fn open(dir: PathBuf, max: u64) -> anyhow::Result<Arc<Cache>> {
        let tmp = dir.join("tmp");
        let _ = fs::remove_dir_all(&tmp);
        fs::create_dir_all(&tmp)?;
        fs::create_dir_all(dir.join("objects"))?;
        let mut st = State::default();
        for sub in fs::read_dir(dir.join("objects"))? {
            for f in fs::read_dir(sub?.path())? {
                let p = f?.path();
                let name = p.file_name().unwrap_or_default().to_string_lossy().into_owned();
                let (key, is_meta) = name.strip_suffix(".meta").map_or((name.as_str(), false), |k| (k, true));
                let (data, meta) = (p.with_file_name(key), p.with_file_name(format!("{key}.meta")));
                if is_meta {
                    if !data.exists() {
                        let _ = fs::remove_file(&meta);
                    }
                    continue;
                }
                let desc = fs::read_to_string(&meta).ok().and_then(|m| {
                    let (etag, size) = m.split_once('\n')?;
                    Some((etag.to_string(), size.trim().parse::<u64>().ok()?))
                });
                let len = fs::metadata(&data).map(|m| m.len()).ok();
                match desc {
                    Some((etag, size)) if valid(key) && Some(size) == len => {
                        let used = fs::metadata(&meta).and_then(|m| m.modified()).unwrap_or(SystemTime::UNIX_EPOCH);
                        st.total += size;
                        st.items.insert(key.to_string(), Item { etag, size, used });
                    }
                    // cut off while being written
                    _ => {
                        let _ = fs::remove_file(&data);
                        let _ = fs::remove_file(&meta);
                    }
                }
            }
        }
        tracing::info!("cache {}: {} files, {} MB of {} MB", dir.display(), st.items.len(), st.total >> 20, max >> 20);
        Ok(Arc::new(Cache { dir, max, state: Mutex::new(st) }))
    }

    fn path(&self, key: &str) -> PathBuf {
        self.dir.join("objects").join(&key[..2]).join(key)
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, State> {
        self.state.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// The copy, if it is still the file shelf just described.
    pub async fn get(&self, key: &str, etag: &str, size: u64) -> Option<tokio::fs::File> {
        {
            let mut st = self.lock();
            let it = st.items.get_mut(key)?;
            if it.etag != etag || it.size != size {
                return None;
            }
            it.used = SystemTime::now();
        }
        let f = tokio::fs::File::open(self.path(key)).await.ok()?;
        let meta = self.path(key).with_extension("meta");
        tokio::task::spawn_blocking(move || {
            let _ = fs::File::options().append(true).open(meta).and_then(|f| f.set_modified(SystemTime::now()));
        });
        Some(f)
    }

    /// Start filling `key`, unless that is already under way or it is too big.
    pub fn claim(self: &Arc<Self>, key: &str, size: u64) -> Option<Fill> {
        if !valid(key) || size > self.max / 4 {
            return None;
        }
        if !self.lock().filling.insert(key.to_string()) {
            return None;
        }
        let tmp = self.dir.join("tmp").join(format!("{key}-{}", std::process::id()));
        Some(Fill { cache: self.clone(), key: key.to_string(), tmp, file: None, written: 0, size, broken: false })
    }

    fn evict(&self, st: &mut State) {
        while st.total > self.max {
            let Some(k) = st.items.iter().filter(|(k, _)| !st.filling.contains(*k)).min_by_key(|(_, i)| i.used).map(|(k, _)| k.clone())
            else {
                break;
            };
            let it = st.items.remove(&k).expect("listed");
            st.total -= it.size;
            let p = self.path(&k);
            let _ = fs::remove_file(p.with_extension("meta"));
            let _ = fs::remove_file(p);
            tracing::debug!("evicted {k} ({} bytes)", it.size);
        }
    }
}

/// A copy being written; only becomes visible on a complete `commit`.
pub struct Fill {
    cache: Arc<Cache>,
    key: String,
    tmp: PathBuf,
    file: Option<tokio::fs::File>,
    written: u64,
    size: u64,
    broken: bool,
}

impl Fill {
    pub fn broken(&self) -> bool {
        self.broken
    }

    pub async fn write(&mut self, b: &[u8]) {
        if self.broken {
            return;
        }
        if self.file.is_none() {
            match tokio::fs::File::create(&self.tmp).await {
                Ok(f) => self.file = Some(f),
                Err(e) => return self.fail(e),
            }
        }
        match self.file.as_mut().expect("opened").write_all(b).await {
            Ok(()) => self.written += b.len() as u64,
            Err(e) => self.fail(e),
        }
    }

    fn fail(&mut self, e: std::io::Error) {
        tracing::warn!("cache write: {e}");
        self.broken = true;
        self.file = None;
    }

    pub async fn commit(mut self, etag: &str) {
        if self.broken || self.written != self.size || etag.is_empty() || etag.contains('\n') {
            return;
        }
        if self.size == 0 && self.file.is_none() {
            let _ = tokio::fs::File::create(&self.tmp).await;
        }
        if let Some(mut f) = self.file.take() {
            if f.flush().await.is_err() {
                return;
            }
        }
        let dest = self.cache.path(&self.key);
        let meta = dest.with_extension("meta");
        let done = async {
            tokio::fs::create_dir_all(dest.parent().expect("in objects/")).await?;
            tokio::fs::rename(&self.tmp, &dest).await?;
            tokio::fs::write(&meta, format!("{etag}\n{}\n", self.size)).await
        };
        if let Err(e) = done.await {
            tracing::warn!("cache commit: {e}");
            let _ = tokio::fs::remove_file(&dest).await;
            return;
        }
        let mut st = self.cache.lock();
        let item = Item { etag: etag.to_string(), size: self.size, used: SystemTime::now() };
        if let Some(old) = st.items.insert(self.key.clone(), item) {
            st.total -= old.size;
        }
        st.total += self.size;
        st.filling.remove(&self.key);
        self.cache.evict(&mut st);
        tracing::debug!("cached {} ({} bytes)", self.key, self.size);
    }
}

impl Drop for Fill {
    fn drop(&mut self) {
        self.cache.lock().filling.remove(&self.key);
        let _ = fs::remove_file(&self.tmp);
    }
}
