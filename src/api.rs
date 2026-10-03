//! API keys: a user gives a program one of their folders (`POST /api/keys`),
//! read-only or read-write. The program sends `Authorization: Bearer <key>`
//! to `/api/v1/…` and can list, download, upload, replace, move and delete
//! inside that folder, never above it. Keys follow their folder when it is
//! moved and end with it when it is deleted (db::repath / db::unshare), when
//! they expire, or when the owner removes them or is disabled. docs/API.md
//! describes the API for the people writing such programs.

use std::{collections::HashMap, io, sync::Arc};

use axum::{
    body::Body,
    extract::{FromRequestParts, Path, Query, State},
    http::{header, request::Parts, HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    routing::{delete, get, post},
    Json, Router,
};
use futures_util::TryStreamExt;
use rusqlite::params;
use serde::Deserialize;
use serde_json::{json, Value};

use crate::{
    auth::User,
    crypto,
    db::now,
    edge::{self, Remote},
    error::{AppError, Res},
    files::{self, Target},
    http_util,
    vfs::{Entry, FsError, RelPath},
    App,
};

/// Keys start with this, so they are easy to spot in configs and logs.
const PREFIX: &str = "shk_";
/// A recursive listing stops here; list folder by folder beyond that.
const MAX_LIST: usize = 100_000;

pub fn routes() -> Router<Arc<App>> {
    Router::new()
        .route("/api/keys", get(list_keys).post(create_key))
        .route("/api/keys/{id}", delete(delete_key))
        .route("/api/v1", get(info))
        .route("/api/v1/list", get(list))
        .route("/api/v1/list/{*path}", get(list))
        .route("/api/v1/file/{*path}", get(download).put(upload).delete(remove))
        .route("/api/v1/mkdir/{*path}", post(mkdir))
        .route("/api/v1/move", post(mv))
}

/// The key a request carries; only the `/api/v1` routes take it, and they take
/// nothing else, so a browser's cookie never reaches them.
pub struct Key {
    id: i64,
    name: String,
    owner: User,
    mount: Option<i64>,
    path: String,
    write: bool,
    expires: Option<i64>,
}

impl FromRequestParts<Arc<App>> for Key {
    type Rejection = AppError;

    async fn from_request_parts(parts: &mut Parts, app: &Arc<App>) -> Result<Self, Self::Rejection> {
        let bad = || AppError::new(StatusCode::UNAUTHORIZED, "a valid API key is required (Authorization: Bearer shk_…)");
        let token = parts
            .headers
            .get(header::AUTHORIZATION)
            .and_then(|v| v.to_str().ok())
            .and_then(|v| v.strip_prefix("Bearer "))
            .map(str::trim)
            .filter(|t| t.starts_with(PREFIX))
            .ok_or_else(bad)?;
        let h = crypto::sha256_hex(token);
        let t = now();
        let key = app
            .db
            .opt(|c| {
                let (key, last): (Key, Option<i64>) = c.query_row(
                    "SELECT k.id, k.name, k.mount_id, k.path, k.can_write, k.expires, k.last_used,
                            u.id, u.username, u.is_admin, u.remote_cidrs
                     FROM api_keys k JOIN users u ON u.id = k.owner_id
                     WHERE k.token_hash = ?1 AND u.disabled = 0 AND (k.expires IS NULL OR k.expires > ?2)",
                    params![h, t],
                    |r| {
                        let owner = User { id: r.get(7)?, username: r.get(8)?, admin: r.get(9)?, cidrs: r.get(10)? };
                        let key = Key {
                            id: r.get(0)?,
                            name: r.get(1)?,
                            mount: r.get(2)?,
                            path: r.get(3)?,
                            write: r.get(4)?,
                            expires: r.get(5)?,
                            owner,
                        };
                        Ok((key, r.get(6)?))
                    },
                )?;
                if last.is_none_or(|l| t - l > 60) {
                    c.execute("UPDATE api_keys SET last_used = ?1 WHERE id = ?2", params![t, key.id])?;
                }
                Ok(key)
            })?
            .ok_or_else(bad)?;
        if let Some(Remote(ip)) = parts.extensions.get::<Remote>() {
            if !edge::allowed(app, &key.owner.cidrs, *ip) {
                return Err(AppError::new(StatusCode::FORBIDDEN, format!("{} cannot be used from {ip}", key.owner.username)));
            }
        }
        Ok(key)
    }
}

impl Key {
    /// `sub` inside the key's folder.
    async fn target(&self, app: &App, sub: &str) -> Res<Target> {
        let root = RelPath::parse(&self.path)?;
        Ok(Target {
            backend: files::owner_backend(app, &self.owner.username, self.mount).await?,
            path: root.join(&RelPath::parse(sub)?),
            root_name: root.name().unwrap_or("folder").to_string(),
            root,
            write: self.write,
            owner: self.owner.id,
            mount: self.mount,
        })
    }

    fn need_write(&self) -> Res<()> {
        if !self.write {
            return Err(AppError::new(StatusCode::FORBIDDEN, "this API key is read-only"));
        }
        Ok(())
    }
}

/// An entry with its path inside the key's folder (`/a/b.txt`; `/` is the folder).
fn entry_json(e: &Entry, rel: &RelPath) -> Value {
    let mut v = e.json();
    v["path"] = json!(rel.to_string());
    if !rel.is_root() {
        v["name"] = json!(rel.name());
    }
    v
}

fn sub(p: &HashMap<String, String>) -> &str {
    p.get("path").map_or("", String::as_str)
}

fn header_str<'a>(h: &'a HeaderMap, name: header::HeaderName) -> Option<&'a str> {
    h.get(name).and_then(|v| v.to_str().ok()).map(str::trim)
}

fn precondition(msg: &str) -> AppError {
    AppError::new(StatusCode::PRECONDITION_FAILED, msg)
}

/// What the key is: `GET /api/v1`.
async fn info(key: Key) -> Json<Value> {
    Json(json!({
        "name": key.name, "user": key.owner.username,
        "folder": key.path.rsplit('/').next().unwrap_or(""),
        "write": key.write, "expires": key.expires, "version": env!("CARGO_PKG_VERSION"),
    }))
}

#[derive(Deserialize)]
struct ListQ {
    recursive: Option<String>,
}

/// A folder's entries, or with `?recursive=1` everything below it.
async fn list(
    State(app): State<Arc<App>>,
    key: Key,
    Path(p): Path<HashMap<String, String>>,
    Query(q): Query<ListQ>,
) -> Res<Json<Value>> {
    let t = key.target(&app, sub(&p)).await?;
    let me = t.backend.stat(&t.path).await?;
    if !me.is_dir {
        return Err(FsError::NotDir.into());
    }
    let recursive = q.recursive.as_deref().is_some_and(|v| v != "0" && v != "false");
    let mut out = Vec::new();
    let mut todo = vec![(t.path.clone(), 0u32)];
    while let Some((dir, depth)) = todo.pop() {
        let mut entries = t.backend.list(&dir).await?;
        entries.sort_by(|a, b| a.name.cmp(&b.name));
        for e in entries {
            let Ok(full) = dir.child(&e.name) else { continue };
            let rel = full.strip_prefix(&t.root).unwrap_or_default();
            if recursive && e.is_dir && depth < 32 {
                todo.push((full, depth + 1));
            }
            out.push(entry_json(&e, &rel));
            if out.len() > MAX_LIST {
                return Err(AppError::bad(format!("more than {MAX_LIST} entries; list folder by folder")));
            }
        }
    }
    Ok(Json(json!({ "path": t.rel().to_string(), "entries": out })))
}

/// The file's bytes; ranges, `If-None-Match` and HEAD work as for any download.
async fn download(State(app): State<Arc<App>>, key: Key, Path(p): Path<HashMap<String, String>>, headers: HeaderMap) -> Res<Response> {
    let t = key.target(&app, sub(&p)).await?;
    let (e, r) = t.backend.open(&t.path).await?;
    Ok(http_util::serve(e, r, &headers, &t.name(&t.path), false, false, None).await)
}

#[derive(Deserialize)]
struct PutQ {
    /// create missing folders on the way
    mkdirs: Option<String>,
    /// modification time to set, seconds since the epoch
    mtime: Option<i64>,
}

/// Creates or replaces a file. `If-Match: <etag>` replaces only that version
/// (`*`: only an existing file); `If-None-Match: *` only creates.
async fn upload(
    State(app): State<Arc<App>>,
    key: Key,
    Path(p): Path<HashMap<String, String>>,
    Query(q): Query<PutQ>,
    headers: HeaderMap,
    body: Body,
) -> Res<Response> {
    key.need_write()?;
    let t = key.target(&app, sub(&p)).await?;
    if t.path == t.root {
        return Err(AppError::bad("no file name"));
    }
    let cur = match t.backend.stat(&t.path).await {
        Ok(e) => Some(e),
        Err(FsError::NotFound) => None,
        Err(e) => return Err(e.into()),
    };
    if cur.as_ref().is_some_and(|e| e.is_dir) {
        return Err(FsError::IsDir.into());
    }
    if let Some(want) = header_str(&headers, header::IF_MATCH) {
        if !cur.as_ref().is_some_and(|e| want == "*" || e.etag() == want) {
            return Err(precondition("the file changed or is gone (If-Match)"));
        }
    }
    if header_str(&headers, header::IF_NONE_MATCH) == Some("*") && cur.is_some() {
        return Err(precondition("the file exists already (If-None-Match: *)"));
    }
    if q.mkdirs.is_some() {
        if let Some(parent) = t.path.parent() {
            files::mkdirs(t.backend.as_ref(), &t.root, &parent).await?;
        }
    }
    let stream = body.into_data_stream().map_err(io::Error::other);
    let mut e = match t.backend.write(&t.path, Box::pin(stream)).await {
        Err(FsError::NotFound) => return Err(AppError::new(StatusCode::NOT_FOUND, "no such folder (add ?mkdirs=1 to make it)")),
        r => r?,
    };
    if let Some(m) = q.mtime {
        t.backend.set_mtime(&t.path, m).await?;
        e = t.backend.stat(&t.path).await?;
    }
    app.sizes.touch(&files::store_id(t.owner, t.mount), &t.path);
    let status = if cur.is_some() { StatusCode::OK } else { StatusCode::CREATED };
    Ok((status, Json(entry_json(&e, &t.rel()))).into_response())
}

#[derive(Deserialize)]
struct RmQ {
    /// a folder that is not empty, with everything in it
    recursive: Option<String>,
}

/// Deletes a file (`If-Match` works), or an empty folder; with `?recursive=1`
/// a folder and everything in it.
async fn remove(
    State(app): State<Arc<App>>,
    key: Key,
    Path(p): Path<HashMap<String, String>>,
    Query(q): Query<RmQ>,
    headers: HeaderMap,
) -> Res<Json<Value>> {
    key.need_write()?;
    let t = key.target(&app, sub(&p)).await?;
    if t.path == t.root {
        return Err(AppError::bad("the key's own folder cannot be deleted"));
    }
    let e = t.backend.stat(&t.path).await?;
    if let Some(want) = header_str(&headers, header::IF_MATCH) {
        if e.is_dir || (want != "*" && e.etag() != want) {
            return Err(precondition("the file changed (If-Match)"));
        }
    }
    let recursive = q.recursive.as_deref().is_some_and(|v| v != "0" && v != "false");
    if e.is_dir && !recursive && !t.backend.list(&t.path).await?.is_empty() {
        return Err(AppError::conflict("the folder is not empty (add ?recursive=1 to delete it with everything in it)"));
    }
    files::remove_item(&app, &t, &t.path).await?;
    files::changed(&app, &t);
    Ok(Json(json!({ "ok": true })))
}

#[derive(Deserialize)]
struct MkdirQ {
    /// also the missing folders above it, and no error if it is there
    parents: Option<String>,
}

async fn mkdir(State(app): State<Arc<App>>, key: Key, Path(p): Path<HashMap<String, String>>, Query(q): Query<MkdirQ>) -> Res<Response> {
    key.need_write()?;
    let t = key.target(&app, sub(&p)).await?;
    if t.path == t.root {
        return Err(AppError::conflict("already exists"));
    }
    if q.parents.is_some() {
        files::mkdirs(t.backend.as_ref(), &t.root, &t.path).await?;
    } else {
        t.backend.mkdir(&t.path).await?;
    }
    app.sizes.touch(&files::store_id(t.owner, t.mount), &t.path);
    let e = t.backend.stat(&t.path).await?;
    Ok((StatusCode::CREATED, Json(entry_json(&e, &t.rel()))).into_response())
}

#[derive(Deserialize)]
struct MoveReq {
    from: String,
    to: String,
}

/// Renames or moves a file or folder inside the key's folder; fails if `to` exists.
async fn mv(State(app): State<Arc<App>>, key: Key, Json(req): Json<MoveReq>) -> Res<Json<Value>> {
    key.need_write()?;
    let t = key.target(&app, "").await?;
    let (from, to) = (t.at(&req.from)?, t.at(&req.to)?);
    files::move_item(&app, &t, &from, &to).await?;
    files::changed(&app, &t);
    let e = t.backend.stat(&to).await?;
    Ok(Json(entry_json(&e, &to.strip_prefix(&t.root).unwrap_or_default())))
}

/* ---- the owner's side, with the login cookie ---- */

fn key_json(r: &rusqlite::Row) -> rusqlite::Result<Value> {
    let mount: Option<i64> = r.get(1)?;
    let path: String = r.get(3)?;
    Ok(json!({
        "id": r.get::<_, i64>(0)?, "loc": mount.map_or("home".into(), |m| format!("m{m}")),
        "loc_name": r.get::<_, Option<String>>(2)?.unwrap_or("home".into()),
        "path": path, "folder": path.rsplit('/').next().unwrap_or(""),
        "name": r.get::<_, String>(4)?, "write": r.get::<_, bool>(5)?, "expires": r.get::<_, Option<i64>>(6)?,
        "created": r.get::<_, i64>(7)?, "last_used": r.get::<_, Option<i64>>(8)?,
    }))
}

async fn list_keys(State(app): State<Arc<App>>, user: User) -> Res<Json<Value>> {
    let keys = app.db.with(|c| {
        let mut st = c.prepare(
            "SELECT k.id, k.mount_id, m.name, k.path, k.name, k.can_write, k.expires, k.created, k.last_used
             FROM api_keys k LEFT JOIN mounts m ON m.id = k.mount_id WHERE k.owner_id = ?1 ORDER BY k.created DESC",
        )?;
        let v = st.query_map([user.id], key_json)?.collect::<rusqlite::Result<Vec<_>>>();
        v
    })?;
    Ok(Json(json!(keys)))
}

#[derive(Deserialize)]
struct CreateReq {
    loc: String,
    path: String,
    name: String,
    #[serde(default)]
    write: bool,
    /// valid for this many days; none = until removed
    days: Option<i64>,
}

/// The key is only ever in this answer; shelf keeps its hash.
async fn create_key(State(app): State<Arc<App>>, user: User, Json(req): Json<CreateReq>) -> Res<Json<Value>> {
    if req.loc.starts_with('s') {
        return Err(AppError::bad("API keys are for your own folders, not ones shared with you"));
    }
    let t = files::resolve(&app, &user, &req.loc, &req.path).await?;
    if t.path.is_root() {
        return Err(AppError::bad("pick a folder, not the whole location"));
    }
    if !t.backend.stat(&t.path).await?.is_dir {
        return Err(AppError::bad("API keys are for folders"));
    }
    let name: String = req.name.trim().chars().take(60).collect();
    let name = if name.is_empty() { "api key".to_string() } else { name };
    let token = format!("{PREFIX}{}", crypto::random_token(32));
    let expires = req.days.filter(|d| *d > 0).map(|d| now() + d * 86400);
    let path = t.path.to_string();
    let id = app.db.with(|c| {
        c.execute(
            "INSERT INTO api_keys (owner_id, mount_id, path, name, can_write, token_hash, expires, created)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
            params![user.id, t.mount, path, name, req.write, crypto::sha256_hex(&token), expires, now()],
        )?;
        Ok(c.last_insert_rowid())
    })?;
    Ok(Json(json!({ "id": id, "name": name, "key": token, "write": req.write, "expires": expires })))
}

async fn delete_key(State(app): State<Arc<App>>, user: User, Path(id): Path<i64>) -> Res<Json<Value>> {
    let n = app.db.with(|c| c.execute("DELETE FROM api_keys WHERE id = ?1 AND owner_id = ?2", [id, user.id]))?;
    if n == 0 {
        return Err(AppError::not_found());
    }
    Ok(Json(json!({ "ok": true })))
}
