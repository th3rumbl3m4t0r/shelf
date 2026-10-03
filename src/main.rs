//! shelf: small self-hosted file sharing with a few editors. See README.md.

mod api;
mod assets;
mod auth;
mod backup;
mod crypto;
mod db;
mod edge;
mod error;
mod files;
mod http_util;
mod md;
mod mounts;
mod pictures;
mod public;
mod shares;
mod sizes;
mod sync;
mod users;
mod vfs;

use std::{
    fs,
    os::unix::fs::MetadataExt,
    path::{Path, PathBuf},
    sync::Arc,
    time::{Duration, SystemTime},
};

use axum::{
    extract::{DefaultBodyLimit, Request},
    http::{header, HeaderValue, Method, StatusCode},
    middleware::{self, Next},
    response::{IntoResponse, Response},
    Router,
};

use crate::error::AppError;

pub struct Config {
    /// database, secret.key, users/, deleted/, tmp/, thumbs/
    pub data: PathBuf,
    pub bind: String,
    /// `https://files.example.org` if links should be absolute; None = relative
    pub public_url: Option<String>,
    /// set when served over https (behind a proxy)
    pub secure_cookie: bool,
    /// shown in the title bar
    pub host: String,
    /// TLS listener for the public edge (edge.rs), e.g. `0.0.0.0:8080`
    pub edge_bind: Option<String>,
    /// UPS status page (JSON); the backup runs when it leaves line power and
    /// prunes only on line power
    pub ups_url: Option<String>,
}

impl Config {
    fn from_env() -> Self {
        let var = |k: &str| std::env::var(k).ok().filter(|v| !v.trim().is_empty());
        let host = var("SHELF_HOST").unwrap_or_else(|| {
            fs::read_to_string("/proc/sys/kernel/hostname").map(|s| s.trim().to_string()).unwrap_or_else(|_| "shelf".into())
        });
        Config {
            data: var("SHELF_DATA").unwrap_or_else(|| "/home/shelf".into()).into(),
            bind: var("SHELF_BIND").unwrap_or_else(|| "0.0.0.0:80".into()),
            public_url: var("SHELF_PUBLIC_URL").map(|u| u.trim().trim_end_matches('/').to_string()),
            secure_cookie: var("SHELF_SECURE_COOKIE").is_some_and(|v| v == "1" || v == "true"),
            edge_bind: var("SHELF_EDGE_BIND"),
            ups_url: var("SHELF_UPS_URL"),
            host,
        }
    }
}

pub struct App {
    pub cfg: Config,
    pub db: Arc<db::Db>,
    pub key: crypto::Key,
    pub sftp: vfs::sftp::Pool,
    pub limiter: auth::Limiter,
    pub assets: assets::Assets,
    pub backup: backup::Runner,
    pub edge: Option<edge::Edge>,
    pub asns: edge::Asns,
    pub pics: pictures::Index,
    pub sizes: sizes::Sizes,
}

impl App {
    pub fn user_root(&self, name: &str) -> PathBuf {
        self.cfg.data.join("users").join(name)
    }
    pub fn tmp_dir(&self) -> PathBuf {
        self.cfg.data.join("tmp")
    }
}

/// Files created as root in the data folder would lock the service out.
fn check_owner(data: &Path) -> anyhow::Result<()> {
    // SAFETY: geteuid cannot fail
    let euid = unsafe { libc::geteuid() };
    if let Ok(m) = fs::metadata(data) {
        if euid == 0 && m.uid() != 0 {
            anyhow::bail!("{} belongs to another user; run as that user: runuser -u shelf -- shelf …", data.display());
        }
    }
    Ok(())
}

fn open_app(cfg: Config) -> anyhow::Result<App> {
    for d in ["users", "tmp", "deleted"] {
        fs::create_dir_all(cfg.data.join(d))?;
    }
    let db = Arc::new(db::Db::open(&cfg.data.join("shelf.db"))?);
    let key = crypto::Key::load_or_create(&cfg.data.join("secret.key"))?;
    let edge = cfg.edge_bind.is_some().then(|| edge::Edge::load(&cfg.data)).transpose()?;
    Ok(App {
        edge,
        assets: assets::Assets::new(&cfg.host),
        sftp: vfs::sftp::Pool::new(db.clone()),
        db,
        key,
        limiter: Default::default(),
        backup: Default::default(),
        asns: Default::default(),
        pics: pictures::Index::new(),
        sizes: Default::default(),
        cfg,
    })
}

/// State-changing API calls must carry `X-Shelf` (a form on another site
/// cannot set it), and every response gets the basic hardening headers.
/// `/api/v1` is left out: it takes only API keys, never the login cookie.
async fn guard(req: Request, next: Next) -> Response {
    let safe = matches!(*req.method(), Method::GET | Method::HEAD | Method::OPTIONS);
    let api = req.uri().path().starts_with("/api/");
    let keyed = req.uri().path() == "/api/v1" || req.uri().path().starts_with("/api/v1/");
    if !safe && api && !keyed && !req.headers().contains_key("x-shelf") {
        return AppError::new(StatusCode::FORBIDDEN, "missing X-Shelf header").into_response();
    }
    let mut res = next.run(req).await;
    let h = res.headers_mut();
    // a caching front server must never keep per-user answers
    h.entry(header::CACHE_CONTROL).or_insert(HeaderValue::from_static(if api { "no-store" } else { "no-cache" }));
    h.insert(header::X_CONTENT_TYPE_OPTIONS, HeaderValue::from_static("nosniff"));
    h.entry(header::REFERRER_POLICY).or_insert(HeaderValue::from_static("same-origin"));
    h.entry(header::X_FRAME_OPTIONS).or_insert(HeaderValue::from_static("SAMEORIGIN"));
    res
}

async fn housekeeping(app: Arc<App>) {
    let mut tick = tokio::time::interval(Duration::from_secs(60));
    for n in 0u64.. {
        tick.tick().await;
        app.sftp.reap(Duration::from_secs(600));
        if n % 10 == 0 {
            pictures::kick(&app, Duration::ZERO);
        }
        if n % 60 != 0 {
            continue;
        }
        let a = app.clone();
        tokio::spawn(async move { a.asns.housekeeping(&a.db).await });
        let t = db::now();
        app.db
            .with(|c| {
                c.execute("DELETE FROM sessions WHERE expires < ?1", [t])?;
                c.execute("DELETE FROM links WHERE expires IS NOT NULL AND expires < ?1", [t])?;
                c.execute("DELETE FROM api_keys WHERE expires IS NOT NULL AND expires < ?1", [t])
            })
            .ok();
        // uploads that died half way
        let day_ago = SystemTime::now() - Duration::from_secs(86400);
        for e in fs::read_dir(app.tmp_dir()).into_iter().flatten().flatten() {
            if e.metadata().and_then(|m| m.modified()).is_ok_and(|t| t < day_ago) {
                let _ = fs::remove_file(e.path());
            }
        }
    }
}

async fn shutdown(stop: tokio_util::sync::CancellationToken) {
    let mut term = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate()).expect("signal");
    tokio::select! {
        _ = term.recv() => {}
        _ = tokio::signal::ctrl_c() => {}
    }
    tracing::info!("shutting down");
    pictures::stop();
    stop.cancel();
}

fn serve(app: App) -> anyhow::Result<()> {
    let rt = tokio::runtime::Builder::new_multi_thread().enable_all().build()?;
    app.pics.load(&app.db).map_err(|e| anyhow::anyhow!(e.msg))?;
    rt.block_on(async move {
        let app = Arc::new(app);
        let router = Router::new()
            .merge(users::routes())
            .merge(files::routes())
            .merge(shares::routes())
            .merge(mounts::routes())
            .merge(backup::routes())
            .merge(pictures::routes())
            .merge(sync::routes())
            .merge(api::routes())
            .merge(public::routes())
            .merge(assets::routes())
            .fallback(assets::fallback)
            // JSON bodies; uploads stream past this
            .layer(DefaultBodyLimit::max(8 << 20))
            .layer(middleware::from_fn(guard));
        tokio::spawn(housekeeping(app.clone()));
        tokio::spawn(backup::scheduler(app.clone()));
        tokio::spawn(backup::ups_watch(app.clone()));
        let stop = tokio_util::sync::CancellationToken::new();
        tokio::spawn(shutdown(stop.clone()));
        let lan = router.clone().layer(middleware::from_fn(edge::lan)).with_state(app.clone());
        let listener = tokio::net::TcpListener::bind(&app.cfg.bind).await?;
        tracing::info!("shelf {} on {}, data in {}", env!("CARGO_PKG_VERSION"), app.cfg.bind, app.cfg.data.display());
        let lan = axum::serve(listener, lan).with_graceful_shutdown(stop.clone().cancelled_owned());
        let (Some(bind), Some(e)) = (&app.cfg.edge_bind, &app.edge) else { return Ok(lan.await?) };
        let edge = router.layer(middleware::from_fn_with_state(app.clone(), edge::gate)).with_state(app.clone());
        let listener = edge::TlsListener::bind(bind, e).await?;
        tracing::info!("edge listener (tls) on {bind}");
        let edge = axum::serve(listener, edge).with_graceful_shutdown(stop.cancelled_owned());
        tokio::try_join!(lan, edge)?;
        Ok(())
    })
}

fn main() -> anyhow::Result<()> {
    let filter = tracing_subscriber::EnvFilter::try_from_default_env().unwrap_or_else(|_| "shelf=info".into());
    let journald = std::env::var_os("JOURNAL_STREAM").is_some();
    let log = tracing_subscriber::fmt().with_env_filter(filter).with_writer(std::io::stderr).with_ansi(false);
    if journald {
        log.without_time().init();
    } else {
        log.init();
    }
    let args: Vec<String> = std::env::args().skip(1).collect();
    let cfg = Config::from_env();
    match args.first().map(String::as_str) {
        None | Some("serve") => {
            check_owner(&cfg.data)?;
            serve(open_app(cfg)?)
        }
        Some("user") => {
            check_owner(&cfg.data)?;
            users::cli(&open_app(cfg)?, &args[1..])
        }
        Some("backup") => {
            check_owner(&cfg.data)?;
            backup::cli(open_app(cfg)?, &args[1..])
        }
        Some("edge") => {
            check_owner(&cfg.data)?;
            edge::cli(&cfg.data, &args[1..])
        }
        Some("version" | "--version" | "-V") => {
            println!("shelf {}", env!("CARGO_PKG_VERSION"));
            Ok(())
        }
        _ => anyhow::bail!("usage: shelf [serve] | user add|passwd|remote|list … | backup set|run|show … | edge init|show | version"),
    }
}
