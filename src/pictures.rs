//! The "pictures" metaplace: every picture a user can see (their home and
//! folders shared with them; not SFTP storage) in one list, newest first.
//!
//! A background scan walks the users' folders and keeps an index in the
//! database (`pictures`): when each picture was taken, from its EXIF data,
//! else a date in its name, else one in its folder, else its modification
//! time. Hard links (an album next to the dated folders) are one picture.
//! Small versions for the grid and the slideshow are made on request, and for
//! the grid ahead of time after each scan; they are kept in `<data>/thumbs`.

use std::{
    collections::{HashMap, HashSet},
    fs,
    io::{self, Cursor},
    os::unix::fs::MetadataExt,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex, RwLock,
    },
    time::{Duration, Instant, SystemTime},
};

use axum::{
    body::Body,
    extract::{Path as UrlPath, Query, State},
    http::{header, HeaderMap, StatusCode},
    response::Response,
    routing::get,
    Json, Router,
};
use image::{codecs::jpeg::JpegEncoder, imageops::FilterType, metadata::Orientation, DynamicImage, ImageDecoder};
use rusqlite::params;
use serde::Deserialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

use crate::{
    auth::User,
    error::{AppError, Res},
    files, http_util,
    vfs::FsError,
    App,
};

pub fn routes() -> Router<Arc<App>> {
    Router::new()
        .route("/api/pictures", get(list))
        .route("/api/thumb/{loc}", get(thumb))
        .route("/api/thumb/{loc}/{*path}", get(thumb))
}

/// What the browser can show; the rest (tif, heic) stays in the file list.
const EXTS: &[&str] = &["jpg", "jpeg", "png", "gif", "webp", "bmp", "avif"];

fn is_picture(name: &str) -> bool {
    name.rsplit_once('.').is_some_and(|(_, e)| EXTS.iter().any(|x| x.eq_ignore_ascii_case(e)))
}

fn is_jpeg(name: &str) -> bool {
    name.rsplit_once('.').is_some_and(|(_, e)| e.eq_ignore_ascii_case("jpg") || e.eq_ignore_ascii_case("jpeg"))
}

/// Where a picture's date came from, best first.
#[derive(Clone, Copy, PartialEq, Debug)]
enum Src {
    Exif,
    Name,
    Folder,
    Mtime,
}

impl Src {
    fn as_str(self) -> &'static str {
        match self {
            Src::Exif => "exif",
            Src::Name => "name",
            Src::Folder => "folder",
            Src::Mtime => "mtime",
        }
    }
    fn parse(s: &str) -> Src {
        match s {
            "exif" => Src::Exif,
            "name" => Src::Name,
            "folder" => Src::Folder,
            _ => Src::Mtime,
        }
    }
}

#[derive(Clone, Debug)]
struct Pic {
    owner: i64,
    /// in the owner's home, `/a/b.jpg`
    path: String,
    size: u64,
    mtime: i64,
    dev: u64,
    ino: u64,
    /// the EXIF date; None when the file has none (or is not a JPEG)
    exif: Option<i64>,
    /// wall-clock seconds, as if UTC
    taken: i64,
    src: Src,
}

impl Pic {
    fn same_file(&self, m: &fs::Metadata) -> bool {
        self.size == m.len() && self.mtime == m.mtime() && self.dev == m.dev() && self.ino == m.ino()
    }
}

#[derive(Default)]
struct Progress {
    /// scanning or making thumbnails
    busy: bool,
    scanning: bool,
    done: usize,
    total: usize,
    finished: Option<Instant>,
    /// files changed during the run: another one follows
    again: bool,
}

pub struct Index {
    pics: RwLock<Arc<Vec<Pic>>>,
    state: Mutex<Progress>,
    /// pictures being made at a time (the grid's requests and the scan's)
    work: tokio::sync::Semaphore,
}

/// Set on shutdown: the scan and the thumbnail run stop at the next file.
static STOP: AtomicBool = AtomicBool::new(false);

pub fn stop() {
    STOP.store(true, Ordering::Relaxed);
}

impl Index {
    pub fn new() -> Self {
        Index { pics: Default::default(), state: Default::default(), work: tokio::sync::Semaphore::new(2) }
    }

    /// The index as the last scan left it.
    pub fn load(&self, db: &crate::db::Db) -> Res<()> {
        let v = db.with(|c| {
            let mut st = c.prepare("SELECT owner_id, path, size, mtime, dev, ino, exif, taken, src FROM pictures")?;
            let v = st
                .query_map([], |r| {
                    Ok(Pic {
                        owner: r.get(0)?,
                        path: r.get(1)?,
                        size: r.get::<_, i64>(2)? as u64,
                        mtime: r.get(3)?,
                        dev: r.get::<_, i64>(4)? as u64,
                        ino: r.get::<_, i64>(5)? as u64,
                        exif: r.get(6)?,
                        taken: r.get(7)?,
                        src: Src::parse(&r.get::<_, String>(8)?),
                    })
                })?
                .collect::<rusqlite::Result<Vec<_>>>();
            v
        })?;
        *self.pics.write().unwrap() = Arc::new(v);
        Ok(())
    }

    fn all(&self) -> Arc<Vec<Pic>> {
        self.pics.read().unwrap().clone()
    }
}

/// Starts a scan (and then the thumbnails) unless one is running or the last
/// one finished less than `gap` ago. A zero `gap` (files changed) while one
/// runs gets another after it.
pub fn kick(app: &Arc<App>, gap: Duration) {
    {
        let mut st = app.pics.state.lock().unwrap();
        if st.busy {
            st.again |= gap.is_zero();
            return;
        }
        if st.finished.is_some_and(|t| t.elapsed() < gap) {
            return;
        }
        *st = Progress { busy: true, scanning: true, finished: st.finished, ..Default::default() };
    }
    let app = app.clone();
    let rt = tokio::runtime::Handle::current();
    tokio::task::spawn_blocking(move || {
        let t0 = Instant::now();
        let scanned = scan(&app);
        match &scanned {
            Ok(s) if !s.is_empty() => tracing::info!("pictures: {s} in {:.1} s", t0.elapsed().as_secs_f32()),
            Ok(_) => {}
            Err(e) => tracing::warn!("pictures: scan failed: {e:#}"),
        }
        app.pics.state.lock().unwrap().scanning = false;
        if scanned.is_ok() {
            let t0 = Instant::now();
            match thumbs_ahead(&app, &rt) {
                Ok(0) => {}
                Ok(n) => tracing::info!("pictures: {n} thumbnails made in {:.0} s", t0.elapsed().as_secs_f32()),
                Err(e) => tracing::warn!("pictures: thumbnails: {e:#}"),
            }
        }
        let again = {
            let mut st = app.pics.state.lock().unwrap();
            st.busy = false;
            st.finished = Some(Instant::now());
            std::mem::take(&mut st.again)
        };
        if again && !STOP.load(Ordering::Relaxed) {
            kick(&app, Duration::ZERO);
        }
    });
}

/// Brings the index up to date with the disk. Returns what changed ("" for nothing).
fn scan(app: &App) -> anyhow::Result<String> {
    let users: Vec<(i64, String)> = app.db.with(|c| {
        let mut st = c.prepare("SELECT id, username FROM users")?;
        let v = st.query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?.collect::<rusqlite::Result<Vec<_>>>();
        v
    }).map_err(ah)?;
    let mut files = Vec::new();
    for (id, name) in &users {
        let mut dirs = HashSet::new();
        walk(&app.user_root(name), "", &mut dirs, &mut |path, m| files.push((*id, path, m)));
    }
    app.pics.state.lock().unwrap().total = files.len();

    let old = app.pics.all();
    let by_path: HashMap<(i64, &str), &Pic> = old.iter().map(|p| ((p.owner, p.path.as_str()), p)).collect();
    // EXIF dates already read, by file: moved files and hard links are not read again
    let mut exif_of: HashMap<(u64, u64), Option<i64>> = HashMap::new();
    for p in old.iter() {
        exif_of.insert((p.dev, p.ino), p.exif);
    }
    let mut known: HashMap<(u64, u64), (u64, i64)> = old.iter().map(|p| ((p.dev, p.ino), (p.size, p.mtime))).collect();

    let mut now = Vec::with_capacity(files.len());
    let mut fresh = Vec::new();
    let (mut added, mut read) = (0, 0);
    for (i, (owner, path, m)) in files.into_iter().enumerate() {
        if STOP.load(Ordering::Relaxed) {
            anyhow::bail!("stopped");
        }
        if i % 256 == 0 {
            app.pics.state.lock().unwrap().done = i;
        }
        if let Some(p) = by_path.get(&(owner, path.as_str())).filter(|p| p.same_file(&m)) {
            now.push((*p).clone());
            continue;
        }
        let id = (m.dev(), m.ino());
        let exif = match (exif_of.get(&id), known.get(&id)) {
            (Some(e), Some(&(size, mtime))) if size == m.len() && mtime == m.mtime() => *e,
            _ if is_jpeg(&path) => {
                read += 1;
                let mut f = app.user_root(&users.iter().find(|u| u.0 == owner).map(|u| u.1.clone()).unwrap_or_default());
                f.push(path.trim_start_matches('/'));
                exif_date(&f)
            }
            _ => None,
        };
        exif_of.insert(id, exif);
        known.insert(id, (m.len(), m.mtime()));
        let (taken, src) = date_of(exif, &path, m.mtime());
        let p = Pic { owner, path, size: m.len(), mtime: m.mtime(), dev: m.dev(), ino: m.ino(), exif, taken, src };
        added += 1;
        fresh.push(p.clone());
        now.push(p);
        // a restart in the middle of a long first scan keeps what was read
        if fresh.len() >= 500 {
            save(app, &std::mem::take(&mut fresh)).map_err(ah)?;
        }
    }
    save(app, &fresh).map_err(ah)?;
    let here: HashSet<(i64, &str)> = now.iter().map(|p| (p.owner, p.path.as_str())).collect();
    let gone: Vec<&Pic> = old.iter().filter(|p| !here.contains(&(p.owner, p.path.as_str()))).collect();
    app.db.with(|c| {
        let tx = c.unchecked_transaction()?;
        for p in &gone {
            tx.execute("DELETE FROM pictures WHERE owner_id = ?1 AND path = ?2", params![p.owner, p.path])?;
        }
        tx.commit()
    })
    .map_err(ah)?;
    let removed = gone.len();
    let total = now.len();
    *app.pics.pics.write().unwrap() = Arc::new(now);
    Ok(if added + removed == 0 { String::new() } else { format!("{total} files, {added} new or changed ({read} read), {removed} gone") })
}

fn ah(e: AppError) -> anyhow::Error {
    anyhow::anyhow!(e.msg)
}

fn save(app: &App, pics: &[Pic]) -> Res<()> {
    app.db.with(|c| {
        let tx = c.unchecked_transaction()?;
        {
            let mut st = tx.prepare(
                "INSERT INTO pictures (owner_id, path, size, mtime, dev, ino, exif, taken, src) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
                 ON CONFLICT(owner_id, path) DO UPDATE SET size = excluded.size, mtime = excluded.mtime, dev = excluded.dev,
                   ino = excluded.ino, exif = excluded.exif, taken = excluded.taken, src = excluded.src",
            )?;
            for p in pics {
                st.execute(params![p.owner, p.path, p.size as i64, p.mtime, p.dev as i64, p.ino as i64, p.exif, p.taken, p.src.as_str()])?;
            }
        }
        tx.commit()
    })
}

/// Pictures under `dir`, following symlinks (each folder once); hidden
/// files and folders are skipped.
fn walk(dir: &Path, rel: &str, seen: &mut HashSet<(u64, u64)>, found: &mut dyn FnMut(String, fs::Metadata)) {
    let Ok(rd) = fs::read_dir(dir) else { return };
    for e in rd.flatten() {
        let Ok(name) = e.file_name().into_string() else { continue };
        if name.starts_with('.') {
            continue;
        }
        let Ok(mut m) = e.metadata() else { continue };
        if m.file_type().is_symlink() {
            match fs::metadata(e.path()) {
                Ok(t) => m = t,
                Err(_) => continue,
            }
        }
        let path = format!("{rel}/{name}");
        if m.is_dir() {
            if seen.insert((m.dev(), m.ino())) {
                walk(&e.path(), &path, seen, found);
            }
        } else if m.is_file() && is_picture(&name) {
            found(path, m);
        }
    }
}

/* ---- dates ---- */

/// Seconds since 1970 of a wall-clock time, as if it were UTC.
fn civil(y: i64, mo: i64, d: i64, h: i64, mi: i64, s: i64) -> Option<i64> {
    let leap = y % 4 == 0 && (y % 100 != 0 || y % 400 == 0);
    let days_in = [31, if leap { 29 } else { 28 }, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
    if !(1900..=2100).contains(&y) || !(1..=12).contains(&mo) || d < 1 || d > days_in[mo as usize - 1] {
        return None;
    }
    if !(0..24).contains(&h) || !(0..60).contains(&mi) || !(0..=60).contains(&s) {
        return None;
    }
    // days from the civil calendar (H. Hinnant)
    let y = if mo <= 2 { y - 1 } else { y };
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let doy = (153 * ((mo + 9) % 12) + 2) / 5 + d - 1;
    let days = era * 146097 + yoe * 365 + yoe / 4 - yoe / 100 + doy - 719468;
    Some(days * 86400 + h * 3600 + mi * 60 + s)
}

/// A moment (seconds since 1970) as this host's wall clock shows it.
fn wall(t: i64) -> i64 {
    let tt = t as libc::time_t;
    // SAFETY: zeroed is a valid tm; both pointers live through the call
    let mut tm: libc::tm = unsafe { std::mem::zeroed() };
    if unsafe { libc::localtime_r(&tt, &mut tm) }.is_null() {
        return t;
    }
    t + tm.tm_gmtoff
}

fn exif_date(path: &Path) -> Option<i64> {
    let f = fs::File::open(path).ok()?;
    let ex = exif::Reader::new().read_from_container(&mut io::BufReader::new(f)).ok()?;
    [exif::Tag::DateTimeOriginal, exif::Tag::DateTimeDigitized, exif::Tag::DateTime].into_iter().find_map(|tag| {
        let exif::Value::Ascii(v) = &ex.get_field(tag, exif::In::PRIMARY)?.value else { return None };
        let d = exif::DateTime::from_ascii(v.first()?).ok()?;
        civil(d.year as i64, d.month as i64, d.day as i64, d.hour as i64, d.minute as i64, d.second as i64)
    })
}

/// A date in a file or folder name: `IMG_20250713_142233`, `20220823_105705`,
/// `Screenshot_20221010-124258`, `2023-05-01 12.34.56`, `2025-07-24`, or a
/// timestamp in milliseconds (`-1720172267966`).
fn date_in(name: &str) -> Option<i64> {
    let b = name.as_bytes();
    let mut runs = Vec::new();
    let mut i = 0;
    while i < b.len() {
        if b[i].is_ascii_digit() {
            let s = i;
            while i < b.len() && b[i].is_ascii_digit() {
                i += 1;
            }
            runs.push((s, i));
        } else {
            i += 1;
        }
    }
    let num = |s: usize, e: usize| name[s..e].parse::<i64>().unwrap_or(-1);
    // run k, if it follows run k-1 after at most `gap` separator characters
    let next = |k: usize, gap: usize| -> Option<(usize, usize)> {
        let (&(s, e), &(_, pe)) = (runs.get(k)?, runs.get(k - 1)?);
        (s - pe <= gap && b[pe..s].iter().all(|c| b" _-.T:at".contains(c))).then_some((s, e))
    };
    for (k, &(s, e)) in runs.iter().enumerate() {
        match e - s {
            13 => {
                let ms = num(s, e);
                if (946_684_800_000..4_102_444_800_000).contains(&ms) {
                    return Some(wall(ms / 1000));
                }
            }
            // yyyymmdd, yyyymmddhhmmss, yyyymmddhhmmssmmm
            8 | 14 | 17 => {
                let (y, mo, d) = (num(s, s + 4), num(s + 4, s + 6), num(s + 6, s + 8));
                if y < 1990 {
                    continue;
                }
                let hms = if e - s >= 14 {
                    Some(s + 8)
                } else {
                    next(k + 1, 1).filter(|(ts, te)| matches!(te - ts, 6 | 9)).map(|(ts, _)| ts)
                };
                let t = hms.and_then(|h| civil(y, mo, d, num(h, h + 2), num(h + 2, h + 4), num(h + 4, h + 6)));
                if let Some(t) = t.or_else(|| civil(y, mo, d, 0, 0, 0)) {
                    return Some(t);
                }
            }
            // yyyy-mm-dd, then maybe hh.mm.ss or hhmmss
            4 => {
                let (Some(m), Some(d)) = (next(k + 1, 1), next(k + 2, 1)) else { continue };
                if m.1 - m.0 != 2 || d.1 - d.0 != 2 || num(s, e) < 1990 {
                    continue;
                }
                let (y, mo, d) = (num(s, e), num(m.0, m.1), num(d.0, d.1));
                let time = match (next(k + 3, 4), next(k + 4, 1), next(k + 5, 1)) {
                    (Some(h), Some(mi), Some(sec)) if [h, mi, sec].iter().all(|r| r.1 - r.0 == 2) => {
                        civil(y, mo, d, num(h.0, h.1), num(mi.0, mi.1), num(sec.0, sec.1))
                    }
                    (Some(h), _, _) if h.1 - h.0 == 6 => civil(y, mo, d, num(h.0, h.0 + 2), num(h.0 + 2, h.0 + 4), num(h.0 + 4, h.1)),
                    _ => None,
                };
                if let Some(t) = time.or_else(|| civil(y, mo, d, 0, 0, 0)) {
                    return Some(t);
                }
            }
            _ => {}
        }
    }
    None
}

/// When a picture was taken, best guess first.
fn date_of(exif: Option<i64>, path: &str, mtime: i64) -> (i64, Src) {
    if let Some(t) = exif {
        return (t, Src::Exif);
    }
    let mut segs = path.rsplit('/').filter(|s| !s.is_empty());
    let name = segs.next().unwrap_or("");
    let stem = name.rsplit_once('.').map_or(name, |(s, _)| s);
    if let Some(t) = date_in(stem) {
        return (t, Src::Name);
    }
    let local = wall(mtime);
    let mut year = None;
    for dir in segs {
        if let Some(t) = date_in(dir) {
            return (t, Src::Folder);
        }
        if year.is_none() && dir.len() == 4 {
            year = dir.parse::<i64>().ok().filter(|y| (1990..=2100).contains(y));
        }
    }
    // a year folder: the modification time if it is in that year, else new year's day
    if let Some(y) = year {
        let (a, b) = (civil(y, 1, 1, 0, 0, 0).unwrap_or(0), civil(y + 1, 1, 1, 0, 0, 0).unwrap_or(0));
        if !(a..b).contains(&local) {
            return (a, Src::Folder);
        }
    }
    (local, Src::Mtime)
}

/// Whether some folder on the way names a date (`2025/2025-07-24`).
fn dated_folder(path: &str) -> bool {
    let mut segs = path.rsplit('/').filter(|s| !s.is_empty());
    segs.next();
    segs.any(|d| date_in(d).is_some() || (d.len() == 4 && d.parse::<u16>().is_ok_and(|y| (1990..=2100).contains(&y))))
}

/* ---- the list ---- */

/// A share with the user that pictures can come from: (id, owner, path, is_dir, can_write).
type LocalShare = (i64, i64, String, bool, bool);

/// `path` relative to `root`: `/b.jpg` for `/a/b.jpg` under `/a`, `""` for `root` itself.
fn under<'a>(path: &'a str, root: &str) -> Option<&'a str> {
    if root == "/" {
        return Some(path);
    }
    let rest = path.strip_prefix(root)?;
    (rest.is_empty() || rest.starts_with('/')).then_some(rest)
}

/// `{dirs: [[loc, folder or null for a shared file, writable]], items: [[dir, name, taken, mtime, src, links]], ...}`,
/// newest first. Folders are listed once so thousands of pictures stay a
/// small answer. `links`, the names the user can see the file by, only when
/// more than one (hard links): deleting one leaves the picture.
async fn list(State(app): State<Arc<App>>, user: User) -> Res<Json<Value>> {
    kick(&app, Duration::from_secs(120));
    let shares: Vec<LocalShare> = app.db.with(|c| {
        let mut st = c.prepare(
            "SELECT s.id, s.owner_id, s.path, s.is_dir, s.can_write FROM shares s JOIN users o ON o.id = s.owner_id
             WHERE s.recipient_id = ?1 AND s.mount_id IS NULL AND o.disabled = 0",
        )?;
        let v = st.query_map([user.id], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?)))?.collect::<rusqlite::Result<Vec<_>>>();
        v
    })?;
    let pics = app.pics.all();
    // per file: (from a share?, loc, path in the loc, writable, picture)
    let mut best: HashMap<(u64, u64), (bool, String, &str, bool, &Pic)> = HashMap::new();
    let mut links: HashMap<(u64, u64), u32> = HashMap::new();
    for p in pics.iter() {
        let at = if p.owner == user.id {
            Some((false, "home".to_string(), p.path.as_str(), true))
        } else {
            shares.iter().filter(|s| s.1 == p.owner).find_map(|(id, _, root, dir, write)| {
                let rel = under(&p.path, root)?;
                (*dir != rel.is_empty()).then(|| (true, format!("s{id}"), rel, *write))
            })
        };
        let Some((shared, loc, rel, write)) = at else { continue };
        *links.entry((p.dev, p.ino)).or_default() += 1;
        let better = match best.get(&(p.dev, p.ino)) {
            None => true,
            // own copies first, then one in a dated folder, then the shorter path
            Some((s, _, _, _, q)) => {
                (shared, !dated_folder(&p.path), p.path.len()) < (*s, !dated_folder(&q.path), q.path.len())
            }
        };
        if better {
            best.insert((p.dev, p.ino), (shared, loc, rel, write, p));
        }
    }
    let mut v: Vec<_> = best.into_values().collect();
    v.sort_by(|a, b| b.4.taken.cmp(&a.4.taken).then_with(|| a.2.cmp(b.2)));
    let mut dirs: Vec<Value> = Vec::new();
    let mut dir_ix: HashMap<(String, Option<&str>), usize> = HashMap::new();
    let items: Vec<Value> = v
        .iter()
        .map(|(_, loc, rel, write, p)| {
            let (dir, name) = match rel.rsplit_once('/') {
                Some((d, n)) => (Some(d), n),
                // a shared file: the location is the picture
                None => (None, p.path.rsplit('/').next().unwrap_or("")),
            };
            let k = (loc.clone(), dir);
            let i = *dir_ix.entry(k).or_insert_with(|| {
                dirs.push(json!([loc, dir.map(|d| if d.is_empty() { "/" } else { d }), write]));
                dirs.len() - 1
            });
            let src = &p.src.as_str()[..1];
            match links[&(p.dev, p.ino)] {
                1 => json!([i, name, p.taken, p.mtime, src]),
                n => json!([i, name, p.taken, p.mtime, src, n]),
            }
        })
        .collect();
    let st = app.pics.state.lock().unwrap();
    Ok(Json(json!({
        "dirs": dirs, "items": items,
        "scanning": st.scanning.then(|| json!({ "done": st.done, "total": st.total })),
    })))
}

/* ---- thumbnails ---- */

#[derive(Clone, Copy, PartialEq)]
enum Size {
    /// the grid: 320 px on the short side
    Small,
    /// the slideshow: 1600 px on the long side
    Screen,
}

impl Size {
    fn dir(self) -> &'static str {
        match self {
            Size::Small => "s",
            Size::Screen => "l",
        }
    }
    /// the size to make from a `w` x `h` picture; no upscaling
    fn fit(self, w: u32, h: u32) -> (u32, u32) {
        let f = match self {
            Size::Small => (320.0 / w.min(h) as f64).min(1280.0 / w.max(h) as f64),
            Size::Screen => 1600.0 / w.max(h) as f64,
        };
        if f >= 1.0 {
            return (w, h);
        }
        (((w as f64 * f).round() as u32).max(1), ((h as f64 * f).round() as u32).max(1))
    }
}

/// JPEGs up to this size go to the slideshow as they are.
const SCREEN_MIN: u64 = 1_500_000;

/// Names a file's content: the same key for all its hard links.
fn cache_key(dev: u64, ino: u64, size: u64, mtime: i64) -> String {
    hex::encode(&Sha256::digest(format!("{dev}:{ino}:{size}:{mtime}"))[..16])
}

fn cache_path(data: &Path, size: Size, key: &str) -> PathBuf {
    data.join("thumbs").join(size.dir()).join(&key[..2]).join(format!("{key}.jpg"))
}

fn decode_jpeg(data: &[u8], size: Size) -> anyhow::Result<DynamicImage> {
    use jpeg_decoder::PixelFormat;
    let mut d = jpeg_decoder::Decoder::new(data);
    d.read_info()?;
    let info = d.info().ok_or_else(|| anyhow::anyhow!("no jpeg header"))?;
    // decode at 1/2, 1/4 or 1/8 of the size where that is still big enough
    let (tw, th) = size.fit(info.width as u32, info.height as u32);
    d.scale(tw.min(u16::MAX as u32) as u16, th.min(u16::MAX as u32) as u16)?;
    let px = d.decode()?;
    let info = d.info().ok_or_else(|| anyhow::anyhow!("no jpeg header"))?;
    let (w, h) = (info.width as u32, info.height as u32);
    let bad = || anyhow::anyhow!("jpeg: short pixel data");
    Ok(match info.pixel_format {
        PixelFormat::RGB24 => DynamicImage::ImageRgb8(image::RgbImage::from_raw(w, h, px).ok_or_else(bad)?),
        PixelFormat::L8 => DynamicImage::ImageLuma8(image::GrayImage::from_raw(w, h, px).ok_or_else(bad)?),
        // CMYK, 16 bit: rare enough for the slow way
        _ => image::load_from_memory_with_format(data, image::ImageFormat::Jpeg)?,
    })
}

/// A JPEG of `size` from the picture at `src`, upright.
fn render(src: &Path, size: Size) -> anyhow::Result<Vec<u8>> {
    let data = fs::read(src)?;
    let (mut img, orient) = if data.starts_with(&[0xff, 0xd8]) {
        let o = exif::Reader::new()
            .read_from_container(&mut Cursor::new(&data))
            .ok()
            .and_then(|e| e.get_field(exif::Tag::Orientation, exif::In::PRIMARY)?.value.get_uint(0))
            .and_then(|o| Orientation::from_exif(o as u8))
            .unwrap_or(Orientation::NoTransforms);
        (decode_jpeg(&data, size)?, o)
    } else {
        let mut d = image::ImageReader::new(Cursor::new(&data)).with_guessed_format()?.into_decoder()?;
        let o = d.orientation().unwrap_or(Orientation::NoTransforms);
        (DynamicImage::from_decoder(d)?, o)
    };
    let (w, h) = size.fit(img.width(), img.height());
    if (w, h) != (img.width(), img.height()) {
        img = img.resize_exact(w, h, FilterType::Triangle);
    }
    img.apply_orientation(orient);
    let mut out = Vec::new();
    DynamicImage::ImageRgb8(img.to_rgb8()).write_with_encoder(JpegEncoder::new_with_quality(&mut out, if size == Size::Small { 78 } else { 84 }))?;
    Ok(out)
}

/// Makes and keeps the picture; an empty file marks one that cannot be read.
fn make(src: &Path, dst: &Path, size: Size) -> io::Result<Vec<u8>> {
    let out = render(src, size).unwrap_or_else(|e| {
        tracing::debug!("pictures: {}: {e:#}", src.display());
        Vec::new()
    });
    fs::create_dir_all(dst.parent().unwrap_or(dst))?;
    let tmp = dst.with_extension(format!("tmp{}", std::process::id()));
    fs::write(&tmp, &out)?;
    fs::rename(&tmp, dst)?;
    Ok(out)
}

#[derive(Deserialize)]
struct ThumbQ {
    /// `screen`: for the slideshow; else the grid's size
    s: Option<String>,
}

async fn thumb(
    State(app): State<Arc<App>>,
    user: User,
    UrlPath(p): UrlPath<HashMap<String, String>>,
    Query(q): Query<ThumbQ>,
    headers: HeaderMap,
) -> Res<Response> {
    let (loc, sub) = (p.get("loc").cloned().unwrap_or_default(), p.get("path").cloned().unwrap_or_default());
    let t = files::resolve(&app, &user, &loc, &sub).await?;
    let name = t.name(&t.path);
    if t.mount.is_some() || !is_picture(&name) {
        return Err(AppError::new(StatusCode::UNSUPPORTED_MEDIA_TYPE, "no preview for this file"));
    }
    let owner: String = app.db.with(|c| c.query_row("SELECT username FROM users WHERE id = ?1", [t.owner], |r| r.get(0)))?;
    let mut src = app.user_root(&owner);
    for s in t.path.segs() {
        src.push(s);
    }
    let m = tokio::fs::metadata(&src).await.map_err(FsError::from)?;
    if m.is_dir() {
        return Err(FsError::IsDir.into());
    }
    let size = if q.s.as_deref() == Some("screen") { Size::Screen } else { Size::Small };
    if size == Size::Screen && (!is_jpeg(&name) || m.len() <= SCREEN_MIN) {
        // small enough, or maybe animated: the picture itself
        let (e, r) = t.backend.open(&t.path).await?;
        return Ok(http_util::serve(e, r, &headers, &name, false, false, None).await);
    }
    let key = cache_key(m.dev(), m.ino(), m.len(), m.mtime());
    let etag = format!("\"{}{key}\"", size.dir());
    let cached = |b: axum::http::response::Builder| {
        b.header(header::ETAG, &etag).header(header::CACHE_CONTROL, "private, max-age=2592000, immutable")
    };
    if headers.get(header::IF_NONE_MATCH).is_some_and(|v| v.as_bytes() == etag.as_bytes()) {
        return Ok(cached(Response::builder()).status(StatusCode::NOT_MODIFIED).body(Body::empty()).unwrap());
    }
    let dst = cache_path(&app.cfg.data, size, &key);
    let body = match tokio::fs::read(&dst).await {
        Ok(b) => {
            if size == Size::Screen {
                // kept while in use (see prune)
                let d = dst.clone();
                tokio::task::spawn_blocking(move || touch(&d));
            }
            b
        }
        Err(_) => {
            let _turn = app.pics.work.acquire().await.map_err(AppError::internal)?;
            match tokio::fs::read(&dst).await {
                Ok(b) => b,
                Err(_) => tokio::task::spawn_blocking(move || make(&src, &dst, size)).await.map_err(AppError::internal)?.map_err(AppError::internal)?,
            }
        }
    };
    if body.is_empty() {
        return Err(AppError::new(StatusCode::UNSUPPORTED_MEDIA_TYPE, "cannot read this picture"));
    }
    Ok(cached(Response::builder())
        .header(header::CONTENT_TYPE, "image/jpeg")
        .header(header::CONTENT_LENGTH, body.len())
        .body(Body::from(body))
        .unwrap())
}

fn touch(p: &Path) {
    let old = fs::metadata(p).and_then(|m| m.modified()).is_ok_and(|t| t.elapsed().unwrap_or_default() > Duration::from_secs(86400));
    if old {
        let _ = fs::File::options().write(true).open(p).and_then(|f| f.set_modified(SystemTime::now()));
    }
}

/// Grid thumbnails for pictures that have none yet, one at a time; then the
/// ones of pictures that are gone are removed, and slideshow ones not looked
/// at for two weeks. Returns how many were made.
fn thumbs_ahead(app: &App, rt: &tokio::runtime::Handle) -> anyhow::Result<usize> {
    let names: HashMap<i64, String> = app.db.with(|c| {
        let mut st = c.prepare("SELECT id, username FROM users")?;
        let v = st.query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?.collect::<rusqlite::Result<HashMap<_, _>>>();
        v
    })
    .map_err(ah)?;
    let pics = app.pics.all();
    // newest first: that is the top of the grid
    let mut order: Vec<&Pic> = pics.iter().collect();
    order.sort_by(|a, b| b.taken.cmp(&a.taken));
    let mut keep = HashSet::new();
    let mut made = 0;
    for p in order {
        let key = cache_key(p.dev, p.ino, p.size, p.mtime);
        if !keep.insert(key.clone()) {
            continue;
        }
        let dst = cache_path(&app.cfg.data, Size::Small, &key);
        if dst.exists() {
            continue;
        }
        if STOP.load(Ordering::Relaxed) {
            anyhow::bail!("stopped");
        }
        let Some(owner) = names.get(&p.owner) else { continue };
        let mut src = app.user_root(owner);
        src.push(p.path.trim_start_matches('/'));
        let _turn = rt.block_on(app.pics.work.acquire())?;
        if !dst.exists() {
            make(&src, &dst, Size::Small)?;
            made += 1;
        }
    }
    let two_weeks = SystemTime::now() - Duration::from_secs(14 * 86400);
    for size in [Size::Small, Size::Screen] {
        let dir = app.cfg.data.join("thumbs").join(size.dir());
        for sub in fs::read_dir(&dir).into_iter().flatten().flatten() {
            for f in fs::read_dir(sub.path()).into_iter().flatten().flatten() {
                let name = f.file_name().to_string_lossy().into_owned();
                let stale = match (size, name.strip_suffix(".jpg")) {
                    (Size::Small, Some(k)) => !keep.contains(k),
                    (Size::Screen, Some(_)) => f.metadata().and_then(|m| m.modified()).is_ok_and(|t| t < two_weeks),
                    // a tmp file left by a crash
                    (_, None) => f.metadata().and_then(|m| m.modified()).is_ok_and(|t| t.elapsed().unwrap_or_default() > Duration::from_secs(3600)),
                };
                if stale {
                    let _ = fs::remove_file(f.path());
                }
            }
        }
    }
    Ok(made)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn at(s: &str) -> i64 {
        // "2025-07-13 14:22:33"
        let n = |a: usize, b: usize| s[a..b].parse().unwrap();
        civil(n(0, 4), n(5, 7), n(8, 10), n(11, 13), n(14, 16), n(17, 19)).unwrap()
    }

    #[test]
    fn civil_dates() {
        assert_eq!(civil(1970, 1, 1, 0, 0, 0), Some(0));
        assert_eq!(civil(2000, 3, 1, 0, 0, 0), Some(951868800));
        assert_eq!(civil(2024, 2, 29, 23, 59, 59), Some(1709251199));
        assert_eq!(civil(2023, 2, 29, 0, 0, 0), None);
        assert_eq!(civil(2023, 13, 1, 0, 0, 0), None);
    }

    #[test]
    fn dates_in_names() {
        assert_eq!(date_in("IMG_20250713_142233"), Some(at("2025-07-13 14:22:33")));
        assert_eq!(date_in("20220823_105705"), Some(at("2022-08-23 10:57:05")));
        assert_eq!(date_in("Screenshot_20221010-124258"), Some(at("2022-10-10 12:42:58")));
        assert_eq!(date_in("RDT_20220908_1012345678901234"), Some(at("2022-09-08 00:00:00")));
        assert_eq!(date_in("PXL_20230101_123456789"), Some(at("2023-01-01 12:34:56")));
        assert_eq!(date_in("IMG20230101123456"), Some(at("2023-01-01 12:34:56")));
        assert_eq!(date_in("2025-07-24"), Some(at("2025-07-24 00:00:00")));
        assert_eq!(date_in("WhatsApp Image 2023-05-01 at 12.34.56"), Some(at("2023-05-01 12:34:56")));
        assert_eq!(date_in("signal-2023-05-01-123456"), Some(at("2023-05-01 12:34:56")));
        assert_eq!(date_in("received_1720172267966"), Some(wall(1720172267)));
        assert_eq!(date_in("DSC_0042"), None);
        assert_eq!(date_in("IMG_1234_5678"), None);
        assert_eq!(date_in("scan 12345678"), None);
        assert_eq!(date_in("2019"), None);
    }

    #[test]
    fn best_date() {
        let m = at("2025-09-01 10:00:00");
        assert_eq!(date_of(Some(5), "/a/IMG_20250713_142233.jpg", m), (5, Src::Exif));
        assert_eq!(date_of(None, "/2025/2025-07-24/IMG_20220101_000000.jpg", m).1, Src::Name);
        assert_eq!(date_of(None, "/2025/2025-07-24/x.png", m), (at("2025-07-24 00:00:00"), Src::Folder));
        assert_eq!(date_of(None, "/Admin/2004/x.png", m), (at("2004-01-01 00:00:00"), Src::Folder));
        assert_eq!(date_of(None, "/Admin/2025/x.png", m).1, Src::Mtime);
        assert_eq!(date_of(None, "/misc/x.png", m).1, Src::Mtime);
        assert!(dated_folder("/p/Admin/2025/2025-07-24/a.jpg"));
        assert!(!dated_folder("/p/Albums/all/IMG_20250713_1.jpg"));
    }

    #[test]
    fn shares() {
        assert_eq!(under("/a/b.jpg", "/a"), Some("/b.jpg"));
        assert_eq!(under("/ab/c.jpg", "/a"), None);
        assert_eq!(under("/a.jpg", "/a.jpg"), Some(""));
        assert_eq!(under("/a/b.jpg", "/"), Some("/a/b.jpg"));
    }

    #[test]
    fn sizes() {
        assert_eq!(Size::Small.fit(4000, 3000), (427, 320));
        assert_eq!(Size::Small.fit(3000, 4000), (320, 427));
        assert_eq!(Size::Small.fit(200, 100), (200, 100));
        assert_eq!(Size::Small.fit(8000, 1000), (1280, 160));
        assert_eq!(Size::Screen.fit(4000, 3000), (1600, 1200));
    }
}
