//! The web UI, compiled into the binary. Asset urls carry `?v=<hash>`, so the
//! browser keeps them for good and only revalidates the HTML.

use std::{collections::HashMap, sync::Arc};

use axum::{
    extract::{Path, Query, State},
    http::{header, HeaderMap, Method, StatusCode, Uri},
    response::{IntoResponse, Response},
    routing::get,
    Router,
};
use sha2::{Digest, Sha256};

use crate::{error::AppError, App};

struct Asset {
    name: &'static str,
    body: &'static [u8],
    ctype: &'static str,
}

const CSS: &str = "text/css; charset=utf-8";
const JS: &str = "text/javascript; charset=utf-8";

macro_rules! asset {
    ($n:literal, $t:expr) => {
        Asset { name: $n, body: include_bytes!(concat!(env!("CARGO_MANIFEST_DIR"), "/static/", $n)), ctype: $t }
    };
}

static ASSETS: &[Asset] = &[
    asset!("i18n.js", JS),
    asset!("x11.css", CSS),
    asset!("x11.js", JS),
    asset!("app.css", CSS),
    asset!("util.js", JS),
    asset!("viewer.js", JS),
    asset!("app.js", JS),
    asset!("csv.js", JS),
    asset!("xlsx.js", JS),
    asset!("ods.js", JS),
    asset!("sheet.js", JS),
    asset!("rtf.js", JS),
    asset!("public.js", JS),
    asset!("favicon.svg", "image/svg+xml"),
];

const INDEX: &str = include_str!("../static/index.html");
const PUBLIC: &str = include_str!("../static/public.html");

/// Pages only load our own scripts; styles may be inline (editors set them).
const CSP_HTML: &str = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; \
    img-src 'self' data: blob:; media-src 'self' blob:; frame-src 'self'; object-src 'none'; \
    base-uri 'none'; form-action 'self'; frame-ancestors 'self'";

pub struct Assets {
    pub version: String,
    index: String,
    public: String,
}

fn esc(s: &str) -> String {
    s.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;").replace('"', "&quot;")
}

impl Assets {
    pub fn new(host: &str) -> Self {
        let mut h = Sha256::new();
        for a in ASSETS {
            h.update(a.body);
        }
        h.update(INDEX);
        h.update(PUBLIC);
        let version = hex::encode(h.finalize())[..10].to_string();
        let fill = |s: &str| s.replace("{{v}}", &version).replace("{{host}}", &esc(host));
        Assets { index: fill(INDEX), public: fill(PUBLIC), version }
    }

    pub fn index_page(&self) -> Response {
        html(self.index.clone(), StatusCode::OK)
    }

    pub fn public_page(&self, status: StatusCode) -> Response {
        html(self.public.clone(), status)
    }
}

fn html(body: String, status: StatusCode) -> Response {
    (
        status,
        [
            (header::CONTENT_TYPE, "text/html; charset=utf-8"),
            (header::CACHE_CONTROL, "no-cache"),
            (header::CONTENT_SECURITY_POLICY, CSP_HTML),
        ],
        body,
    )
        .into_response()
}

pub fn routes() -> Router<Arc<App>> {
    Router::new().route("/static/{file}", get(file))
}

async fn file(
    State(app): State<Arc<App>>,
    Path(name): Path<String>,
    Query(q): Query<HashMap<String, String>>,
    headers: HeaderMap,
) -> Response {
    let Some(a) = ASSETS.iter().find(|a| a.name == name) else {
        return AppError::not_found().into_response();
    };
    let etag = format!("\"{}\"", app.assets.version);
    if headers.get(header::IF_NONE_MATCH).is_some_and(|v| v.as_bytes() == etag.as_bytes()) {
        return StatusCode::NOT_MODIFIED.into_response();
    }
    let cache = if q.get("v") == Some(&app.assets.version) { "public, max-age=31536000, immutable" } else { "no-cache" };
    ([(header::CONTENT_TYPE, a.ctype), (header::CACHE_CONTROL, cache), (header::ETAG, etag.as_str())], a.body).into_response()
}

/// Every other GET is a page of the single-page app.
pub async fn fallback(State(app): State<Arc<App>>, method: Method, uri: Uri) -> Response {
    let p = uri.path();
    let api = ["/api/", "/s/", "/static/", "/oidc/", "/.well-known/"].iter().any(|x| p.starts_with(x)) || p == "/favicon.ico";
    if api || (method != Method::GET && method != Method::HEAD) {
        return AppError::not_found().into_response();
    }
    app.assets.index_page()
}
