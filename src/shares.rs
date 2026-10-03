//! Sharing with other users (`shares`) and public links (`links`, served by public.rs).

use std::sync::Arc;

use axum::{
    extract::{Path, Query, State},
    routing::{delete, get},
    Json, Router,
};
use rusqlite::params;
use serde::Deserialize;
use serde_json::{json, Value};

use crate::{
    auth::User,
    crypto,
    db::now,
    error::{AppError, Res},
    files::{self, Target},
    App,
};

pub fn routes() -> Router<Arc<App>> {
    Router::new()
        .route("/api/shares", get(all_shares).post(create_share))
        .route("/api/shares/item", get(item))
        .route("/api/shares/{id}", delete(delete_share))
        .route("/api/links", get(all_links).post(create_link))
        .route("/api/links/{id}", delete(delete_link))
}

/// An item the user owns and may share: in their home or on one of their mounts.
async fn own_item(app: &App, user: &User, loc: &str, path: &str) -> Res<(Target, bool)> {
    if loc.starts_with('s') {
        return Err(AppError::bad("things shared with you cannot be shared on"));
    }
    let t = files::resolve(app, user, loc, path).await?;
    if t.path.is_root() {
        return Err(AppError::bad("share a folder or file, not the whole location"));
    }
    let e = t.backend.stat(&t.path).await?;
    Ok((t, e.is_dir))
}

fn loc_of(mount: Option<i64>) -> String {
    mount.map_or("home".into(), |m| format!("m{m}"))
}

fn name_of(path: &str) -> &str {
    path.rsplit('/').next().unwrap_or(path)
}

pub fn link_url(app: &App, token: &str) -> String {
    format!("{}/s/{token}", app.cfg.public_url.as_deref().unwrap_or(""))
}

fn link_json(app: &App, r: &rusqlite::Row) -> rusqlite::Result<Value> {
    let mount: Option<i64> = r.get(2)?;
    let path: String = r.get(3)?;
    let token: String = r.get(1)?;
    Ok(json!({
        "id": r.get::<_, i64>(0)?, "token": token, "url": link_url(app, &token),
        "loc": loc_of(mount), "loc_name": r.get::<_, Option<String>>(4)?.unwrap_or("home".into()),
        "path": path, "name": name_of(&path), "dir": r.get::<_, bool>(5)?,
        "expires": r.get::<_, Option<i64>>(6)?, "created": r.get::<_, i64>(7)?, "hits": r.get::<_, i64>(8)?,
    }))
}

const LINK_COLS: &str = "l.id, l.token, l.mount_id, l.path, m.name, l.is_dir, l.expires, l.created, l.hits";

fn share_json(r: &rusqlite::Row) -> rusqlite::Result<Value> {
    let mount: Option<i64> = r.get(1)?;
    let path: String = r.get(3)?;
    Ok(json!({
        "id": r.get::<_, i64>(0)?, "loc": loc_of(mount),
        "loc_name": r.get::<_, Option<String>>(2)?.unwrap_or("home".into()),
        "path": path, "name": name_of(&path), "dir": r.get::<_, bool>(4)?,
        "user": r.get::<_, String>(5)?, "write": r.get::<_, bool>(6)?, "created": r.get::<_, i64>(7)?,
    }))
}

const SHARE_COLS: &str = "s.id, s.mount_id, m.name, s.path, s.is_dir, u.username, s.can_write, s.created";

async fn all_shares(State(app): State<Arc<App>>, user: User) -> Res<Json<Value>> {
    let (by_me, with_me) = app.db.with(|c| {
        let mut st = c.prepare(&format!(
            "SELECT {SHARE_COLS} FROM shares s JOIN users u ON u.id = s.recipient_id
             LEFT JOIN mounts m ON m.id = s.mount_id WHERE s.owner_id = ?1 ORDER BY s.path, u.username"
        ))?;
        let by_me = st.query_map([user.id], share_json)?.collect::<rusqlite::Result<Vec<_>>>()?;
        // for the recipient, "user" is the owner, and loc is the share itself
        let mut st = c.prepare(&format!(
            "SELECT {SHARE_COLS} FROM shares s JOIN users u ON u.id = s.owner_id
             LEFT JOIN mounts m ON m.id = s.mount_id WHERE s.recipient_id = ?1 AND u.disabled = 0
             ORDER BY s.created DESC"
        ))?;
        let with_me = st
            .query_map([user.id], |r| {
                let mut v = share_json(r)?;
                v["loc"] = json!(format!("s{}", v["id"]));
                v["loc_name"] = Value::Null;
                Ok(v)
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok((by_me, with_me))
    })?;
    Ok(Json(json!({ "by_me": by_me, "with_me": with_me })))
}

#[derive(Deserialize)]
struct ItemQ {
    loc: String,
    path: String,
}

/// Shares and links of one item, for the share dialog.
async fn item(State(app): State<Arc<App>>, user: User, Query(q): Query<ItemQ>) -> Res<Json<Value>> {
    let (t, is_dir) = own_item(&app, &user, &q.loc, &q.path).await?;
    let path = t.path.to_string();
    let (shares, links) = app.db.with(|c| {
        let mut st = c.prepare(&format!(
            "SELECT {SHARE_COLS} FROM shares s JOIN users u ON u.id = s.recipient_id
             LEFT JOIN mounts m ON m.id = s.mount_id
             WHERE s.owner_id = ?1 AND IFNULL(s.mount_id, 0) = ?2 AND s.path = ?3 ORDER BY u.username"
        ))?;
        let shares = st.query_map(params![user.id, t.mount.unwrap_or(0), path], share_json)?.collect::<rusqlite::Result<Vec<_>>>()?;
        let mut st = c.prepare(&format!(
            "SELECT {LINK_COLS} FROM links l LEFT JOIN mounts m ON m.id = l.mount_id
             WHERE l.owner_id = ?1 AND IFNULL(l.mount_id, 0) = ?2 AND l.path = ?3 ORDER BY l.created"
        ))?;
        let links = st
            .query_map(params![user.id, t.mount.unwrap_or(0), path], |r| link_json(&app, r))?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok((shares, links))
    })?;
    Ok(Json(json!({ "shares": shares, "links": links, "dir": is_dir, "path": path })))
}

#[derive(Deserialize)]
struct ShareReq {
    loc: String,
    path: String,
    user: String,
    #[serde(default)]
    write: bool,
}

async fn create_share(State(app): State<Arc<App>>, user: User, Json(req): Json<ShareReq>) -> Res<Json<Value>> {
    let (t, is_dir) = own_item(&app, &user, &req.loc, &req.path).await?;
    let to: i64 = app
        .db
        .opt(|c| c.query_row("SELECT id FROM users WHERE username = ?1 AND disabled = 0", [req.user.trim()], |r| r.get(0)))?
        .ok_or_else(|| AppError::bad("no such user"))?;
    if to == user.id {
        return Err(AppError::bad("that is you"));
    }
    let path = t.path.to_string();
    let id = app.db.with(|c| {
        let n = c.execute(
            "UPDATE shares SET can_write = ?5, is_dir = ?6
             WHERE owner_id = ?1 AND IFNULL(mount_id, 0) = IFNULL(?2, 0) AND path = ?3 AND recipient_id = ?4",
            params![user.id, t.mount, path, to, req.write, is_dir],
        )?;
        if n == 0 {
            c.execute(
                "INSERT INTO shares (owner_id, mount_id, path, is_dir, recipient_id, can_write, created)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
                params![user.id, t.mount, path, is_dir, to, req.write, now()],
            )?;
        }
        c.query_row(
            "SELECT id FROM shares WHERE owner_id = ?1 AND IFNULL(mount_id, 0) = IFNULL(?2, 0) AND path = ?3 AND recipient_id = ?4",
            params![user.id, t.mount, path, to],
            |r| r.get::<_, i64>(0),
        )
    })?;
    Ok(Json(json!({ "id": id })))
}

/// The owner revokes a share, or the recipient drops it.
async fn delete_share(State(app): State<Arc<App>>, user: User, Path(id): Path<i64>) -> Res<Json<Value>> {
    let n = app.db.with(|c| {
        c.execute("DELETE FROM shares WHERE id = ?1 AND (owner_id = ?2 OR recipient_id = ?2)", [id, user.id])
    })?;
    if n == 0 {
        return Err(AppError::not_found());
    }
    Ok(Json(json!({ "ok": true })))
}

async fn all_links(State(app): State<Arc<App>>, user: User) -> Res<Json<Value>> {
    let links = app.db.with(|c| {
        let mut st = c.prepare(&format!(
            "SELECT {LINK_COLS} FROM links l LEFT JOIN mounts m ON m.id = l.mount_id
             WHERE l.owner_id = ?1 ORDER BY l.created DESC"
        ))?;
        let v = st.query_map([user.id], |r| link_json(&app, r))?.collect::<rusqlite::Result<Vec<_>>>();
        v
    })?;
    Ok(Json(json!(links)))
}

#[derive(Deserialize)]
struct LinkReq {
    loc: String,
    path: String,
    /// valid for this many days; none = until removed
    days: Option<i64>,
}

async fn create_link(State(app): State<Arc<App>>, user: User, Json(req): Json<LinkReq>) -> Res<Json<Value>> {
    let (t, is_dir) = own_item(&app, &user, &req.loc, &req.path).await?;
    let token = crypto::random_token(16);
    let expires = req.days.filter(|d| *d > 0).map(|d| now() + d * 86400);
    let path = t.path.to_string();
    let id = app.db.with(|c| {
        c.execute(
            "INSERT INTO links (token, owner_id, mount_id, path, is_dir, expires, created) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            params![token, user.id, t.mount, path, is_dir, expires, now()],
        )?;
        Ok(c.last_insert_rowid())
    })?;
    Ok(Json(json!({ "id": id, "token": token, "url": link_url(&app, &token) })))
}

async fn delete_link(State(app): State<Arc<App>>, user: User, Path(id): Path<i64>) -> Res<Json<Value>> {
    let n = app.db.with(|c| c.execute("DELETE FROM links WHERE id = ?1 AND owner_id = ?2", [id, user.id]))?;
    if n == 0 {
        return Err(AppError::not_found());
    }
    Ok(Json(json!({ "ok": true })))
}
