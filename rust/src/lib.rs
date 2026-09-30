//! Native CLI updates at the executable boundary, before product work.
//!
//! The library owns policy, release selection, installation identity and process
//! coordination. A product supplies a **bundled, trusted** [`Installer`] that
//! preserves its archive, attestation, layout and rollback checks. Never use a
//! downloaded installer script as that callback. Keep the returned [`ActiveLease`]
//! alive until the product command finishes. SDK entrypoints must not call startup.

mod filesystem;
mod process;
mod release;
mod updater;

pub use process::{run_bounded, BoundedOutput};
pub use release::{Asset, Channel, CurlGithub, Product, Release, ReleaseSource, RunningIdentity};
pub use updater::{
    parse_update_command, ActiveLease, CommandAction, CommandRequest, InstallReceipt,
    InstallRequest, InstallationKind, Installer, Paths, Policy, Reentry, StartupContext,
    StartupOutcome, UpdateResult, UpdateStatus, Updater, VerifiedInstallation,
};

use serde::Serialize;
use std::fmt;

/// Stable categories suitable for structured CLI errors.
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ErrorCode {
    Configuration,
    InvalidCommand,
    Unsupported,
    UnsafePath,
    InvalidState,
    Ownership,
    Busy,
    Network,
    Limit,
    Release,
    Installer,
    UnsafeInstallation,
    Io,
}

#[derive(Clone, Debug, Serialize)]
pub struct Error {
    pub code: ErrorCode,
    pub message: String,
}

impl Error {
    pub fn new(code: ErrorCode, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }
    pub(crate) fn io(context: &str, error: std::io::Error) -> Self {
        Self::new(ErrorCode::Io, format!("{context}: {error}"))
    }
}

impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}", self.message)
    }
}

impl std::error::Error for Error {}

pub type Result<T> = std::result::Result<T, Error>;
