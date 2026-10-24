//! Earlier versions of what is in a home, from the nightly backup's snapshots
//! (backup.rs). A snapshot's manifest.json says which files it holds, with
//! their size, mtime and sha256; the content is read from the snapshot over
//! SFTP. A file can be looked at as it was, a folder looked through as it was,
//! and either put back: in its place when that is free, else next to it as
//! `name (2026-10-12).ext`, or a file over the one there now.
//!
//! Homes only: storage over SFTP is not backed up, and a shared path may have
//! held other things of its owner's before it was shared.

use std::{
    collections::{BTreeMap, HashMap, HashSet},
    io,
    sync::{Arc, Mutex},
    time::Duration,
};

use axum::{
    extract::{Path, Query, State},
    http::{HeaderMap, StatusCode},
    response::Response,
    routing::{get, post},
    Json, Router,
};
use bytes::Bytes;
use futures_util::{future, stream, StreamExt};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use tokio::io::AsyncReadExt;
use tokio_util::io::ReaderStream;

use crate::{
    auth::User,
    backup::{self, Manifest, Rec},
    db,
    error::{AppError, Res},
    files::{self, Target},
    http_util, quota,
    vfs::{sftp::Sftp, Backend, ByteStream, Entry, FsError, RelPath},
    App,
};

pub fn routes() -> Router<Arc<App>> {
    Router::new()
        .route("/api/versions/{loc}", get(versions))
        .route("/api/versions/{loc}/{*path}", get(versions))
        .route("/api/snap/{snap}/ls/{loc}", get(snap_ls))
        .route("/api/snap/{snap}/ls/{loc}/{*path}", get(snap_ls))
        .route("/api/snap/{snap}/raw/{loc}/{*path}", get(snap_raw))
        .route("/api/restore", post(restore))
}

/// The backup target, kept open between requests, and the manifests read from it.
#[derive(Default)]
pub struct Snapshots {
    /// the `backup` setting it was opened with, and the target
    target: Mutex<Option<(String, Arc<Sftp>)>>,
    manifests: Mutex<HashMap<String, Arc<Manifest>>>,
}

fn remote(e: impl std::fmt::Display) -> AppError {
    AppError::new(StatusCode::BAD_GATEWAY, format!("backup: {e}"))
}

impl Snapshots {
    /// The target; opened anew when the backup setting changed.
    fn target(&self, app: &App) -> Res<Arc<Sftp>> {
        let setting = db::get_setting(&app.db, "backup")?.ok_or_else(|| AppError::bad("there is no backup to take versions from"))?;
        let mut g = self.target.lock().unwrap();
        if let Some((_, t)) = g.as_ref().filter(|(s, _)| *s == setting) {
            return Ok(t.clone());
        }
        let t = backup::reader(app, &setting)?;
        *g = Some((setting, t.clone()));
        Ok(t)
    }

    /// Housekeeping: the connection goes after a while without use.
    pub fn reap(&self, idle: Duration) {
        let t = self.target.lock().unwrap().as_ref().map(|(_, t)| t.clone());
        if t.is_some_and(|t| t.close_idle(idle)) {
            tracing::debug!("versions: closed idle backup connection");
        }
    }

    /// The snapshots there are, newest first. Manifests of the ones gone are dropped.
    async fn list(&self, t: &Sftp) -> Res<Vec<String>> {
        let mut v: Vec<String> = t
            .list(&RelPath::root())
            .await
            .map_err(remote)?
            .into_iter()
            .filter(|e| e.is_dir && backup::stamp_secs(&e.name).is_some())
            .map(|e| e.name)
            .collect();
        v.sort_by(|a, b| b.cmp(a));
        self.manifests.lock().unwrap().retain(|k, _| v.contains(k));
        Ok(v)
    }

    /// A snapshot's manifest; read once, a snapshot does not change. None if it
    /// is damaged.
    async fn manifest(&self, t: &Sftp, snap: &str) -> Res<Option<Arc<Manifest>>> {
        if let Some(m) = self.manifests.lock().unwrap().get(snap) {
            return Ok(Some(m.clone()));
        }
        let (_, mut f) = match t.open(&RelPath::parse(&format!("{snap}/manifest.json"))?).await {
            Ok(v) => v,
            Err(FsError::NotFound) => return Err(AppError::new(StatusCode::NOT_FOUND, "there is no such backup")),
            Err(e) => return Err(remote(e)),
        };
        let mut raw = Vec::new();
        f.read_to_end(&mut raw).await.map_err(remote)?;
        let parsed = tokio::task::spawn_blocking(move || serde_json::from_slice::<Manifest>(&raw)).await.map_err(AppError::internal)?;
        let m = match parsed {
            Ok(m) => Arc::new(m),
            Err(e) => {
                tracing::warn!("versions: {snap}/manifest.json is damaged: {e}");
                return Ok(None);
            }
        };
        self.manifests.lock().unwrap().insert(snap.to_string(), m.clone());
        Ok(Some(m))
    }

    /// A manifest that has to be there.
    async fn need(&self, t: &Sftp, snap: &str) -> Res<Arc<Manifest>> {
        self.manifest(t, snap).await?.ok_or_else(|| AppError::internal(format!("{snap}/manifest.json is damaged")))
    }
}

fn loc_sub(p: &HashMap<String, String>) -> (String, String) {
    (p.get("loc").cloned().unwrap_or_default(), p.get("path").cloned().unwrap_or_default())
}

fn snap_of(name: &str) -> Res<String> {
    backup::stamp_secs(name).map(|_| name.to_string()).ok_or_else(|| AppError::bad("bad snapshot name"))
}

/// The user's home: the only place with versions.
async fn home(app: &App, user: &User, loc: &str, sub: &str) -> Res<Target> {
    if loc != "home" {
        return Err(AppError::bad("earlier versions are kept for the home only"));
    }
    files::resolve(app, user, loc, sub).await
}

/// Where a path of a home is in a snapshot, and in its manifest.
fn key(user: &str, p: &RelPath) -> String {
    format!("users/{user}{}", if p.is_root() { String::new() } else { p.to_string() })
}

/// The files of a manifest below the folder `key`, by their path from there.
fn under<'a>(m: &'a Manifest, key: &str) -> impl Iterator<Item = (&'a str, &'a Rec)> + 'a {
    let prefix = format!("{key}/");
    let n = prefix.len();
    m.files.range(prefix.clone()..).take_while(move |(k, _)| k.starts_with(&prefix)).map(move |(k, r)| (&k[n..], r))
}

/// The file now is the one the record describes, as the backup decides it. A
/// time without its sub-second part (a restored file) matches on the seconds.
fn same(r: &Rec, e: &Entry) -> bool {
    !e.is_dir && (r.0, r.1) == (e.size, e.mtime) && (r.2 == e.nanos || e.nanos == 0)
}

#[derive(Serialize, Clone)]
struct Snap {
    name: String,
    /// when the backup began
    time: Option<i64>,
}

impl Snap {
    fn new(name: &str) -> Self {
        Snap { name: name.into(), time: backup::stamp_time(name) }
    }
}

/// One version: a file's content, or a folder as one snapshot has it.
#[derive(Serialize)]
struct Version {
    dir: bool,
    /// bytes; of a folder, of all its files
    size: u64,
    /// a file's modification time; of a folder, its newest file's
    mtime: i64,
    /// files in a folder
    #[serde(skip_serializing_if = "Option::is_none")]
    files: Option<u64>,
    /// the file is like this now
    same: bool,
    /// the snapshots that have it, newest first
    snaps: Vec<Snap>,
}

/// What the backups have of a file or folder: `versions`, newest first; a
/// file's once per content.
async fn versions(State(app): State<Arc<App>>, user: User, Path(p): Path<HashMap<String, String>>) -> Res<Json<Value>> {
    let (loc, sub) = loc_sub(&p);
    let t = home(&app, &user, &loc, &sub).await?;
    let now = match t.backend.stat(&t.path).await {
        Ok(e) => Some(e),
        Err(FsError::NotFound) => None,
        Err(e) => return Err(e.into()),
    };
    let target = app.snaps.target(&app)?;
    let snaps = app.snaps.list(&target).await?;
    let k = key(&user.username, &t.path);
    let mut out: Vec<Version> = Vec::new();
    let mut by_sha: HashMap<String, usize> = HashMap::new();
    let mut read = Vec::new();
    for s in &snaps {
        // a damaged one, or one pruned since the listing, is left out
        let m = match app.snaps.manifest(&target, s).await {
            Ok(Some(m)) => m,
            Ok(None) => continue,
            Err(e) if e.status == StatusCode::NOT_FOUND => continue,
            Err(e) => return Err(e),
        };
        read.push(Snap::new(s));
        if let Some(r) = m.files.get(&k) {
            if let Some(&i) = by_sha.get(&r.3) {
                out[i].snaps.push(Snap::new(s));
                continue;
            }
            by_sha.insert(r.3.clone(), out.len());
            out.push(Version {
                dir: false,
                size: r.0,
                mtime: r.1,
                files: None,
                same: now.as_ref().is_some_and(|e| same(r, e)),
                snaps: vec![Snap::new(s)],
            });
            continue;
        }
        let (n, size, mtime) = under(&m, &k).fold((0u64, 0u64, 0i64), |(n, b, t), (_, r)| (n + 1, b + r.0, t.max(r.1)));
        if n > 0 {
            out.push(Version { dir: true, size, mtime, files: Some(n), same: false, snaps: vec![Snap::new(s)] });
        }
    }
    Ok(Json(json!({
        "path": t.rel().to_string(), "name": t.name(&t.path),
        "now": now.map(|e| e.json()),
        "snapshots": read,
        "versions": out,
    })))
}

/// A folder as a snapshot has it, each entry marked with how it is now:
/// `gone`, `same` or `changed` (files), `here` (folders).
async fn snap_ls(State(app): State<Arc<App>>, user: User, Path(p): Path<HashMap<String, String>>) -> Res<Json<Value>> {
    let (loc, sub) = loc_sub(&p);
    let snap = snap_of(p.get("snap").map_or("", String::as_str))?;
    let t = home(&app, &user, &loc, &sub).await?;
    let target = app.snaps.target(&app)?;
    let m = app.snaps.need(&target, &snap).await?;
    let k = key(&user.username, &t.path);
    // name -> files, bytes, newest mtime
    let mut dirs: BTreeMap<&str, (u64, u64, i64)> = BTreeMap::new();
    let mut plain: Vec<(&str, &Rec)> = Vec::new();
    for (rest, r) in under(&m, &k) {
        match rest.split_once('/') {
            Some((d, _)) => {
                let e = dirs.entry(d).or_default();
                *e = (e.0 + 1, e.1 + r.0, e.2.max(r.1));
            }
            None => plain.push((rest, r)),
        }
    }
    if dirs.is_empty() && plain.is_empty() && !t.path.is_root() {
        return Err(AppError::new(StatusCode::NOT_FOUND, "this backup does not have it"));
    }
    let now: HashMap<String, Entry> = match t.backend.list(&t.path).await {
        Ok(l) => l.into_iter().map(|e| (e.name.clone(), e)).collect(),
        Err(_) => HashMap::new(),
    };
    let mut entries: Vec<Value> = dirs
        .into_iter()
        .map(|(name, (n, size, mtime))| {
            let state = match now.get(name) {
                None => "gone",
                Some(e) if e.is_dir => "here",
                Some(_) => "changed",
            };
            json!({ "name": name, "dir": true, "files": n, "size": size, "mtime": mtime, "now": state })
        })
        .collect();
    entries.extend(plain.into_iter().map(|(name, r)| {
        let state = match now.get(name) {
            None => "gone",
            Some(e) if same(r, e) => "same",
            Some(_) => "changed",
        };
        json!({ "name": name, "dir": false, "size": r.0, "mtime": r.1, "now": state })
    }));
    Ok(Json(json!({ "snap": Snap::new(&snap), "path": t.rel().to_string(), "entries": entries })))
}

#[derive(Deserialize)]
struct RawQ {
    dl: Option<String>,
}

/// A file as a snapshot has it, with ranges, like `/api/raw`.
async fn snap_raw(
    State(app): State<Arc<App>>,
    user: User,
    Path(p): Path<HashMap<String, String>>,
    Query(q): Query<RawQ>,
    headers: HeaderMap,
) -> Res<Response> {
    let (loc, sub) = loc_sub(&p);
    let snap = snap_of(p.get("snap").map_or("", String::as_str))?;
    let t = home(&app, &user, &loc, &sub).await?;
    let target = app.snaps.target(&app)?;
    let m = app.snaps.need(&target, &snap).await?;
    let k = key(&user.username, &t.path);
    let r = m.files.get(&k).ok_or_else(AppError::not_found)?;
    let (mut e, f) = target.open(&RelPath::parse(&format!("{snap}/{k}"))?).await.map_err(|e| match e {
        FsError::NotFound => AppError::not_found(),
        e => remote(e),
    })?;
    // the version's own time, and with it its etag
    (e.mtime, e.nanos) = (r.1, r.2);
    Ok(http_util::serve(e, f, &headers, &t.name(&t.path), q.dl.is_some(), false, None).await)
}

#[derive(Deserialize)]
struct RestoreReq {
    loc: String,
    path: String,
    snap: String,
    /// a file goes over the one there now instead of next to it
    #[serde(default)]
    replace: bool,
}

/// Puts back what snapshot `snap` has at `path`; answers where it went.
async fn restore(State(app): State<Arc<App>>, user: User, Json(req): Json<RestoreReq>) -> Res<Json<Value>> {
    let snap = snap_of(&req.snap)?;
    let t = home(&app, &user, &req.loc, &req.path).await?;
    if t.path.is_root() {
        return Err(AppError::bad("restore what is in it, one by one"));
    }
    let target = app.snaps.target(&app)?;
    let m = app.snaps.need(&target, &snap).await?;
    let k = key(&user.username, &t.path);
    // carries on if the page is left half way
    let job = {
        let app = app.clone();
        tokio::spawn(async move {
            let res = put_back(&app, &t, &target, &snap, &m, &k, req.replace).await;
            match &res {
                Ok(to) => tracing::info!("versions: {} restored {k} of {snap} as {to}", user.username),
                Err(e) => tracing::warn!("versions: {} restoring {k} of {snap}: {}", user.username, e.msg),
            }
            res
        })
    };
    let to = job.await.map_err(AppError::internal)??;
    Ok(Json(json!({ "path": to.to_string() })))
}

/// Writes the file or folder `k` of snapshot `snap` into the home at `t.path`
/// if that is free (or `replace` and both are files), else next to it.
async fn put_back(app: &Arc<App>, t: &Target, src: &Sftp, snap: &str, m: &Manifest, k: &str, replace: bool) -> Res<RelPath> {
    let file = m.files.get(k);
    let inside: Vec<(&str, &Rec)> = under(m, k).collect();
    if file.is_none() && inside.is_empty() {
        return Err(AppError::new(StatusCode::NOT_FOUND, "this backup does not have it"));
    }
    let to = match t.backend.stat(&t.path).await {
        Err(FsError::NotFound) => t.path.clone(),
        Ok(e) if replace && !e.is_dir && file.is_some() => t.path.clone(),
        Ok(_) => free_name(t, &snap[..10], file.is_none()).await?,
        Err(e) => return Err(e.into()),
    };
    files::mkdirs(t.backend.as_ref(), &t.root, &to.parent().unwrap_or_default()).await?;
    let store = files::store_id(t.owner, t.mount);
    let res = match file {
        Some(r) => put_file(app, t, src, &format!("{snap}/{k}"), r, &to).await,
        None => async {
            t.backend.mkdir(&to).await?;
            let mut made = HashSet::new();
            for (rest, r) in inside {
                let dst = to.join(&RelPath::parse(rest)?);
                if let Some(dir) = dst.parent().filter(|d| made.insert(d.to_string())) {
                    files::mkdirs(t.backend.as_ref(), &to, &dir).await?;
                }
                put_file(app, t, src, &format!("{snap}/{k}/{rest}"), r, &dst).await?;
            }
            Ok::<(), AppError>(())
        }
        .await,
    };
    app.sizes.touch(&store, &to);
    files::changed(app, t);
    res.map(|()| to)
}

/// `name (2026-10-12).ext` next to the item, ` (2)`… after the date when that
/// is taken too. Folders keep their name whole.
async fn free_name(t: &Target, day: &str, dir: bool) -> Res<RelPath> {
    let parent = t.path.parent().unwrap_or_default();
    let name = t.path.name().unwrap_or_default();
    let (stem, ext) = match name.rfind('.') {
        Some(i) if i > 0 && !dir => name.split_at(i),
        _ => (name, ""),
    };
    for n in 1..1000 {
        let mark = if n == 1 { format!("({day})") } else { format!("({day}) ({n})") };
        let p = parent.child(&format!("{stem} {mark}{ext}"))?;
        match t.backend.stat(&p).await {
            Err(FsError::NotFound) => return Ok(p),
            Err(e) => return Err(e.into()),
            Ok(_) => {}
        }
    }
    Err(AppError::conflict("no free name to restore it under"))
}

/// One file of a snapshot (`from`, a path on the target) into the home at
/// `to`, with its modification time back. It counts against the storage
/// limit, and is kept only if it hashes to what the manifest says.
async fn put_file(app: &Arc<App>, t: &Target, src: &Sftp, from: &str, r: &Rec, to: &RelPath) -> Res<()> {
    let (_, f) = src.open(&RelPath::parse(from)?).await.map_err(remote)?;
    let replaces = t.backend.stat(to).await.ok().filter(|e| !e.is_dir).map_or(0, |e| e.size);
    let w = quota::start(app, t.owner, t.mount, replaces, Some(r.0)).await?;
    let fault = Fault::default();
    let mut data = checked(Box::pin(ReaderStream::with_capacity(f, 256 * 1024)), r.3.clone(), fault.clone());
    if let Some(w) = &w {
        data = w.wrap(data);
    }
    t.backend.write(to, data).await.map_err(|e| match fault.lock().unwrap().take() {
        Some(m) => AppError::new(StatusCode::BAD_GATEWAY, m),
        None => quota::why(&w, e),
    })?;
    if let Some(w) = w {
        w.stored();
    }
    t.backend.set_mtime(to, r.1).await?;
    Ok(())
}

/// What went wrong on the backup's side of a restore; the write that fails
/// with it only knows an I/O error.
type Fault = Arc<Mutex<Option<String>>>;

/// The bytes of a backed-up file, ending in an error if they do not hash to
/// `sha`, so the write keeps nothing. Either failure is noted in `fault`.
fn checked(data: ByteStream, sha: String, fault: Fault) -> ByteStream {
    let h = Arc::new(Mutex::new(Sha256::new()));
    let (fed, failed) = (h.clone(), fault.clone());
    let body = data.inspect(move |c| match c {
        Ok(b) => fed.lock().unwrap().update(b),
        Err(e) => *failed.lock().unwrap() = Some(format!("backup: reading failed: {e}")),
    });
    let end = stream::once(future::lazy(move |_| {
        if hex::encode(h.lock().unwrap().clone().finalize()) == sha {
            return None;
        }
        let m = "the copy in the backup does not match its checksum";
        *fault.lock().unwrap() = Some(m.into());
        Some(Err::<Bytes, _>(io::Error::other(m)))
    }))
    .filter_map(future::ready);
    Box::pin(body.chain(end))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rec(size: u64) -> Rec {
        (size, 1, 0, String::new())
    }

    #[test]
    fn files_under_a_folder() {
        let mut m = Manifest::default();
        for (p, n) in [("users/a/x", 1), ("users/a/d/y", 2), ("users/a/d/z/w", 3), ("users/a/d2/v", 4), ("users/ab/q", 5), ("shelf.db", 6)] {
            m.files.insert(p.into(), rec(n));
        }
        let got: Vec<(&str, u64)> = under(&m, "users/a").map(|(p, r)| (p, r.0)).collect();
        assert_eq!(got, [("d/y", 2), ("d/z/w", 3), ("d2/v", 4), ("x", 1)]);
        let got: Vec<&str> = under(&m, "users/a/d").map(|(p, _)| p).collect();
        assert_eq!(got, ["y", "z/w"]);
        assert_eq!(under(&m, "users/a/x").count(), 0);
        assert_eq!(key("a", &RelPath::root()), "users/a");
        assert_eq!(key("a", &RelPath::parse("/d/y").unwrap()), "users/a/d/y");
    }

    #[tokio::test]
    async fn checksums() {
        let data = || -> ByteStream { Box::pin(stream::iter([Ok(Bytes::from_static(b"hello ")), Ok(Bytes::from_static(b"world"))])) };
        let sha = hex::encode(Sha256::digest(b"hello world"));
        let fault = Fault::default();
        let ok: Vec<io::Result<Bytes>> = checked(data(), sha, fault.clone()).collect().await;
        assert!(ok.iter().all(Result::is_ok) && ok.len() == 2);
        assert!(fault.lock().unwrap().is_none());
        let bad: Vec<io::Result<Bytes>> = checked(data(), "00".into(), fault.clone()).collect().await;
        assert_eq!(bad.len(), 3);
        assert!(bad[2].is_err());
        assert!(fault.lock().unwrap().as_deref().is_some_and(|m| m.contains("checksum")));
    }
}
