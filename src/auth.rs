use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};

use argon2::{
    password_hash::{rand_core::OsRng, PasswordHash, PasswordHasher, PasswordVerifier, SaltString},
    Argon2,
};
use axum::{
    extract::FromRequestParts,
    http::{header, request::Parts, HeaderMap, StatusCode},
};
use rusqlite::params;

use crate::{
    crypto,
    db::now,
    edge::{self, Remote},
    error::{AppError, Res},
    App,
};

pub const COOKIE: &str = "shelf";
pub const SESSION_SECS: i64 = 30 * 86400;

#[derive(Clone, Debug)]
pub struct User {
    pub id: i64,
    pub username: String,
    pub admin: bool,
    /// networks and AS numbers the account may be used from through the edge (`edge::normalize`)
    pub cidrs: String,
}

/// A logged-in user who is also an admin.
pub struct Admin(pub User);

pub fn hash_password(pw: &str) -> String {
    let salt = SaltString::generate(&mut OsRng);
    Argon2::default().hash_password(pw.as_bytes(), &salt).expect("argon2").to_string()
}

pub fn verify_password(pw: &str, hash: &str) -> bool {
    PasswordHash::new(hash).is_ok_and(|h| Argon2::default().verify_password(pw.as_bytes(), &h).is_ok())
}

pub fn check_password_rules(pw: &str) -> Res<()> {
    if pw.chars().count() < 8 {
        return Err(AppError::bad("password needs at least 8 characters"));
    }
    Ok(())
}

pub fn cookie_token(headers: &HeaderMap) -> Option<String> {
    headers
        .get_all(header::COOKIE)
        .iter()
        .filter_map(|v| v.to_str().ok())
        .flat_map(|v| v.split(';'))
        .find_map(|kv| {
            let (k, v) = kv.trim().split_once('=')?;
            (k == COOKIE && !v.is_empty()).then(|| v.to_string())
        })
}

pub fn session_user(app: &App, token: &str) -> Res<Option<User>> {
    let h = crypto::sha256_hex(token);
    let t = now();
    app.db.opt(|c| {
        let (user, last): (User, i64) = c.query_row(
            "SELECT u.id, u.username, u.is_admin, u.remote_cidrs, s.last_seen FROM sessions s JOIN users u ON u.id = s.user_id
             WHERE s.token_hash = ?1 AND s.expires > ?2 AND u.disabled = 0",
            params![h, t],
            |r| Ok((User { id: r.get(0)?, username: r.get(1)?, admin: r.get(2)?, cidrs: r.get(3)? }, r.get(4)?)),
        )?;
        // sliding expiry, written at most every 10 minutes
        if t - last > 600 {
            c.execute(
                "UPDATE sessions SET last_seen = ?1, expires = ?2 WHERE token_hash = ?3",
                params![t, t + SESSION_SECS, h],
            )?;
        }
        Ok(user)
    })
}

pub fn new_session(app: &App, user_id: i64) -> Res<String> {
    let token = crypto::random_token(32);
    let t = now();
    app.db.with(|c| {
        c.execute(
            "INSERT INTO sessions (token_hash, user_id, created, last_seen, expires) VALUES (?1, ?2, ?3, ?3, ?4)",
            params![crypto::sha256_hex(&token), user_id, t, t + SESSION_SECS],
        )
    })?;
    Ok(token)
}

/// `remote`: the request came through the edge, which is https only
pub fn session_cookie(app: &App, token: &str, max_age: i64, remote: bool) -> String {
    let secure = if app.cfg.secure_cookie || remote { "; Secure" } else { "" };
    format!("{COOKIE}={token}; Path=/; HttpOnly; SameSite=Lax; Max-Age={max_age}{secure}")
}

impl FromRequestParts<Arc<App>> for User {
    type Rejection = AppError;

    async fn from_request_parts(parts: &mut Parts, app: &Arc<App>) -> Result<Self, Self::Rejection> {
        let token = cookie_token(&parts.headers).ok_or_else(AppError::unauthorized)?;
        let user = session_user(app, &token)?.ok_or_else(AppError::unauthorized)?;
        if let Some(Remote(ip)) = parts.extensions.get::<Remote>() {
            if !edge::allowed(app, &user.cidrs, *ip) {
                return Err(AppError::new(StatusCode::FORBIDDEN, format!("{} cannot be used from {ip}", user.username)));
            }
        }
        Ok(user)
    }
}

impl FromRequestParts<Arc<App>> for Admin {
    type Rejection = AppError;

    async fn from_request_parts(parts: &mut Parts, app: &Arc<App>) -> Result<Self, Self::Rejection> {
        let u = User::from_request_parts(parts, app).await?;
        if !u.admin {
            return Err(AppError::forbidden());
        }
        Ok(Admin(u))
    }
}

/// Failed logins per username: 10 within 15 minutes and that name is locked
/// until the window has passed.
#[derive(Default)]
pub struct Limiter(Mutex<HashMap<String, (u32, Instant)>>);

const WINDOW: Duration = Duration::from_secs(15 * 60);
const MAX_FAILS: u32 = 10;

impl Limiter {
    pub fn allowed(&self, key: &str) -> bool {
        let mut m = self.0.lock().unwrap();
        match m.get(key) {
            Some((_, since)) if since.elapsed() > WINDOW => {
                m.remove(key);
                true
            }
            Some((n, _)) => *n < MAX_FAILS,
            None => true,
        }
    }

    pub fn fail(&self, key: &str) {
        let mut m = self.0.lock().unwrap();
        let e = m.entry(key.to_string()).or_insert((0, Instant::now()));
        if e.1.elapsed() > WINDOW {
            *e = (0, Instant::now());
        }
        e.0 += 1;
    }

    pub fn clear(&self, key: &str) {
        self.0.lock().unwrap().remove(key);
    }
}
