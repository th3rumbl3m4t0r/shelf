use std::{io::BufRead, sync::Arc};

use axum::{
    extract::{Extension, Path, State},
    http::{header, HeaderMap},
    response::{IntoResponse, Response},
    routing::{get, patch, post, put},
    Json, Router,
};
use rusqlite::params;
use serde::Deserialize;
use serde_json::{json, Value};

use crate::{
    auth::{self, Admin, User},
    crypto,
    db::{self, now},
    edge::{self, Remote},
    error::{AppError, Res},
    quota, App,
};

pub fn routes() -> Router<Arc<App>> {
    Router::new()
        .route("/api/login", post(login))
        .route("/api/logout", post(logout))
        .route("/api/me", get(me))
        .route("/api/me/lang", put(set_lang))
        .route("/api/password", post(password))
        .route("/api/usernames", get(usernames))
        .route("/api/users", get(list).post(create))
        .route("/api/users/{id}", patch(update).delete(remove))
}

/// Usernames double as folder names under `<data>/users`.
pub fn valid_username(n: &str) -> bool {
    let b = n.as_bytes();
    !b.is_empty()
        && b.len() <= 32
        && b[0].is_ascii_lowercase() | b[0].is_ascii_digit()
        && b.iter().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || b"._-".contains(c))
}

pub fn create_user(app: &App, name: &str, pw: &str, admin: bool) -> Res<i64> {
    if !valid_username(name) {
        return Err(AppError::bad("username: 1-32 of a-z 0-9 . _ -, starting with a letter or digit"));
    }
    auth::check_password_rules(pw)?;
    let hash = auth::hash_password(pw);
    let id = app.db.with(|c| {
        c.execute(
            "INSERT INTO users (username, pw_hash, is_admin, created) VALUES (?1, ?2, ?3, ?4)",
            params![name, hash, admin, now()],
        )?;
        Ok(c.last_insert_rowid())
    });
    let id = match id {
        Err(e) if e.status.is_server_error() => {
            let taken = app.db.opt(|c| c.query_row("SELECT 1 FROM users WHERE username = ?1", [name], |_| Ok(())))?;
            return Err(if taken.is_some() { AppError::conflict("username taken") } else { e });
        }
        r => r?,
    };
    std::fs::create_dir_all(app.user_root(name)).map_err(AppError::internal)?;
    Ok(id)
}

fn user_json(r: &rusqlite::Row) -> rusqlite::Result<Value> {
    Ok(json!({
        "id": r.get::<_, i64>(0)?, "username": r.get::<_, String>(1)?,
        "admin": r.get::<_, bool>(2)?, "disabled": r.get::<_, bool>(3)?, "created": r.get::<_, i64>(4)?,
        "remote": r.get::<_, String>(5)?, "quota": r.get::<_, Option<i64>>(6)?,
    }))
}

#[derive(Deserialize)]
struct LoginReq {
    username: String,
    password: String,
}

async fn login(State(app): State<Arc<App>>, remote: Option<Extension<Remote>>, Json(req): Json<LoginReq>) -> Res<Response> {
    let name = req.username.trim().to_lowercase();
    let remote = remote.map(|Extension(Remote(ip))| ip);
    // strangers on the internet can only lock the account's outside logins
    let key = if remote.is_some() { format!("{name}@edge") } else { name.clone() };
    if !app.limiter.allowed(&key) {
        return Err(AppError::new(
            axum::http::StatusCode::TOO_MANY_REQUESTS,
            "too many failed logins, try again in 15 minutes",
        ));
    }
    let row = app.db.opt(|c| {
        c.query_row(
            "SELECT id, pw_hash, remote_cidrs FROM users WHERE username = ?1 AND disabled = 0",
            [&name],
            |r| Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?, r.get::<_, String>(2)?)),
        )
    })?;
    // hash even for unknown names so both cases take as long
    let (id, hash, cidrs) =
        row.unwrap_or((0, "$argon2id$v=19$m=19456,t=2,p=1$c29tZXNhbHQ$ybmUEjYvh7/XyCCs2FcxKtWYfy9pgh8OpeAGf6QgOYg".into(), String::new()));
    let pw = req.password;
    let ok = tokio::task::spawn_blocking(move || auth::verify_password(&pw, &hash)).await.unwrap_or(false);
    let from_ok = remote.is_none_or(|ip| edge::allowed(&app, &cidrs, ip));
    if !ok || id == 0 || !from_ok {
        app.limiter.fail(&key);
        // the same answer either way: no hint which names exist or are allowed out
        let (msg, via) = match remote {
            Some(ip) => (format!("wrong username or password, or this account cannot be used from {ip}"), format!(" from {ip} (edge)")),
            None => ("wrong username or password".into(), String::new()),
        };
        tracing::warn!("failed login for {name:?}{via}");
        return Err(AppError::new(axum::http::StatusCode::UNAUTHORIZED, msg));
    }
    app.limiter.clear(&key);
    if let Some(ip) = remote {
        tracing::info!("{name} logged in from {ip} (edge)");
    }
    let token = auth::new_session(&app, id)?;
    let cookie = auth::session_cookie(&app, &token, auth::SESSION_SECS, remote.is_some());
    Ok(([(header::SET_COOKIE, cookie)], Json(json!({ "ok": true }))).into_response())
}

async fn logout(State(app): State<Arc<App>>, remote: Option<Extension<Remote>>, headers: HeaderMap) -> Res<Response> {
    if let Some(t) = auth::cookie_token(&headers) {
        let h = crypto::sha256_hex(&t);
        app.db.with(|c| c.execute("DELETE FROM sessions WHERE token_hash = ?1", [h]))?;
    }
    Ok(([(header::SET_COOKIE, auth::session_cookie(&app, "", 0, remote.is_some()))], Json(json!({ "ok": true }))).into_response())
}

async fn me(State(app): State<Arc<App>>, remote: Option<Extension<Remote>>, user: User) -> Res<Json<Value>> {
    let lang: String = app.db.with(|c| c.query_row("SELECT lang FROM users WHERE id = ?1", [user.id], |r| r.get(0)))?;
    Ok(Json(json!({
        "id": user.id, "username": user.username, "admin": user.admin, "lang": lang,
        "host": app.cfg.host, "version": env!("CARGO_PKG_VERSION"),
        "public_url": app.cfg.public_url, "remote": remote.map(|Extension(Remote(ip))| ip.to_string()),
        // earlier versions come from the backup
        "versions": db::get_setting(&app.db, "backup")?.is_some(),
    })))
}

/// UI languages (static/i18n.js has the texts); "" goes back to the browser's.
pub const LANGS: &[&str] = &["en", "cs", "sk", "hu", "fr"];

#[derive(Deserialize)]
struct LangReq {
    lang: String,
}

async fn set_lang(State(app): State<Arc<App>>, user: User, Json(req): Json<LangReq>) -> Res<Json<Value>> {
    if !req.lang.is_empty() && !LANGS.contains(&req.lang.as_str()) {
        return Err(AppError::bad("unknown language"));
    }
    app.db.with(|c| c.execute("UPDATE users SET lang = ?1 WHERE id = ?2", params![req.lang, user.id]))?;
    Ok(Json(json!({ "lang": req.lang })))
}

#[derive(Deserialize)]
struct PasswordReq {
    old: String,
    new: String,
}

async fn password(State(app): State<Arc<App>>, user: User, headers: HeaderMap, Json(req): Json<PasswordReq>) -> Res<Json<Value>> {
    auth::check_password_rules(&req.new)?;
    let hash: String = app.db.with(|c| c.query_row("SELECT pw_hash FROM users WHERE id = ?1", [user.id], |r| r.get(0)))?;
    let old = req.old;
    if !tokio::task::spawn_blocking(move || auth::verify_password(&old, &hash)).await.unwrap_or(false) {
        return Err(AppError::bad("current password is wrong"));
    }
    let new_hash = tokio::task::spawn_blocking(move || auth::hash_password(&req.new)).await.map_err(AppError::internal)?;
    let keep = auth::cookie_token(&headers).map(|t| crypto::sha256_hex(&t)).unwrap_or_default();
    app.db.with(|c| {
        c.execute("UPDATE users SET pw_hash = ?1 WHERE id = ?2", params![new_hash, user.id])?;
        // other devices have to log in again, and so do the programs signed in to
        c.execute("DELETE FROM sessions WHERE user_id = ?1 AND token_hash != ?2", params![user.id, keep])?;
        c.execute("DELETE FROM oidc_tokens WHERE user_id = ?1", [user.id])
    })?;
    Ok(Json(json!({ "ok": true })))
}

async fn usernames(State(app): State<Arc<App>>, _user: User) -> Res<Json<Value>> {
    let names = app.db.with(|c| {
        let mut st = c.prepare("SELECT username FROM users WHERE disabled = 0 ORDER BY username")?;
        let v = st.query_map([], |r| r.get::<_, String>(0))?.collect::<rusqlite::Result<Vec<_>>>();
        v
    })?;
    Ok(Json(json!(names)))
}

async fn list(State(app): State<Arc<App>>, _a: Admin) -> Res<Json<Value>> {
    let users = app.db.with(|c| {
        let mut st = c.prepare("SELECT id, username, is_admin, disabled, created, remote_cidrs, quota FROM users ORDER BY username")?;
        let v = st.query_map([], user_json)?.collect::<rusqlite::Result<Vec<_>>>();
        v
    })?;
    // how full the homes with a limit are
    let mut users = users;
    for u in users.iter_mut().filter(|u| u["quota"].is_number()) {
        if let Some(id) = u["id"].as_i64() {
            u["used"] = json!(app.quotas.used(&app, id).await.ok());
        }
    }
    Ok(Json(json!(users)))
}

#[derive(Deserialize)]
struct CreateReq {
    username: String,
    password: String,
    #[serde(default)]
    admin: bool,
}

async fn create(State(app): State<Arc<App>>, Admin(a): Admin, Json(req): Json<CreateReq>) -> Res<Json<Value>> {
    let name = req.username.trim().to_lowercase();
    let id = tokio::task::block_in_place(|| create_user(&app, &name, &req.password, req.admin))?;
    tracing::info!("{} created user {name} (admin: {})", a.username, req.admin);
    Ok(Json(json!({ "id": id })))
}

#[derive(Deserialize)]
struct UpdateReq {
    admin: Option<bool>,
    disabled: Option<bool>,
    password: Option<String>,
    /// networks (CIDR, AS numbers) for outside access, `""`: none
    remote: Option<String>,
    /// room in the home, as `quota::parse` takes it; `""`: no limit
    quota: Option<String>,
}

async fn update(State(app): State<Arc<App>>, Admin(a): Admin, Path(id): Path<i64>, Json(req): Json<UpdateReq>) -> Res<Json<Value>> {
    if id == a.id && (req.admin == Some(false) || req.disabled == Some(true)) {
        return Err(AppError::bad("you cannot demote or disable yourself"));
    }
    let hash = match req.password {
        Some(pw) => {
            auth::check_password_rules(&pw)?;
            Some(tokio::task::spawn_blocking(move || auth::hash_password(&pw)).await.map_err(AppError::internal)?)
        }
        None => None,
    };
    let remote = req.remote.as_deref().map(edge::normalize).transpose().map_err(AppError::bad)?;
    let quota = req.quota.as_deref().map(quota::parse).transpose()?;
    let n = app.db.with(|c| {
        let mut n = 0;
        if let Some(v) = req.admin {
            n += c.execute("UPDATE users SET is_admin = ?1 WHERE id = ?2", params![v, id])?;
        }
        if let Some(v) = req.disabled {
            n += c.execute("UPDATE users SET disabled = ?1 WHERE id = ?2", params![v, id])?;
            if v {
                c.execute("DELETE FROM sessions WHERE user_id = ?1", [id])?;
                c.execute("DELETE FROM oidc_tokens WHERE user_id = ?1", [id])?;
            }
        }
        if let Some(h) = &hash {
            n += c.execute("UPDATE users SET pw_hash = ?1 WHERE id = ?2", params![h, id])?;
            c.execute("DELETE FROM sessions WHERE user_id = ?1", [id])?;
            c.execute("DELETE FROM oidc_tokens WHERE user_id = ?1", [id])?;
        }
        if let Some(r) = &remote {
            n += c.execute("UPDATE users SET remote_cidrs = ?1 WHERE id = ?2", params![r, id])?;
        }
        if let Some(q) = quota {
            n += c.execute("UPDATE users SET quota = ?1 WHERE id = ?2", params![q.map(|q| q as i64), id])?;
        }
        Ok(n)
    })?;
    if n == 0 {
        return Err(AppError::not_found());
    }
    if let Some(q) = quota {
        tracing::info!("{} set the storage limit of user {id} to {}", a.username, q.map_or("none".into(), |q| format!("{q} bytes")));
    }
    let mut note = None;
    if let Some(r) = &remote {
        tracing::info!("{} set outside access of user {id} to {:?}", a.username, r);
        note = asn_note(&app, r).await;
    }
    Ok(Json(json!({ "ok": true, "note": note })))
}

/// Fetches the networks of the AS numbers in a new list right away, so a
/// typo shows up now rather than as a refused login later.
async fn asn_note(app: &App, list: &str) -> Option<String> {
    let asns = edge::asns_in(list);
    if asns.is_empty() {
        return None;
    }
    let got = app.asns.refresh(&app.db, &asns, true).await;
    let parts: Vec<String> = got
        .into_iter()
        .map(|(n, r)| match r {
            Ok(k) => format!("AS{n}: {k} networks"),
            Err(e) => format!("AS{n}: not fetched ({e}); retried hourly"),
        })
        .collect();
    Some(parts.join("\n"))
}

/// Deletes the account with its sessions, mounts, shares and links. The files
/// are kept: they move to `<data>/deleted/<name>-<time>`.
async fn remove(State(app): State<Arc<App>>, Admin(a): Admin, Path(id): Path<i64>) -> Res<Json<Value>> {
    if id == a.id {
        return Err(AppError::bad("you cannot delete yourself"));
    }
    let (name, mounts) = app
        .db
        .opt(|c| {
            let name: String = c.query_row("SELECT username FROM users WHERE id = ?1", [id], |r| r.get(0))?;
            let mut st = c.prepare("SELECT id FROM mounts WHERE user_id = ?1")?;
            let mounts = st.query_map([id], |r| r.get::<_, i64>(0))?.collect::<rusqlite::Result<Vec<_>>>()?;
            c.execute("DELETE FROM users WHERE id = ?1", [id])?;
            Ok((name, mounts))
        })?
        .ok_or_else(AppError::not_found)?;
    for m in mounts {
        app.sftp.forget(m);
    }
    let kept = app.cfg.data.join("deleted").join(format!("{name}-{}", now()));
    let moved = std::fs::rename(app.user_root(&name), &kept).is_ok();
    tracing::info!("{} deleted user {name}; files {}", a.username, if moved { kept.display().to_string() } else { "none".into() });
    Ok(Json(json!({ "ok": true, "files_kept_at": moved.then(|| kept.display().to_string()) })))
}

/// `shelf user add|passwd|remote|limit|list …` for the first admin and for lockouts.
pub fn cli(app: &App, args: &[String]) -> anyhow::Result<()> {
    let flag = |f: &str| args.iter().any(|a| a == f);
    let read_pw = || -> anyhow::Result<String> {
        if flag("--random") {
            let pw = crypto::random_token(12);
            println!("{pw}");
            return Ok(pw);
        }
        eprintln!("password (one line on stdin):");
        let mut s = String::new();
        std::io::stdin().lock().read_line(&mut s)?;
        Ok(s.trim_end_matches(['\r', '\n']).to_string())
    };
    let e = |e: AppError| anyhow::anyhow!(e.msg);
    match (args.first().map(String::as_str), args.get(1)) {
        (Some("add"), Some(name)) => {
            let pw = read_pw()?;
            create_user(app, name, &pw, flag("--admin")).map_err(e)?;
            eprintln!("created {name}{}", if flag("--admin") { " (admin)" } else { "" });
        }
        (Some("passwd"), Some(name)) => {
            let pw = read_pw()?;
            auth::check_password_rules(&pw).map_err(e)?;
            let h = auth::hash_password(&pw);
            let n = app.db.with(|c| c.execute("UPDATE users SET pw_hash = ?1, disabled = 0 WHERE username = ?2", params![h, name])).map_err(e)?;
            anyhow::ensure!(n == 1, "no user {name}");
            eprintln!("password of {name} set");
        }
        (Some("remote"), Some(name)) => {
            let list = edge::normalize(&args[2..].join(" ")).map_err(|m| anyhow::anyhow!(m))?;
            let n = app.db.with(|c| c.execute("UPDATE users SET remote_cidrs = ?1 WHERE username = ?2", params![list, name])).map_err(e)?;
            anyhow::ensure!(n == 1, "no user {name}");
            eprintln!("{name} from outside: {}", if list.is_empty() { "not allowed" } else { &list });
            let rt = tokio::runtime::Builder::new_current_thread().enable_all().build()?;
            if let Some(note) = rt.block_on(asn_note(app, &list)) {
                eprintln!("{note}");
            }
        }
        (Some("limit"), Some(name)) => {
            let q = quota::parse(args.get(2).map_or("", String::as_str)).map_err(e)?;
            let n = app.db.with(|c| c.execute("UPDATE users SET quota = ?1 WHERE username = ?2", params![q.map(|q| q as i64), name])).map_err(e)?;
            anyhow::ensure!(n == 1, "no user {name}");
            eprintln!("{name}: {}", q.map_or("no storage limit".into(), |q| format!("storage limit {q} bytes")));
        }
        (Some("list"), _) => {
            app.db
                .with(|c| {
                    let mut st = c.prepare("SELECT id, username, is_admin, disabled, created, remote_cidrs, quota FROM users ORDER BY username")?;
                    for u in st.query_map([], user_json)? {
                        println!("{}", u?);
                    }
                    Ok(())
                })
                .map_err(e)?;
        }
        _ => anyhow::bail!("usage: shelf user add <name> [--admin] [--random] | passwd <name> [--random] | remote <name> [cidr|AS<n> …] | limit <name> [50G|1.5T|…] | list"),
    }
    Ok(())
}
