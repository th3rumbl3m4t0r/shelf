//! Storage behind every location: the user's home (local disk) or an external
//! mount (SFTP). Handlers, public links, and later WebDAV / WOPI only talk to
//! `Backend`, so a new kind of storage is one more impl of it.

use std::{fmt, io, pin::Pin};

use async_trait::async_trait;
use bytes::Bytes;
use futures_util::Stream;
use tokio::io::{AsyncRead, AsyncSeek};

pub mod local;
pub mod sftp;

/// A validated path relative to a backend root: no `.`/`..`, no empty or
/// slash-bearing segments. Displays as `/a/b` (root is `/`).
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct RelPath(Vec<String>);

pub fn valid_name(s: &str) -> bool {
    !s.is_empty() && s != "." && s != ".." && s.len() <= 255 && !s.contains(['/', '\0'])
}

impl RelPath {
    pub fn root() -> Self {
        RelPath(Vec::new())
    }

    pub fn parse(s: &str) -> Result<Self, FsError> {
        let mut v = Vec::new();
        for seg in s.split('/').filter(|s| !s.is_empty()) {
            if !valid_name(seg) {
                return Err(FsError::Invalid(format!("bad path segment {seg:?}")));
            }
            v.push(seg.to_string());
        }
        Ok(RelPath(v))
    }

    pub fn segs(&self) -> &[String] {
        &self.0
    }
    pub fn is_root(&self) -> bool {
        self.0.is_empty()
    }
    pub fn name(&self) -> Option<&str> {
        self.0.last().map(String::as_str)
    }
    pub fn parent(&self) -> Option<RelPath> {
        (!self.0.is_empty()).then(|| RelPath(self.0[..self.0.len() - 1].to_vec()))
    }
    pub fn join(&self, other: &RelPath) -> RelPath {
        let mut v = self.0.clone();
        v.extend(other.0.iter().cloned());
        RelPath(v)
    }
    pub fn child(&self, name: &str) -> Result<RelPath, FsError> {
        if !valid_name(name) {
            return Err(FsError::Invalid(format!("bad name {name:?}")));
        }
        let mut v = self.0.clone();
        v.push(name.to_string());
        Ok(RelPath(v))
    }
    pub fn starts_with(&self, other: &RelPath) -> bool {
        self.0.len() >= other.0.len() && self.0[..other.0.len()] == other.0[..]
    }
    pub fn strip_prefix(&self, other: &RelPath) -> Option<RelPath> {
        self.starts_with(other).then(|| RelPath(self.0[other.0.len()..].to_vec()))
    }
}

impl fmt::Display for RelPath {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        if self.0.is_empty() {
            return f.write_str("/");
        }
        for s in &self.0 {
            write!(f, "/{s}")?;
        }
        Ok(())
    }
}

#[derive(Clone, Debug)]
pub struct Entry {
    pub name: String,
    pub is_dir: bool,
    pub size: u64,
    /// seconds since the epoch
    pub mtime: i64,
    /// sub-second part where the backend has it; only feeds the etag
    pub nanos: u32,
}

impl Entry {
    pub fn etag(&self) -> String {
        format!("\"{:x}-{:x}-{:x}\"", self.size, self.mtime, self.nanos)
    }
    pub fn json(&self) -> serde_json::Value {
        serde_json::json!({
            "name": self.name, "dir": self.is_dir, "size": self.size,
            "mtime": self.mtime, "etag": self.etag(),
        })
    }
}

/// Room on the filesystem under a path, in bytes.
#[derive(Clone, Copy, Debug)]
pub struct Space {
    pub size: u64,
    pub used: u64,
    /// what writes may still take (the root reserve left out, as in `df`)
    pub free: u64,
}

#[derive(Debug)]
pub enum FsError {
    NotFound,
    Exists,
    NotDir,
    IsDir,
    Denied,
    Invalid(String),
    Io(String),
    /// the remote side (SFTP) failed or is unreachable
    Remote(String),
}

impl fmt::Display for FsError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            FsError::NotFound => f.write_str("not found"),
            FsError::Exists => f.write_str("already exists"),
            FsError::NotDir => f.write_str("not a folder"),
            FsError::IsDir => f.write_str("is a folder"),
            FsError::Denied => f.write_str("permission denied"),
            FsError::Invalid(m) | FsError::Io(m) | FsError::Remote(m) => f.write_str(m),
        }
    }
}

impl std::error::Error for FsError {}

impl From<io::Error> for FsError {
    fn from(e: io::Error) -> Self {
        use io::ErrorKind::*;
        match e.kind() {
            NotFound => FsError::NotFound,
            AlreadyExists => FsError::Exists,
            PermissionDenied => FsError::Denied,
            NotADirectory => FsError::NotDir,
            IsADirectory => FsError::IsDir,
            _ => FsError::Io(e.to_string()),
        }
    }
}

pub type ByteStream = Pin<Box<dyn Stream<Item = io::Result<Bytes>> + Send>>;

pub trait ReadSeek: AsyncRead + AsyncSeek + Send + Unpin {}
impl<T: AsyncRead + AsyncSeek + Send + Unpin> ReadSeek for T {}

#[async_trait]
pub trait Backend: Send + Sync {
    async fn stat(&self, p: &RelPath) -> Result<Entry, FsError>;
    /// Entries of a folder, unsorted.
    async fn list(&self, p: &RelPath) -> Result<Vec<Entry>, FsError>;
    async fn open(&self, p: &RelPath) -> Result<(Entry, Box<dyn ReadSeek>), FsError>;
    /// Create or replace a file with the stream. Readers never see a half-written file.
    async fn write(&self, p: &RelPath, data: ByteStream) -> Result<Entry, FsError>;
    async fn mkdir(&self, p: &RelPath) -> Result<(), FsError>;
    /// Remove a file, or a folder with everything in it.
    async fn remove(&self, p: &RelPath) -> Result<(), FsError>;
    /// Fails with `Exists` if `to` is there already.
    async fn rename(&self, from: &RelPath, to: &RelPath) -> Result<(), FsError>;
    /// Room on the filesystem holding `p`; None when the storage cannot tell.
    async fn space(&self, p: &RelPath) -> Result<Option<Space>, FsError>;
    /// Sets the modification time (seconds since the epoch), where the storage can.
    async fn set_mtime(&self, _p: &RelPath, _mtime: i64) -> Result<(), FsError> {
        Ok(())
    }

    /// Bytes in all the files under the folder `p`, all the way down. Unreadable
    /// subfolders count as empty; symlinked folders are followed, at most 32 deep.
    async fn du(&self, p: &RelPath) -> Result<u64, FsError> {
        let mut todo = vec![(p.clone(), 0u32)];
        let mut n = 0;
        while let Some((d, depth)) = todo.pop() {
            let list = match self.list(&d).await {
                Ok(l) => l,
                Err(e) if d == *p => return Err(e),
                Err(_) => continue,
            };
            for e in list {
                if !e.is_dir {
                    n += e.size;
                } else if depth < 32 {
                    if let Ok(c) = d.child(&e.name) {
                        todo.push((c, depth + 1));
                    }
                }
            }
        }
        Ok(n)
    }
}
