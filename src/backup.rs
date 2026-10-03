//! Nightly backup to an SFTP server, taken while shelf keeps serving: the
//! database is copied with `VACUUM INTO` on a connection of its own (WAL lets
//! it read a consistent snapshot next to live writes), and files are only
//! read. Shelf replaces files by rename, so every read sees a whole version.
//!
//! Every run writes a complete snapshot folder named by its local time, and
//! three are kept (see [`retain`]). A file unchanged since the newest snapshot,
//! or whose content any kept snapshot already has, is hard-linked instead of
//! sent, so each distinct content is stored once. Remote layout:
//!
//! ```text
//! RESTORE.md               how to rebuild the server, which snapshots there are
//! 2026-09-27T031500/       one snapshot:
//!   manifest.json          size, mtime and sha256 of every file in it
//!   shelf.db               database snapshot
//!   secret.key             unseals the SFTP credentials in the database
//!   users/…  deleted/…     user files, files of removed users
//!   etc/…                  systemd unit and environment file
//!   bin/shelf              the running binary
//! .partial-<time>/         a run in progress, or one that died
//! ```
//!
//! Nothing else in the target folder is touched. Mounted SFTP storage is not
//! backed up.

use std::{
    collections::{BTreeMap, HashMap, HashSet},
    fs,
    io::{self, Read, Seek},
    os::{fd::AsRawFd, unix::fs::MetadataExt},
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    time::Duration,
};

use anyhow::{anyhow, Context};
use axum::{
    extract::State,
    routing::{get, post},
    Json, Router,
};
use bytes::Bytes;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use tokio::io::AsyncReadExt;
use tokio_util::io::ReaderStream;

use crate::{
    auth::Admin,
    db::{self, now, Db},
    error::{AppError, Res},
    mounts::{self, SftpForm},
    vfs::{
        sftp::{self, MountCfg, Sftp},
        Backend, ByteStream, FsError, RelPath,
    },
    App,
};

/// Copied along if readable, so a rebuilt server starts the same way.
const EXTRA: &[(&str, &str)] = &[
    ("/etc/systemd/system/shelf.service", "etc/shelf.service"),
    ("/etc/shelf/shelf.env", "etc/shelf.env"),
    ("/proc/self/exe", "bin/shelf"),
];

pub fn routes() -> Router<Arc<App>> {
    Router::new()
        .route("/api/backup", get(show).put(save))
        .route("/api/backup/test", post(test))
        .route("/api/backup/run", post(run_now))
}

/// The `backup` setting.
#[derive(Serialize, Deserialize, Clone, Default)]
struct Conf {
    enabled: bool,
    /// local time, `HH:MM`
    time: String,
    host: String,
    port: u16,
    username: String,
    auth: String,
    root: String,
    /// sealed `mounts::Secret`
    secret: String,
    host_key: Option<String>,
}

fn load(db: &Db) -> Res<Option<Conf>> {
    match db::get_setting(db, "backup")? {
        Some(s) => Ok(Some(serde_json::from_str(&s).map_err(AppError::internal)?)),
        None => Ok(None),
    }
}

fn store(db: &Db, c: &Conf) -> Res<()> {
    db::set_setting(db, "backup", &serde_json::to_string(c).expect("json"))
}

fn target_cfg(app: &App, c: &Conf) -> Res<MountCfg> {
    let form = SftpForm {
        host: c.host.clone(),
        port: Some(c.port),
        username: c.username.clone(),
        auth: c.auth.clone(),
        root: Some(c.root.clone()),
        ..Default::default()
    };
    let mut cfg = form.cfg(0, &mounts::unseal(app, &c.secret)?, c.host_key.clone())?;
    cfg.private = true;
    Ok(cfg)
}

/// Whether a run is going on, and how far it got.
#[derive(Default)]
pub struct Runner {
    running: AtomicBool,
    status: Mutex<String>,
}

impl Runner {
    fn set(&self, s: impl Into<String>) {
        *self.status.lock().unwrap() = s.into();
    }
}

fn local_time(ts: i64) -> libc::tm {
    let t = ts as libc::time_t;
    // SAFETY: localtime_r only writes the tm it is given
    unsafe {
        let mut tm: libc::tm = std::mem::zeroed();
        libc::localtime_r(&t, &mut tm);
        tm
    }
}

/// `2026-09-27T03:15:00+02:00`, for people
fn iso_time(ts: i64) -> String {
    let t = local_time(ts);
    let off = t.tm_gmtoff / 60;
    format!(
        "{:04}-{:02}-{:02}T{:02}:{:02}:{:02}{}{:02}:{:02}",
        t.tm_year + 1900,
        t.tm_mon + 1,
        t.tm_mday,
        t.tm_hour,
        t.tm_min,
        t.tm_sec,
        if off < 0 { '-' } else { '+' },
        off.abs() / 60,
        off.abs() % 60
    )
}

/// `2026-09-27T031500`: names a snapshot and sorts by time.
fn stamp(ts: i64) -> String {
    let t = local_time(ts);
    format!(
        "{:04}-{:02}-{:02}T{:02}{:02}{:02}",
        t.tm_year + 1900,
        t.tm_mon + 1,
        t.tm_mday,
        t.tm_hour,
        t.tm_min,
        t.tm_sec
    )
}

/// Seconds of a [`stamp`], reading local time as if it were UTC; only
/// differences are used. None for anything that is not a stamp.
fn stamp_secs(s: &str) -> Option<i64> {
    let b = s.as_bytes();
    if b.len() != 17 || b[4] != b'-' || b[7] != b'-' || b[10] != b'T' {
        return None;
    }
    let num = |r: std::ops::Range<usize>| -> Option<i64> {
        if !b[r.clone()].iter().all(u8::is_ascii_digit) {
            return None;
        }
        s[r].parse().ok()
    };
    let (y, mo, d) = (num(0..4)?, num(5..7)?, num(8..10)?);
    let (h, mi, se) = (num(11..13)?, num(13..15)?, num(15..17)?);
    if !(1..=12).contains(&mo) || !(1..=31).contains(&d) || h > 23 || mi > 59 || se > 60 {
        return None;
    }
    // days from the civil date, after Howard Hinnant
    let y = if mo <= 2 { y - 1 } else { y };
    let doy = (153 * ((mo + 9) % 12) + 2) / 5 + d - 1;
    let yoe = y % 400;
    let days = y / 400 * 146097 + yoe * 365 + yoe / 4 - yoe / 100 + doy - 719468;
    Some(days * 86400 + h * 3600 + mi * 60 + se)
}

/// Which snapshots to keep, given their times newest first; returns indices.
/// The newest stays, plus one from the week before it and one from one to four
/// weeks before it. With one run a night the second is 1–7 days older than the
/// newest and the third 8–29: once the second is more than a week old it
/// either replaces the third (if that would pass 30 days before the next such
/// turn) or goes, and the run before the newest takes its place.
fn retain(times: &[i64]) -> Vec<usize> {
    if times.len() <= 3 {
        return (0..times.len()).collect();
    }
    // whole days before the newest, rounded
    let age = |i: usize| (times[0] - times[i] + 43200).div_euclid(86400);
    let (prev, week, month) = (1, 2, times.len() - 1);
    if age(week) <= 7 {
        vec![0, week, month]
    } else if age(month) + 7 > 30 {
        vec![0, prev, week]
    } else {
        vec![0, prev, month]
    }
}

fn check_time(s: &str) -> Res<String> {
    let bad = || AppError::bad("time must be HH:MM");
    let (h, m) = s.trim().split_once(':').ok_or_else(bad)?;
    let (h, m): (u32, u32) = (h.parse().map_err(|_| bad())?, m.parse().map_err(|_| bad())?);
    if h > 23 || m > 59 {
        return Err(bad());
    }
    Ok(format!("{h:02}:{m:02}"))
}

/// Checks twice a minute. A run missed while the server was down happens as
/// soon as it is back.
pub async fn scheduler(app: Arc<App>) {
    app.db
        .with(|c| c.execute("UPDATE backup_runs SET finished = started, ok = 0, message = 'interrupted' WHERE finished IS NULL", []))
        .ok();
    let mut tick = tokio::time::interval(Duration::from_secs(30));
    loop {
        tick.tick().await;
        let Ok(Some(conf)) = load(&app.db) else { continue };
        if !conf.enabled {
            continue;
        }
        let day = stamp(now())[..10].to_string();
        let t = local_time(now());
        if format!("{:02}:{:02}", t.tm_hour, t.tm_min) < conf.time {
            continue;
        }
        if db::get_setting(&app.db, "backup_last_day").ok().flatten().as_deref() == Some(day.as_str()) {
            continue;
        }
        db::set_setting(&app.db, "backup_last_day", &day).ok();
        if let Err(e) = start(&app) {
            tracing::warn!("backup: not started: {}", e.msg);
        }
    }
}

/// How long the UPS page may be unreadable before pruning goes ahead without it.
const UPS_GRACE: i64 = 600;

/// Reads the UPS page: Some(true) on line power, Some(false) on anything else,
/// None if the page cannot be read. When it went unreadable is kept in the
/// settings (`ups_down_since`), so `shelf backup run` knows it too.
async fn ups_read(app: &App, url: &str) -> Option<bool> {
    let read = async {
        let client = reqwest::Client::builder()
            .timeout(Duration::from_secs(10))
            .user_agent(concat!("shelf/", env!("CARGO_PKG_VERSION")))
            .build()?;
        let body = client.get(url).send().await?.error_for_status()?.bytes().await?;
        let v: Value = serde_json::from_slice(&body)?;
        anyhow::Ok(v["status"]["flags"].as_object().is_some_and(|f| f.values().any(|x| x == "on line power")))
    };
    match read.await {
        Ok(line) => {
            app.db.with(|c| c.execute("DELETE FROM settings WHERE key = 'ups_down_since'", [])).ok();
            Some(line)
        }
        Err(e) => {
            if db::get_setting(&app.db, "ups_down_since").ok().flatten().is_none() {
                tracing::warn!("ups: cannot read {url}: {e:#}");
                db::set_setting(&app.db, "ups_down_since", &now().to_string()).ok();
            }
            None
        }
    }
}

/// The UPS page has been unreadable for [`UPS_GRACE`]; then backups go on as
/// if there were no UPS.
fn ups_gone(app: &App) -> bool {
    let since = db::get_setting(&app.db, "ups_down_since").ok().flatten().and_then(|s| s.parse::<i64>().ok());
    since.is_some_and(|t| now() - t >= UPS_GRACE)
}

/// Old snapshots are removed only while the UPS reads "on line power" (or its
/// page has been gone a while, or there is no UPS); a power cut during the
/// removal could leave a half-removed snapshot.
async fn may_prune(app: &App) -> bool {
    let Some(url) = &app.cfg.ups_url else { return true };
    match ups_read(app, url).await {
        Some(line) => line,
        None => ups_gone(app),
    }
}

fn prune_pending(app: &App) -> bool {
    db::get_setting(&app.db, "backup_prune_pending").ok().flatten().is_some()
}

/// Looks at the UPS page once in every five minutes, at a random second. A
/// backup starts when it stops reading line power; a pruning put off for want
/// of line power happens once it is back.
pub async fn ups_watch(app: Arc<App>) {
    let Some(url) = app.cfg.ups_url.clone() else { return };
    let mut on_battery = false;
    loop {
        let t = now();
        let next = (t / 300 + 1) * 300 + rand::random::<i64>().rem_euclid(300);
        tokio::time::sleep(Duration::from_secs((next - t) as u64)).await;
        let line = ups_read(&app, &url).await;
        match line {
            Some(false) if !on_battery => {
                on_battery = true;
                tracing::warn!("ups: not on line power; starting a backup");
                if let Err(e) = start(&app) {
                    tracing::warn!("backup: not started: {}", e.msg);
                }
            }
            Some(true) if on_battery => {
                on_battery = false;
                tracing::info!("ups: on line power again");
            }
            _ => {}
        }
        if prune_pending(&app) && (line == Some(true) || line.is_none() && ups_gone(&app)) {
            start_prune(&app);
        }
    }
}

/// Held for a run, so the server and `shelf backup run` never overlap.
fn lock(app: &App) -> Res<fs::File> {
    let dir = app.cfg.data.join("backup");
    fs::create_dir_all(&dir).map_err(AppError::internal)?;
    let f = fs::OpenOptions::new()
        .create(true)
        .truncate(false)
        .write(true)
        .open(dir.join("lock"))
        .map_err(AppError::internal)?;
    // SAFETY: flock only looks at the descriptor, which f keeps open
    if unsafe { libc::flock(f.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) } != 0 {
        return Err(AppError::conflict("a backup is running already"));
    }
    Ok(f)
}

pub fn start(app: &Arc<App>) -> Res<()> {
    let conf = load(&app.db)?.ok_or_else(|| AppError::bad("no backup target configured"))?;
    if app.backup.running.swap(true, Ordering::SeqCst) {
        return Err(AppError::conflict("a backup is running already"));
    }
    let held = match lock(app) {
        Ok(f) => f,
        Err(e) => {
            app.backup.running.store(false, Ordering::SeqCst);
            return Err(e);
        }
    };
    let app = app.clone();
    tokio::spawn(async move {
        let _ = execute(&app, &conf).await;
        drop(held);
        app.backup.running.store(false, Ordering::SeqCst);
    });
    Ok(())
}

/// The pruning a run had to leave, on its own. Quietly skipped while a run is
/// going on; that run prunes, or the next look at the UPS tries again.
fn start_prune(app: &Arc<App>) {
    let Ok(Some(conf)) = load(&app.db) else { return };
    if app.backup.running.swap(true, Ordering::SeqCst) {
        return;
    }
    let Ok(held) = lock(app) else {
        app.backup.running.store(false, Ordering::SeqCst);
        return;
    };
    let app = app.clone();
    tokio::spawn(async move {
        tracing::info!("backup: pruning that was put off");
        let res = async {
            let target = connect(&app, &conf)?;
            let res = prune(&app, &conf, &target, true).await;
            target.close().await;
            res
        }
        .await;
        match res {
            Ok(keep) => tracing::info!("backup: pruned; snapshots {}", keep.join(", ")),
            Err(e) => tracing::error!("backup: pruning failed: {e:#}"),
        }
        app.backup.set("");
        drop(held);
        app.backup.running.store(false, Ordering::SeqCst);
    });
}

/// One run, recorded in `backup_runs`.
async fn execute(app: &Arc<App>, conf: &Conf) -> anyhow::Result<()> {
    let started = now();
    let id = app.db.with(|c| {
        c.execute("INSERT INTO backup_runs (started) VALUES (?1)", [started])?;
        Ok(c.last_insert_rowid())
    });
    tracing::info!("backup: started");
    let mut st = Stats::default();
    let res = run(app, conf, &mut st).await;
    let msg = match &res {
        Ok(()) => {
            let mut m = format!("{} files; snapshots {}", st.checked, st.kept.join(", "));
            if st.no_links {
                m += "; the target cannot hard-link, so every file was sent";
            }
            if st.prune_put_off {
                m += "; old snapshots stay until the UPS is on line power";
            }
            m
        }
        Err(e) => format!("{e:#}"),
    };
    if res.is_ok() {
        tracing::info!("backup: done, {} sent ({}), {} linked; {msg}", st.uploaded, human(st.bytes), st.linked);
    } else {
        tracing::error!("backup: failed: {msg}");
    }
    if let Ok(id) = id {
        app.db
            .with(|c| {
                c.execute(
                    "UPDATE backup_runs SET finished = ?1, ok = ?2, uploaded = ?3, bytes = ?4, linked = ?5, message = ?6
                     WHERE id = ?7",
                    rusqlite::params![
                        now(),
                        res.is_ok(),
                        st.uploaded as i64,
                        st.bytes as i64,
                        st.linked as i64,
                        msg,
                        id
                    ],
                )
            })
            .ok();
    }
    app.backup.set("");
    res
}

#[derive(Default)]
struct Stats {
    checked: u64,
    uploaded: u64,
    bytes: u64,
    linked: u64,
    /// the target has no `hardlink@openssh.com`
    no_links: bool,
    /// the UPS was not on line power, so nothing was removed
    prune_put_off: bool,
    kept: Vec<String>,
}

/// size, mtime seconds, mtime nanoseconds, sha256
type Rec = (u64, i64, u32, String);

#[derive(Serialize, Deserialize, Default)]
struct Manifest {
    finished: i64,
    files: BTreeMap<String, Rec>,
}

struct Item {
    /// path inside the snapshot
    remote: String,
    src: PathBuf,
    /// size, mtime seconds and nanoseconds when the walk saw it
    seen: (u64, i64, u32),
}

fn seen(m: &fs::Metadata) -> (u64, i64, u32) {
    (m.len(), m.mtime(), m.mtime_nsec() as u32)
}

/// Regular files and folders below `src`; symlinks and the like are skipped,
/// as is whatever disappears while we look.
fn walk(src: &Path, remote: &str, items: &mut Vec<Item>, dirs: &mut Vec<String>) -> io::Result<()> {
    let rd = match fs::read_dir(src) {
        Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(()),
        r => r?,
    };
    dirs.push(remote.to_string());
    for e in rd {
        let e = e?;
        let Ok(name) = e.file_name().into_string() else { continue };
        let Ok(ft) = e.file_type() else { continue };
        let r = format!("{remote}/{name}");
        if ft.is_dir() {
            walk(&e.path(), &r, items, dirs)?;
        } else if ft.is_file() {
            if let Ok(m) = e.metadata() {
                items.push(Item { remote: r, src: e.path(), seen: seen(&m) });
            }
        }
    }
    Ok(())
}

async fn ensure_dir(b: &dyn Backend, made: &mut HashSet<String>, dir: &RelPath) -> Result<(), FsError> {
    let mut cur = RelPath::root();
    for s in dir.segs() {
        cur = cur.child(s)?;
        let k = cur.to_string();
        if made.contains(&k) {
            continue;
        }
        match b.mkdir(&cur).await {
            Ok(()) | Err(FsError::Exists) => {}
            Err(e) => return Err(e),
        }
        made.insert(k);
    }
    Ok(())
}

fn once(data: Vec<u8>) -> ByteStream {
    Box::pin(futures_util::stream::once(async move { Ok(Bytes::from(data)) }))
}

async fn read_remote(b: &dyn Backend, p: &str) -> anyhow::Result<Option<Vec<u8>>> {
    match b.open(&RelPath::parse(p)?).await {
        Ok((_, mut r)) => {
            let mut v = Vec::new();
            r.read_to_end(&mut v).await?;
            Ok(Some(v))
        }
        Err(FsError::NotFound) => Ok(None),
        Err(e) => Err(e.into()),
    }
}

/// Opens and hashes `src`. The file comes back rewound, so what is sent is
/// what was hashed (shelf never rewrites a file in place). None if it is gone.
async fn hash(src: PathBuf) -> anyhow::Result<Option<(fs::File, Rec)>> {
    let res = tokio::task::spawn_blocking(move || -> io::Result<(fs::File, Rec)> {
        let mut f = fs::File::open(&src)?;
        let m = f.metadata()?;
        let mut h = Sha256::new();
        let mut buf = vec![0; 256 << 10];
        loop {
            let n = f.read(&mut buf)?;
            if n == 0 {
                break;
            }
            h.update(&buf[..n]);
        }
        f.rewind()?;
        let (size, secs, nanos) = seen(&m);
        Ok((f, (size, secs, nanos, hex::encode(h.finalize()))))
    })
    .await?;
    match res {
        Ok(v) => Ok(Some(v)),
        Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(e.into()),
    }
}

/// Hard-links `from` (a path on the target) as `to`. False means send the
/// file instead: the target cannot link, or `from` is not there any more.
async fn link(t: &Sftp, st: &mut Stats, from: &str, to: &RelPath) -> anyhow::Result<bool> {
    if st.no_links {
        return Ok(false);
    }
    match t.hardlink(&RelPath::parse(from)?, to).await {
        Ok(true) => {
            st.linked += 1;
            Ok(true)
        }
        Ok(false) => {
            st.no_links = true;
            Ok(false)
        }
        Err(e) => {
            tracing::warn!("backup: linking {from}: {e}; sending it instead");
            Ok(false)
        }
    }
}

fn human(n: u64) -> String {
    let mut f = n as f64;
    for u in ["B", "KiB", "MiB", "GiB"] {
        if f < 1024.0 {
            return format!("{f:.1} {u}");
        }
        f /= 1024.0;
    }
    format!("{f:.1} TiB")
}

async fn run(app: &Arc<App>, conf: &Conf, st: &mut Stats) -> anyhow::Result<()> {
    let label = stamp(now());
    let work = app.cfg.data.join("backup");
    fs::create_dir_all(&work)?;
    let snap = work.join("shelf.db");
    app.backup.set("copying the database");
    {
        let (src, snap) = (app.cfg.data.join("shelf.db"), snap.clone());
        tokio::task::spawn_blocking(move || -> anyhow::Result<()> {
            let _ = fs::remove_file(&snap);
            let c = rusqlite::Connection::open(&src)?;
            c.busy_timeout(Duration::from_secs(30))?;
            c.execute("VACUUM INTO ?1", [snap.to_string_lossy()])?;
            Ok(())
        })
        .await?
        .context("database snapshot")?;
    }
    let res = sync(app, conf, st, &label, &snap).await;
    let _ = fs::remove_file(&snap);
    res
}

async fn sync(app: &Arc<App>, conf: &Conf, st: &mut Stats, label: &str, snap: &Path) -> anyhow::Result<()> {
    app.backup.set("looking for files");
    let (items, dirs) = {
        let (data, snap) = (app.cfg.data.clone(), snap.to_path_buf());
        tokio::task::spawn_blocking(move || -> io::Result<(Vec<Item>, Vec<String>)> {
            let (mut items, mut dirs) = (Vec::new(), Vec::new());
            let mut add = |src: PathBuf, remote: &str| {
                if let Ok(m) = fs::metadata(&src) {
                    items.push(Item { remote: remote.into(), src, seen: seen(&m) });
                }
            };
            add(snap, "shelf.db");
            add(data.join("secret.key"), "secret.key");
            for (src, remote) in EXTRA {
                if fs::File::open(src).is_ok() {
                    add(src.into(), remote);
                }
            }
            walk(&data.join("users"), "users", &mut items, &mut dirs)?;
            walk(&data.join("deleted"), "deleted", &mut items, &mut dirs)?;
            Ok((items, dirs))
        })
        .await??
    };

    let target = connect(app, conf)?;
    let res = snapshot(app, conf, &target, st, label, &items, &dirs).await;
    target.close().await;
    res
}

fn connect(app: &App, conf: &Conf) -> anyhow::Result<Arc<Sftp>> {
    app.backup.set("connecting");
    let cfg = target_cfg(app, conf).map_err(|e| anyhow!(e.msg))?;
    let db = app.db.clone();
    Ok(Sftp::new(
        cfg,
        Arc::new(move |fp: &str| {
            if let Ok(Some(mut c)) = load(&db) {
                if c.host_key.is_none() {
                    c.host_key = Some(fp.into());
                    store(&db, &c).ok();
                }
            }
        }),
    ))
}

/// Writes `.partial-<label>`, renames it to `<label>` once complete, then
/// removes the snapshots [`retain`] lets go if [`may_prune`].
#[allow(clippy::too_many_arguments)]
async fn snapshot(
    app: &App,
    conf: &Conf,
    t: &Sftp,
    st: &mut Stats,
    label: &str,
    items: &[Item],
    dirs: &[String],
) -> anyhow::Result<()> {
    let b: &dyn Backend = t;
    let top = b.list(&RelPath::root()).await.context("listing the target folder")?;
    for e in &top {
        if e.is_dir && e.name.strip_prefix(".partial-").is_some_and(|s| stamp_secs(s).is_some()) {
            app.backup.set(format!("removing the unfinished {}", e.name));
            b.remove(&RelPath::parse(&e.name)?).await.with_context(|| format!("removing {}", e.name))?;
        }
    }
    let mut snaps: Vec<String> =
        top.into_iter().filter(|e| e.is_dir && stamp_secs(&e.name).is_some()).map(|e| e.name).collect();
    snaps.sort_by(|x, y| y.cmp(x));

    // content already on the target by sha256, newest snapshot first
    let mut known: HashMap<String, String> = HashMap::new();
    let mut last: Option<(String, Manifest)> = None;
    for s in &snaps {
        app.backup.set(format!("reading {s}/manifest.json"));
        let raw = read_remote(b, &format!("{s}/manifest.json")).await.with_context(|| format!("reading {s}/manifest.json"))?;
        let m: Manifest = match raw.map(|r| serde_json::from_slice(&r)) {
            Some(Ok(m)) => m,
            Some(Err(e)) => {
                tracing::warn!("backup: {s}/manifest.json is damaged: {e}");
                continue;
            }
            None => continue,
        };
        for (p, r) in &m.files {
            known.entry(r.3.clone()).or_insert_with(|| format!("{s}/{p}"));
        }
        if last.is_none() {
            last = Some((s.clone(), m));
        }
    }

    let part = format!(".partial-{label}");
    let at = |p: &str| RelPath::parse(&format!("{part}/{p}"));
    let mut made = HashSet::new();
    ensure_dir(b, &mut made, &RelPath::parse(&part)?).await.with_context(|| format!("creating {part}"))?;
    for d in dirs {
        ensure_dir(b, &mut made, &at(d)?).await.with_context(|| format!("creating {d}"))?;
    }
    let mut man = Manifest::default();
    let total = items.len();
    for (i, it) in items.iter().enumerate() {
        st.checked += 1;
        app.backup.set(format!(
            "{} of {total} files, {} sent ({}), {} linked: {}",
            i + 1,
            st.uploaded,
            human(st.bytes),
            st.linked,
            it.remote
        ));
        let dst = at(&it.remote)?;
        ensure_dir(b, &mut made, &dst.parent().unwrap_or_default()).await?;
        // unchanged since the newest snapshot
        if let Some((s, m)) = &last {
            if let Some(r) = m.files.get(&it.remote).filter(|r| (r.0, r.1, r.2) == it.seen) {
                if link(t, st, &format!("{s}/{}", it.remote), &dst).await? {
                    man.files.insert(it.remote.clone(), r.clone());
                    continue;
                }
            }
        }
        let Some((f, rec)) = hash(it.src.clone()).await.with_context(|| format!("reading {}", it.src.display()))? else {
            continue; // deleted since the walk
        };
        // the same content under another name or in an older snapshot
        if let Some(from) = known.get(&rec.3) {
            if link(t, st, from, &dst).await? {
                man.files.insert(it.remote.clone(), rec);
                continue;
            }
        }
        b.write(&dst, Box::pin(ReaderStream::with_capacity(tokio::fs::File::from_std(f), 256 * 1024)))
            .await
            .with_context(|| format!("uploading {}", it.remote))?;
        st.uploaded += 1;
        st.bytes += rec.0;
        known.insert(rec.3.clone(), format!("{part}/{}", it.remote));
        man.files.insert(it.remote.clone(), rec);
    }
    man.finished = now();
    b.write(&at("manifest.json")?, once(serde_json::to_vec(&man)?)).await.context("writing manifest.json")?;
    b.rename(&RelPath::parse(&part)?, &RelPath::parse(label)?)
        .await
        .with_context(|| format!("renaming {part} to {label}"))?;

    app.backup.set("asking the UPS");
    let may = may_prune(app).await;
    st.prune_put_off = !may;
    st.kept = prune(app, conf, t, may).await?;
    Ok(())
}

/// Removes the snapshots [`retain`] lets go, or with `may` false only notes
/// that this is still to do (`backup_prune_pending`). Rewrites RESTORE.md
/// either way; returns the snapshots left.
async fn prune(app: &App, conf: &Conf, t: &Sftp, may: bool) -> anyhow::Result<Vec<String>> {
    let b: &dyn Backend = t;
    let mut snaps: Vec<String> = b
        .list(&RelPath::root())
        .await
        .context("listing the target folder")?
        .into_iter()
        .filter(|e| e.is_dir && stamp_secs(&e.name).is_some())
        .map(|e| e.name)
        .collect();
    snaps.sort_by(|x, y| y.cmp(x));
    let keep: Vec<String> = if may {
        let times: Vec<i64> = snaps.iter().map(|s| stamp_secs(s).unwrap_or_default()).collect();
        let keep: Vec<String> = retain(&times).into_iter().map(|i| snaps[i].clone()).collect();
        for s in snaps.iter().filter(|s| !keep.contains(s)) {
            app.backup.set(format!("removing {s}"));
            b.remove(&RelPath::parse(s)?).await.with_context(|| format!("removing {s}"))?;
        }
        keep
    } else {
        snaps
    };
    b.write(&RelPath::parse("RESTORE.md")?, once(restore_md(app, conf, &keep).into_bytes()))
        .await
        .context("writing RESTORE.md")?;
    db::set_setting(&app.db, "backup_snapshots", &serde_json::to_string(&keep)?).map_err(|e| anyhow!(e.msg))?;
    if may {
        app.db.with(|c| c.execute("DELETE FROM settings WHERE key = 'backup_prune_pending'", [])).map_err(|e| anyhow!(e.msg))?;
    } else {
        db::set_setting(&app.db, "backup_prune_pending", &now().to_string()).map_err(|e| anyhow!(e.msg))?;
    }
    Ok(keep)
}

fn restore_md(app: &App, conf: &Conf, keep: &[String]) -> String {
    let list: String = keep.iter().map(|s| format!("    {s}/\n")).collect();
    format!(
        r#"# Restoring shelf

Backups of the shelf instance on {host}; this file was last written {time}.

{list}
Each folder, named by the server's local time, is a complete copy. A file that
did not change between runs is a hard link shared by the folders, so it takes
space once. Kept are the newest, one from the week before it and one from one
to four weeks before it; the others are removed after each run. A
`.partial-<time>` folder is a run that did not finish; the next run removes it.

    shelf.db         database: users, shares, links, mounts, settings
    secret.key       unseals the SFTP credentials stored in the database
    users/<name>/    everyone's files
    deleted/         files of deleted users
    etc/             systemd unit and environment file
    bin/shelf        the program (x86_64 Linux)
    manifest.json    size, mtime and sha256 of every file above

Files on external SFTP mounts are not in here; they live on their own servers.

## Rebuild

On a fresh Linux server, as root, taking the newest folder (or an older one):

    scp -r {user}@{server}:{root}/{newest} /root/shelf-backup
    useradd -r -m -d /home/shelf -s /sbin/nologin shelf
    B=/root/shelf-backup
    install -m 600 $B/shelf.db $B/secret.key /home/shelf/
    cp -a $B/users $B/deleted /home/shelf/
    chown -R shelf:shelf /home/shelf
    install -D -m 755 $B/bin/shelf /opt/shelf/target/release/shelf
    install -D -m 644 $B/etc/shelf.service /etc/systemd/system/shelf.service
    install -D -m 644 $B/etc/shelf.env /etc/shelf/shelf.env
    systemctl daemon-reload && systemctl enable --now shelf

Then allow port 80/tcp in the firewall (SHELF_BIND in shelf.env sets it). If
the binary does not run there, build it from the shelf source
with `cargo build --release` in /opt/shelf.

Users log in with their old passwords and public links keep working. The
sha256 of every file must match manifest.json.
"#,
        host = app.cfg.host,
        time = iso_time(now()),
        user = conf.username,
        server = conf.host,
        root = conf.root,
        newest = keep.first().map_or("<time>", String::as_str),
    )
}

fn overview(app: &App) -> Res<Value> {
    let config = match load(&app.db)? {
        Some(c) => {
            let s = mounts::unseal(app, &c.secret)?;
            json!({
                "enabled": c.enabled, "time": c.time, "host": c.host, "port": c.port,
                "username": c.username, "auth": c.auth, "root": c.root, "host_key": c.host_key,
                "has_password": s.password.is_some(), "has_key": s.key.is_some(),
            })
        }
        None => Value::Null,
    };
    let snapshots: Vec<String> =
        db::get_setting(&app.db, "backup_snapshots")?.and_then(|s| serde_json::from_str(&s).ok()).unwrap_or_default();
    let runs = app.db.with(|c| {
        let mut st = c.prepare(
            "SELECT id, started, finished, ok, uploaded, bytes, linked, message FROM backup_runs ORDER BY id DESC LIMIT 30",
        )?;
        let v = st
            .query_map([], |r| {
                Ok(json!({
                    "id": r.get::<_, i64>(0)?, "started": r.get::<_, i64>(1)?, "finished": r.get::<_, Option<i64>>(2)?,
                    "ok": r.get::<_, Option<bool>>(3)?, "uploaded": r.get::<_, i64>(4)?, "bytes": r.get::<_, i64>(5)?,
                    "linked": r.get::<_, i64>(6)?, "message": r.get::<_, Option<String>>(7)?,
                }))
            })?
            .collect::<rusqlite::Result<Vec<_>>>();
        v
    })?;
    Ok(json!({
        "config": config,
        "running": app.backup.running.load(Ordering::SeqCst),
        "status": app.backup.status.lock().unwrap().clone(),
        "snapshots": snapshots,
        "prune_pending": prune_pending(app),
        "runs": runs,
    }))
}

async fn show(State(app): State<Arc<App>>, _a: Admin) -> Res<Json<Value>> {
    Ok(Json(overview(&app)?))
}

#[derive(Deserialize)]
struct ConfReq {
    #[serde(default)]
    enabled: bool,
    time: String,
    #[serde(flatten)]
    sftp: SftpForm,
    #[serde(default)]
    reset_host_key: bool,
}

/// Connects first; the host key is pinned from then on. Returns the host key
/// and how many entries the target folder has.
async fn configure(app: &App, req: ConfReq) -> Res<(String, usize)> {
    let time = check_time(&req.time)?;
    let old = load(&app.db)?;
    let old_secret = match &old {
        Some(o) => Some(mounts::unseal(app, &o.secret)?),
        None => None,
    };
    let secret = req.sftp.secret(old_secret);
    let port = req.sftp.port.unwrap_or(22);
    let pinned = old
        .filter(|o| !req.reset_host_key && o.host == req.sftp.host.trim() && o.port == port)
        .and_then(|o| o.host_key);
    let cfg = req.sftp.cfg(0, &secret, pinned)?;
    let (fp, n) = sftp::probe(&cfg).await?;
    store(
        &app.db,
        &Conf {
            enabled: req.enabled,
            time,
            host: cfg.host,
            port: cfg.port,
            username: cfg.user,
            auth: req.sftp.auth,
            root: cfg.root,
            secret: mounts::seal(app, &secret),
            host_key: Some(fp.clone()),
        },
    )?;
    Ok((fp, n))
}

async fn save(State(app): State<Arc<App>>, _a: Admin, Json(req): Json<ConfReq>) -> Res<Json<Value>> {
    let (fp, n) = configure(&app, req).await?;
    Ok(Json(json!({ "ok": true, "host_key": fp, "entries": n })))
}

async fn test(State(app): State<Arc<App>>, _a: Admin) -> Res<Json<Value>> {
    let conf = load(&app.db)?.ok_or_else(|| AppError::bad("no backup target configured"))?;
    let (fp, n) = sftp::probe(&target_cfg(&app, &conf)?).await?;
    Ok(Json(json!({ "ok": true, "host_key": fp, "entries": n })))
}

async fn run_now(State(app): State<Arc<App>>, _a: Admin) -> Res<Json<Value>> {
    start(&app)?;
    Ok(Json(json!({ "started": true })))
}

/// `shelf backup set|run|show`, as the shelf user. `set` reads the private key
/// (`--key`) or password (`--password`) from stdin, so neither shows up in the
/// process list or shell history.
pub fn cli(app: App, args: &[String]) -> anyhow::Result<()> {
    let app = Arc::new(app);
    let opt = |f: &str| args.iter().position(|a| a == f).and_then(|i| args.get(i + 1)).map(String::as_str);
    let flag = |f: &str| args.iter().any(|a| a == f);
    let e = |e: AppError| anyhow!(e.msg);
    let rt = tokio::runtime::Builder::new_multi_thread().enable_all().build()?;
    match args.first().map(String::as_str) {
        Some("set") => {
            let old = load(&app.db).map_err(e)?;
            let target = match (opt("--target"), &old) {
                (Some(t), _) => t.to_string(),
                (None, Some(o)) => format!("{}@{}:{}", o.username, o.host, o.root),
                (None, None) => anyhow::bail!("--target user@host:/folder is required"),
            };
            let bad = || anyhow!("--target is user@host:/folder");
            let (user, rest) = target.split_once('@').ok_or_else(bad)?;
            let (host, root) = rest.split_once(':').ok_or_else(bad)?;
            let auth = match (flag("--key"), flag("--password")) {
                (true, _) => "key",
                (_, true) => "password",
                _ => old.as_ref().map_or("key", |o| o.auth.as_str()),
            };
            let mut secret = String::new();
            if flag("--key") || flag("--password") {
                eprintln!("{} on stdin:", if auth == "key" { "private key" } else { "password (one line)" });
                io::stdin().read_to_string(&mut secret)?;
                if auth == "password" {
                    secret = secret.lines().next().unwrap_or_default().to_string();
                }
            }
            let req = ConfReq {
                enabled: !flag("--off"),
                time: opt("--time")
                    .map(str::to_string)
                    .or_else(|| old.as_ref().map(|o| o.time.clone()))
                    .unwrap_or_else(|| "03:15".into()),
                sftp: SftpForm {
                    host: host.into(),
                    port: match opt("--port") {
                        Some(p) => Some(p.parse().context("--port")?),
                        None => old.as_ref().map(|o| o.port),
                    },
                    username: user.into(),
                    auth: auth.into(),
                    password: (auth == "password").then(|| secret.clone()),
                    key: (auth == "key").then(|| secret.clone()),
                    passphrase: None,
                    root: Some(root.into()),
                },
                reset_host_key: flag("--reset-host-key"),
            };
            let (fp, n) = rt.block_on(configure(&app, req)).map_err(e)?;
            eprintln!("saved; target reachable ({n} entries), host key {fp}");
        }
        Some("run") => {
            let conf = load(&app.db).map_err(e)?.context("no backup target configured; see shelf backup set")?;
            let _held = lock(&app).map_err(e)?;
            rt.block_on(async {
                let a = app.clone();
                let progress = tokio::spawn(async move {
                    let mut last = String::new();
                    loop {
                        tokio::time::sleep(Duration::from_secs(5)).await;
                        let s = a.backup.status.lock().unwrap().clone();
                        if !s.is_empty() && s != last {
                            eprintln!("{s}");
                            last = s;
                        }
                    }
                });
                let res = execute(&app, &conf).await;
                progress.abort();
                res
            })?;
        }
        Some("show") => println!("{}", serde_json::to_string_pretty(&overview(&app).map_err(e)?)?),
        _ => anyhow::bail!(
            "usage: shelf backup set [--target user@host:/folder] [--port N] [--time HH:MM] [--key|--password] [--off] [--reset-host-key] | run | show"
        ),
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    const DAY: i64 = 86400;

    /// Feeds runs at times `runs` (ascending) through [`retain`] as the backup
    /// does, handing each run's time and the kept set (newest first) to `check`.
    fn simulate(runs: &[i64], mut check: impl FnMut(i64, &[i64])) {
        let mut kept: Vec<i64> = Vec::new();
        for &t in runs {
            kept.insert(0, t);
            kept = retain(&kept).into_iter().map(|i| kept[i]).collect();
            check(t, &kept);
        }
    }

    #[test]
    fn stamps() {
        assert_eq!(stamp_secs("1970-01-01T000000"), Some(0));
        assert_eq!(stamp_secs("2026-09-27T031500"), Some(1_790_478_900));
        assert_eq!(stamp_secs("2000-03-01T000000"), Some(951_868_800));
        for bad in ["test", "2026-09-27T0315", "2026-13-01T000000", "2026-09-27 031500", "2026-09-27T03150x", ".partial-2026"] {
            assert_eq!(stamp_secs(bad), None, "{bad}");
        }
        let t = 1_790_478_900;
        assert_eq!(stamp_secs(&stamp(t + DAY)).unwrap() - stamp_secs(&stamp(t)).unwrap(), DAY);
    }

    #[test]
    fn nightly() {
        let runs: Vec<i64> = (0..200).map(|d| d * DAY + 3 * 3600 + 900).collect();
        simulate(&runs, |t, kept| {
            let (day, age) = (t / DAY, |k: i64| (t - k) / DAY);
            assert_eq!(kept[0], t);
            assert_eq!(kept.len(), (day as usize + 1).min(3), "day {day}");
            if day >= 30 {
                assert!((1..=7).contains(&age(kept[1])), "day {day}: {kept:?}");
                assert!((8..=30).contains(&age(kept[2])), "day {day}: {kept:?}");
            }
        });
    }

    #[test]
    fn extra_runs_and_gaps() {
        // nightly, with runs by hand the same day and the server off for days
        let (mut runs, mut t, mut r) = (Vec::new(), 0, 7u64);
        for _ in 0..600 {
            r = r.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
            t += match r >> 59 {
                0 => 5 * DAY,
                1..=4 => 3600,
                _ => DAY,
            };
            runs.push(t);
        }
        simulate(&runs, |t, kept| {
            assert_eq!(kept[0], t);
            assert!(kept.len() == 3 || t < runs[2], "{kept:?}");
            assert!(kept.windows(2).all(|w| w[0] > w[1]), "{kept:?}");
            assert!(t - kept[kept.len() - 1] <= 40 * DAY, "{kept:?}");
        });
    }
}
