/// Unified error types for the HTTP API layer.
///
/// Two-layer model: `InternalError` carries the full causal chain for backend
/// logging; `ApiError` carries only what the frontend should see.
/// The boundary is `IntoResponse` — internal detail gets logged, then stripped.
///
/// See `backend/docs/error-system.md` for the full design doc, rules, and
/// error code catalog.
use axum::{
    http::StatusCode,
    response::{IntoResponse, Response},
    Json,
};
use serde_json::{json, Value};
use std::fmt;

// ─── Public error (what the frontend sees) ───────────────────────────────────

/// Every HTTP error response has this exact shape. No exceptions.
///
/// ```json
/// {
///   "code": "preflight_failed",
///   "error": "Credential check failed",
///   "details": { ... }
/// }
/// ```
///
/// - `code`: stable, machine-readable, snake_case — frontend switches on this
/// - `error`: human-readable message safe to display to end users
/// - `details`: optional structured JSON metadata (field errors, failed integrations, etc.)
#[derive(Debug, Clone)]
pub struct ApiError {
    pub status: StatusCode,
    pub code: &'static str,
    pub message: String,
    pub details: Option<Value>,
}

impl ApiError {
    pub fn new(status: StatusCode, code: &'static str, message: impl Into<String>) -> Self {
        Self {
            status,
            code,
            message: message.into(),
            details: None,
        }
    }

    pub fn with_details(mut self, details: Value) -> Self {
        self.details = Some(details);
        self
    }

    // ── Convenience constructors (public-safe messages only) ─────────────

    pub fn not_found(msg: impl Into<String>) -> Self {
        Self::new(StatusCode::NOT_FOUND, "not_found", msg)
    }

    pub fn bad_request(msg: impl Into<String>) -> Self {
        Self::new(StatusCode::BAD_REQUEST, "bad_request", msg)
    }

    pub fn unauthorized(msg: impl Into<String>) -> Self {
        Self::new(StatusCode::UNAUTHORIZED, "unauthorized", msg)
    }

    pub fn forbidden(msg: impl Into<String>) -> Self {
        Self::new(StatusCode::FORBIDDEN, "forbidden", msg)
    }

    pub fn unprocessable(msg: impl Into<String>) -> Self {
        Self::new(StatusCode::UNPROCESSABLE_ENTITY, "validation_failed", msg)
    }

    pub fn unavailable(msg: impl Into<String>) -> Self {
        Self::new(StatusCode::SERVICE_UNAVAILABLE, "unavailable", msg)
    }

    pub fn internal(msg: impl Into<String>) -> Self {
        Self::new(StatusCode::INTERNAL_SERVER_ERROR, "internal_error", msg)
    }
}

impl fmt::Display for ApiError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "[{}] {}: {}", self.status.as_u16(), self.code, self.message)
    }
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        let mut body = json!({
            "code": self.code,
            "error": self.message,
        });
        if let Some(details) = self.details {
            body["details"] = details;
        }
        (self.status, Json(body)).into_response()
    }
}

// ─── Internal error (what stays in the backend logs) ─────────────────────────

/// Internal errors carry the full causal chain for debugging.
/// They are NEVER sent to the frontend directly — they convert to `ApiError`
/// at the response boundary, logging the internal detail and returning a safe
/// public message.
#[derive(Debug)]
pub struct InternalError {
    /// The public error the frontend will receive.
    pub public: ApiError,
    /// The full internal error chain (for logging only, never exposed).
    pub source: Option<anyhow::Error>,
}

impl InternalError {
    /// Wrap an internal error with a public-facing message.
    /// The source error is logged but never sent to the frontend.
    pub fn new(public: ApiError, source: impl Into<anyhow::Error>) -> Self {
        Self {
            public,
            source: Some(source.into()),
        }
    }

    /// Public-only error (no internal source to log).
    pub fn public(api_error: ApiError) -> Self {
        Self {
            public: api_error,
            source: None,
        }
    }
}

impl fmt::Display for InternalError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}", self.public)?;
        if let Some(ref src) = self.source {
            write!(f, " caused by: {src}")?;
        }
        Ok(())
    }
}

/// THE conversion boundary. This is where internal detail is stripped.
impl IntoResponse for InternalError {
    fn into_response(self) -> Response {
        // Log the full internal chain — this stays in backend logs only
        if let Some(ref source) = self.source {
            tracing::error!(
                status = %self.public.status,
                code = self.public.code,
                error = %source,
                "request failed"
            );
        } else {
            tracing::warn!(
                status = %self.public.status,
                code = self.public.code,
                message = %self.public.message,
                "request failed"
            );
        }
        // Return only the public envelope
        self.public.into_response()
    }
}

// ─── Conversion bridges ──────────────────────────────────────────────────────

/// anyhow::Error → InternalError (generic 500, logs full chain).
///
/// This is the "catch-all" — any `?` on `anyhow::Result` auto-converts.
/// The frontend sees "An internal error occurred", the backend log has the
/// full error chain.
impl From<anyhow::Error> for InternalError {
    fn from(err: anyhow::Error) -> Self {
        InternalError::new(
            ApiError::new(
                StatusCode::INTERNAL_SERVER_ERROR,
                "internal_error",
                "An internal error occurred",
            ),
            err,
        )
    }
}

/// ApiError → InternalError (for public-only errors with no internal source).
impl From<ApiError> for InternalError {
    fn from(api_error: ApiError) -> Self {
        InternalError::public(api_error)
    }
}

/// StatusCode → InternalError (backward compat during migration).
///
/// Allows existing `.map_err(|_| StatusCode::NOT_FOUND)?` patterns to work
/// after changing the return type to `Result<_, InternalError>`.
/// New code should use `ApiError::not_found(...)` instead for better messages.
impl From<StatusCode> for InternalError {
    fn from(status: StatusCode) -> Self {
        let (code, message) = match status.as_u16() {
            400 => ("bad_request", "Bad request"),
            401 => ("unauthorized", "Unauthorized"),
            403 => ("forbidden", "Forbidden"),
            404 => ("not_found", "Not found"),
            422 => ("validation_failed", "Validation failed"),
            503 => ("unavailable", "Service unavailable"),
            _ => ("internal_error", "An internal error occurred"),
        };
        InternalError::public(ApiError::new(status, code, message))
    }
}

/// (StatusCode, Json<Value>) → InternalError (backward compat during migration).
///
/// Allows existing `Err((StatusCode::BAD_REQUEST, Json(json!({"error": "..."}))))` patterns
/// to work after changing the return type. Extracts the "error" field as the message.
/// New code should use `ApiError` directly.
impl From<(StatusCode, Json<Value>)> for InternalError {
    fn from((status, Json(body)): (StatusCode, Json<Value>)) -> Self {
        let (code, _default_msg) = match status.as_u16() {
            400 => ("bad_request", "Bad request"),
            401 => ("unauthorized", "Unauthorized"),
            403 => ("forbidden", "Forbidden"),
            404 => ("not_found", "Not found"),
            422 => ("validation_failed", "Validation failed"),
            503 => ("unavailable", "Service unavailable"),
            _ => ("internal_error", "An internal error occurred"),
        };
        let message = body
            .get("error")
            .and_then(Value::as_str)
            .unwrap_or(_default_msg)
            .to_string();
        // Preserve additional fields from the original JSON as details
        let details = if body.as_object().is_some_and(|o| o.len() > 1) {
            Some(body)
        } else {
            None
        };
        let mut api_error = ApiError::new(status, code, message);
        if let Some(d) = details {
            api_error = api_error.with_details(d);
        }
        InternalError::public(api_error)
    }
}

// ─── Macros ──────────────────────────────────────────────────────────────────

/// Early-return with a public error (no internal source).
///
/// ```rust,ignore
/// api_bail!(NOT_FOUND, "agent_not_found", "Agent '{}' not found", slug);
/// ```
#[macro_export]
macro_rules! api_bail {
    ($status:expr, $code:expr, $($arg:tt)*) => {
        return Err($crate::error::InternalError::from(
            $crate::error::ApiError::new(
                axum::http::StatusCode::$status,
                $code,
                format!($($arg)*),
            )
        ))
    };
}

/// Early-return with an internal error wrapped in a public message.
///
/// ```rust,ignore
/// api_bail_internal!(BAD_GATEWAY, "llm_failed", "LLM call failed", source_err);
/// ```
#[macro_export]
macro_rules! api_bail_internal {
    ($status:expr, $code:expr, $msg:expr, $source:expr) => {
        return Err($crate::error::InternalError::new(
            $crate::error::ApiError::new(axum::http::StatusCode::$status, $code, $msg),
            $source,
        ))
    };
}
