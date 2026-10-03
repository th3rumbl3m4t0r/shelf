use axum::{
    http::StatusCode,
    response::{IntoResponse, Response},
    Json,
};

use crate::vfs::FsError;

/// Every handler error: a status and a message the UI can show as is.
#[derive(Debug)]
pub struct AppError {
    pub status: StatusCode,
    pub msg: String,
}

pub type Res<T> = Result<T, AppError>;

impl AppError {
    pub fn new(status: StatusCode, msg: impl Into<String>) -> Self {
        Self { status, msg: msg.into() }
    }
    pub fn bad(msg: impl Into<String>) -> Self {
        Self::new(StatusCode::BAD_REQUEST, msg)
    }
    pub fn not_found() -> Self {
        Self::new(StatusCode::NOT_FOUND, "not found")
    }
    pub fn forbidden() -> Self {
        Self::new(StatusCode::FORBIDDEN, "not allowed")
    }
    pub fn conflict(msg: impl Into<String>) -> Self {
        Self::new(StatusCode::CONFLICT, msg)
    }
    pub fn unauthorized() -> Self {
        Self::new(StatusCode::UNAUTHORIZED, "login required")
    }
    pub fn internal(msg: impl std::fmt::Display) -> Self {
        tracing::error!("internal: {msg}");
        Self::new(StatusCode::INTERNAL_SERVER_ERROR, "internal error")
    }
}

impl IntoResponse for AppError {
    fn into_response(self) -> Response {
        (self.status, Json(serde_json::json!({ "error": self.msg }))).into_response()
    }
}

impl From<rusqlite::Error> for AppError {
    fn from(e: rusqlite::Error) -> Self {
        Self::internal(format!("db: {e}"))
    }
}

impl From<FsError> for AppError {
    fn from(e: FsError) -> Self {
        match e {
            FsError::NotFound => Self::not_found(),
            FsError::Exists => Self::conflict("already exists"),
            FsError::NotDir => Self::bad("not a folder"),
            FsError::IsDir => Self::bad("is a folder"),
            FsError::Denied => Self::new(StatusCode::FORBIDDEN, "permission denied on storage"),
            FsError::Invalid(m) => Self::bad(m),
            FsError::Io(m) => Self::internal(m),
            FsError::Remote(m) => Self::new(StatusCode::BAD_GATEWAY, m),
        }
    }
}
