//! One-way sync from phones. The shelf app pairs a phone with the user's login
//! (`POST /api/devices`) and gets a token of its own; with it the phone can only
//! list folders in its owner's home and put files there. It adds new files and
//! replaces the ones it put itself, as long as nobody changed them on shelf
//! since (`device_files`); anything else is refused, so a lost phone cannot
//! destroy what is on shelf. Removing the device in settings ends its token.

use std::{io, sync::Arc};

use axum::{
    body::Body,
    extract::{FromRequestParts, Path, Query, State},
    http::{header, request::Parts, HeaderMap, StatusCode},
    routing::{delete, get, put},
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
    files,
    vfs::{FsError, RelPath},
    App,
};

pub fn routes() -> Router<Arc<App>> {
    Router::new()
        .route("/api/devices", get(list).post(create))
        .route("/api/devices/{id}", delete(remove))
        .route("/api/sync/me", get(me).delete(unpair))
        .route("/api/sync/ls/{*path}", get(ls))
        .route("/api/sync/put/{*path}", put(upload))
}

/// A paired device, from `Authorization: Bearer <token>`; only the routes here take it.
pub struct Device {
    pub id: i64,
    pub name: String,
    pub user: User,
}

impl FromRequestParts<Arc<App>> for Device {
    type Rejection = AppError;

    async fn from_request_parts(parts: &mut Parts, app: &Arc<App>) -> Result<Self, Self::Rejection> {
        let token = parts
            .headers
            .get(header::AUTHORIZATION)
            .and_then(|v| v.to_str().ok())
            .and_then(|v| v.strip_prefix("Bearer "))
            .ok_or_else(AppError::unauthorized)?;
        let h = crypto::sha256_hex(token.trim());
        let t = now();
        let dev = app
            .db
            .opt(|c| {
                let (dev, last): (Device, i64) = c.query_row(
                    "SELECT d.id, d.name, d.last_seen, u.id, u.username, u.is_admin, u.remote_cidrs
                     FROM devices d JOIN users u ON u.id = d.user_id WHERE d.token_hash = ?1 AND u.disabled = 0",
                    [&h],
                    |r| {
                        let user = User { id: r.get(3)?, username: r.get(4)?, admin: r.get(5)?, cidrs: r.get(6)? };
                        Ok((Device { id: r.get(0)?, name: r.get(1)?, user }, r.get(2)?))
                    },
                )?;
                if t - last > 60 {
                    c.execute("UPDATE devices SET last_seen = ?1 WHERE id = ?2", params![t, dev.id])?;
                }
                Ok(dev)
            })?
            .ok_or_else(AppError::unauthorized)?;
        if let Some(Remote(ip)) = parts.extensions.get::<Remote>() {
            if !edge::allowed(app, &dev.user.cidrs, *ip) {
                return Err(AppError::new(StatusCode::FORBIDDEN, format!("{} cannot be used from {ip}", dev.user.username)));
            }
        }
        Ok(dev)
    }
}

async fn list(State(app): State<Arc<App>>, user: User) -> Res<Json<Value>> {
    let v = app.db.with(|c| {
        let mut st = c.prepare(
            "SELECT d.id, d.name, d.created, d.last_seen, (SELECT COUNT(*) FROM device_files f WHERE f.device_id = d.id)
             FROM devices d WHERE d.user_id = ?1 ORDER BY d.created",
        )?;
        let rows = st.query_map([user.id], |r| {
            Ok(json!({ "id": r.get::<_, i64>(0)?, "name": r.get::<_, String>(1)?, "created": r.get::<_, i64>(2)?,
                "last_seen": r.get::<_, i64>(3)?, "files": r.get::<_, i64>(4)? }))
        })?;
        rows.collect::<rusqlite::Result<Vec<_>>>()
    })?;
    Ok(Json(json!(v)))
}

#[derive(Deserialize)]
struct CreateReq {
    name: String,
}

/// The token is only ever in this answer; shelf keeps its hash.
async fn create(State(app): State<Arc<App>>, user: User, Json(req): Json<CreateReq>) -> Res<Json<Value>> {
    let name: String = req.name.trim().chars().take(60).collect();
    let name = if name.is_empty() { "phone".to_string() } else { name };
    let token = crypto::random_token(32);
    let t = now();
    let id = app.db.with(|c| {
        c.execute(
            "INSERT INTO devices (user_id, name, token_hash, created, last_seen) VALUES (?1, ?2, ?3, ?4, ?4)",
            params![user.id, name, crypto::sha256_hex(&token), t],
        )?;
        Ok(c.last_insert_rowid())
    })?;
    Ok(Json(json!({ "id": id, "name": name, "token": token, "username": user.username })))
}

async fn remove(State(app): State<Arc<App>>, user: User, Path(id): Path<i64>) -> Res<Json<Value>> {
    let n = app.db.with(|c| c.execute("DELETE FROM devices WHERE id = ?1 AND user_id = ?2", [id, user.id]))?;
    if n == 0 {
        return Err(AppError::not_found());
    }
    Ok(Json(json!({ "ok": true })))
}

async fn me(dev: Device) -> Json<Value> {
    Json(json!({ "username": dev.user.username, "device": dev.name, "version": env!("CARGO_PKG_VERSION") }))
}

/// The phone lets go of its token.
async fn unpair(State(app): State<Arc<App>>, dev: Device) -> Res<Json<Value>> {
    app.db.with(|c| c.execute("DELETE FROM devices WHERE id = ?1", [dev.id]))?;
    Ok(Json(json!({ "ok": true })))
}

/// A folder in the home: `{entries: [{name, dir, size, mtime, etag}]}`.
async fn ls(State(app): State<Arc<App>>, dev: Device, Path(p): Path<String>) -> Res<Json<Value>> {
    let b = files::home_backend(&app, &dev.user.username);
    let list = b.list(&RelPath::parse(&p)?).await?;
    Ok(Json(json!({ "entries": list.iter().map(|e| e.json()).collect::<Vec<_>>() })))
}

#[derive(Deserialize)]
struct PutQ {
    /// the file's time on the phone, seconds since the epoch
    mtime: Option<i64>,
}

/// A new file (missing folders are made), or with `If-Match` a new version of
/// one this device put there and nobody changed since.
async fn upload(
    State(app): State<Arc<App>>,
    dev: Device,
    Path(p): Path<String>,
    Query(q): Query<PutQ>,
    headers: HeaderMap,
    body: Body,
) -> Res<Json<Value>> {
    let b = files::home_backend(&app, &dev.user.username);
    let path = RelPath::parse(&p)?;
    let Some(parent) = path.parent() else { return Err(AppError::bad("no file name")) };
    let key = path.to_string();
    let want = headers.get(header::IF_MATCH).and_then(|v| v.to_str().ok());
    let mine: Option<String> = app.db.opt(|c| {
        c.query_row("SELECT etag FROM device_files WHERE device_id = ?1 AND path = ?2", params![dev.id, key], |r| r.get(0))
    })?;
    match (b.stat(&path).await, want) {
        (Err(FsError::NotFound), None) => {}
        (Ok(_), None) => return Err(AppError::conflict("there is a file of that name already")),
        (Ok(e), Some(w)) if e.etag() == w && mine.as_deref() == Some(w) => {}
        (Ok(_) | Err(FsError::NotFound), Some(_)) => {
            return Err(AppError::new(StatusCode::PRECONDITION_FAILED, "changed or removed on shelf since this phone put it there"))
        }
        (Err(e), _) => return Err(e.into()),
    }
    files::mkdirs(b.as_ref(), &RelPath::root(), &parent).await?;
    let stream = body.into_data_stream().map_err(io::Error::other);
    let mut e = b.write(&path, Box::pin(stream)).await?;
    if let Some(t) = q.mtime {
        b.set_mtime(&path, t).await?;
        e = b.stat(&path).await?;
    }
    app.sizes.touch(&files::store_id(dev.user.id, None), &path);
    let etag = e.etag();
    app.db.with(|c| {
        c.execute(
            "INSERT INTO device_files (device_id, path, etag) VALUES (?1, ?2, ?3)
             ON CONFLICT(device_id, path) DO UPDATE SET etag = excluded.etag",
            params![dev.id, key, etag],
        )
    })?;
    Ok(Json(e.json()))
}
