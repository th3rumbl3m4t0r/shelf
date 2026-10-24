//! OpenID Connect: other programs on the LAN let people log in with their
//! shelf account. An admin registers each program as a client (admin →
//! sign-in for other programs, or `shelf oidc add`); its name is its
//! client_id. Only the authorization code flow, with PKCE (S256, required for
//! public clients). ID tokens are RS256 JWTs, signed with a key made on first
//! start and kept sealed in settings (`oidc_key`), so the backup has it.
//! Access and refresh tokens are random; only their sha256 is kept
//! (`oidc_tokens`). Codes and sign-ins waiting for a login live in memory.
//! There is no consent page: the clients are the admin's own. On only with
//! `SHELF_OIDC_ISSUER`, and only on the LAN listener. docs/OIDC.md is for the
//! people setting up a client.

use std::{
    collections::HashMap,
    sync::{Arc, Mutex, OnceLock},
};

use anyhow::Context;
use axum::{
    extract::{Extension, Path, Query, State},
    http::{header, HeaderMap, HeaderValue, StatusCode},
    response::{IntoResponse, Redirect, Response},
    routing::{get, patch, post},
    Form, Json, Router,
};
use base64::{engine::general_purpose::STANDARD as B64, engine::general_purpose::URL_SAFE_NO_PAD as B64URL, Engine};
use percent_encoding::{percent_decode_str, utf8_percent_encode, AsciiSet, NON_ALPHANUMERIC};
use rusqlite::params;
use serde::Deserialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

use crate::{
    auth::{self, Admin, User},
    crypto,
    db::{self, now},
    edge::{self, Remote},
    error::{AppError, Res},
    users, App,
};

/// a code is exchanged for tokens within this, seconds
const CODE_SECS: i64 = 60;
/// a sign-in waits this long for its login
const PENDING_SECS: i64 = 600;
const ACCESS_SECS: i64 = 3600;
const REFRESH_SECS: i64 = 30 * 86400;
/// sign-ins and codes held at once; past this, new ones are refused
const MAX_HELD: usize = 10_000;
/// the scopes understood here; others asked for are left out of the grant
const SCOPES: &[&str] = &["openid", "profile", "offline_access"];

pub fn routes() -> Router<Arc<App>> {
    Router::new()
        .route("/.well-known/openid-configuration", get(discovery))
        .route("/oidc/jwks", get(jwks))
        .route("/oidc/authorize", get(authorize_get).post(authorize_post))
        .route("/oidc/resume/{id}", get(resume))
        .route("/oidc/token", post(token))
        .route("/oidc/userinfo", get(userinfo).post(userinfo))
        .route("/api/oidc/clients", get(list_clients).post(create_client))
        .route("/api/oidc/clients/{id}", patch(update_client).delete(delete_client))
        .route("/api/oidc/clients/{id}/secret", post(new_secret))
}

/// The signing key, and what is held in memory between the steps of a sign-in.
#[derive(Default)]
pub struct Oidc {
    key: OnceLock<Signer>,
    /// sign-ins waiting for a login, by id
    pending: Mutex<HashMap<String, Pending>>,
    /// codes handed to clients, kept until they expire so a second use shows
    codes: Mutex<HashMap<String, Code>>,
}

struct Pending {
    client: i64,
    req: AuthReq,
    since: i64,
    /// prompt=login or max_age: only a login after `since` will do
    relogin: bool,
}

#[derive(Clone)]
struct Code {
    client: i64,
    user: i64,
    redirect_uri: String,
    scope: String,
    nonce: Option<String>,
    challenge: Option<String>,
    auth_time: i64,
    /// the login these tokens come from, refreshes included
    grant: String,
    expires: i64,
    used: bool,
}

impl Oidc {
    fn signer(&self, app: &App) -> Res<&Signer> {
        if let Some(s) = self.key.get() {
            return Ok(s);
        }
        let s = load_key(app).map_err(AppError::internal)?;
        Ok(self.key.get_or_init(|| s))
    }
}

/// At start: the issuer is checked and the key loaded (made the first time).
pub fn ready(app: &App) -> anyhow::Result<()> {
    let Some(iss) = &app.cfg.oidc_issuer else { return Ok(()) };
    let rest = iss.strip_prefix("https://").or_else(|| iss.strip_prefix("http://"));
    anyhow::ensure!(
        rest.is_some_and(|r| !r.is_empty() && !r.contains(['/', '?', '#'])),
        "SHELF_OIDC_ISSUER must be http(s)://host[:port], without a path"
    );
    let kid = &app.oidc.signer(app).map_err(|e| anyhow::anyhow!(e.msg))?.kid;
    tracing::info!("sign-in for other programs (OpenID Connect) as {iss}, key {kid}");
    Ok(())
}

/// The issuer, when sign-in is on and the request came in on the LAN.
fn issuer<'a>(app: &'a App, remote: &Option<Extension<Remote>>) -> Res<&'a str> {
    match (&app.cfg.oidc_issuer, remote) {
        (Some(iss), None) => Ok(iss),
        _ => Err(AppError::not_found()),
    }
}

/* ---- the signing key ---- */

struct Signer {
    pair: ring::signature::RsaKeyPair,
    kid: String,
    jwk: Value,
}

impl Signer {
    fn from_der(der: &[u8]) -> anyhow::Result<Self> {
        use rsa::{pkcs8::DecodePrivateKey, traits::PublicKeyParts};
        let k = rsa::RsaPrivateKey::from_pkcs8_der(der)?;
        let (n, e) = (B64URL.encode(k.n().to_bytes_be()), B64URL.encode(k.e().to_bytes_be()));
        // the RFC 7638 thumbprint: the required members, in order, no spaces
        let kid = B64URL.encode(Sha256::digest(format!(r#"{{"e":"{e}","kty":"RSA","n":"{n}"}}"#)));
        let pair = ring::signature::RsaKeyPair::from_pkcs8(der).map_err(|e| anyhow::anyhow!("signing key: {e}"))?;
        Ok(Signer { jwk: json!({ "kty": "RSA", "use": "sig", "alg": "RS256", "kid": kid, "n": n, "e": e }), kid, pair })
    }

    fn sign(&self, claims: &Value) -> Res<String> {
        let head = B64URL.encode(json!({ "alg": "RS256", "typ": "JWT", "kid": self.kid }).to_string());
        let input = format!("{head}.{}", B64URL.encode(claims.to_string()));
        let mut sig = vec![0; self.pair.public().modulus_len()];
        self.pair
            .sign(&ring::signature::RSA_PKCS1_SHA256, &ring::rand::SystemRandom::new(), input.as_bytes(), &mut sig)
            .map_err(|_| AppError::internal("oidc: signing failed"))?;
        Ok(format!("{input}.{}", B64URL.encode(sig)))
    }
}

/// Sealed with secret.key in settings. Made on first use; when two make one
/// at once, the first stored wins and both use that.
fn load_key(app: &App) -> anyhow::Result<Signer> {
    let get = || db::get_setting(&app.db, "oidc_key").map_err(|e| anyhow::anyhow!(e.msg));
    if get()?.is_none() {
        use rsa::pkcs8::EncodePrivateKey;
        let der = rsa::RsaPrivateKey::new(&mut rand::rngs::OsRng, 2048)?.to_pkcs8_der()?;
        let sealed = app.key.seal(der.as_bytes());
        app.db
            .with(|c| c.execute("INSERT INTO settings (key, value) VALUES ('oidc_key', ?1) ON CONFLICT(key) DO NOTHING", [sealed]))
            .map_err(|e| anyhow::anyhow!(e.msg))?;
    }
    let der = app.key.open(&get()?.context("oidc_key missing")?).context("oidc_key does not open with secret.key")?;
    Signer::from_der(&der)
}

/* ---- clients ---- */

#[derive(Clone)]
struct Client {
    id: i64,
    name: String,
    /// None: a public client (an app that cannot keep a secret), PKCE only
    secret_hash: Option<String>,
    redirect_uris: Vec<String>,
    /// who may sign in; empty: everyone
    users: Vec<String>,
}

impl Client {
    fn lets_in(&self, username: &str) -> bool {
        self.users.is_empty() || self.users.iter().any(|u| u == username)
    }
}

fn client_where(app: &App, cond: &str, v: &dyn rusqlite::ToSql) -> Res<Option<Client>> {
    app.db.opt(|c| {
        c.query_row(&format!("SELECT id, name, secret_hash, redirect_uris, users FROM oidc_clients WHERE {cond} = ?1"), [v], |r| {
            Ok(Client {
                id: r.get(0)?,
                name: r.get(1)?,
                secret_hash: r.get(2)?,
                redirect_uris: r.get::<_, String>(3)?.lines().map(str::to_string).collect(),
                users: r.get::<_, String>(4)?.split_whitespace().map(str::to_string).collect(),
            })
        })
    })
}

/// One per line (or space separated): absolute, ASCII without spaces, no
/// fragment (RFC 6749 §3.1.2). Custom schemes are for apps on phones.
fn redirect_uris(s: &str) -> Res<String> {
    let list: Vec<&str> = s.split_whitespace().collect();
    if list.is_empty() {
        return Err(AppError::bad("at least one redirect URI is needed"));
    }
    for u in &list {
        let ok = u.len() <= 1000
            && u.bytes().all(|b| b.is_ascii_graphic())
            && !u.contains('#')
            && u.split_once(':').is_some_and(|(scheme, rest)| {
                let web = scheme == "http" || scheme == "https";
                scheme.bytes().next().is_some_and(|b| b.is_ascii_lowercase())
                    && scheme.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b"+.-".contains(&b))
                    && if web { rest.len() > 2 && rest.starts_with("//") } else { !rest.is_empty() }
            });
        if !ok {
            return Err(AppError::bad(format!("not a redirect URI: {u}")));
        }
    }
    Ok(list.join("\n"))
}

/// Usernames, comma or space separated, each of an existing account. Empty: everyone.
fn allowed_users(app: &App, s: &str) -> Res<String> {
    let mut names: Vec<String> = Vec::new();
    for n in s.split([',', ' ', '\n']).map(|n| n.trim().to_lowercase()).filter(|n| !n.is_empty()) {
        if app.db.opt(|c| c.query_row("SELECT 1 FROM users WHERE username = ?1", [&n], |_| Ok(())))?.is_none() {
            return Err(AppError::bad(format!("no user {n}")));
        }
        if !names.contains(&n) {
            names.push(n);
        }
    }
    Ok(names.join(" "))
}

/// For the admin page and `shelf oidc add`; the secret is returned only here.
fn add_client(app: &App, name: &str, uris: &str, who: &str, public: bool) -> Res<(i64, Option<String>)> {
    if !users::valid_username(name) {
        return Err(AppError::bad("name: 1-32 of a-z 0-9 . _ -, starting with a letter or digit"));
    }
    let uris = redirect_uris(uris)?;
    let who = allowed_users(app, who)?;
    if client_where(app, "name", &name)?.is_some() {
        return Err(AppError::conflict("a program with that name exists"));
    }
    let secret = (!public).then(|| crypto::random_token(32));
    let id = app.db.with(|c| {
        c.execute(
            "INSERT INTO oidc_clients (name, secret_hash, redirect_uris, users, created) VALUES (?1, ?2, ?3, ?4, ?5)",
            params![name, secret.as_deref().map(crypto::sha256_hex), uris, who, now()],
        )?;
        Ok(c.last_insert_rowid())
    })?;
    Ok((id, secret))
}

fn clients_json(app: &App) -> Res<Vec<Value>> {
    app.db.with(|c| {
        let mut st = c.prepare(
            "SELECT id, name, secret_hash IS NULL, redirect_uris, users, created, last_used,
                    (SELECT COUNT(DISTINCT user_id) FROM oidc_tokens t WHERE t.client_id = oidc_clients.id AND t.kind = 'refresh' AND t.expires > ?1)
             FROM oidc_clients ORDER BY name",
        )?;
        let v = st
            .query_map([now()], |r| {
                Ok(json!({
                    "id": r.get::<_, i64>(0)?, "name": r.get::<_, String>(1)?, "public": r.get::<_, bool>(2)?,
                    "redirect_uris": r.get::<_, String>(3)?.lines().map(str::to_string).collect::<Vec<_>>(),
                    "users": r.get::<_, String>(4)?, "created": r.get::<_, i64>(5)?,
                    "last_used": r.get::<_, Option<i64>>(6)?, "signed_in": r.get::<_, i64>(7)?,
                }))
            })?
            .collect::<rusqlite::Result<Vec<_>>>();
        v
    })
}

/* ---- people ---- */

/// The logged-in user of a request and when they logged in.
fn session(app: &App, headers: &HeaderMap) -> Res<Option<(User, i64)>> {
    let Some(token) = auth::cookie_token(headers) else { return Ok(None) };
    let Some(user) = auth::session_user(app, &token)? else { return Ok(None) };
    let h = crypto::sha256_hex(&token);
    let at = app.db.opt(|c| c.query_row("SELECT created FROM sessions WHERE token_hash = ?1", [h], |r| r.get(0)))?;
    Ok(at.map(|at| (user, at)))
}

fn user_by_id(app: &App, id: i64) -> Res<Option<User>> {
    app.db.opt(|c| {
        c.query_row("SELECT id, username, is_admin, remote_cidrs FROM users WHERE id = ?1 AND disabled = 0", [id], |r| {
            Ok(User { id: r.get(0)?, username: r.get(1)?, admin: r.get(2)?, cidrs: r.get(3)? })
        })
    })
}

/// The account's subject in tokens: random and never reused, as ids and
/// names can be. Made when first needed.
fn sub(app: &App, user: i64) -> Res<String> {
    app.db.with(|c| {
        c.execute("UPDATE users SET sub = ?1 WHERE id = ?2 AND sub IS NULL", params![crypto::random_token(16), user])?;
        c.query_row("SELECT sub FROM users WHERE id = ?1", [user], |r| r.get(0))
    })
}

fn profile(claims: &mut Value, user: &User) {
    claims["preferred_username"] = json!(user.username);
    claims["name"] = json!(user.username);
}

/* ---- discovery ---- */

/// Cacheable, and readable from pages on other origins.
fn public_json(v: Value) -> Response {
    ([(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*"), (header::CACHE_CONTROL, "public, max-age=300")], Json(v)).into_response()
}

async fn discovery(State(app): State<Arc<App>>, remote: Option<Extension<Remote>>) -> Res<Response> {
    let iss = issuer(&app, &remote)?;
    Ok(public_json(json!({
        "issuer": iss,
        "authorization_endpoint": format!("{iss}/oidc/authorize"),
        "token_endpoint": format!("{iss}/oidc/token"),
        "userinfo_endpoint": format!("{iss}/oidc/userinfo"),
        "jwks_uri": format!("{iss}/oidc/jwks"),
        "scopes_supported": SCOPES,
        "response_types_supported": ["code"],
        "response_modes_supported": ["query"],
        "grant_types_supported": ["authorization_code", "refresh_token"],
        "subject_types_supported": ["public"],
        "id_token_signing_alg_values_supported": ["RS256"],
        "token_endpoint_auth_methods_supported": ["client_secret_basic", "client_secret_post", "none"],
        "code_challenge_methods_supported": ["S256"],
        "claims_supported": ["iss", "sub", "aud", "azp", "exp", "iat", "auth_time", "nonce", "at_hash", "preferred_username", "name"],
        "prompt_values_supported": ["none", "login"],
        "authorization_response_iss_parameter_supported": true,
        "claims_parameter_supported": false,
        "request_parameter_supported": false,
        "request_uri_parameter_supported": false,
    })))
}

async fn jwks(State(app): State<Arc<App>>, remote: Option<Extension<Remote>>) -> Res<Response> {
    issuer(&app, &remote)?;
    Ok(public_json(json!({ "keys": [app.oidc.signer(&app)?.jwk] })))
}

/* ---- authorization endpoint ---- */

#[derive(Deserialize, Clone, Default)]
struct AuthReq {
    response_type: Option<String>,
    client_id: Option<String>,
    redirect_uri: Option<String>,
    scope: Option<String>,
    state: Option<String>,
    nonce: Option<String>,
    code_challenge: Option<String>,
    code_challenge_method: Option<String>,
    prompt: Option<String>,
    max_age: Option<String>,
    response_mode: Option<String>,
    request: Option<String>,
    request_uri: Option<String>,
}

/// Everything but the unreserved characters (RFC 3986 §2.3), so a state
/// like `a-b_c` comes back as it went.
const QUERY: &AsciiSet = &NON_ALPHANUMERIC.remove(b'-').remove(b'.').remove(b'_').remove(b'~');

fn enc(s: &str) -> String {
    utf8_percent_encode(s, QUERY).to_string()
}

/// `uri` with the answer, the client's state and our issuer (RFC 9207) added.
fn back_url(uri: &str, kv: &[(&str, &str)], state: Option<&str>, iss: &str) -> String {
    let mut u = uri.to_string();
    let mut sep = if u.contains('?') { '&' } else { '?' };
    for (k, v) in kv.iter().copied().chain(state.map(|s| ("state", s))).chain([("iss", iss)]) {
        u.push(sep);
        u.push_str(k);
        u.push('=');
        u.push_str(&enc(v));
        sep = '&';
    }
    u
}

fn back(uri: &str, kv: &[(&str, &str)], state: Option<&str>, iss: &str) -> Response {
    ([(header::CACHE_CONTROL, "no-store")], Redirect::to(&back_url(uri, kv, state, iss))).into_response()
}

/// When the client or its redirect_uri do not check out, the answer cannot go
/// back to the client: the browser shows it.
fn error_page(msg: &str) -> Response {
    (StatusCode::BAD_REQUEST, [(header::CONTENT_TYPE, "text/plain; charset=utf-8")], format!("shelf sign-in: {msg}\n")).into_response()
}

/// The SPA's login page, which comes back to `/oidc/resume/<id>`.
fn to_login(id: &str, client: &Client) -> Response {
    let next = format!("/oidc/resume/{id}");
    ([(header::CACHE_CONTROL, "no-store")], Redirect::to(&format!("/login?next={}&to={}", enc(&next), enc(&client.name)))).into_response()
}

fn pkce_ok(s: &str) -> bool {
    (43..=128).contains(&s.len()) && s.bytes().all(|b| b.is_ascii_alphanumeric() || b"-._~".contains(&b))
}

fn grant_scope(asked: &str) -> String {
    let mut v: Vec<&str> = Vec::new();
    for s in asked.split_whitespace().filter(|s| SCOPES.contains(s)) {
        if !v.contains(&s) {
            v.push(s);
        }
    }
    v.join(" ")
}

fn has_scope(scope: &str, s: &str) -> bool {
    scope.split(' ').any(|x| x == s)
}

/// Keeps `v` under a new random id, after dropping what is no longer `alive`.
fn hold<T>(map: &Mutex<HashMap<String, T>>, v: T, alive: impl Fn(&T) -> bool) -> Option<String> {
    let mut m = map.lock().unwrap_or_else(|e| e.into_inner());
    m.retain(|_, x| alive(x));
    if m.len() >= MAX_HELD {
        return None;
    }
    let id = crypto::random_token(32);
    m.insert(id.clone(), v);
    Some(id)
}

async fn authorize_get(State(app): State<Arc<App>>, remote: Option<Extension<Remote>>, headers: HeaderMap, Query(req): Query<AuthReq>) -> Response {
    authorize(&app, remote, &headers, req)
}

async fn authorize_post(State(app): State<Arc<App>>, remote: Option<Extension<Remote>>, headers: HeaderMap, Form(req): Form<AuthReq>) -> Response {
    authorize(&app, remote, &headers, req)
}

fn authorize(app: &App, remote: Option<Extension<Remote>>, headers: &HeaderMap, req: AuthReq) -> Response {
    let iss = match issuer(app, &remote) {
        Ok(i) => i,
        Err(e) => return e.into_response(),
    };
    let client = match client_where(app, "name", &req.client_id.as_deref().unwrap_or("")) {
        Ok(Some(c)) => c,
        Ok(None) => return error_page("no program with this client_id"),
        Err(e) => return e.into_response(),
    };
    let Some(uri) = req.redirect_uri.clone().filter(|u| client.redirect_uris.contains(u)) else {
        return error_page(&format!("the redirect_uri is not one registered for {}", client.name));
    };
    let fail = |code: &str, desc: &str| back(&uri, &[("error", code), ("error_description", desc)], req.state.as_deref(), iss);
    if req.request.is_some() {
        return fail("request_not_supported", "request objects are not supported");
    }
    if req.request_uri.is_some() {
        return fail("request_uri_not_supported", "request_uri is not supported");
    }
    if req.response_type.as_deref() != Some("code") {
        return fail("unsupported_response_type", "only response_type=code");
    }
    if req.response_mode.as_deref().is_some_and(|m| m != "query") {
        return fail("invalid_request", "only response_mode=query");
    }
    if !req.scope.as_deref().unwrap_or("").split_whitespace().any(|s| s == "openid") {
        return fail("invalid_scope", "the scope must include openid");
    }
    // without a method, PKCE means "plain", which is not taken
    match (req.code_challenge.as_deref(), req.code_challenge_method.as_deref()) {
        (None, None) if client.secret_hash.is_some() => {}
        (None, None) => return fail("invalid_request", "a public client must use PKCE (code_challenge, S256)"),
        (Some(c), Some("S256")) if pkce_ok(c) => {}
        _ => return fail("invalid_request", "code_challenge: only S256"),
    }
    let prompt: Vec<&str> = req.prompt.as_deref().unwrap_or("").split_whitespace().collect();
    if prompt.contains(&"none") && prompt.len() > 1 {
        return fail("invalid_request", "prompt=none goes alone");
    }
    let max_age = match req.max_age.as_deref().map(str::parse::<i64>) {
        None => None,
        Some(Ok(m)) if m >= 0 => Some(m),
        _ => return fail("invalid_request", "max_age: seconds"),
    };
    let session = match session(app, headers) {
        Ok(s) => s,
        Err(e) => return e.into_response(),
    };
    let t = now();
    let relogin = prompt.contains(&"login") || matches!((max_age, &session), (Some(m), Some((_, at))) if t - at > m);
    match session {
        Some((user, at)) if !relogin => finish(app, iss, &client, &uri, &req, &user, at),
        _ if prompt.contains(&"none") => fail("login_required", "not logged in to shelf"),
        _ => {
            let p = Pending { client: client.id, req: req.clone(), since: t, relogin };
            match hold(&app.oidc.pending, p, |p| t - p.since < PENDING_SECS) {
                Some(id) => to_login(&id, &client),
                None => fail("temporarily_unavailable", "too many sign-ins at once"),
            }
        }
    }
}

/// After the login page: the sign-in goes on where it was left.
async fn resume(State(app): State<Arc<App>>, remote: Option<Extension<Remote>>, headers: HeaderMap, Path(id): Path<String>) -> Response {
    let iss = match issuer(&app, &remote) {
        Ok(i) => i,
        Err(e) => return e.into_response(),
    };
    let t = now();
    let held = {
        let m = app.oidc.pending.lock().unwrap_or_else(|e| e.into_inner());
        m.get(&id).filter(|p| t - p.since < PENDING_SECS).map(|p| (p.client, p.req.clone(), p.since, p.relogin))
    };
    let Some((cid, req, since, relogin)) = held else {
        return error_page("this sign-in is done or took too long; start again from the program");
    };
    let client = match client_where(&app, "id", &cid) {
        Ok(Some(c)) => c,
        Ok(None) => return error_page("the program was removed"),
        Err(e) => return e.into_response(),
    };
    let uri = req.redirect_uri.clone().unwrap_or_default();
    if !client.redirect_uris.contains(&uri) {
        return error_page(&format!("the redirect_uri is not one registered for {}", client.name));
    }
    match session(&app, &headers) {
        Ok(Some((user, at))) if !relogin || at >= since => {
            app.oidc.pending.lock().unwrap_or_else(|e| e.into_inner()).remove(&id);
            finish(&app, iss, &client, &uri, &req, &user, at)
        }
        Ok(_) => to_login(&id, &client),
        Err(e) => e.into_response(),
    }
}

/// A logged-in user goes back to the client with a code.
fn finish(app: &App, iss: &str, client: &Client, uri: &str, req: &AuthReq, user: &User, auth_time: i64) -> Response {
    let state = req.state.as_deref();
    if !client.lets_in(&user.username) {
        tracing::warn!("{} may not sign in to {}", user.username, client.name);
        let desc = format!("{} may not use {}", user.username, client.name);
        return back(uri, &[("error", "access_denied"), ("error_description", &desc)], state, iss);
    }
    let t = now();
    let code = Code {
        client: client.id,
        user: user.id,
        redirect_uri: uri.to_string(),
        scope: grant_scope(req.scope.as_deref().unwrap_or("")),
        nonce: req.nonce.clone(),
        challenge: req.code_challenge.clone(),
        auth_time,
        grant: crypto::random_token(16),
        expires: t + CODE_SECS,
        used: false,
    };
    let Some(code) = hold(&app.oidc.codes, code, |c| c.expires > t) else {
        return back(uri, &[("error", "temporarily_unavailable"), ("error_description", "too many sign-ins at once")], state, iss);
    };
    tracing::info!("{} signed in to {}", user.username, client.name);
    back(uri, &[("code", &code)], state, iss)
}

/* ---- token endpoint ---- */

#[derive(Deserialize)]
struct TokenReq {
    grant_type: Option<String>,
    code: Option<String>,
    redirect_uri: Option<String>,
    code_verifier: Option<String>,
    refresh_token: Option<String>,
    scope: Option<String>,
    client_id: Option<String>,
    client_secret: Option<String>,
}

/// An error as RFC 6749 §5.2 has it.
fn oauth_err(status: StatusCode, code: &str, desc: &str) -> Response {
    let mut r = (status, [(header::CACHE_CONTROL, "no-store")], Json(json!({ "error": code, "error_description": desc }))).into_response();
    if status == StatusCode::UNAUTHORIZED {
        r.headers_mut().insert(header::WWW_AUTHENTICATE, HeaderValue::from_static("Basic realm=\"shelf\""));
    }
    r
}

fn grant_err(desc: &str) -> Response {
    oauth_err(StatusCode::BAD_REQUEST, "invalid_grant", desc)
}

fn ie(e: AppError) -> Response {
    e.into_response()
}

/// client_secret_basic, client_secret_post, or none for a public client.
fn authenticate(app: &App, headers: &HeaderMap, req: &TokenReq) -> Result<Client, Response> {
    let bad = || oauth_err(StatusCode::UNAUTHORIZED, "invalid_client", "unknown client or wrong secret");
    let basic = headers.get(header::AUTHORIZATION).and_then(|v| v.to_str().ok()).and_then(|v| v.strip_prefix("Basic "));
    // the two halves are form-encoded inside the base64 (RFC 6749 §2.3.1)
    let unform = |s: &str| percent_decode_str(&s.replace('+', " ")).decode_utf8_lossy().into_owned();
    let (id, secret) = match basic {
        Some(b) => {
            if req.client_secret.is_some() {
                return Err(oauth_err(StatusCode::BAD_REQUEST, "invalid_request", "client secret both in the header and in the body"));
            }
            let raw = B64.decode(b.trim()).ok().and_then(|r| String::from_utf8(r).ok()).ok_or_else(bad)?;
            let (i, s) = raw.split_once(':').ok_or_else(bad)?;
            let (i, s) = (unform(i), unform(s));
            if req.client_id.as_ref().is_some_and(|c| *c != i) {
                return Err(oauth_err(StatusCode::BAD_REQUEST, "invalid_request", "client_id differs from the one in the header"));
            }
            (i, Some(s))
        }
        None => (req.client_id.clone().ok_or_else(bad)?, req.client_secret.clone()),
    };
    let client = client_where(app, "name", &id).map_err(ie)?.ok_or_else(bad)?;
    let ok = match (&client.secret_hash, &secret) {
        (Some(h), Some(s)) => edge::ct_eq(crypto::sha256_hex(s).as_bytes(), h.as_bytes()),
        (None, None) => true,
        _ => false,
    };
    if !ok {
        tracing::warn!("client {id} failed to authenticate");
        return Err(bad());
    }
    Ok(client)
}

async fn token(State(app): State<Arc<App>>, remote: Option<Extension<Remote>>, headers: HeaderMap, Form(req): Form<TokenReq>) -> Response {
    let iss = match issuer(&app, &remote) {
        Ok(i) => i,
        Err(e) => return e.into_response(),
    };
    let client = match authenticate(&app, &headers, &req) {
        Ok(c) => c,
        Err(r) => return r,
    };
    let r = match req.grant_type.as_deref() {
        Some("authorization_code") => by_code(&app, iss, &client, &req),
        Some("refresh_token") => by_refresh(&app, iss, &client, &req),
        _ => Err(oauth_err(StatusCode::BAD_REQUEST, "unsupported_grant_type", "authorization_code or refresh_token")),
    };
    match r {
        Ok(v) => ([(header::CACHE_CONTROL, "no-store"), (header::PRAGMA, "no-cache")], Json(v)).into_response(),
        Err(r) => r,
    }
}

fn by_code(app: &App, iss: &str, client: &Client, req: &TokenReq) -> Result<Value, Response> {
    let t = now();
    let code = {
        let mut codes = app.oidc.codes.lock().unwrap_or_else(|e| e.into_inner());
        match req.code.as_deref().and_then(|k| codes.get_mut(k)) {
            Some(c) if c.used => Err(Some(c.grant.clone())),
            Some(c) if c.expires > t && c.client == client.id => {
                c.used = true;
                Ok(c.clone())
            }
            _ => Err(None),
        }
    };
    let code = match code {
        Ok(c) => c,
        Err(reused) => {
            if let Some(g) = reused {
                // someone else may have it: the tokens it gave go too
                tracing::warn!("a code of {} was used twice; its tokens are revoked", client.name);
                app.db.with(|c| c.execute("DELETE FROM oidc_tokens WHERE grant_id = ?1", [g])).map_err(ie)?;
            }
            return Err(grant_err("unknown, used or expired code"));
        }
    };
    if req.redirect_uri.as_deref() != Some(code.redirect_uri.as_str()) {
        return Err(grant_err("redirect_uri is not the one of the authorization request"));
    }
    match (&code.challenge, req.code_verifier.as_deref()) {
        (None, None) => {}
        (Some(ch), Some(v)) if pkce_ok(v) && B64URL.encode(Sha256::digest(v)) == *ch => {}
        _ => return Err(grant_err("code_verifier does not match the code_challenge")),
    }
    let user = user_by_id(app, code.user).map_err(ie)?.ok_or_else(|| grant_err("the account is disabled"))?;
    issue(app, iss, client, &user, &code.scope, code.nonce.as_deref(), code.auth_time, &code.grant).map_err(ie)
}

fn by_refresh(app: &App, iss: &str, client: &Client, req: &TokenReq) -> Result<Value, Response> {
    let Some(rt) = req.refresh_token.as_deref() else {
        return Err(oauth_err(StatusCode::BAD_REQUEST, "invalid_request", "refresh_token missing"));
    };
    let h = crypto::sha256_hex(rt);
    let row = app
        .db
        .opt(|c| {
            c.query_row(
                "SELECT t.client_id, t.scope, t.grant_id, t.auth_time, u.id, u.username, u.is_admin, u.remote_cidrs
                 FROM oidc_tokens t JOIN users u ON u.id = t.user_id
                 WHERE t.token_hash = ?1 AND t.kind = 'refresh' AND t.expires > ?2 AND u.disabled = 0",
                params![h, now()],
                |r| {
                    let user = User { id: r.get(4)?, username: r.get(5)?, admin: r.get(6)?, cidrs: r.get(7)? };
                    Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?, r.get::<_, String>(2)?, r.get::<_, i64>(3)?, user))
                },
            )
        })
        .map_err(ie)?;
    let Some((cid, scope, grant, auth_time, user)) = row else { return Err(grant_err("unknown or expired refresh token")) };
    if cid != client.id {
        return Err(grant_err("the refresh token is another program's"));
    }
    if !client.lets_in(&user.username) {
        return Err(grant_err(&format!("{} may not use {}", user.username, client.name)));
    }
    // a narrower scope may be asked for, never a wider one
    let scope = match req.scope.as_deref() {
        None => scope,
        Some(s) if s.split_whitespace().all(|x| has_scope(&scope, x)) => grant_scope(s),
        Some(_) => return Err(oauth_err(StatusCode::BAD_REQUEST, "invalid_scope", "more than the original grant")),
    };
    // each refresh token works once; its successor comes with the answer
    let n = app.db.with(|c| c.execute("DELETE FROM oidc_tokens WHERE token_hash = ?1", [&h])).map_err(ie)?;
    if n == 0 {
        return Err(grant_err("unknown or expired refresh token"));
    }
    issue(app, iss, client, &user, &scope, None, auth_time, &grant).map_err(ie)
}

#[allow(clippy::too_many_arguments)]
fn issue(app: &App, iss: &str, client: &Client, user: &User, scope: &str, nonce: Option<&str>, auth_time: i64, grant: &str) -> Res<Value> {
    let t = now();
    let (access, refresh) = (crypto::random_token(32), crypto::random_token(32));
    app.db.with(|c| {
        let mut st = c.prepare(
            "INSERT INTO oidc_tokens (token_hash, kind, client_id, user_id, scope, grant_id, auth_time, created, expires)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
        )?;
        st.execute(params![crypto::sha256_hex(&access), "access", client.id, user.id, scope, grant, auth_time, t, t + ACCESS_SECS])?;
        st.execute(params![crypto::sha256_hex(&refresh), "refresh", client.id, user.id, scope, grant, auth_time, t, t + REFRESH_SECS])?;
        c.execute("UPDATE oidc_clients SET last_used = ?1 WHERE id = ?2", params![t, client.id])
    })?;
    let mut out = json!({
        "access_token": access, "token_type": "Bearer", "expires_in": ACCESS_SECS,
        "refresh_token": refresh, "scope": scope,
    });
    if has_scope(scope, "openid") {
        let mut claims = json!({
            "iss": iss, "sub": sub(app, user.id)?, "aud": client.name, "azp": client.name,
            "iat": t, "exp": t + ACCESS_SECS, "auth_time": auth_time,
            // the left half of the access token's sha256 (OIDC core 3.3.2.11)
            "at_hash": B64URL.encode(&Sha256::digest(&access)[..16]),
        });
        if let Some(n) = nonce {
            claims["nonce"] = json!(n);
        }
        if has_scope(scope, "profile") {
            profile(&mut claims, user);
        }
        out["id_token"] = json!(app.oidc.signer(app)?.sign(&claims)?);
    }
    Ok(out)
}

/* ---- userinfo ---- */

async fn userinfo(State(app): State<Arc<App>>, remote: Option<Extension<Remote>>, headers: HeaderMap) -> Response {
    if let Err(e) = issuer(&app, &remote) {
        return e.into_response();
    }
    let bad = || {
        let mut r = (StatusCode::UNAUTHORIZED, Json(json!({ "error": "invalid_token" }))).into_response();
        r.headers_mut().insert(header::WWW_AUTHENTICATE, HeaderValue::from_static("Bearer error=\"invalid_token\""));
        r
    };
    let token = headers.get(header::AUTHORIZATION).and_then(|v| v.to_str().ok()).and_then(|v| v.strip_prefix("Bearer ")).map(str::trim);
    let Some(token) = token else { return bad() };
    let row = app.db.opt(|c| {
        c.query_row(
            "SELECT t.scope, u.id, u.username, u.is_admin, u.remote_cidrs FROM oidc_tokens t JOIN users u ON u.id = t.user_id
             WHERE t.token_hash = ?1 AND t.kind = 'access' AND t.expires > ?2 AND u.disabled = 0",
            params![crypto::sha256_hex(token), now()],
            |r| Ok((r.get::<_, String>(0)?, User { id: r.get(1)?, username: r.get(2)?, admin: r.get(3)?, cidrs: r.get(4)? })),
        )
    });
    let (scope, user) = match row {
        Ok(Some(x)) => x,
        Ok(None) => return bad(),
        Err(e) => return e.into_response(),
    };
    let mut v = match sub(&app, user.id) {
        Ok(s) => json!({ "sub": s }),
        Err(e) => return e.into_response(),
    };
    if has_scope(&scope, "profile") {
        profile(&mut v, &user);
    }
    ([(header::CACHE_CONTROL, "no-store")], Json(v)).into_response()
}

/* ---- admin: the programs ---- */

async fn list_clients(State(app): State<Arc<App>>, _a: Admin) -> Res<Json<Value>> {
    Ok(Json(json!({ "issuer": app.cfg.oidc_issuer, "clients": clients_json(&app)? })))
}

#[derive(Deserialize)]
struct ClientReq {
    name: String,
    redirect_uris: String,
    #[serde(default)]
    users: String,
    #[serde(default)]
    public: bool,
}

async fn create_client(State(app): State<Arc<App>>, Admin(a): Admin, Json(req): Json<ClientReq>) -> Res<Json<Value>> {
    let name = req.name.trim().to_lowercase();
    let (id, secret) = add_client(&app, &name, &req.redirect_uris, &req.users, req.public)?;
    tracing::info!("{} added the sign-in client {name} ({})", a.username, if req.public { "public" } else { "with secret" });
    Ok(Json(json!({ "id": id, "client_id": name, "client_secret": secret, "issuer": app.cfg.oidc_issuer })))
}

#[derive(Deserialize)]
struct ClientPatch {
    redirect_uris: Option<String>,
    users: Option<String>,
}

async fn update_client(State(app): State<Arc<App>>, Admin(a): Admin, Path(id): Path<i64>, Json(req): Json<ClientPatch>) -> Res<Json<Value>> {
    let uris = req.redirect_uris.as_deref().map(redirect_uris).transpose()?;
    let who = req.users.as_deref().map(|u| allowed_users(&app, u)).transpose()?;
    let n = app.db.with(|c| {
        let mut n = 0;
        if let Some(u) = &uris {
            n += c.execute("UPDATE oidc_clients SET redirect_uris = ?1 WHERE id = ?2", params![u, id])?;
        }
        if let Some(w) = &who {
            n += c.execute("UPDATE oidc_clients SET users = ?1 WHERE id = ?2", params![w, id])?;
        }
        Ok(n)
    })?;
    if n == 0 {
        return Err(AppError::not_found());
    }
    tracing::info!("{} changed the sign-in client {id}", a.username);
    Ok(Json(json!({ "ok": true })))
}

async fn new_secret(State(app): State<Arc<App>>, Admin(a): Admin, Path(id): Path<i64>) -> Res<Json<Value>> {
    let secret = crypto::random_token(32);
    let n = app.db.with(|c| {
        c.execute("UPDATE oidc_clients SET secret_hash = ?1 WHERE id = ?2 AND secret_hash IS NOT NULL", params![crypto::sha256_hex(&secret), id])
    })?;
    if n == 0 {
        return Err(AppError::bad("no such program, or a public one (it has no secret)"));
    }
    tracing::info!("{} made a new secret for the sign-in client {id}", a.username);
    Ok(Json(json!({ "client_secret": secret })))
}

/// Its tokens go with it.
async fn delete_client(State(app): State<Arc<App>>, Admin(a): Admin, Path(id): Path<i64>) -> Res<Json<Value>> {
    let n = app.db.with(|c| c.execute("DELETE FROM oidc_clients WHERE id = ?1", [id]))?;
    if n == 0 {
        return Err(AppError::not_found());
    }
    tracing::info!("{} removed the sign-in client {id}", a.username);
    Ok(Json(json!({ "ok": true })))
}

/// `shelf oidc add|list|secret|remove …`
pub fn cli(app: &App, args: &[String]) -> anyhow::Result<()> {
    let e = |e: AppError| anyhow::anyhow!(e.msg);
    let show_issuer = || match &app.cfg.oidc_issuer {
        Some(i) => println!("issuer:        {i}\ndiscovery:     {i}/.well-known/openid-configuration"),
        None => eprintln!("sign-in is off until SHELF_OIDC_ISSUER is set (/etc/shelf/shelf.env)"),
    };
    match (args.first().map(String::as_str), args.get(1)) {
        (Some("add"), Some(name)) => {
            let (mut uris, mut who, mut public) = (Vec::new(), String::new(), false);
            let mut it = args[2..].iter();
            while let Some(a) = it.next() {
                match a.as_str() {
                    "--redirect" => uris.push(it.next().context("--redirect needs a URI")?.clone()),
                    "--users" => who = it.next().context("--users needs names")?.clone(),
                    "--public" => public = true,
                    x => anyhow::bail!("unknown option {x}"),
                }
            }
            let (_, secret) = add_client(app, name, &uris.join(" "), &who, public).map_err(e)?;
            println!("client_id:     {name}");
            if let Some(s) = secret {
                println!("client_secret: {s}");
            }
            show_issuer();
        }
        (Some("list"), _) => {
            for c in clients_json(app).map_err(e)? {
                println!("{c}");
            }
            show_issuer();
        }
        (Some("secret"), Some(name)) => {
            let secret = crypto::random_token(32);
            let n = app
                .db
                .with(|c| c.execute("UPDATE oidc_clients SET secret_hash = ?1 WHERE name = ?2 AND secret_hash IS NOT NULL", params![crypto::sha256_hex(&secret), name]))
                .map_err(e)?;
            anyhow::ensure!(n == 1, "no program {name} with a secret");
            println!("client_secret: {secret}");
        }
        (Some("remove"), Some(name)) => {
            let n = app.db.with(|c| c.execute("DELETE FROM oidc_clients WHERE name = ?1", [name])).map_err(e)?;
            anyhow::ensure!(n == 1, "no program {name}");
            eprintln!("removed {name}; its tokens are gone");
        }
        _ => anyhow::bail!("usage: shelf oidc add <name> --redirect <uri> [--redirect <uri> …] [--users a,b] [--public] | list | secret <name> | remove <name>"),
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn redirect_uris_checked() {
        assert_eq!(redirect_uris("http://apps.lan/oauth2/callback\n https://a.b/c?x=1 ").unwrap(), "http://apps.lan/oauth2/callback\nhttps://a.b/c?x=1");
        assert!(redirect_uris("com.th3rumbl3.app:/cb").is_ok());
        for bad in ["", "/cb", "http:/x", "http://", "https://a/b#frag", "HTTP://a/b", "http://ä/b", "1x://a"] {
            assert!(redirect_uris(bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn scopes() {
        assert_eq!(grant_scope("openid email profile openid groups"), "openid profile");
        assert!(has_scope("openid profile", "profile") && !has_scope("openid profile", "prof"));
    }

    #[test]
    fn pkce_s256() {
        // RFC 7636 appendix B
        let v = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
        assert!(pkce_ok(v) && !pkce_ok("short") && !pkce_ok(&"a".repeat(129)) && !pkce_ok(&format!("{v}+")));
        assert_eq!(B64URL.encode(Sha256::digest(v)), "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
    }

    #[test]
    fn answer_url() {
        assert_eq!(back_url("http://a/cb", &[("code", "x y")], Some("s/1"), "http://i"), "http://a/cb?code=x%20y&state=s%2F1&iss=http%3A%2F%2Fi");
        assert_eq!(back_url("http://a/cb?app=1", &[("error", "e")], None, "http://i"), "http://a/cb?app=1&error=e&iss=http%3A%2F%2Fi");
        assert_eq!(back_url("x:/cb", &[("code", "a-b_c.d~e")], Some("s-1"), "http://shelf.lan"), "x:/cb?code=a-b_c.d~e&state=s-1&iss=http%3A%2F%2Fshelf.lan");
    }

    #[test]
    fn signed_token_checks_out_with_the_jwk() {
        use rsa::pkcs8::EncodePrivateKey;
        let der = rsa::RsaPrivateKey::new(&mut rand::rngs::OsRng, 2048).unwrap().to_pkcs8_der().unwrap();
        let s = Signer::from_der(der.as_bytes()).unwrap();
        let jwt = s.sign(&json!({ "sub": "x" })).unwrap();
        let (input, sig) = jwt.rsplit_once('.').unwrap();
        let part = |k: &str| B64URL.decode(s.jwk[k].as_str().unwrap()).unwrap();
        let key = ring::signature::RsaPublicKeyComponents { n: part("n"), e: part("e") };
        key.verify(&ring::signature::RSA_PKCS1_2048_8192_SHA256, input.as_bytes(), &B64URL.decode(sig).unwrap()).unwrap();
        let head: Value = serde_json::from_slice(&B64URL.decode(input.split('.').next().unwrap()).unwrap()).unwrap();
        assert_eq!(head["kid"], s.jwk["kid"]);
        assert_eq!(s.jwk["n"].as_str().unwrap().len(), 342);
    }
}
