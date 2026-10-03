//! External storage over SFTP. One SSH connection per mount, opened on first
//! use, reused by every request, and dropped after it has been idle for a while.
//! The server's host key is trusted on first use and pinned in `mounts.host_key`.

use std::{
    collections::HashMap,
    future::Future,
    io,
    pin::Pin,
    sync::{Arc, Mutex as StdMutex},
    task::{Context, Poll},
    time::{Duration, Instant},
};

use async_trait::async_trait;
use futures_util::StreamExt;
use russh::{
    client,
    keys::{self, HashAlg, PrivateKeyWithHashAlg},
};
use russh_sftp::{
    client::{error::Error as SErr, SftpSession},
    protocol::{FileAttributes, OpenFlags, StatusCode},
};
use tokio::{
    io::{AsyncRead, AsyncSeek, AsyncWriteExt, ReadBuf},
    sync::Mutex,
};

use super::{Backend, ByteStream, Entry, FsError, ReadSeek, RelPath, Space};
use crate::db::Db;

/// Stores a host key fingerprint pinned on first use.
pub type PinFn = Arc<dyn Fn(&str) + Send + Sync>;

#[derive(Clone)]
pub enum Auth {
    Password(String),
    Key { pem: String, passphrase: Option<String> },
}

#[derive(Clone)]
pub struct MountCfg {
    pub id: i64,
    pub host: String,
    pub port: u16,
    pub user: String,
    pub auth: Auth,
    /// remote folder the mount starts at; empty = the login's home
    pub root: String,
    /// pinned `SHA256:…` fingerprint, None until the first connection
    pub host_key: Option<String>,
    /// backup target: new files 0600 and folders 0700, whatever the server's umask
    pub private: bool,
}

struct Client {
    expected: Option<String>,
    seen: Arc<StdMutex<Option<String>>>,
}

impl client::Handler for Client {
    type Error = russh::Error;

    async fn check_server_key(&mut self, key: &keys::PublicKey) -> Result<bool, Self::Error> {
        let fp = key.fingerprint(HashAlg::Sha256).to_string();
        let ok = self.expected.as_deref().is_none_or(|e| e == fp);
        *self.seen.lock().unwrap() = Some(fp);
        Ok(ok)
    }
}

pub struct Conn {
    ssh: client::Handle<Client>,
    sftp: SftpSession,
    /// canonical remote path of the mount root, without a trailing slash
    base: String,
    used: StdMutex<Instant>,
}

impl Conn {
    fn at(&self, p: &RelPath) -> String {
        if p.is_root() {
            if self.base.is_empty() { "/".into() } else { self.base.clone() }
        } else {
            format!("{}{}", self.base, p)
        }
    }
}

fn remote(e: impl std::fmt::Display) -> FsError {
    FsError::Remote(e.to_string())
}

fn sftp_err(e: SErr) -> FsError {
    match e {
        SErr::Status(s) => match s.status_code {
            StatusCode::NoSuchFile => FsError::NotFound,
            StatusCode::PermissionDenied => FsError::Denied,
            c if s.error_message.is_empty() => FsError::Remote(format!("sftp: {c}")),
            _ => FsError::Remote(format!("sftp: {}", s.error_message)),
        },
        SErr::Timeout => FsError::Remote("sftp: timed out".into()),
        other => FsError::Remote(format!("sftp: {other}")),
    }
}

/// errors after which the connection is not worth keeping
fn is_transport(e: &SErr) -> bool {
    matches!(e, SErr::IO(_) | SErr::Timeout | SErr::UnexpectedBehavior(_))
}

/// Connect, log in and start SFTP. Returns the connection and the host key fingerprint.
pub async fn connect(cfg: &MountCfg) -> Result<(Conn, String), FsError> {
    let seen = Arc::new(StdMutex::new(None));
    let handler = Client { expected: cfg.host_key.clone(), seen: seen.clone() };
    let config = Arc::new(client::Config {
        keepalive_interval: Some(Duration::from_secs(30)),
        ..Default::default()
    });
    let res = tokio::time::timeout(
        Duration::from_secs(15),
        client::connect(config, (cfg.host.as_str(), cfg.port), handler),
    )
    .await
    .map_err(|_| FsError::Remote(format!("{}:{}: connect timed out", cfg.host, cfg.port)))?;
    let fp = seen.lock().unwrap().clone();
    let mut ssh = match res {
        Ok(h) => h,
        Err(e) => {
            if let (Some(want), Some(got)) = (&cfg.host_key, &fp) {
                if want != got {
                    return Err(FsError::Remote(format!(
                        "host key of {} changed: pinned {want}, server sent {got}. \
                         If that is expected, reset the host key in the mount settings.",
                        cfg.host
                    )));
                }
            }
            return Err(FsError::Remote(format!("{}:{}: {e}", cfg.host, cfg.port)));
        }
    };
    let auth = match &cfg.auth {
        Auth::Password(pw) => ssh.authenticate_password(&cfg.user, pw).await,
        Auth::Key { pem, passphrase } => {
            let key = keys::decode_secret_key(pem, passphrase.as_deref())
                .map_err(|e| match (passphrase.is_some(), e.to_string()) {
                    (_, s) if s.contains("encrypted") => FsError::Invalid("private key: key is encrypted, passphrase needed".into()),
                    (true, s) if s.contains("crypt") => FsError::Invalid("private key: cannot decrypt (wrong passphrase?)".into()),
                    (_, s) => FsError::Invalid(format!("private key: {s}")),
                })?;
            let hash = ssh.best_supported_rsa_hash().await.map_err(remote)?.flatten();
            ssh.authenticate_publickey(&cfg.user, PrivateKeyWithHashAlg::new(Arc::new(key), hash)).await
        }
    }
    .map_err(remote)?;
    if !auth.success() {
        return Err(FsError::Remote(format!("{}@{}: authentication failed", cfg.user, cfg.host)));
    }
    let ch = ssh.channel_open_session().await.map_err(remote)?;
    ch.request_subsystem(true, "sftp").await.map_err(remote)?;
    let sftp = SftpSession::new(ch.into_stream()).await.map_err(sftp_err)?;
    sftp.set_timeout(30);
    let root = match cfg.root.trim() {
        "" => ".",
        r => r,
    };
    let base = sftp.canonicalize(root).await.map_err(|e| match sftp_err(e) {
        FsError::NotFound => FsError::Invalid(format!("folder {root} does not exist on {}", cfg.host)),
        e => e,
    })?;
    if !sftp.metadata(base.clone()).await.map_err(sftp_err)?.file_type().is_dir() {
        return Err(FsError::Invalid(format!("{base} on {} is not a folder", cfg.host)));
    }
    let conn = Conn {
        ssh,
        sftp,
        base: base.trim_end_matches('/').to_string(),
        used: StdMutex::new(Instant::now()),
    };
    Ok((conn, fp.unwrap_or_default()))
}

/// For the settings page: can we get in, and how many entries are at the root?
pub async fn probe(cfg: &MountCfg) -> Result<(String, usize), FsError> {
    let (c, fp) = connect(cfg).await?;
    let n = c.sftp.read_dir(c.at(&RelPath::root())).await.map_err(sftp_err)?.count();
    let _ = c.ssh.disconnect(russh::Disconnect::ByApplication, "", "en").await;
    Ok((fp, n))
}

fn entry(name: String, m: &FileAttributes) -> Entry {
    let dir = m.file_type().is_dir();
    Entry {
        name,
        is_dir: dir,
        size: if dir { 0 } else { m.size.unwrap_or(0) },
        mtime: m.mtime.unwrap_or(0) as i64,
        nanos: 0,
    }
}

/// A remote file that keeps its connection alive while it is being read.
struct Held<T> {
    inner: T,
    _conn: Arc<Conn>,
}

impl<T: AsyncRead + Unpin> AsyncRead for Held<T> {
    fn poll_read(mut self: Pin<&mut Self>, cx: &mut Context<'_>, buf: &mut ReadBuf<'_>) -> Poll<io::Result<()>> {
        Pin::new(&mut self.inner).poll_read(cx, buf)
    }
}

impl<T: AsyncSeek + Unpin> AsyncSeek for Held<T> {
    fn start_seek(mut self: Pin<&mut Self>, pos: io::SeekFrom) -> io::Result<()> {
        Pin::new(&mut self.inner).start_seek(pos)
    }
    fn poll_complete(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<u64>> {
        Pin::new(&mut self.inner).poll_complete(cx)
    }
}

pub struct Sftp {
    cfg: MountCfg,
    host_key: StdMutex<Option<String>>,
    conn: Mutex<Option<Arc<Conn>>>,
    on_pin: PinFn,
}

impl Sftp {
    pub fn new(cfg: MountCfg, on_pin: PinFn) -> Arc<Self> {
        Arc::new(Sftp { host_key: StdMutex::new(cfg.host_key.clone()), cfg, conn: Mutex::new(None), on_pin })
    }

    /// Close the connection now (open readers keep theirs).
    pub async fn close(&self) {
        *self.conn.lock().await = None;
    }

    async fn conn(&self) -> Result<Arc<Conn>, FsError> {
        let mut g = self.conn.lock().await;
        if let Some(c) = g.as_ref() {
            if !c.ssh.is_closed() {
                *c.used.lock().unwrap() = Instant::now();
                return Ok(c.clone());
            }
        }
        *g = None;
        let mut cfg = self.cfg.clone();
        cfg.host_key = self.host_key.lock().unwrap().clone();
        let (c, fp) = connect(&cfg).await?;
        if cfg.host_key.is_none() && !fp.is_empty() {
            tracing::info!("sftp {}: pinned host key {fp}", cfg.host);
            *self.host_key.lock().unwrap() = Some(fp.clone());
            (self.on_pin)(&fp);
        }
        let c = Arc::new(c);
        *g = Some(c.clone());
        Ok(c)
    }

    /// Run a read-only operation, reconnecting once if the connection went away.
    async fn run<T, F, Fut>(&self, f: F) -> Result<T, FsError>
    where
        F: Fn(Arc<Conn>) -> Fut,
        Fut: Future<Output = Result<T, SErr>> + Send,
    {
        let c = self.conn().await?;
        match f(c).await {
            Err(e) if is_transport(&e) => {
                tracing::info!("sftp {}: reconnecting after {e}", self.cfg.host);
                *self.conn.lock().await = None;
                f(self.conn().await?).await.map_err(sftp_err)
            }
            r => r.map_err(sftp_err),
        }
    }

    async fn exists(&self, c: &Conn, p: &RelPath) -> bool {
        c.sftp.symlink_metadata(c.at(p)).await.is_ok()
    }

    /// Hard-link `from` as `to` (`hardlink@openssh.com`). False when the
    /// server does not offer the extension.
    pub async fn hardlink(&self, from: &RelPath, to: &RelPath) -> Result<bool, FsError> {
        let c = self.conn().await?;
        c.sftp.hardlink(c.at(from), c.at(to)).await.map_err(sftp_err)
    }
}

#[async_trait]
impl Backend for Sftp {
    async fn stat(&self, p: &RelPath) -> Result<Entry, FsError> {
        let m = self
            .run(|c| {
                let path = c.at(p);
                async move { c.sftp.metadata(path).await }
            })
            .await?;
        Ok(entry(p.name().unwrap_or("").to_string(), &m))
    }

    async fn list(&self, p: &RelPath) -> Result<Vec<Entry>, FsError> {
        let raw = self
            .run(|c| {
                let path = c.at(p);
                async move {
                    let mut out = Vec::new();
                    for e in c.sftp.read_dir(path.clone()).await? {
                        let name = e.file_name();
                        if name == "." || name == ".." {
                            continue;
                        }
                        let mut m = e.metadata();
                        if m.file_type().is_symlink() {
                            match c.sftp.metadata(format!("{}/{name}", path.trim_end_matches('/'))).await {
                                Ok(t) => m = t,
                                Err(_) => continue, // dangling
                            }
                        }
                        out.push((name, m));
                    }
                    Ok(out)
                }
            })
            .await?;
        Ok(raw.into_iter().map(|(n, m)| entry(n, &m)).collect())
    }

    async fn open(&self, p: &RelPath) -> Result<(Entry, Box<dyn ReadSeek>), FsError> {
        let e = self.stat(p).await?;
        if e.is_dir {
            return Err(FsError::IsDir);
        }
        let c = self.conn().await?;
        let f = c.sftp.open(c.at(p)).await.map_err(sftp_err)?;
        Ok((e, Box::new(Held { inner: f, _conn: c })))
    }

    async fn write(&self, p: &RelPath, mut data: ByteStream) -> Result<Entry, FsError> {
        let parent = p.parent().ok_or(FsError::Invalid("cannot write the root".into()))?;
        let name = p.name().unwrap_or_default();
        let part = parent.child(&format!(".{}.shelf-part", &name[..name.len().min(200)]))?;
        let c = self.conn().await?;
        if !c.sftp.metadata(c.at(&parent)).await.map_err(sftp_err)?.file_type().is_dir() {
            return Err(FsError::NotDir);
        }
        let existing = c.sftp.metadata(c.at(p)).await.ok();
        if existing.as_ref().is_some_and(|m| m.file_type().is_dir()) {
            return Err(FsError::IsDir);
        }
        let flags = OpenFlags::CREATE | OpenFlags::TRUNCATE | OpenFlags::WRITE;
        let mut f = if self.cfg.private {
            let attrs = FileAttributes { permissions: Some(0o600), ..Default::default() };
            c.sftp.open_with_flags_and_attributes(c.at(&part), flags, attrs).await.map_err(sftp_err)?
        } else {
            c.sftp.open_with_flags(c.at(&part), flags).await.map_err(sftp_err)?
        };
        let res: Result<(), FsError> = async {
            while let Some(chunk) = data.next().await {
                f.write_all(&chunk?).await?;
            }
            f.shutdown().await?;
            Ok(())
        }
        .await;
        if let Err(e) = res {
            let _ = c.sftp.remove_file(c.at(&part)).await;
            return Err(e);
        }
        // plain SFTP rename refuses to replace, so the old file goes first
        if existing.is_some() {
            c.sftp.remove_file(c.at(p)).await.map_err(sftp_err)?;
        }
        c.sftp.rename(c.at(&part), c.at(p)).await.map_err(sftp_err)?;
        self.stat(p).await
    }

    async fn mkdir(&self, p: &RelPath) -> Result<(), FsError> {
        let c = self.conn().await?;
        if self.exists(&c, p).await {
            return Err(FsError::Exists);
        }
        c.sftp.create_dir(c.at(p)).await.map_err(sftp_err)?;
        if self.cfg.private {
            let attrs = FileAttributes { permissions: Some(0o700), ..Default::default() };
            c.sftp.set_metadata(c.at(p), attrs).await.map_err(sftp_err)?;
        }
        Ok(())
    }

    async fn remove(&self, p: &RelPath) -> Result<(), FsError> {
        if p.is_root() {
            return Err(FsError::Invalid("cannot remove the root".into()));
        }
        let c = self.conn().await?;
        let path = c.at(p);
        let m = c.sftp.symlink_metadata(path.clone()).await.map_err(sftp_err)?;
        if !m.file_type().is_dir() {
            return c.sftp.remove_file(path).await.map_err(sftp_err);
        }
        // depth first; a folder is removed on its second visit, once it is empty
        let mut stack = vec![(path, false)];
        while let Some((dir, emptied)) = stack.pop() {
            if emptied {
                c.sftp.remove_dir(dir).await.map_err(sftp_err)?;
                continue;
            }
            stack.push((dir.clone(), true));
            for e in c.sftp.read_dir(dir.clone()).await.map_err(sftp_err)? {
                let name = e.file_name();
                if name == "." || name == ".." {
                    continue;
                }
                let full = format!("{dir}/{name}");
                if e.file_type().is_dir() {
                    stack.push((full, false));
                } else {
                    c.sftp.remove_file(full).await.map_err(sftp_err)?;
                }
            }
        }
        Ok(())
    }

    async fn rename(&self, from: &RelPath, to: &RelPath) -> Result<(), FsError> {
        let c = self.conn().await?;
        if self.exists(&c, to).await {
            return Err(FsError::Exists);
        }
        c.sftp.rename(c.at(from), c.at(to)).await.map_err(sftp_err)
    }

    /// `statvfs@openssh.com`; None from servers without it
    async fn space(&self, p: &RelPath) -> Result<Option<Space>, FsError> {
        let s = self
            .run(|c| {
                let path = c.at(p);
                async move { c.sftp.fs_info(path).await }
            })
            .await?;
        Ok(s.map(|s| {
            let f = if s.fragment_size > 0 { s.fragment_size } else { s.block_size };
            Space { size: s.blocks * f, used: s.blocks.saturating_sub(s.blocks_free) * f, free: s.blocks_avail * f }
        }))
    }
}

/// Live SFTP backends by mount id.
pub struct Pool {
    db: Arc<Db>,
    map: StdMutex<HashMap<i64, Arc<Sftp>>>,
}

impl Pool {
    pub fn new(db: Arc<Db>) -> Self {
        Pool { db, map: StdMutex::new(HashMap::new()) }
    }

    pub fn get(&self, id: i64) -> Option<Arc<Sftp>> {
        self.map.lock().unwrap().get(&id).cloned()
    }

    pub fn insert(&self, cfg: MountCfg) -> Arc<Sftp> {
        let (id, db) = (cfg.id, self.db.clone());
        let s = Sftp::new(
            cfg,
            Arc::new(move |fp: &str| {
                db.with(|c| c.execute("UPDATE mounts SET host_key = ?1 WHERE id = ?2 AND host_key IS NULL", rusqlite::params![fp, id]))
                    .ok();
            }),
        );
        self.map.lock().unwrap().insert(id, s.clone());
        s
    }

    /// After a mount is edited or deleted; open readers keep their connection.
    pub fn forget(&self, id: i64) {
        self.map.lock().unwrap().remove(&id);
    }

    pub fn reap(&self, idle: Duration) {
        let all: Vec<Arc<Sftp>> = self.map.lock().unwrap().values().cloned().collect();
        for s in all {
            if let Ok(mut g) = s.conn.try_lock() {
                if g.as_ref().is_some_and(|c| c.used.lock().unwrap().elapsed() > idle) {
                    tracing::debug!("mount {}: closing idle connection", s.cfg.id);
                    *g = None;
                }
            }
        }
    }
}
