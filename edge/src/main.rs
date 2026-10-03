//! shelf-edge: the public face of a shelf server that stays at home. Every
//! request goes on to shelf (TLS with a pinned certificate, plus a shared
//! token) together with the visitor's address; shelf decides everything. The
//! edge only keeps copies of file bodies, and sends one only after shelf has
//! answered a probe for that very request with the same ETag. See README.md.

mod cache;

use std::{
    io,
    net::{IpAddr, SocketAddr},
    sync::{
        atomic::{AtomicBool, Ordering::Relaxed},
        Arc,
    },
    time::Duration,
};

use axum::{
    body::Body,
    extract::{ConnectInfo, Request, State},
    http::{header, HeaderMap, HeaderValue, Method, StatusCode},
    response::{IntoResponse, Response},
    Router,
};
use futures_util::StreamExt;
use rustls::{
    client::danger::{HandshakeSignatureValid, ServerCertVerified, ServerCertVerifier},
    crypto::WebPkiSupportedAlgorithms,
    pki_types::{CertificateDer, ServerName, UnixTime},
    DigitallySignedStruct, SignatureScheme,
};
use sha2::{Digest, Sha256};
use tokio::{
    io::{AsyncReadExt, AsyncSeekExt, SeekFrom},
    sync::mpsc,
};
use tokio_util::io::ReaderStream;

use crate::cache::{Cache, Fill};

struct Upstream {
    base: String,
    up: AtomicBool,
}

struct Edge {
    ups: Vec<Upstream>,
    http: reqwest::Client,
    token: HeaderValue,
    cache: Arc<Cache>,
}

/// Not passed on in either direction. The x-shelf ones are the edge's own
/// words to shelf; a visitor does not get to say them.
const DROP: &[&str] = &[
    "connection", "keep-alive", "proxy-authenticate", "proxy-authorization", "proxy-connection", "te", "trailer",
    "transfer-encoding", "upgrade", "host", "x-real-ip", "x-forwarded-for", "x-forwarded-proto", "x-forwarded-host",
];

fn dropped(name: &str) -> bool {
    DROP.contains(&name) || name.starts_with("x-shelf-")
}

/// Responses that are a file body: shelf answers these to a probe.
fn is_file(path: &str) -> bool {
    path.starts_with("/api/raw/")
        || path.strip_prefix("/s/").and_then(|r| r.split_once('/')).is_some_and(|(_, rest)| rest == "raw" || rest.starts_with("raw/"))
}

impl Edge {
    /// Healthy upstreams first, in the configured order.
    fn order(&self) -> Vec<&Upstream> {
        let (up, down): (Vec<_>, Vec<_>) = self.ups.iter().partition(|u| u.up.load(Relaxed));
        up.into_iter().chain(down).collect()
    }

    fn mark(&self, u: &Upstream, ok: bool) {
        if u.up.swap(ok, Relaxed) != ok {
            tracing::info!("{} is {}", u.base, if ok { "up" } else { "down" });
        }
    }

    /// Without a body the request moves on to the next upstream when one
    /// cannot be reached; a streamed body can only be sent once.
    async fn send(&self, method: Method, pq: &str, h: HeaderMap, mut body: Option<reqwest::Body>) -> reqwest::Result<reqwest::Response> {
        let retry = body.is_none();
        let mut last = None;
        for u in self.order() {
            let mut rb = self.http.request(method.clone(), format!("{}{pq}", u.base)).headers(h.clone());
            if let Some(b) = body.take() {
                rb = rb.body(b);
            }
            match rb.send().await {
                Ok(r) => {
                    self.mark(u, true);
                    return Ok(r);
                }
                Err(e) if e.is_connect() => {
                    self.mark(u, false);
                    last = Some(e);
                    if !retry {
                        break;
                    }
                }
                Err(e) => return Err(e),
            }
        }
        Err(last.expect("at least one upstream"))
    }

    /// A file: probe, then the copy or the body from shelf (kept for next time).
    async fn file(self: &Arc<Self>, pq: &str, h: HeaderMap) -> reqwest::Result<Response> {
        let mut ph = h.clone();
        ph.insert("x-shelf-probe", HeaderValue::from_static("1"));
        let probe = self.send(Method::GET, pq, ph, None).await?;
        let hv = |n: &str| probe.headers().get(n).and_then(|v| v.to_str().ok()).map(str::to_string);
        // not a yes (error, 304, 416): that is the answer
        let (Some(key), Some(size)) = (hv("x-shelf-cache"), hv("x-shelf-size").and_then(|s| s.parse::<u64>().ok())) else {
            return Ok(pass(probe));
        };
        let etag = hv("etag").unwrap_or_default();
        let span = match probe.status() {
            StatusCode::OK => Some((0, size)),
            StatusCode::PARTIAL_CONTENT => hv("content-range").as_deref().and_then(content_range),
            _ => None,
        };
        if let Some((start, len)) = span {
            if let Some(mut f) = self.cache.get(&key, &etag, size).await {
                if f.seek(SeekFrom::Start(start)).await.is_ok() {
                    let b = head(probe.status(), probe.headers()).header(header::CONTENT_LENGTH, len).header("x-edge-cache", "hit");
                    return Ok(b.body(Body::from_stream(ReaderStream::with_capacity(f.take(len), 256 << 10))).expect("response"));
                }
            }
        }
        let mut fh = h;
        fh.insert("x-shelf-probe", HeaderValue::from_static("fetch"));
        if probe.status() != StatusCode::OK {
            // a range (video seeking): pass it on, fetch the whole file aside
            if let Some(fill) = self.cache.claim(&key, size) {
                let mut bh = fh.clone();
                for k in [header::RANGE, header::IF_RANGE, header::IF_NONE_MATCH, header::IF_MODIFIED_SINCE] {
                    bh.remove(k);
                }
                tokio::spawn(self.clone().background(pq.to_string(), bh, fill));
            }
            return self.send(Method::GET, pq, fh, None).await.map(pass);
        }
        let r = self.send(Method::GET, pq, fh, None).await?;
        match (r.status() == StatusCode::OK && r.content_length() == Some(size)).then(|| self.cache.claim(&key, size)).flatten() {
            Some(fill) => Ok(tee(r, fill)),
            None => Ok(pass(r)),
        }
    }

    async fn background(self: Arc<Self>, pq: String, h: HeaderMap, mut fill: Fill) {
        let r = match self.send(Method::GET, &pq, h, None).await {
            Ok(r) if r.status() == StatusCode::OK => r,
            _ => return,
        };
        let etag = r.headers().get(header::ETAG).and_then(|v| v.to_str().ok()).unwrap_or("").to_string();
        let mut s = r.bytes_stream();
        while let Some(c) = s.next().await {
            let Ok(b) = c else { return };
            fill.write(&b).await;
            if fill.broken() {
                return;
            }
        }
        fill.commit(&etag).await;
    }

    async fn watch(self: Arc<Self>) {
        let mut tick = tokio::time::interval(Duration::from_secs(10));
        loop {
            tick.tick().await;
            for u in &self.ups {
                let r = self
                    .http
                    .get(format!("{}/_edge/ping", u.base))
                    .header("x-shelf-edge", self.token.clone())
                    .timeout(Duration::from_secs(5))
                    .send()
                    .await;
                self.mark(u, r.is_ok_and(|r| r.status().is_success()));
            }
        }
    }
}

/// "bytes 5-9/10" -> (5, 5)
fn content_range(v: &str) -> Option<(u64, u64)> {
    let (span, _) = v.strip_prefix("bytes ")?.split_once('/')?;
    let (a, b) = span.split_once('-')?;
    let (a, b) = (a.parse::<u64>().ok()?, b.parse::<u64>().ok()?);
    (b >= a).then_some((a, b - a + 1))
}

fn head(status: StatusCode, h: &HeaderMap) -> axum::http::response::Builder {
    let mut b = Response::builder().status(status);
    let out = b.headers_mut().expect("fresh builder");
    for (k, v) in h {
        if !dropped(k.as_str()) && k != header::CONTENT_LENGTH {
            out.append(k, v.clone());
        }
    }
    b
}

fn pass(r: reqwest::Response) -> Response {
    let mut b = head(r.status(), r.headers());
    if let Some(n) = r.headers().get(header::CONTENT_LENGTH) {
        b = b.header(header::CONTENT_LENGTH, n);
    }
    b.body(Body::from_stream(r.bytes_stream())).expect("response")
}

/// The body goes to the visitor and into the cache; if the visitor leaves
/// half way, the copy is still finished.
fn tee(r: reqwest::Response, mut fill: Fill) -> Response {
    let b = head(r.status(), r.headers()).header(header::CONTENT_LENGTH, r.content_length().unwrap_or(0));
    let etag = r.headers().get(header::ETAG).and_then(|v| v.to_str().ok()).unwrap_or("").to_string();
    let (tx, mut rx) = mpsc::channel::<io::Result<bytes::Bytes>>(8);
    let mut s = r.bytes_stream();
    tokio::spawn(async move {
        let mut tx = Some(tx);
        while let Some(c) = s.next().await {
            match c {
                Ok(bytes) => {
                    fill.write(&bytes).await;
                    if let Some(t) = &tx {
                        if t.send(Ok(bytes)).await.is_err() {
                            tx = None;
                        }
                    }
                    if tx.is_none() && fill.broken() {
                        return;
                    }
                }
                Err(e) => {
                    if let Some(t) = &tx {
                        let _ = t.send(Err(io::Error::other(e))).await;
                    }
                    return;
                }
            }
        }
        fill.commit(&etag).await;
    });
    b.body(Body::from_stream(futures_util::stream::poll_fn(move |cx| rx.poll_recv(cx)))).expect("response")
}

/// nginx in front on the same host says who the visitor is.
fn visitor(h: &HeaderMap, peer: SocketAddr) -> IpAddr {
    let real = || h.get("x-real-ip")?.to_str().ok()?.trim().parse::<IpAddr>().ok();
    if peer.ip().is_loopback() {
        if let Some(ip) = real() {
            return ip;
        }
    }
    peer.ip()
}

async fn relay(State(edge): State<Arc<Edge>>, ConnectInfo(peer): ConnectInfo<SocketAddr>, req: Request) -> Response {
    let (parts, body) = req.into_parts();
    if parts.uri.path().starts_with("/_edge/") {
        return StatusCode::NOT_FOUND.into_response();
    }
    let ip = visitor(&parts.headers, peer);
    let mut h = HeaderMap::new();
    for (k, v) in &parts.headers {
        if !dropped(k.as_str()) {
            h.append(k, v.clone());
        }
    }
    h.insert("x-shelf-edge", edge.token.clone());
    h.insert("x-shelf-client", HeaderValue::from_str(&ip.to_string()).expect("an address is a header value"));
    let pq = parts.uri.path_and_query().map_or("/", |p| p.as_str());
    let res = if parts.method == Method::GET && is_file(parts.uri.path()) {
        edge.file(pq, h).await
    } else {
        let has_body = parts.headers.contains_key(header::CONTENT_LENGTH) || parts.headers.contains_key(header::TRANSFER_ENCODING);
        let body = has_body.then(|| reqwest::Body::wrap_stream(body.into_data_stream()));
        edge.send(parts.method.clone(), pq, h, body).await.map(pass)
    };
    res.unwrap_or_else(|e| {
        tracing::warn!("{} {pq}: {e}", parts.method);
        (StatusCode::BAD_GATEWAY, "shelf is not reachable right now, try again in a minute\n").into_response()
    })
}

/// shelf's certificate is self-signed; it is accepted by its sha256, nothing else.
#[derive(Debug)]
struct Pinned {
    pin: Vec<u8>,
    algs: WebPkiSupportedAlgorithms,
}

impl ServerCertVerifier for Pinned {
    fn verify_server_cert(
        &self,
        cert: &CertificateDer,
        _: &[CertificateDer],
        _: &ServerName,
        _: &[u8],
        _: UnixTime,
    ) -> Result<ServerCertVerified, rustls::Error> {
        if Sha256::digest(cert.as_ref()).as_slice() == self.pin.as_slice() {
            Ok(ServerCertVerified::assertion())
        } else {
            Err(rustls::Error::General("certificate does not match EDGE_PIN".into()))
        }
    }

    fn verify_tls12_signature(&self, m: &[u8], c: &CertificateDer, d: &DigitallySignedStruct) -> Result<HandshakeSignatureValid, rustls::Error> {
        rustls::crypto::verify_tls12_signature(m, c, d, &self.algs)
    }

    fn verify_tls13_signature(&self, m: &[u8], c: &CertificateDer, d: &DigitallySignedStruct) -> Result<HandshakeSignatureValid, rustls::Error> {
        rustls::crypto::verify_tls13_signature(m, c, d, &self.algs)
    }

    fn supported_verify_schemes(&self) -> Vec<SignatureScheme> {
        self.algs.supported_schemes()
    }
}

fn main() -> anyhow::Result<()> {
    let filter = tracing_subscriber::EnvFilter::try_from_default_env().unwrap_or_else(|_| "shelf_edge=info".into());
    let log = tracing_subscriber::fmt().with_env_filter(filter).with_writer(io::stderr).with_ansi(false);
    if std::env::var_os("JOURNAL_STREAM").is_some() {
        log.without_time().init();
    } else {
        log.init();
    }
    let var = |k: &str| std::env::var(k).ok().filter(|v| !v.trim().is_empty());
    let need = |k: &str| var(k).ok_or_else(|| anyhow::anyhow!("{k} is not set"));
    let token = HeaderValue::from_str(need("EDGE_TOKEN")?.trim())?;
    let pin = hex::decode(need("EDGE_PIN")?.trim())?;
    anyhow::ensure!(pin.len() == 32, "EDGE_PIN: sha256 of shelf's certificate, 64 hex digits");
    let ups: Vec<Upstream> = need("EDGE_UPSTREAMS")?
        .split(',')
        .map(|u| u.trim().trim_end_matches('/'))
        .filter(|u| !u.is_empty())
        .map(|u| Upstream { base: u.to_string(), up: AtomicBool::new(true) })
        .collect();
    anyhow::ensure!(!ups.is_empty(), "EDGE_UPSTREAMS is empty");
    let bind = var("EDGE_BIND").unwrap_or_else(|| "127.0.0.1:8470".into());
    let gb: u64 = var("EDGE_CACHE_GB").map_or(Ok(30), |v| v.trim().parse())?;
    let cache = Cache::open(var("EDGE_CACHE").unwrap_or_else(|| "/var/cache/shelf-edge".into()).into(), gb << 30)?;

    let provider = Arc::new(rustls::crypto::ring::default_provider());
    let algs = provider.signature_verification_algorithms;
    let tls = rustls::ClientConfig::builder_with_provider(provider)
        .with_safe_default_protocol_versions()?
        .dangerous()
        .with_custom_certificate_verifier(Arc::new(Pinned { pin, algs }))
        .with_no_client_auth();
    let http = reqwest::Client::builder()
        .use_preconfigured_tls(tls)
        .redirect(reqwest::redirect::Policy::none())
        .connect_timeout(Duration::from_secs(5))
        .pool_idle_timeout(Duration::from_secs(60))
        .tcp_keepalive(Duration::from_secs(30))
        .http1_only()
        .build()?;
    let edge = Arc::new(Edge { ups, http, token, cache });

    let rt = tokio::runtime::Builder::new_multi_thread().enable_all().build()?;
    rt.block_on(async move {
        tokio::spawn(edge.clone().watch());
        let router = Router::new().fallback(relay).with_state(edge.clone());
        let listener = tokio::net::TcpListener::bind(&bind).await?;
        let to: Vec<&str> = edge.ups.iter().map(|u| u.base.as_str()).collect();
        tracing::info!("shelf-edge {} on {bind}, shelf at {}", env!("CARGO_PKG_VERSION"), to.join(" or "));
        axum::serve(listener, router.into_make_service_with_connect_info::<SocketAddr>())
            .with_graceful_shutdown(async {
                let mut term = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate()).expect("signal");
                tokio::select! {
                    _ = term.recv() => {}
                    _ = tokio::signal::ctrl_c() => {}
                }
            })
            .await?;
        Ok(())
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn paths_and_ranges() {
        assert!(is_file("/api/raw/home/a.mp4"));
        assert!(is_file("/s/AbC/raw"));
        assert!(is_file("/s/AbC/raw/x/y.jpg"));
        assert!(!is_file("/s/AbC/ls"));
        assert!(!is_file("/s/raw"));
        assert!(!is_file("/api/ls/home"));
        assert_eq!(content_range("bytes 5-9/10"), Some((5, 5)));
        assert_eq!(content_range("bytes */10"), None);
        assert!(dropped("x-shelf-probe") && dropped("host") && !dropped("cookie"));
    }
}
