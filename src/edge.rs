//! The public edge (`shelf-edge`, see edge/) runs on another host and reaches
//! this server on a TLS listener of its own (`SHELF_EDGE_BIND`). It proves
//! itself with a shared token and passes the visitor's address along; logins,
//! permissions and links are decided here exactly as for the LAN. Accounts can
//! only be used from outside when the visitor's address is in their list of
//! networks (`users.remote_cidrs`: CIDR blocks and AS numbers); public links
//! work for everyone.
//!
//! The edge keeps copies of file bodies, but only hands one out after asking
//! here first (`x-shelf-probe`), see `http_util::serve`.

use std::{
    collections::{HashMap, HashSet},
    fs,
    net::{IpAddr, SocketAddr},
    os::unix::fs::{DirBuilderExt, OpenOptionsExt},
    path::Path,
    sync::{Arc, RwLock},
    time::Duration,
};

use axum::{
    extract::{Request, State},
    http::{HeaderMap, StatusCode},
    middleware::Next,
    response::{IntoResponse, Response},
};
use sha2::{Digest, Sha256};
use tokio::{net::TcpStream, sync::mpsc};
use tokio_rustls::{
    rustls::{
        self,
        pki_types::{pem::PemObject, CertificateDer, PrivateKeyDer},
    },
    server::TlsStream,
    TlsAcceptor,
};

use crate::{
    crypto,
    db::{self, Db},
    error::AppError,
    vfs::RelPath,
    App,
};

pub struct Edge {
    token: String,
    tls: Arc<rustls::ServerConfig>,
}

/// Set on requests that came through the edge: the visitor's address.
#[derive(Clone, Copy, Debug)]
pub struct Remote(pub IpAddr);

/// `<data>/edge`: token, cert.pem, key.pem, and edge.env to copy to the edge host
fn dir(data: &Path) -> std::path::PathBuf {
    data.join("edge")
}

impl Edge {
    pub fn load(data: &Path) -> anyhow::Result<Self> {
        let d = dir(data);
        let token = fs::read_to_string(d.join("token"))
            .map_err(|e| anyhow::anyhow!("{}: {e}; run `shelf edge init` first", d.join("token").display()))?
            .trim()
            .to_string();
        let certs = CertificateDer::pem_file_iter(d.join("cert.pem"))?.collect::<Result<Vec<_>, _>>()?;
        let key = PrivateKeyDer::from_pem_file(d.join("key.pem"))?;
        let tls = rustls::ServerConfig::builder_with_provider(Arc::new(rustls::crypto::ring::default_provider()))
            .with_safe_default_protocol_versions()?
            .with_no_client_auth()
            .with_single_cert(certs, key)?;
        Ok(Edge { token, tls: Arc::new(tls) })
    }

    /// Opaque name of a file for the edge's cache: the same file reached
    /// through a link or a share is one cache entry. Keyed with the token so
    /// it says nothing about the path.
    pub fn cache_key(&self, store: &str, path: &RelPath) -> String {
        hex::encode(Sha256::digest(format!("{}\0{store}\0{path}", self.token)))
    }
}

/// What a file response should be for this request: `Some(key)` when the edge
/// only asks whether it may serve its copy (headers, no body).
pub fn probe(app: &App, headers: &HeaderMap, store: &str, path: &RelPath) -> Option<String> {
    let edge = app.edge.as_ref()?;
    (headers.get("x-shelf-probe")? == "1").then(|| edge.cache_key(store, path))
}

/// The edge fetching a body after a probe; not a new download.
pub fn is_fetch(headers: &HeaderMap) -> bool {
    headers.get("x-shelf-probe").is_some_and(|v| v == "fetch")
}

/// Requests on the edge listener: the token has to match, the visitor's
/// address becomes the `Remote` extension.
pub async fn gate(State(app): State<Arc<App>>, mut req: Request, next: Next) -> Response {
    let Some(edge) = app.edge.as_ref() else { return StatusCode::NOT_FOUND.into_response() };
    let ok = req.headers().get("x-shelf-edge").is_some_and(|v| ct_eq(v.as_bytes(), edge.token.as_bytes()));
    if !ok {
        return AppError::forbidden().into_response();
    }
    if req.uri().path() == "/_edge/ping" {
        return (StatusCode::OK, env!("CARGO_PKG_VERSION")).into_response();
    }
    let ip = req.headers().get("x-shelf-client").and_then(|v| v.to_str().ok()).and_then(|s| s.trim().parse::<IpAddr>().ok());
    let Some(ip) = ip else { return AppError::bad("x-shelf-client missing").into_response() };
    req.headers_mut().remove("x-shelf-edge");
    req.extensions_mut().insert(Remote(ip.to_canonical()));
    next.run(req).await
}

/// The LAN listener must not accept the edge's headers.
pub async fn lan(mut req: Request, next: Next) -> Response {
    for h in ["x-shelf-probe", "x-shelf-client", "x-shelf-edge"] {
        req.headers_mut().remove(h);
    }
    next.run(req).await
}

pub fn ct_eq(a: &[u8], b: &[u8]) -> bool {
    a.len() == b.len() && a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

/// TLS on top of a TCP listener; handshakes run concurrently so a stalled
/// one does not hold up the rest.
pub struct TlsListener {
    rx: mpsc::Receiver<(TlsStream<TcpStream>, SocketAddr)>,
    addr: SocketAddr,
}

impl TlsListener {
    pub async fn bind(addr: &str, edge: &Edge) -> anyhow::Result<Self> {
        let tcp = tokio::net::TcpListener::bind(addr).await?;
        let addr = tcp.local_addr()?;
        let acceptor = TlsAcceptor::from(edge.tls.clone());
        let (tx, rx) = mpsc::channel(16);
        tokio::spawn(async move {
            loop {
                let (s, peer) = match tcp.accept().await {
                    Ok(c) => c,
                    Err(e) => {
                        tracing::warn!("edge listener: {e}");
                        tokio::time::sleep(Duration::from_millis(200)).await;
                        continue;
                    }
                };
                let (acceptor, tx) = (acceptor.clone(), tx.clone());
                tokio::spawn(async move {
                    match tokio::time::timeout(Duration::from_secs(10), acceptor.accept(s)).await {
                        Ok(Ok(t)) => {
                            let _ = tx.send((t, peer)).await;
                        }
                        Ok(Err(e)) => tracing::debug!("edge tls from {peer}: {e}"),
                        Err(_) => tracing::debug!("edge tls from {peer}: handshake timed out"),
                    }
                });
            }
        });
        Ok(TlsListener { rx, addr })
    }
}

impl axum::serve::Listener for TlsListener {
    type Io = TlsStream<TcpStream>;
    type Addr = SocketAddr;

    async fn accept(&mut self) -> (Self::Io, Self::Addr) {
        match self.rx.recv().await {
            Some(c) => c,
            None => std::future::pending().await,
        }
    }

    fn local_addr(&self) -> std::io::Result<SocketAddr> {
        Ok(self.addr)
    }
}

/// A network in a user's list; a bare address is a /32 or /128.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Cidr {
    net: IpAddr,
    bits: u8,
}

fn mask(ip: IpAddr, bits: u8) -> IpAddr {
    match ip {
        IpAddr::V4(a) => IpAddr::V4((u32::from(a) & u32::MAX.checked_shl(32 - bits as u32).unwrap_or(0)).into()),
        IpAddr::V6(a) => IpAddr::V6((u128::from(a) & u128::MAX.checked_shl(128 - bits as u32).unwrap_or(0)).into()),
    }
}

impl Cidr {
    pub fn parse(s: &str) -> Option<Cidr> {
        let (a, b) = s.split_once('/').map_or((s, None), |(a, b)| (a, Some(b)));
        let net = a.parse::<IpAddr>().ok()?.to_canonical();
        let max = if net.is_ipv4() { 32 } else { 128 };
        let bits = match b {
            Some(b) => b.parse::<u8>().ok().filter(|&n| n <= max)?,
            None => max,
        };
        Some(Cidr { net: mask(net, bits), bits })
    }

    pub fn contains(&self, ip: IpAddr) -> bool {
        let ip = ip.to_canonical();
        ip.is_ipv4() == self.net.is_ipv4() && mask(ip, self.bits) == self.net
    }
}

impl std::fmt::Display for Cidr {
    fn fmt(&self, f: &mut std::fmt::Formatter) -> std::fmt::Result {
        write!(f, "{}/{}", self.net, self.bits)
    }
}

/// `AS5610` / `as5610` -> 5610
fn parse_asn(s: &str) -> Option<u32> {
    let n = s.strip_prefix("AS").or_else(|| s.strip_prefix("as")).or_else(|| s.strip_prefix("As"))?;
    n.bytes().all(|b| b.is_ascii_digit()).then(|| n.parse().ok()).flatten().filter(|&n| n != 0)
}

/// `"10.0.0.0/8 192.0.2.7, as5610"` -> `"10.0.0.0/8, 192.0.2.7/32, AS5610"`.
/// An AS number stands for the networks it announces (an ISP, say).
pub fn normalize(list: &str) -> Result<String, String> {
    let mut out = Vec::new();
    for s in list.split([',', ' ', '\n', '\t']).filter(|s| !s.is_empty()) {
        let e = match parse_asn(s) {
            Some(n) => format!("AS{n}"),
            None => {
                let c = Cidr::parse(s).ok_or_else(|| format!("not a network or AS number: {s}"))?;
                if c.bits == 0 {
                    return Err(format!("{s} would be the whole internet"));
                }
                c.to_string()
            }
        };
        if !out.contains(&e) {
            out.push(e);
        }
    }
    Ok(out.join(", "))
}

/// The AS numbers in a normalized list.
pub fn asns_in(list: &str) -> Vec<u32> {
    list.split(", ").filter_map(parse_asn).collect()
}

pub fn allowed(app: &App, list: &str, ip: IpAddr) -> bool {
    allowed_with(list, ip, |n| app.asns.get(&app.db, n))
}

fn allowed_with(list: &str, ip: IpAddr, asn: impl Fn(u32) -> Option<Arc<Vec<Cidr>>>) -> bool {
    list.split(", ").any(|s| match parse_asn(s) {
        Some(n) => asn(n).is_some_and(|nets| nets.iter().any(|c| c.contains(ip))),
        None => Cidr::parse(s).is_some_and(|c| c.contains(ip)),
    })
}

/// What the AS numbers in users' lists announce, from RIPEstat. Kept in the
/// database (`asn_prefixes`) and refreshed daily; a failed fetch keeps what
/// was there.
#[derive(Default)]
pub struct Asns(RwLock<HashMap<u32, Arc<Vec<Cidr>>>>);

const ASN_MAX_AGE: i64 = 86400;

impl Asns {
    /// Falls back to the database: `shelf user remote` may have fetched it.
    fn get(&self, db: &Db, n: u32) -> Option<Arc<Vec<Cidr>>> {
        if let Some(v) = self.0.read().unwrap().get(&n) {
            return Some(v.clone());
        }
        let s: String = db.opt(|c| c.query_row("SELECT prefixes FROM asn_prefixes WHERE asn = ?1", [n], |r| r.get(0))).ok()??;
        let v = Arc::new(s.split(' ').filter_map(Cidr::parse).collect::<Vec<_>>());
        self.0.write().unwrap().insert(n, v.clone());
        Some(v)
    }

    /// Fetches those of `asns` that are missing or older than a day (all of
    /// them with `force`). Per AS: the number of networks, or why not.
    pub async fn refresh(&self, db: &Db, asns: &[u32], force: bool) -> Vec<(u32, Result<usize, String>)> {
        let mut out = Vec::new();
        let t = db::now();
        for &n in asns {
            let fetched: Option<i64> = db.opt(|c| c.query_row("SELECT fetched FROM asn_prefixes WHERE asn = ?1", [n], |r| r.get(0))).ok().flatten();
            if !force && fetched.is_some_and(|f| t - f < ASN_MAX_AGE) {
                continue;
            }
            let r = match fetch_asn(n).await {
                Ok(nets) => {
                    let s = nets.iter().map(Cidr::to_string).collect::<Vec<_>>().join(" ");
                    let saved = db.with(|c| {
                        c.execute(
                            "INSERT INTO asn_prefixes (asn, prefixes, fetched) VALUES (?1, ?2, ?3)
                             ON CONFLICT(asn) DO UPDATE SET prefixes = excluded.prefixes, fetched = excluded.fetched",
                            rusqlite::params![n, s, t],
                        )
                    });
                    match saved {
                        Ok(_) => {
                            tracing::info!("AS{n}: {} networks", nets.len());
                            let len = nets.len();
                            self.0.write().unwrap().insert(n, Arc::new(nets));
                            Ok(len)
                        }
                        Err(e) => Err(e.msg),
                    }
                }
                Err(e) => {
                    tracing::warn!("AS{n}: {e:#}");
                    Err(format!("{e:#}"))
                }
            };
            out.push((n, r));
        }
        out
    }

    /// Hourly: whatever users' lists name is fetched when due; the rest is dropped.
    pub async fn housekeeping(&self, db: &Db) {
        let lists: Vec<String> = db
            .with(|c| {
                let mut st = c.prepare("SELECT remote_cidrs FROM users WHERE remote_cidrs LIKE '%AS%'")?;
                let v = st.query_map([], |r| r.get(0))?.collect::<rusqlite::Result<Vec<_>>>();
                v
            })
            .unwrap_or_default();
        let mut want: Vec<u32> = lists.iter().flat_map(|l| asns_in(l)).collect();
        want.sort_unstable();
        want.dedup();
        self.refresh(db, &want, false).await;
        let keep: HashSet<u32> = want.into_iter().collect();
        self.0.write().unwrap().retain(|n, _| keep.contains(n));
        let _ = db.with(|c| {
            let mut st = c.prepare("SELECT asn FROM asn_prefixes")?;
            let have = st.query_map([], |r| r.get::<_, u32>(0))?.collect::<rusqlite::Result<Vec<_>>>()?;
            for n in have.into_iter().filter(|n| !keep.contains(n)) {
                c.execute("DELETE FROM asn_prefixes WHERE asn = ?1", [n])?;
            }
            Ok(())
        });
    }
}

/// The prefixes RIPEstat saw announced by an AS in the last two weeks.
async fn fetch_asn(n: u32) -> anyhow::Result<Vec<Cidr>> {
    let url = format!("https://stat.ripe.net/data/announced-prefixes/data.json?resource=AS{n}&sourceapp=shelf");
    let client = reqwest::Client::builder().timeout(Duration::from_secs(60)).user_agent(concat!("shelf/", env!("CARGO_PKG_VERSION"))).build()?;
    let body = client.get(url).send().await?.error_for_status()?.bytes().await?;
    let v: serde_json::Value = serde_json::from_slice(&body)?;
    let list = v["data"]["prefixes"].as_array().ok_or_else(|| anyhow::anyhow!("RIPEstat: unexpected answer"))?;
    let mut nets: Vec<Cidr> = list.iter().filter_map(|p| Cidr::parse(p["prefix"].as_str()?)).filter(|c| c.bits > 0).collect();
    nets.dedup();
    anyhow::ensure!(!nets.is_empty(), "announces no networks (RIPEstat)");
    Ok(nets)
}

/// `shelf edge init|show`
pub fn cli(data: &Path, args: &[String]) -> anyhow::Result<()> {
    let d = dir(data);
    match args.first().map(String::as_str) {
        Some("init") => {
            anyhow::ensure!(!d.join("token").exists() || args.iter().any(|a| a == "--force"), "{} exists; --force replaces it", d.display());
            fs::DirBuilder::new().recursive(true).mode(0o700).create(&d)?;
            let ck = rcgen::generate_simple_self_signed(vec!["shelf-onprem".into()])?;
            let token = crypto::random_token(32);
            let pin = hex::encode(Sha256::digest(ck.cert.der()));
            let write = |name: &str, body: &str| -> anyhow::Result<()> {
                use std::io::Write;
                let p = d.join(name);
                let mut f = fs::OpenOptions::new().write(true).create(true).truncate(true).mode(0o600).open(&p)?;
                f.write_all(body.as_bytes())?;
                Ok(())
            };
            write("token", &format!("{token}\n"))?;
            write("cert.pem", &ck.cert.pem())?;
            write("key.pem", &ck.key_pair.serialize_pem())?;
            write("edge.env", &format!("# for shelf-edge: /etc/shelf-edge/edge.env on the edge host\nEDGE_TOKEN={token}\nEDGE_PIN={pin}\n"))?;
            eprintln!("wrote {}; restart shelf, then copy edge.env to the edge host", d.display());
        }
        Some("show") => {
            let pem = fs::read(d.join("cert.pem"))?;
            let cert = CertificateDer::from_pem_slice(&pem)?;
            println!("certificate pin (sha256): {}", hex::encode(Sha256::digest(&cert)));
            println!("edge config: {}", d.join("edge.env").display());
        }
        _ => anyhow::bail!("usage: shelf edge init [--force] | show"),
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cidrs() {
        let ip = |s: &str| s.parse::<IpAddr>().unwrap();
        assert_eq!(normalize("10.1.2.3/8  192.0.2.7,2001:db8::1/32").unwrap(), "10.0.0.0/8, 192.0.2.7/32, 2001:db8::/32");
        assert!(normalize("0.0.0.0/0").is_err());
        assert!(normalize("10.0.0.0/33").is_err());
        assert!(normalize("example.org").is_err());
        assert_eq!(normalize(" ").unwrap(), "");
        let l = normalize("10.0.0.0/8, 192.0.2.7, 2001:db8::/32").unwrap();
        let allowed = |l: &str, ip| allowed_with(l, ip, |_| None);
        assert!(allowed(&l, ip("10.200.0.1")));
        assert!(allowed(&l, ip("::ffff:10.0.0.9")));
        assert!(allowed(&l, ip("192.0.2.7")));
        assert!(!allowed(&l, ip("192.0.2.8")));
        assert!(allowed(&l, ip("2001:db8:ffff::1")));
        assert!(!allowed(&l, ip("2001:db9::1")));
        assert!(!allowed("", ip("10.0.0.1")));
    }

    #[test]
    fn as_numbers() {
        let ip = |s: &str| s.parse::<IpAddr>().unwrap();
        assert_eq!(normalize("as5610 192.0.2.7,AS16019, AS5610").unwrap(), "AS5610, 192.0.2.7/32, AS16019");
        assert!(normalize("AS0").is_err());
        assert!(normalize("AS").is_err());
        assert!(normalize("AS12x").is_err());
        assert!(normalize("AS4294967296").is_err());
        let l = normalize("AS64500, 192.0.2.7").unwrap();
        assert_eq!(asns_in(&l), vec![64500]);
        let nets = Arc::new(vec![Cidr::parse("198.51.100.0/24").unwrap(), Cidr::parse("2001:db8::/32").unwrap()]);
        let known = |n: u32| (n == 64500).then(|| nets.clone());
        assert!(allowed_with(&l, ip("198.51.100.9"), known));
        assert!(allowed_with(&l, ip("2001:db8::5"), known));
        assert!(allowed_with(&l, ip("192.0.2.7"), known));
        assert!(!allowed_with(&l, ip("203.0.113.1"), known));
        // not fetched (yet): nothing from it
        assert!(!allowed_with(&l, ip("198.51.100.9"), |_| None));
    }
}
