use std::{io::Write, os::unix::fs::OpenOptionsExt, path::Path};

use base64::{engine::general_purpose::URL_SAFE_NO_PAD as B64URL, engine::general_purpose::STANDARD as B64, Engine};
use chacha20poly1305::{
    aead::{Aead, KeyInit},
    XChaCha20Poly1305, XNonce,
};
use rand::RngCore;
use sha2::{Digest, Sha256};

/// Seals secrets at rest (SFTP passwords and keys). The key lives in
/// `<data>/secret.key`, 32 random bytes, mode 0600.
pub struct Key(XChaCha20Poly1305);

impl Key {
    pub fn load_or_create(path: &Path) -> anyhow::Result<Self> {
        let bytes = match std::fs::read(path) {
            Ok(b) => b,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                let mut b = vec![0u8; 32];
                rand::thread_rng().fill_bytes(&mut b);
                let mut f = std::fs::OpenOptions::new().write(true).create_new(true).mode(0o600).open(path)?;
                f.write_all(&b)?;
                b
            }
            Err(e) => return Err(e.into()),
        };
        anyhow::ensure!(bytes.len() == 32, "{} must hold 32 bytes", path.display());
        Ok(Key(XChaCha20Poly1305::new_from_slice(&bytes)?))
    }

    pub fn seal(&self, plain: &[u8]) -> String {
        let mut nonce = [0u8; 24];
        rand::thread_rng().fill_bytes(&mut nonce);
        let ct = self.0.encrypt(XNonce::from_slice(&nonce), plain).expect("encrypt");
        let mut out = nonce.to_vec();
        out.extend(ct);
        B64.encode(out)
    }

    pub fn open(&self, sealed: &str) -> Option<Vec<u8>> {
        let raw = B64.decode(sealed).ok()?;
        if raw.len() < 24 {
            return None;
        }
        self.0.decrypt(XNonce::from_slice(&raw[..24]), &raw[24..]).ok()
    }
}

pub fn random_token(bytes: usize) -> String {
    let mut b = vec![0u8; bytes];
    rand::thread_rng().fill_bytes(&mut b);
    B64URL.encode(b)
}

pub fn sha256_hex(s: &str) -> String {
    hex::encode(Sha256::digest(s.as_bytes()))
}
