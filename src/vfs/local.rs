use std::{
    collections::HashSet,
    ffi::CString,
    io,
    os::unix::{ffi::OsStrExt, fs::MetadataExt},
    path::{Path, PathBuf},
    time::UNIX_EPOCH,
};

use async_trait::async_trait;
use futures_util::StreamExt;
use tokio::{fs, io::AsyncWriteExt};

use super::{Backend, ByteStream, Entry, FsError, ReadSeek, RelPath, Space};

/// A folder on this host. Symlinks placed there by the admin are followed
/// (that is how a media folder can be put into someone's home); users cannot
/// create them.
pub struct Local {
    root: PathBuf,
    tmp: PathBuf,
}

impl Local {
    /// `tmp` should be on the same filesystem as `root` so a finished upload is a rename.
    pub fn new(root: PathBuf, tmp: PathBuf) -> Self {
        Local { root, tmp }
    }

    fn full(&self, p: &RelPath) -> PathBuf {
        let mut f = self.root.clone();
        for s in p.segs() {
            f.push(s);
        }
        f
    }
}

fn entry(name: String, m: &std::fs::Metadata) -> Entry {
    let t = m.modified().ok().and_then(|t| t.duration_since(UNIX_EPOCH).ok()).unwrap_or_default();
    Entry {
        name,
        is_dir: m.is_dir(),
        size: if m.is_dir() { 0 } else { m.len() },
        mtime: t.as_secs() as i64,
        nanos: t.subsec_nanos(),
    }
}

#[async_trait]
impl Backend for Local {
    async fn stat(&self, p: &RelPath) -> Result<Entry, FsError> {
        let m = fs::metadata(self.full(p)).await?;
        Ok(entry(p.name().unwrap_or("").to_string(), &m))
    }

    async fn list(&self, p: &RelPath) -> Result<Vec<Entry>, FsError> {
        let dir = self.full(p);
        let mut rd = fs::read_dir(&dir).await?;
        let mut out = Vec::new();
        while let Some(de) = rd.next_entry().await? {
            let Ok(name) = de.file_name().into_string() else { continue };
            let mut m = match de.metadata().await {
                Ok(m) => m,
                Err(_) => continue,
            };
            if m.file_type().is_symlink() {
                match fs::metadata(de.path()).await {
                    Ok(t) => m = t,
                    Err(_) => continue, // dangling
                }
            }
            out.push(entry(name, &m));
        }
        Ok(out)
    }

    async fn open(&self, p: &RelPath) -> Result<(Entry, Box<dyn ReadSeek>), FsError> {
        let f = fs::File::open(self.full(p)).await?;
        let m = f.metadata().await?;
        if m.is_dir() {
            return Err(FsError::IsDir);
        }
        Ok((entry(p.name().unwrap_or("").to_string(), &m), Box::new(f)))
    }

    async fn write(&self, p: &RelPath, mut data: ByteStream) -> Result<Entry, FsError> {
        let target = self.full(p);
        let parent = p.parent().ok_or(FsError::Invalid("cannot write the root".into()))?;
        if !fs::metadata(self.full(&parent)).await?.is_dir() {
            return Err(FsError::NotDir);
        }
        if let Ok(m) = fs::metadata(&target).await {
            if m.is_dir() {
                return Err(FsError::IsDir);
            }
        }
        let tmp = self.tmp.join(format!("up-{}", crate::crypto::random_token(12)));
        let res: Result<(), FsError> = async {
            let mut f = fs::File::create(&tmp).await?;
            while let Some(chunk) = data.next().await {
                f.write_all(&chunk?).await?;
            }
            f.sync_all().await?;
            drop(f);
            if let Err(e) = fs::rename(&tmp, &target).await {
                // EXDEV: the home was symlinked onto another filesystem
                if e.raw_os_error() == Some(18) {
                    fs::copy(&tmp, &target).await?;
                    fs::remove_file(&tmp).await?;
                } else {
                    return Err(e.into());
                }
            }
            Ok(())
        }
        .await;
        if res.is_err() {
            let _ = fs::remove_file(&tmp).await;
        }
        res?;
        self.stat(p).await
    }

    async fn mkdir(&self, p: &RelPath) -> Result<(), FsError> {
        Ok(fs::create_dir(self.full(p)).await?)
    }

    async fn remove(&self, p: &RelPath) -> Result<(), FsError> {
        if p.is_root() {
            return Err(FsError::Invalid("cannot remove the root".into()));
        }
        let full = self.full(p);
        let m = fs::symlink_metadata(&full).await?;
        if m.is_dir() {
            fs::remove_dir_all(&full).await?;
        } else {
            fs::remove_file(&full).await?;
        }
        Ok(())
    }

    async fn rename(&self, from: &RelPath, to: &RelPath) -> Result<(), FsError> {
        let (f, t) = (self.full(from), self.full(to));
        if fs::symlink_metadata(&t).await.is_ok() {
            return Err(FsError::Exists);
        }
        fs::rename(f, t).await?;
        Ok(())
    }

    async fn space(&self, p: &RelPath) -> Result<Option<Space>, FsError> {
        let full = self.full(p);
        let s = tokio::task::spawn_blocking(move || statvfs(&full)).await.map_err(|e| FsError::Io(e.to_string()))??;
        Ok(Some(s))
    }

    async fn set_mtime(&self, p: &RelPath, mtime: i64) -> Result<(), FsError> {
        let full = self.full(p);
        let t = UNIX_EPOCH + std::time::Duration::from_secs(mtime.max(0) as u64);
        let set = move || std::fs::File::options().write(true).open(full)?.set_modified(t);
        Ok(tokio::task::spawn_blocking(set).await.map_err(|e| FsError::Io(e.to_string()))??)
    }

    async fn du(&self, p: &RelPath) -> Result<u64, FsError> {
        let top = self.full(p);
        tokio::task::spawn_blocking(move || du(&top)).await.map_err(|e| FsError::Io(e.to_string()))?
    }
}

/// Bytes in the files under `top`, symlinks followed as `list` does; each
/// folder is walked once, so a link loop ends.
fn du(top: &Path) -> Result<u64, FsError> {
    let m = std::fs::metadata(top)?;
    let mut seen = HashSet::from([(m.dev(), m.ino())]);
    let mut todo = vec![top.to_path_buf()];
    let mut n = 0;
    while let Some(d) = todo.pop() {
        let rd = match std::fs::read_dir(&d) {
            Ok(rd) => rd,
            Err(e) if d == top => return Err(e.into()),
            Err(_) => continue,
        };
        for de in rd.flatten() {
            let Ok(mut m) = de.metadata() else { continue };
            if m.file_type().is_symlink() {
                match std::fs::metadata(de.path()) {
                    Ok(t) => m = t,
                    Err(_) => continue, // dangling
                }
            }
            if !m.is_dir() {
                n += m.len();
            } else if seen.insert((m.dev(), m.ino())) {
                todo.push(de.path());
            }
        }
    }
    Ok(n)
}

fn statvfs(p: &Path) -> io::Result<Space> {
    let c = CString::new(p.as_os_str().as_bytes()).map_err(|_| io::Error::from(io::ErrorKind::InvalidInput))?;
    let mut s: libc::statvfs = unsafe { std::mem::zeroed() };
    if unsafe { libc::statvfs(c.as_ptr(), &mut s) } != 0 {
        return Err(io::Error::last_os_error());
    }
    let f = s.f_frsize as u64;
    Ok(Space {
        size: s.f_blocks as u64 * f,
        used: s.f_blocks.saturating_sub(s.f_bfree) as u64 * f,
        free: s.f_bavail as u64 * f,
    })
}
