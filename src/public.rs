//! Public links: everything a visitor without an account can reach lives
//! under `/s/<token>/…` (plus `/static/`).

use std::{collections::HashMap, sync::Arc};

use axum::{
    extract::{Path, Query, State},
    http::{HeaderMap, StatusCode},
    response::Response,
    routing::get,
    Json, Router,
};
use serde::Deserialize;
use serde_json::{json, Value};
use tokio::io::AsyncReadExt;

use crate::{
    db::now,
    edge,
    error::{AppError, Res},
    files, http_util, md,
    vfs::{Backend, RelPath},
    App,
};

pub fn routes() -> Router<Arc<App>> {
    Router::new()
        .route("/s/{token}", get(page))
        .route("/s/{token}/", get(page))
        .route("/s/{token}/p/{*path}", get(page))
        .route("/s/{token}/info", get(info))
        .route("/s/{token}/ls", get(ls))
        .route("/s/{token}/ls/{*path}", get(ls))
        .route("/s/{token}/raw", get(raw))
        .route("/s/{token}/raw/{*path}", get(raw))
        .route("/s/{token}/md", get(markdown))
        .route("/s/{token}/md/{*path}", get(markdown))
}

struct Link {
    id: i64,
    owner_id: i64,
    owner: String,
    mount: Option<i64>,
    path: RelPath,
    is_dir: bool,
}

fn find(app: &App, token: &str) -> Res<Link> {
    let row = app.db.opt(|c| {
        c.query_row(
            "SELECT l.id, l.owner_id, o.username, l.mount_id, l.path, l.is_dir FROM links l JOIN users o ON o.id = l.owner_id
             WHERE l.token = ?1 AND (l.expires IS NULL OR l.expires > ?2) AND o.disabled = 0",
            rusqlite::params![token, now()],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get::<_, String>(4)?, r.get(5)?)),
        )
    })?;
    let (id, owner_id, owner, mount, path, is_dir) = row.ok_or_else(AppError::not_found)?;
    Ok(Link { id, owner_id, owner, mount, path: RelPath::parse(&path)?, is_dir })
}

/// The link, its storage, and the path `sub` points at. For a file link the
/// tail of the url is only the file name and is ignored.
async fn target(app: &App, token: &str, sub: Option<&String>) -> Res<(Link, Arc<dyn Backend>, RelPath)> {
    let l = find(app, token)?;
    let path = if l.is_dir { l.path.join(&RelPath::parse(sub.map_or("", |s| s))?) } else { l.path.clone() };
    let b = files::owner_backend(app, &l.owner, l.mount).await?;
    Ok((l, b, path))
}

async fn page(State(app): State<Arc<App>>, Path(p): Path<HashMap<String, String>>) -> Response {
    let found = p.get("token").is_some_and(|t| find(&app, t).is_ok());
    app.assets.public_page(if found { StatusCode::OK } else { StatusCode::NOT_FOUND })
}

async fn info(State(app): State<Arc<App>>, Path(token): Path<String>) -> Res<Json<Value>> {
    let (l, b, path) = target(&app, &token, None).await?;
    let e = b.stat(&path).await?;
    Ok(Json(json!({
        "name": l.path.name().unwrap_or(""), "dir": e.is_dir, "size": e.size, "mtime": e.mtime, "owner": l.owner,
    })))
}

async fn ls(State(app): State<Arc<App>>, Path(p): Path<HashMap<String, String>>) -> Res<Json<Value>> {
    let (l, b, path) = target(&app, &p["token"], p.get("path")).await?;
    let me = b.stat(&path).await?;
    let rel = path.strip_prefix(&l.path).unwrap_or_default();
    let name = l.path.name().unwrap_or("");
    if !me.is_dir {
        let mut e = me.json();
        if rel.is_root() {
            e["name"] = json!(name);
        }
        return Ok(Json(json!({ "path": rel.to_string(), "root_name": name, "owner": l.owner, "file": e })));
    }
    let entries: Vec<Value> = b.list(&path).await?.iter().map(|e| e.json()).collect();
    Ok(Json(json!({ "path": rel.to_string(), "root_name": name, "owner": l.owner, "entries": entries })))
}

#[derive(Deserialize)]
struct RawQ {
    dl: Option<String>,
}

async fn raw(
    State(app): State<Arc<App>>,
    Path(p): Path<HashMap<String, String>>,
    Query(q): Query<RawQ>,
    headers: HeaderMap,
) -> Res<Response> {
    let (l, b, path) = target(&app, &p["token"], p.get("path")).await?;
    let (e, r) = b.open(&path).await?;
    // count downloads, not every range request of a video player (nor the
    // edge fetching what it just probed)
    let range = headers.get("range").and_then(|v| v.to_str().ok());
    if range.is_none_or(|r| r.trim() == "bytes=0-") && !edge::is_fetch(&headers) {
        app.db.with(|c| c.execute("UPDATE links SET hits = hits + 1 WHERE id = ?1", [l.id])).ok();
    }
    let probe = edge::probe(&app, &headers, &files::store_id(l.owner_id, l.mount), &path);
    Ok(http_util::serve(e, r, &headers, path.name().unwrap_or("file"), q.dl.is_some(), true, probe).await)
}

const MD_MAX: u64 = 4 << 20;

async fn markdown(State(app): State<Arc<App>>, Path(p): Path<HashMap<String, String>>) -> Res<Json<Value>> {
    let token = &p["token"];
    let (l, b, path) = target(&app, token, p.get("path")).await?;
    let (e, r) = b.open(&path).await?;
    if e.size > MD_MAX {
        return Err(AppError::bad("too large to render"));
    }
    let mut text = String::new();
    r.take(MD_MAX).read_to_string(&mut text).await.map_err(|_| AppError::bad("not UTF-8 text"))?;
    // relative links resolve inside the link's folder
    let dir = path.parent().and_then(|d| d.strip_prefix(&l.path)).unwrap_or_default();
    let enc = http_util::encode_path(&dir);
    let html = md::render(&text, Some(&format!("/s/{token}/raw{enc}/")), Some(&format!("/s/{token}/p{enc}/")));
    Ok(Json(json!({ "html": html })))
}
