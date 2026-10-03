//! External storage: each user can add SFTP mounts. Credentials are sealed
//! with secret.key; the host key is pinned on the first connection.

use std::sync::Arc;

use axum::{
    extract::{Path, State},
    routing::{get, post, put},
    Json, Router,
};
use rusqlite::params;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::{
    auth::User,
    db::now,
    error::{AppError, Res},
    vfs::{
        sftp::{self, Auth, MountCfg},
        Backend,
    },
    App,
};

pub fn routes() -> Router<Arc<App>> {
    Router::new()
        .route("/api/mounts", get(list).post(create))
        .route("/api/mounts/{id}", put(update).delete(remove))
        .route("/api/mounts/{id}/test", post(test))
}

/// What is sealed in `mounts.secret` (and in the backup target setting).
#[derive(Serialize, Deserialize, Default, Clone)]
pub struct Secret {
    pub password: Option<String>,
    pub key: Option<String>,
    pub passphrase: Option<String>,
}

/// The SFTP part of a form, shared by mounts and the backup target.
/// Secret fields left empty keep what was stored before.
#[derive(Deserialize, Default, Clone)]
pub struct SftpForm {
    pub host: String,
    pub port: Option<u16>,
    pub username: String,
    /// `password` or `key`
    pub auth: String,
    pub password: Option<String>,
    pub key: Option<String>,
    pub passphrase: Option<String>,
    pub root: Option<String>,
}

fn nonempty(s: &Option<String>) -> Option<String> {
    s.as_ref().filter(|v| !v.trim().is_empty()).cloned()
}

impl SftpForm {
    pub fn secret(&self, old: Option<Secret>) -> Secret {
        let old = old.unwrap_or_default();
        Secret {
            password: nonempty(&self.password).or(old.password),
            key: nonempty(&self.key).map(|k| k.trim().to_string() + "\n").or(old.key),
            passphrase: nonempty(&self.passphrase).or(old.passphrase),
        }
    }

    pub fn cfg(&self, id: i64, s: &Secret, host_key: Option<String>) -> Res<MountCfg> {
        let host = self.host.trim();
        if host.is_empty() || host.contains(char::is_whitespace) {
            return Err(AppError::bad("host is required"));
        }
        if self.username.trim().is_empty() {
            return Err(AppError::bad("username is required"));
        }
        let auth = match self.auth.as_str() {
            "password" => Auth::Password(s.password.clone().ok_or_else(|| AppError::bad("password is required"))?),
            "key" => Auth::Key {
                pem: s.key.clone().ok_or_else(|| AppError::bad("private key is required"))?,
                passphrase: s.passphrase.clone(),
            },
            _ => return Err(AppError::bad("auth must be password or key")),
        };
        Ok(MountCfg {
            id,
            host: host.to_string(),
            port: self.port.unwrap_or(22),
            user: self.username.trim().to_string(),
            auth,
            root: self.root.clone().unwrap_or_default().trim().to_string(),
            host_key,
            private: false,
        })
    }
}

pub fn seal(app: &App, s: &Secret) -> String {
    app.key.seal(&serde_json::to_vec(s).expect("json"))
}

pub fn unseal(app: &App, sealed: &str) -> Res<Secret> {
    let raw = app.key.open(sealed).ok_or_else(|| AppError::internal("cannot unseal a secret: wrong secret.key?"))?;
    serde_json::from_slice(&raw).map_err(AppError::internal)
}

struct Row {
    user_id: i64,
    name: String,
    form: SftpForm,
    secret: String,
    host_key: Option<String>,
}

fn load(app: &App, id: i64) -> Res<Option<Row>> {
    app.db.opt(|c| {
        c.query_row(
            "SELECT user_id, name, host, port, username, auth, secret, root, host_key FROM mounts WHERE id = ?1",
            [id],
            |r| {
                Ok(Row {
                    user_id: r.get(0)?,
                    name: r.get(1)?,
                    form: SftpForm {
                        host: r.get(2)?,
                        port: Some(r.get(3)?),
                        username: r.get(4)?,
                        auth: r.get(5)?,
                        root: Some(r.get(7)?),
                        ..Default::default()
                    },
                    secret: r.get(6)?,
                    host_key: r.get(8)?,
                })
            },
        )
    })
}

/// The live backend of a mount (the caller has checked who may use it).
pub fn backend(app: &App, id: i64) -> Res<Arc<dyn Backend>> {
    if let Some(s) = app.sftp.get(id) {
        return Ok(s);
    }
    let row = load(app, id)?.ok_or_else(AppError::not_found)?;
    let cfg = row.form.cfg(id, &unseal(app, &row.secret)?, row.host_key)?;
    Ok(app.sftp.insert(cfg))
}

fn own(app: &App, user: &User, id: i64) -> Res<Row> {
    load(app, id)?.filter(|r| r.user_id == user.id).ok_or_else(AppError::not_found)
}

async fn list(State(app): State<Arc<App>>, user: User) -> Res<Json<Value>> {
    let v = app.db.with(|c| {
        let mut st = c.prepare(
            "SELECT id, name, kind, host, port, username, auth, root, host_key, created FROM mounts WHERE user_id = ?1 ORDER BY name",
        )?;
        let v = st
            .query_map([user.id], |r| {
                Ok(json!({
                    "id": r.get::<_, i64>(0)?, "loc": format!("m{}", r.get::<_, i64>(0)?), "name": r.get::<_, String>(1)?,
                    "kind": r.get::<_, String>(2)?, "host": r.get::<_, String>(3)?, "port": r.get::<_, i64>(4)?,
                    "username": r.get::<_, String>(5)?, "auth": r.get::<_, String>(6)?, "root": r.get::<_, String>(7)?,
                    "host_key": r.get::<_, Option<String>>(8)?, "created": r.get::<_, i64>(9)?,
                }))
            })?
            .collect::<rusqlite::Result<Vec<_>>>();
        v
    })?;
    Ok(Json(json!(v)))
}

#[derive(Deserialize)]
struct MountReq {
    name: String,
    #[serde(flatten)]
    sftp: SftpForm,
    #[serde(default)]
    reset_host_key: bool,
}

fn check_name(n: &str) -> Res<String> {
    let n = n.trim();
    if n.is_empty() || n.chars().count() > 64 || n.contains(['/', '\0']) {
        return Err(AppError::bad("name: 1-64 characters, no slash"));
    }
    Ok(n.to_string())
}

/// Adding a mount connects to it first, so a typo shows up right away.
async fn create(State(app): State<Arc<App>>, user: User, Json(req): Json<MountReq>) -> Res<Json<Value>> {
    let name = check_name(&req.name)?;
    let secret = req.sftp.secret(None);
    let cfg = req.sftp.cfg(0, &secret, None)?;
    let (fp, n) = sftp::probe(&cfg).await?;
    let sealed = seal(&app, &secret);
    let id = app.db.with(|c| {
        c.execute(
            "INSERT INTO mounts (user_id, name, kind, host, port, username, auth, secret, root, host_key, created)
             VALUES (?1, ?2, 'sftp', ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
            params![user.id, name, cfg.host, cfg.port, cfg.user, req.sftp.auth, sealed, cfg.root, fp, now()],
        )?;
        Ok(c.last_insert_rowid())
    })?;
    Ok(Json(json!({ "id": id, "loc": format!("m{id}"), "host_key": fp, "entries": n })))
}

async fn update(State(app): State<Arc<App>>, user: User, Path(id): Path<i64>, Json(req): Json<MountReq>) -> Res<Json<Value>> {
    let row = own(&app, &user, id)?;
    let name = check_name(&req.name)?;
    let secret = req.sftp.secret(Some(unseal(&app, &row.secret)?));
    let pinned = if req.reset_host_key { None } else { row.host_key };
    let cfg = req.sftp.cfg(id, &secret, pinned)?;
    let (fp, n) = sftp::probe(&cfg).await?;
    let sealed = seal(&app, &secret);
    app.db.with(|c| {
        c.execute(
            "UPDATE mounts SET name = ?1, host = ?2, port = ?3, username = ?4, auth = ?5, secret = ?6, root = ?7, host_key = ?8
             WHERE id = ?9",
            params![name, cfg.host, cfg.port, cfg.user, req.sftp.auth, sealed, cfg.root, fp, id],
        )
    })?;
    app.sftp.forget(id);
    Ok(Json(json!({ "id": id, "host_key": fp, "entries": n })))
}

async fn remove(State(app): State<Arc<App>>, user: User, Path(id): Path<i64>) -> Res<Json<Value>> {
    own(&app, &user, id)?;
    app.db.with(|c| c.execute("DELETE FROM mounts WHERE id = ?1", [id]))?;
    app.sftp.forget(id);
    Ok(Json(json!({ "ok": true })))
}

async fn test(State(app): State<Arc<App>>, user: User, Path(id): Path<i64>) -> Res<Json<Value>> {
    let row = own(&app, &user, id)?;
    let cfg = row.form.cfg(id, &unseal(&app, &row.secret)?, row.host_key)?;
    let (fp, n) = sftp::probe(&cfg).await?;
    Ok(Json(json!({ "ok": true, "name": row.name, "host_key": fp, "entries": n })))
}
