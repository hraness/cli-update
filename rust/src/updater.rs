use crate::filesystem;
use crate::release::{self, Product, Release, ReleaseSource, RunningIdentity};
use crate::{Error, ErrorCode, Result};
use fs2::FileExt;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::ffi::{OsStr, OsString};
use std::fs::File;
use std::path::{Path, PathBuf};
use std::process::{Command, ExitStatus, Stdio};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

const DAY: u64 = 86_400;
const SCHEMA: &str = "hraness.cli-update.native.v1";

#[derive(Clone, Copy, Debug, Default, Deserialize, Serialize, Eq, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum Policy {
    #[default]
    Auto,
    Notify,
    #[serde(alias = "disable")]
    Disabled,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, Eq, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum InstallationKind {
    NativeRelease,
    Source,
    Cargo,
    Homebrew,
    Unknown,
}

/// Written by the product's verified installer. `release_tag` is the complete
/// verified published tag, including prerelease identity; a CARGO version alone
/// is insufficient. This receipt is not a substitute for archive/attestation
/// verification by that installer.
#[derive(Clone, Debug, Deserialize, Serialize, Eq, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct InstallReceipt {
    pub schema: String,
    pub product: String,
    pub repository: String,
    pub kind: InstallationKind,
    pub executable: PathBuf,
    pub binary_sha256: String,
    pub release_tag: String,
    #[serde(default)]
    pub build_sha: Option<String>,
    pub release_id: u64,
    pub archive_name: String,
    pub archive_sha256: String,
    pub platform: String,
    pub pinned: bool,
}

impl InstallReceipt {
    pub const SCHEMA: &'static str = SCHEMA;

    fn validate(&self, product: &Product, executable: &Path) -> Result<()> {
        filesystem::absolute(&self.executable)?;
        if self.kind != InstallationKind::NativeRelease {
            return Err(Error::new(ErrorCode::Unsupported, match self.kind {
                InstallationKind::Homebrew => "Homebrew owns this executable; use brew upgrade for the installed formula.",
                InstallationKind::Cargo => "Cargo owns this executable; use the original cargo install command and exact release tag.",
                InstallationKind::Source => "This is a source installation; update and rebuild it through its source workflow.",
                _ => "This installation is not owned by the product's native release installer.",
            }));
        }
        if self.schema != SCHEMA
            || self.product != product.id
            || self.repository != product.repository
            || self.platform != product.platform
            || self.executable != executable
            || self.release_id == 0
            || !filesystem::valid_digest(&self.binary_sha256)
            || !filesystem::valid_digest(&self.archive_sha256)
            || self
                .build_sha
                .as_deref()
                .is_some_and(|sha| !release::valid_build_sha(sha))
            || (matches!(product.channel, crate::Channel::Prerelease(_))
                && self.build_sha.is_none())
            || !product.accepts(&product.version(&self.release_tag)?)
            || !product
                .asset_names(&self.release_tag)?
                .contains(&self.archive_name)
        {
            return Err(Error::new(ErrorCode::Ownership, "Install receipt does not match the running executable and configured release identity"));
        }
        if self.executable.file_name() != Some(OsStr::new(&product.executable_name)) {
            return Err(Error::new(
                ErrorCode::Ownership,
                "Receipt executable has the wrong product filename",
            ));
        }
        Ok(())
    }

    /// For an initial verified product installation. Only call after the
    /// product's archive, attestation, layout and executable identity checks.
    /// Existing foreign receipts, symlinks and unsafe parents are refused.
    pub fn write_verified(&self, product: &Product, path: &Path) -> Result<()> {
        product.validate()?;
        // A deliberately pinned native install still needs an honest receipt;
        // eligibility checks later preserve that pin instead of updating it.
        self.validate(product, &self.executable)?;
        filesystem::verify_executable_mode(&self.executable)?;
        if filesystem::sha256_file(&self.executable)? != self.binary_sha256 {
            return Err(Error::new(
                ErrorCode::Ownership,
                "Cannot publish a receipt for different executable bytes",
            ));
        }
        if filesystem::path_exists(path)? {
            let old: InstallReceipt = filesystem::read_json(filesystem::open_path(path, false)?)?;
            if old.product != self.product
                || old.repository != self.repository
                || old.executable != self.executable
            {
                return Err(Error::new(
                    ErrorCode::Ownership,
                    "Refusing to replace a foreign install receipt",
                ));
            }
        }
        let directory = filesystem::open_dir(
            path.parent().ok_or_else(|| {
                Error::new(ErrorCode::UnsafePath, "Receipt needs a parent directory")
            })?,
            false,
            false,
        )?;
        let filename = path
            .file_name()
            .and_then(OsStr::to_str)
            .ok_or_else(|| Error::new(ErrorCode::UnsafePath, "Receipt filename must be Unicode"))?;
        filesystem::write_atomic(&directory, filename, self)
    }
}

#[derive(Clone, Debug)]
pub struct Paths {
    /// A dedicated user-owned 0700 preference directory; shared by all aliases.
    /// Activity locks are separately bound beside the actual running executable.
    pub state_dir: PathBuf,
    pub receipt: PathBuf,
}

#[derive(Clone, Debug)]
pub struct VerifiedInstallation {
    pub receipt: InstallReceipt,
}

pub struct InstallRequest<'a> {
    pub product: &'a Product,
    pub installation: &'a VerifiedInstallation,
    pub release: &'a Release,
    pub paths: &'a Paths,
    pub automatic: bool,
    updater: &'a Updater,
    coordination: &'a Store,
    activity_lock: &'a OwnedLock,
}

impl InstallRequest<'_> {
    /// The installer must call this again immediately before its first write to
    /// installed code, after lengthy download/verification/staging work.
    pub fn revalidate(&self) -> Result<VerifiedInstallation> {
        self.coordination
            .check_lock(self.activity_lock, "activity.lock")?;
        if self.automatic && self.updater.state()?.policy != Policy::Auto {
            return Err(Error::new(
                ErrorCode::Installer,
                "Automatic update was cancelled by a saved policy change before replacement",
            ));
        }
        // Compare the stored install record, not executable bytes: under a
        // repair the bytes legitimately differ from the receipt being
        // replaced, and drifted bytes get overwritten either way.
        let now = self.updater.stored_receipt()?;
        if now != self.installation.receipt {
            return Err(Error::new(
                ErrorCode::Ownership,
                "Installation changed before replacement",
            ));
        }
        Ok(VerifiedInstallation { receipt: now })
    }

    /// Publish the new receipt only after the verified executable is in place.
    /// The product remains responsible for rollback if this fails.
    pub fn publish_receipt(&self, receipt: &InstallReceipt) -> Result<()> {
        self.updater.validate_target(receipt, self.release)?;
        // A replacement preserves the recorded pin: repair restores a pinned
        // install as pinned, and no update may silently set or clear one.
        if receipt.pinned != self.installation.receipt.pinned {
            return Err(Error::new(
                ErrorCode::Ownership,
                "Install receipt may not change the recorded version pin",
            ));
        }
        let existing: InstallReceipt =
            filesystem::read_json(filesystem::open_path(&self.paths.receipt, false)?)?;
        if existing != self.installation.receipt {
            return Err(Error::new(
                ErrorCode::Ownership,
                "Install receipt changed during replacement",
            ));
        }
        receipt.write_verified(self.product, &self.paths.receipt)
    }
}

pub trait Installer {
    /// Trusted bundled code only. Preserve published digest and stronger existing
    /// attestation checks, safe archive members/platform/layout, staging beside
    /// the destination, atomic replacement, executable smoke checks and rollback.
    /// Revalidate just before replacement; publish the receipt last. Do not run a
    /// downloaded mutable script, change source/manager installs or stored pins,
    /// restart a service, or touch product data. This call runs under the exclusive
    /// activity lock, and must bound all downloads, IO, subprocesses and waits.
    /// Installed-code writes, receipt publication and rollback MUST occur in this
    /// same process. Child helpers may only download, verify or stage; they must
    /// never replace installed code or receipts after the lock owner could exit.
    /// There is no subprocess transaction-custody transfer in this API.
    fn install(&self, request: &InstallRequest<'_>) -> Result<()>;
}

#[derive(Clone, Copy, Debug, Serialize, Eq, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum UpdateStatus {
    Current,
    Available,
    Updated,
    /// An install whose recorded release stayed selected but whose executable
    /// bytes were restored because they no longer matched the receipt.
    Repaired,
    /// The install receipt is valid but the executable bytes differ from it;
    /// an explicit `update` restores a verified release.
    Mismatch,
    Enabled,
    Disabled,
    Unsupported,
    Busy,
    Skipped,
    Failed,
}

#[derive(Clone, Debug, Serialize)]
pub struct UpdateResult {
    pub schema: &'static str,
    pub product: String,
    pub status: UpdateStatus,
    pub policy: Policy,
    pub supported: bool,
    pub automatic: bool,
    pub current: Option<String>,
    pub latest: Option<String>,
    pub reason: Option<String>,
    pub instructions: Option<String>,
}

impl UpdateResult {
    pub fn json(&self) -> Result<String> {
        serde_json::to_string(self)
            .map_err(|_| Error::new(ErrorCode::InvalidState, "Cannot serialize update result"))
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum CommandAction {
    Install,
    Check,
    Status,
    Enable,
    Disable,
}
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct CommandRequest {
    pub action: CommandAction,
    pub json: bool,
}

/// Parse argv *after* argv[0]. Non-update commands return None, with no effects.
pub fn parse_update_command(args: &[OsString]) -> Result<Option<CommandRequest>> {
    if args.first().map(OsString::as_os_str) != Some(OsStr::new("update")) {
        return Ok(None);
    }
    let mut action = None;
    let mut json = false;
    for arg in &args[1..] {
        if arg == "--json" {
            if json {
                return Err(Error::new(ErrorCode::InvalidCommand, "Duplicate --json"));
            }
            json = true;
            continue;
        }
        let selected = match arg.to_str() {
            Some("check" | "--check") => CommandAction::Check,
            Some("status") => CommandAction::Status,
            Some("enable") => CommandAction::Enable,
            Some("disable") => CommandAction::Disable,
            Some("install") => CommandAction::Install,
            _ => {
                return Err(Error::new(
                    ErrorCode::InvalidCommand,
                    "Usage: update [check|status|enable|disable] [--json]",
                ))
            }
        };
        if action.replace(selected).is_some() {
            return Err(Error::new(
                ErrorCode::InvalidCommand,
                "Specify only one update action",
            ));
        }
    }
    Ok(Some(CommandRequest {
        action: action.unwrap_or(CommandAction::Install),
        json,
    }))
}

#[derive(Clone, Debug)]
pub struct StartupContext {
    pub args: Vec<OsString>,
    /// Set only from the product parser when it guarantees this invocation exits
    /// after help/version/completion/update routing and performs no product work.
    /// Literal argument matching alone is not a sufficient declaration.
    pub product_effect_free: bool,
    pub no_update: bool,
    pub ci: bool,
    pub reentered: bool,
    /// Product admission flags must be set before calling the updater.
    pub offline: bool,
    pub exact_version_bound: bool,
    pub nested: bool,
    pub deployment: bool,
    pub now_unix: u64,
}

impl StartupContext {
    pub fn from_process() -> Self {
        let ci = std::env::var("CI")
            .ok()
            .map(|value| {
                !matches!(
                    value.trim().to_ascii_lowercase().as_str(),
                    "" | "0" | "false" | "no" | "off"
                )
            })
            .unwrap_or(false);
        Self {
            args: std::env::args_os().skip(1).collect(),
            product_effect_free: false,
            no_update: std::env::var_os("HRANESS_NO_UPDATE").as_deref() == Some(OsStr::new("1")),
            ci,
            reentered: std::env::var_os("HRANESS_CLI_UPDATE_REENTERED").as_deref()
                == Some(OsStr::new("1")),
            offline: false,
            exact_version_bound: false,
            nested: false,
            deployment: false,
            now_unix: SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap_or_default()
                .as_secs(),
        }
    }

    fn effect_free(&self) -> bool {
        self.product_effect_free
            || (self.args.len() == 1
                && matches!(
                    self.args[0].to_str(),
                    Some("--help" | "-h" | "--version" | "-V" | "help" | "version")
                ))
    }

    fn no_incidental(&self) -> bool {
        self.no_update
            || self.ci
            || self.reentered
            || self.offline
            || self.exact_version_bound
            || self.nested
            || self.deployment
            // An ambiguous help-looking token may suppress incidental networking,
            // but must retain a command lease. Nothing after `--` is inferred.
            || self.args.iter().take_while(|arg| arg.as_os_str() != OsStr::new("--"))
                .any(|arg| matches!(arg.to_str(), Some("--help" | "-h" | "--version" | "-V")))
            || matches!(self.args.first().and_then(|arg| arg.to_str()), Some("help" | "version" | "completion" | "completions" | "update"))
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct State {
    schema: String,
    #[serde(default)]
    policy: Policy,
    last_check_unix: Option<u64>,
    installation_key: Option<String>,
    last_repair_unix: Option<u64>,
}
impl Default for State {
    fn default() -> Self {
        Self {
            schema: SCHEMA.to_owned(),
            policy: Policy::Auto,
            last_check_unix: None,
            installation_key: None,
            last_repair_unix: None,
        }
    }
}

struct Store {
    path: PathBuf,
    directory: File,
}
impl Store {
    fn open(path: &Path, create: bool) -> Result<Self> {
        Ok(Self {
            path: path.to_owned(),
            directory: filesystem::open_dir(path, create, true)?,
        })
    }
    fn validate(&self) -> Result<()> {
        if !filesystem::same_file(
            &self.directory,
            &filesystem::open_dir(&self.path, false, true)?,
        )? {
            return Err(Error::new(
                ErrorCode::UnsafePath,
                "Updater state directory changed",
            ));
        }
        Ok(())
    }
    fn read(&self) -> Result<State> {
        self.validate()?;
        if !filesystem::path_exists(&self.path.join("state.json"))? {
            return Ok(State::default());
        }
        let state: State = filesystem::read_json(filesystem::open_file(
            &self.directory,
            OsStr::new("state.json"),
            false,
            true,
        )?)?;
        if state.schema != SCHEMA
            || state
                .installation_key
                .as_ref()
                .is_some_and(|key| !filesystem::valid_digest(key))
        {
            return Err(Error::new(
                ErrorCode::InvalidState,
                "Unknown updater state schema or installation identity",
            ));
        }
        Ok(state)
    }
    fn lock(&self, name: &str, exclusive: bool) -> Result<Option<OwnedLock>> {
        self.validate()?;
        let file = filesystem::open_file(&self.directory, OsStr::new(name), true, true)?;
        let locked = if exclusive {
            FileExt::try_lock_exclusive(&file)
        } else {
            FileExt::try_lock_shared(&file)
        };
        match locked {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => return Ok(None),
            Err(error) => return Err(Error::io("Acquire updater lock", error)),
        }
        let lock = OwnedLock {
            file,
            owner: std::process::id(),
        };
        self.check_lock(&lock, name)?;
        Ok(Some(lock))
    }
    fn check_lock(&self, lock: &OwnedLock, name: &str) -> Result<()> {
        if lock.owner != std::process::id() {
            return Err(Error::new(
                ErrorCode::Ownership,
                "An inherited updater lock belongs to its original process",
            ));
        }
        self.validate()?;
        if !filesystem::same_file(
            &lock.file,
            &filesystem::open_file(&self.directory, OsStr::new(name), false, true)?,
        )? {
            return Err(Error::new(
                ErrorCode::UnsafePath,
                "Updater lock was replaced",
            ));
        }
        Ok(())
    }
    fn update(&self, change: impl FnOnce(&mut State)) -> Result<State> {
        let mut lock = self.lock("state.lock", true)?;
        for _ in 0..20 {
            if lock.is_some() {
                break;
            }
            std::thread::sleep(Duration::from_millis(10));
            lock = self.lock("state.lock", true)?;
        }
        let _lock = lock.ok_or_else(|| {
            Error::new(
                ErrorCode::Busy,
                "Updater policy is being written by another command",
            )
        })?;
        let mut state = self.read()?;
        change(&mut state);
        self.validate()?;
        filesystem::write_atomic(&self.directory, "state.json", &state)?;
        Ok(state)
    }
    fn initialize_policy(&self, policy: Policy) -> Result<Policy> {
        let _lock = self.lock("state.lock", true)?.ok_or_else(|| {
            Error::new(
                ErrorCode::Busy,
                "Updater policy is being written by another command",
            )
        })?;
        let exists = filesystem::path_exists(&self.path.join("state.json"))?;
        let mut state = self.read()?;
        if !exists {
            state.policy = policy;
            self.validate()?;
            filesystem::write_atomic(&self.directory, "state.json", &state)?;
        }
        Ok(state.policy)
    }
    fn shared(&self) -> Result<ActiveLease> {
        let file = self.lock("activity.lock", false)?.ok_or_else(|| {
            Error::new(
                ErrorCode::Busy,
                "An update is replacing this installation; retry after it finishes",
            )
        })?;
        Ok(ActiveLease { file })
    }
}

/// flock is tied to an open file description, including duplicates temporarily
/// inherited by a concurrent fork before close-on-exec. Explicitly unlock when
/// the owning scope ends, so an unrelated child cannot prolong that scope. A
/// forked child's destructor must never release the original owner's lock.
#[derive(Debug)]
struct OwnedLock {
    file: File,
    owner: u32,
}
impl std::ops::Deref for OwnedLock {
    type Target = File;
    fn deref(&self) -> &File {
        &self.file
    }
}
impl Drop for OwnedLock {
    fn drop(&mut self) {
        if self.owner == std::process::id() {
            let _ = FileExt::unlock(&self.file);
        }
    }
}

/// Keep this value alive for the *whole* product command, including awaited work.
/// OS locks release automatically on process death; no PID expiry guesses or
/// stale lease deletion can release an active process's protection.
#[derive(Debug)]
pub struct ActiveLease {
    file: OwnedLock,
}
impl ActiveLease {
    pub fn is_held(&self) -> bool {
        self.file.owner == std::process::id() && self.file.metadata().is_ok()
    }
}

pub enum StartupOutcome {
    Continue {
        lease: Option<ActiveLease>,
        report: UpdateResult,
    },
    Reenter(Reentry),
}

/// A successful automatic replacement must re-enter before any product work.
/// The wrapper retains its shared lease until the child exits and inherits stdin,
/// stdout and stderr without reading or replaying command input.
pub struct Reentry {
    updater: Box<Updater>,
    installation: Box<VerifiedInstallation>,
    args: Vec<OsString>,
    lease: ActiveLease,
    pub report: UpdateResult,
}
impl Reentry {
    pub fn run(self) -> Result<ExitStatus> {
        let verified = self.updater.inspect()?;
        if verified.receipt != self.installation.receipt || !self.lease.is_held() {
            return Err(Error::new(
                ErrorCode::UnsafeInstallation,
                "Updated executable changed before re-entry",
            ));
        }
        Command::new(&verified.receipt.executable)
            .args(&self.args)
            .env("HRANESS_NO_UPDATE", "1")
            .env("HRANESS_CLI_UPDATE_REENTERED", "1")
            .stdin(Stdio::inherit())
            .stdout(Stdio::inherit())
            .stderr(Stdio::inherit())
            .status()
            .map_err(|e| Error::io("Re-enter updated executable", e))
    }

    /// Preserve the child's exit code, including signal termination on Unix.
    pub fn run_and_exit(self) -> ! {
        match self.run() {
            Ok(status) => {
                if let Some(code) = status.code() {
                    std::process::exit(code);
                }
                #[cfg(unix)]
                {
                    use std::os::unix::process::ExitStatusExt;
                    if let Some(signal) = status.signal() {
                        // SAFETY: restore only the child's terminating signal,
                        // then deliver it to this wrapper, never another process.
                        unsafe {
                            libc::signal(signal, libc::SIG_DFL);
                            libc::raise(signal);
                        }
                        std::process::exit(128 + signal);
                    }
                }
                std::process::exit(1);
            }
            Err(error) => {
                eprintln!("update: {error}");
                std::process::exit(1);
            }
        }
    }
}

#[derive(Clone, Debug)]
pub struct Updater {
    product: Product,
    paths: Paths,
    executable: PathBuf,
}
impl Updater {
    /// The only constructor needed by products. Always binds the OS-reported
    /// currently running executable, not PATH or a manifest's preferred binary.
    pub fn new(product: Product, paths: Paths) -> Result<Self> {
        let executable = std::env::current_exe()
            .and_then(|path| path.canonicalize())
            .map_err(|e| Error::io("Locate canonical running executable", e))?;
        Self::for_executable(product, paths, executable)
    }

    /// Injection boundary for deterministic fixture tests and executable adapters.
    /// Production callers must pass `std::env::current_exe()` without substituting
    /// a receipt path, PATH lookup, source tree, or a different executable.
    pub fn for_executable(product: Product, paths: Paths, executable: PathBuf) -> Result<Self> {
        product.validate()?;
        filesystem::absolute(&paths.state_dir)?;
        filesystem::absolute(&paths.receipt)?;
        filesystem::absolute(&executable)?;
        if executable.file_name().is_none() {
            return Err(Error::new(
                ErrorCode::Configuration,
                "Running executable must name a file, not a filesystem root",
            ));
        }
        Ok(Self {
            product,
            paths,
            executable,
        })
    }

    /// Verify installed bytes and receipt on disk. This is deliberately separate
    /// from admission of the loaded image: an updating parent must inspect the
    /// new target before re-entry while it still runs its original image.
    pub fn inspect(&self) -> Result<VerifiedInstallation> {
        self.inspect_native(false)
    }

    fn inspect_native(&self, allow_pinned: bool) -> Result<VerifiedInstallation> {
        let installation = self.inspect_receipt_bound(allow_pinned)?;
        if filesystem::sha256_file(&self.executable)? != installation.receipt.binary_sha256 {
            return Err(Error::new(
                ErrorCode::Ownership,
                "Running executable bytes do not match the native install receipt",
            ));
        }
        Ok(installation)
    }

    /// Everything `inspect_native` proves except executable byte equality with
    /// the receipt: a valid product-owned native receipt bound to this managed
    /// path, outside package-manager and source-checkout locations.
    fn inspect_receipt_bound(&self, allow_pinned: bool) -> Result<VerifiedInstallation> {
        if !filesystem::supported() {
            return Err(Error::new(ErrorCode::Unsupported, "Native self-update is not yet supported on Windows; use the product's verified Windows installer. No executable or state was changed."));
        }
        // Never infer ownership from a conventional ~/.local/bin location.
        if !filesystem::path_exists(&self.paths.receipt)? {
            return Err(Error::new(ErrorCode::Unsupported, "No verified native release receipt is present; source, Cargo, Homebrew and manually copied binaries are not eligible."));
        }
        let receipt: InstallReceipt =
            filesystem::read_json(filesystem::open_path(&self.paths.receipt, false)?)?;
        receipt.validate(&self.product, &self.executable)?;
        let path_parts: Vec<_> = self
            .executable
            .components()
            .filter_map(|c| c.as_os_str().to_str())
            .collect();
        if path_parts.iter().any(|part| {
            matches!(
                *part,
                "Cellar" | ".cargo" | "target" | "node_modules" | ".git"
            )
        }) {
            return Err(Error::new(
                ErrorCode::Unsupported,
                "Package-manager and source build paths are not native installer-owned paths",
            ));
        }
        for parent in self.executable.ancestors().skip(1) {
            if filesystem::path_exists(&parent.join(".git"))?
                && filesystem::path_exists(&parent.join("Cargo.toml"))?
            {
                return Err(Error::new(
                    ErrorCode::Unsupported,
                    "Executable is inside a source checkout; use its source workflow.",
                ));
            }
        }
        filesystem::verify_executable_mode(&self.executable)?;
        if receipt.pinned && !allow_pinned {
            return Err(Error::new(ErrorCode::Unsupported, "This installation is explicitly version-bound; self-update will not change the pin."));
        }
        Ok(VerifiedInstallation { receipt })
    }

    /// The stored install record alone. Under an owned lock this is the
    /// identity a replacement must not disturb; executable bytes are verified
    /// separately where they matter.
    fn stored_receipt(&self) -> Result<InstallReceipt> {
        filesystem::read_json(filesystem::open_path(&self.paths.receipt, false)?)
    }

    fn verify_loaded_image(&self, installation: &VerifiedInstallation) -> Result<()> {
        let matches = match &self.product.running_identity {
            RunningIdentity::Release {
                release_tag,
                build_sha,
            } => {
                installation.receipt.release_tag == *release_tag
                    && build_sha
                        .is_none_or(|sha| installation.receipt.build_sha.as_deref() == Some(sha))
            }
            RunningIdentity::Source => false,
        };
        if !matches {
            return Err(Error::new(ErrorCode::UnsafeInstallation, "The loaded executable's embedded release/build identity differs from the verified installed receipt. Invoke the current executable again before product work."));
        }
        Ok(())
    }

    fn state(&self) -> Result<State> {
        if !filesystem::path_exists(&self.paths.state_dir)? {
            return Ok(State::default());
        }
        Store::open(&self.paths.state_dir, false)?.read()
    }

    /// Fixed per-installation authority, independent of HOME, XDG, preference
    /// overrides and receipt lookup overrides. Products must use the same fixed
    /// Product::id across aliases. The OS-reported executable is canonical.
    pub fn coordination_directory(&self) -> PathBuf {
        self.executable
            .parent()
            .expect("absolute executable has parent")
            .join(format!(".hraness-cli-update-{}", self.product.id))
    }

    fn report(
        &self,
        status: UpdateStatus,
        policy: Policy,
        installation: Option<&VerifiedInstallation>,
        automatic: bool,
        reason: Option<String>,
    ) -> UpdateResult {
        UpdateResult {
            schema: "hraness.cli-update.result.v1",
            product: self.product.id.clone(),
            status,
            policy,
            supported: installation.is_some_and(|i| !i.receipt.pinned),
            automatic,
            current: installation.map(|i| i.receipt.release_tag.clone()),
            latest: None,
            reason,
            instructions: if installation.is_none_or(|i| i.receipt.pinned) {
                Some(self.product.manual_instructions.clone())
            } else {
                None
            },
        }
    }

    fn key(&self) -> String {
        #[cfg(unix)]
        {
            use std::os::unix::ffi::OsStrExt;
            format!(
                "{:x}",
                Sha256::digest(self.executable.as_os_str().as_bytes())
            )
        }
        #[cfg(not(unix))]
        {
            format!(
                "{:x}",
                Sha256::digest(self.executable.to_string_lossy().as_bytes())
            )
        }
    }

    fn validate_target(&self, receipt: &InstallReceipt, release: &Release) -> Result<()> {
        receipt.validate(&self.product, &self.executable)?;
        if receipt.release_tag != release.tag_name || receipt.release_id != release.id {
            return Err(Error::new(
                ErrorCode::Ownership,
                "Installed receipt is not for the selected exact release",
            ));
        }
        Ok(())
    }

    fn replace(
        &self,
        current: &VerifiedInstallation,
        release: &Release,
        installer: &dyn Installer,
        automatic: bool,
        coordination: &Store,
        activity_lock: &OwnedLock,
    ) -> Result<VerifiedInstallation> {
        coordination.check_lock(activity_lock, "activity.lock")?;
        // Receipt equality is the invariant here; drifted executable bytes are
        // exactly what this replacement is about to overwrite.
        if self.stored_receipt()? != current.receipt {
            return Err(Error::new(
                ErrorCode::Ownership,
                "Installation changed before update",
            ));
        }
        let request = InstallRequest {
            product: &self.product,
            installation: current,
            release,
            paths: &self.paths,
            automatic,
            updater: self,
            coordination,
            activity_lock,
        };
        let result = installer.install(&request);
        // Post-install verification admits a preserved pin: it checks that the
        // published receipt and executable bytes again describe the installed
        // release, not whether the install is self-update eligible.
        match (result, self.inspect_native(true)) {
            (Ok(()), Ok(after)) => {
                self.validate_target(&after.receipt, release).map_err(|_| Error::new(ErrorCode::UnsafeInstallation, "Installer did not publish the selected verified release; product work must not continue"))?;
                if after.receipt.pinned != current.receipt.pinned {
                    return Err(Error::new(ErrorCode::UnsafeInstallation, "Update changed the installation's recorded version pin; product work must not continue. Restore using the product's verified installer."));
                }
                Ok(after)
            }
            (Err(error), Ok(after)) if after.receipt == current.receipt => Err(Error::new(ErrorCode::Installer, format!("Update failed and the original installation remains verified: {error}"))),
            _ => Err(Error::new(ErrorCode::UnsafeInstallation, "Update left an unverified or unexpected installation; product work must not continue. Restore using the product's verified installer.")),
        }
    }

    /// Explicit command execution. `status`, `enable` and `disable` do not use
    /// the release source or installer. Disabled automatic policy does not block
    /// an explicit user-requested update. Pinned/unsupported installs stay intact.
    pub fn execute(
        &self,
        command: CommandAction,
        source: &dyn ReleaseSource,
        installer: &dyn Installer,
    ) -> Result<UpdateResult> {
        if !filesystem::supported() {
            return Ok(self.report(UpdateStatus::Unsupported, Policy::Auto, None, false, Some("This platform has no supported native update transaction; use the verified platform installer.".into())));
        }
        if matches!(command, CommandAction::Enable | CommandAction::Disable) {
            let store = Store::open(&self.paths.state_dir, true)?;
            let policy = if command == CommandAction::Enable {
                Policy::Auto
            } else {
                Policy::Disabled
            };
            let state = store.update(|s| s.policy = policy)?;
            let installation = self.inspect().ok();
            return Ok(self.report(
                if policy == Policy::Auto {
                    UpdateStatus::Enabled
                } else {
                    UpdateStatus::Disabled
                },
                state.policy,
                installation.as_ref(),
                false,
                None,
            ));
        }
        let state = self.state()?;
        let (current, repair) = match self.inspect() {
            Ok(value) => (value, false),
            Err(error) if error.code == ErrorCode::Unsupported => {
                // `inspect()` reports pinned installations as unsupported before
                // comparing bytes. A pinned install whose bytes drifted repairs
                // to its recorded pin; everything else reports exactly as before.
                match self.inspect_receipt_bound(true) {
                    Ok(bound)
                        if command == CommandAction::Install
                            && filesystem::sha256_file(&self.executable)
                                .is_ok_and(|sha| sha != bound.receipt.binary_sha256) =>
                    {
                        (bound, true)
                    }
                    _ => {
                        return Ok(self.report(
                            UpdateStatus::Unsupported,
                            state.policy,
                            None,
                            false,
                            Some(error.message),
                        ))
                    }
                }
            }
            // The receipt still proves this path is owned by the product's
            // installer; only the executable bytes drifted (a manual copy, an
            // interrupted earlier write). An explicit install repairs it;
            // read-only actions report the mismatch instead of failing.
            Err(error) if error.code == ErrorCode::Ownership => {
                let bound = self.inspect_receipt_bound(true)?;
                match command {
                    CommandAction::Install => (bound, true),
                    CommandAction::Check | CommandAction::Status => {
                        let mut report = self.report(
                            UpdateStatus::Mismatch,
                            state.policy,
                            Some(&bound),
                            false,
                            Some("The installed executable does not match its verified install receipt; an explicit `update` restores a verified release.".into()),
                        );
                        if command == CommandAction::Check {
                            report.latest = source
                                .releases(&self.product)
                                .ok()
                                .and_then(|releases| {
                                    release::select(
                                        &self.product,
                                        &bound.receipt.release_tag,
                                        releases,
                                    )
                                    .ok()
                                    .flatten()
                                })
                                .map(|release| release.tag_name);
                        }
                        return Ok(report);
                    }
                    _ => return Err(error),
                }
            }
            Err(error) => return Err(error),
        };
        if command == CommandAction::Status {
            return Ok(self.report(
                UpdateStatus::Current,
                state.policy,
                Some(&current),
                false,
                Some("Status is local only; no release check was made.".into()),
            ));
        }
        let store = Store::open(&self.paths.state_dir, true)?;
        let coordination = Store::open(&self.coordination_directory(), true)?;
        let Some(lock) = coordination.lock("activity.lock", command == CommandAction::Install)?
        else {
            return Ok(self.report(
                UpdateStatus::Busy,
                state.policy,
                Some(&current),
                false,
                Some("Another command is using or updating this installation.".into()),
            ));
        };
        let current = if repair {
            // Receipt equality is the admission invariant under repair; the
            // drifted bytes are exactly what replacement overwrites.
            if self.stored_receipt()? != current.receipt {
                return Err(Error::new(
                    ErrorCode::Ownership,
                    "Installation changed before repair",
                ));
            }
            current
        } else {
            let checked = self.inspect()?;
            self.verify_loaded_image(&checked)?;
            checked
        };
        let releases = source.releases(&self.product)?;
        let selected = if repair {
            self.repair_selection(&current.receipt, releases)?
        } else {
            release::select(&self.product, &current.receipt.release_tag, releases)?
        };
        let Some(release) = selected else {
            return Ok(self.report(
                UpdateStatus::Current,
                state.policy,
                Some(&current),
                false,
                None,
            ));
        };
        if command == CommandAction::Check {
            let mut report = self.report(
                UpdateStatus::Available,
                state.policy,
                Some(&current),
                false,
                None,
            );
            report.latest = Some(release.tag_name);
            return Ok(report);
        }
        let preserved = if repair {
            Some(self.preserve_drifted_bytes()?)
        } else {
            None
        };
        let after = self.replace(&current, &release, installer, false, &coordination, &lock)?;
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs();
        store.update(|s| {
            s.last_check_unix = Some(now);
            s.installation_key = Some(self.key());
            s.last_repair_unix = None;
        })?;
        let mut report = self.report(
            if repair {
                UpdateStatus::Repaired
            } else {
                UpdateStatus::Updated
            },
            state.policy,
            Some(&after),
            false,
            preserved.map(|path| {
                format!(
                    "The replaced executable was preserved at {}.",
                    path.display()
                )
            }),
        );
        report.latest = Some(release.tag_name);
        Ok(report)
    }

    /// Select what an explicit repair installs. A pinned installation is
    /// restored to its recorded pin; otherwise the newest acceptable release
    /// wins, falling back to reinstalling the recorded release itself.
    fn repair_selection(
        &self,
        receipt: &InstallReceipt,
        releases: Vec<Release>,
    ) -> Result<Option<Release>> {
        let recorded = || {
            releases
                .iter()
                .find(|release| release.tag_name == receipt.release_tag)
        };
        let selected = if receipt.pinned {
            recorded().cloned()
        } else {
            match release::select(&self.product, &receipt.release_tag, releases.clone())? {
                Some(release) => Some(release),
                None => recorded().cloned(),
            }
        };
        match selected {
            Some(release) => {
                release.validate(&self.product)?;
                Ok(Some(release))
            }
            None if receipt.pinned => Err(Error::new(
                ErrorCode::Release,
                "The pinned release recorded by this installation is no longer published; repair cannot change the pin.",
            )),
            None => Err(Error::new(
                ErrorCode::Release,
                "The release recorded by this installation is no longer published; reinstall with the product's verified installer.",
            )),
        }
    }

    /// Preserve the drifted executable bytes beside the install record before
    /// replacement. The path is receipt-owned, but the replaced bytes may be a
    /// build someone still wants or evidence worth keeping.
    fn preserve_drifted_bytes(&self) -> Result<PathBuf> {
        let sha = filesystem::sha256_file(&self.executable)?;
        let backup = self
            .coordination_directory()
            .join(format!("replaced-{sha}"));
        std::fs::copy(&self.executable, &backup)
            .map_err(|error| Error::io("Preserve the replaced executable", error))?;
        Ok(backup)
    }

    /// Product entrypoints with offline, pin, nesting or deployment admission
    /// policies should use this command boundary. CI/HRANESS_NO_UPDATE suppress
    /// incidental work only; an explicit update remains possible in CI.
    pub fn execute_with_context(
        &self,
        command: CommandAction,
        context: &StartupContext,
        source: &dyn ReleaseSource,
        installer: &dyn Installer,
    ) -> Result<UpdateResult> {
        if matches!(command, CommandAction::Install | CommandAction::Check)
            && (context.offline
                || context.exact_version_bound
                || context.nested
                || context.deployment)
        {
            let state = self.state()?;
            let installation = self.inspect().ok();
            return Ok(self.report(UpdateStatus::Skipped, state.policy, installation.as_ref(), false, Some("The product's offline, version-binding, nested invocation or deployment policy prohibits this update operation.".into())));
        }
        self.execute(command, source, installer)
    }

    /// Run before product initialization or work. Ordinary offline/check failures
    /// preserve command availability. An uncertain replacement is a hard error:
    /// callers must stop, never continue with potentially mixed installed code.
    pub fn startup(
        &self,
        context: &StartupContext,
        source: &dyn ReleaseSource,
        installer: &dyn Installer,
    ) -> Result<StartupOutcome> {
        if context.effect_free() {
            return Ok(StartupOutcome::Continue { lease: None, report: self.report(UpdateStatus::Skipped, Policy::Auto, None, true, Some("Help, version, completion and explicit update routing have no incidental update effects.".into())) });
        }
        let coordination_path = self.coordination_directory();
        // Truly unowned/source installations have no writes. Once an updater
        // authority exists, acquire admission BEFORE reading mutable receipt or
        // executable bytes: a replacement may be between its atomic steps.
        let preflight = if !filesystem::supported() || !filesystem::path_exists(&coordination_path)?
        {
            match self.inspect_native(true) {
                Ok(value) => Some(value),
                Err(error) if error.code == ErrorCode::Unsupported => {
                    return Ok(StartupOutcome::Continue {
                        lease: None,
                        report: self.report(
                            UpdateStatus::Unsupported,
                            Policy::Auto,
                            None,
                            true,
                            Some(error.message),
                        ),
                    });
                }
                // A receipt-owned path whose bytes drifted repairs itself under
                // the saved automatic policy before any product work runs them.
                Err(error)
                    if error.code == ErrorCode::Ownership && self.may_repair(context) =>
                {
                    match self.repair_at_startup(context, source, installer) {
                        Ok(Some(outcome)) => return Ok(outcome),
                        Ok(None) => return Err(error),
                        Err(repair_error) => {
                            return Err(Error::new(
                                ErrorCode::UnsafeInstallation,
                                format!("Managed installation could not be verified: {error}. Automatic repair failed: {repair_error}"),
                            ))
                        }
                    }
                }
                Err(error) => return Err(error),
            }
        } else {
            None
        };
        let coordination = Store::open(&coordination_path, true)?;
        let admission = coordination.shared()?;
        let initial = match self.inspect_native(true) {
            Ok(value) => value,
            Err(error)
                if error.code == ErrorCode::Unsupported
                    && filesystem::path_exists(&self.paths.receipt)? =>
            {
                return Ok(StartupOutcome::Continue {
                    lease: Some(admission),
                    report: self.report(
                        UpdateStatus::Unsupported,
                        self.state()?.policy,
                        None,
                        true,
                        Some(error.message),
                    ),
                });
            }
            Err(error) => {
                if error.code == ErrorCode::Ownership && self.may_repair(context) {
                    drop(admission);
                    match self.repair_at_startup(context, source, installer) {
                        Ok(Some(outcome)) => return Ok(outcome),
                        Ok(None) => {}
                        Err(repair_error) => {
                            return Err(Error::new(
                                ErrorCode::UnsafeInstallation,
                                format!("Managed installation could not be verified after admission: {error}. Automatic repair failed: {repair_error}"),
                            ))
                        }
                    }
                }
                return Err(Error::new(
                    ErrorCode::UnsafeInstallation,
                    format!("Managed installation could not be verified after admission: {error}"),
                ));
            }
        };
        if preflight.is_some_and(|before| before.receipt != initial.receipt) {
            return Err(Error::new(
                ErrorCode::UnsafeInstallation,
                "Installation changed during initial admission; invoke the command again",
            ));
        }
        self.verify_loaded_image(&initial)?;
        if initial.receipt.pinned {
            return Ok(StartupOutcome::Continue { lease: Some(admission), report: self.report(UpdateStatus::Unsupported, self.state()?.policy, Some(&initial), true, Some("This installation is explicitly version-bound; self-update will not change the pin.".into())) });
        }
        let store = Store::open(&self.paths.state_dir, true)?;
        if context.no_incidental() {
            let state = store.read()?;
            return Ok(StartupOutcome::Continue { lease: Some(admission), report: self.report(UpdateStatus::Skipped, state.policy, Some(&initial), true, Some("Automatic updates are suppressed by the environment or product invocation policy.".into())) });
        }
        drop(admission);
        let Some(lock) = coordination.lock("activity.lock", true)? else {
            let lease = coordination.shared()?;
            let current = self.inspect()?;
            if current.receipt != initial.receipt {
                return Err(Error::new(
                    ErrorCode::UnsafeInstallation,
                    "Installation changed before command admission; invoke the command again",
                ));
            }
            let state = store.read()?;
            return Ok(StartupOutcome::Continue { lease: Some(lease), report: self.report(UpdateStatus::Busy, state.policy, Some(&current), true, Some("An active command holds this installation; automatic replacement was skipped.".into())) });
        };
        let current = self.inspect()?;
        if current.receipt != initial.receipt {
            return Err(Error::new(
                ErrorCode::UnsafeInstallation,
                "Installation changed before update admission; invoke the command again",
            ));
        }
        let state = store.read()?;
        let checked_recently = state.installation_key.as_deref() == Some(self.key().as_str())
            && state
                .last_check_unix
                .is_some_and(|last| context.now_unix < last || context.now_unix - last < DAY);
        if state.policy == Policy::Disabled || checked_recently {
            let report = self.report(
                UpdateStatus::Skipped,
                state.policy,
                Some(&current),
                true,
                Some(
                    if state.policy == Policy::Disabled {
                        "Automatic updates are disabled."
                    } else {
                        "The daily release check is not due."
                    }
                    .into(),
                ),
            );
            return self.continue_under_lease(&coordination, lock, &current, report);
        }
        // Reserve the daily check before network IO. Even offline failures are
        // rate-limited; an explicit update/check can always retry immediately.
        store.update(|s| {
            s.last_check_unix = Some(context.now_unix);
            s.installation_key = Some(self.key());
        })?;
        let selected = source
            .releases(&self.product)
            .and_then(|r| release::select(&self.product, &current.receipt.release_tag, r));
        let release = match selected {
            Ok(Some(value)) => value,
            Ok(None) => {
                return self.continue_under_lease(
                    &coordination,
                    lock,
                    &current,
                    self.report(
                        UpdateStatus::Current,
                        state.policy,
                        Some(&current),
                        true,
                        None,
                    ),
                )
            }
            Err(error) => {
                return self.continue_under_lease(
                    &coordination,
                    lock,
                    &current,
                    self.report(
                        UpdateStatus::Failed,
                        state.policy,
                        Some(&current),
                        true,
                        Some(error.message),
                    ),
                )
            }
        };
        let policy = store.read()?.policy; // A concurrent explicit opt-out wins.
        if policy != Policy::Auto {
            let mut report = self.report(
                if policy == Policy::Notify {
                    UpdateStatus::Available
                } else {
                    UpdateStatus::Skipped
                },
                policy,
                Some(&current),
                true,
                None,
            );
            report.latest = Some(release.tag_name);
            return self.continue_under_lease(&coordination, lock, &current, report);
        }
        match self.replace(&current, &release, installer, true, &coordination, &lock) {
            Ok(after) => {
                let mut report =
                    self.report(UpdateStatus::Updated, policy, Some(&after), true, None);
                report.latest = Some(release.tag_name);
                drop(lock);
                let lease = coordination.shared()?;
                if self.inspect()?.receipt != after.receipt {
                    return Err(Error::new(
                        ErrorCode::UnsafeInstallation,
                        "Updated installation changed before re-entry",
                    ));
                }
                Ok(StartupOutcome::Reenter(Reentry {
                    updater: Box::new(self.clone()),
                    installation: Box::new(after),
                    args: context.args.clone(),
                    lease,
                    report,
                }))
            }
            Err(error) if error.code == ErrorCode::Installer => self.continue_under_lease(
                &coordination,
                lock,
                &current,
                self.report(
                    UpdateStatus::Failed,
                    policy,
                    Some(&current),
                    true,
                    Some(error.message),
                ),
            ),
            Err(error) => Err(error),
        }
    }

    /// Repair writes installed code, so it runs only under the saved automatic
    /// policy and outside incidental-suppression contexts (explicit product
    /// offline/nested/deployment bindings, CI, `--no-update`, re-entry).
    fn may_repair(&self, context: &StartupContext) -> bool {
        !context.no_incidental() && self.state().is_ok_and(|state| state.policy == Policy::Auto)
    }

    /// Repair a receipt-owned installation whose executable bytes drifted, then
    /// re-enter the verified image once. Returns None when a repair was already
    /// attempted recently or did not change the installation; the caller then
    /// refuses product work on the unverified bytes.
    fn repair_at_startup(
        &self,
        context: &StartupContext,
        source: &dyn ReleaseSource,
        installer: &dyn Installer,
    ) -> Result<Option<StartupOutcome>> {
        // Bound automatic repair attempts separately from the daily check: a
        // failing repair does not retry a download on every command start, and
        // an unrelated recent check must not postpone self-healing.
        let store = Store::open(&self.paths.state_dir, true)?;
        let state = store.read()?;
        let attempted = state.installation_key.as_deref() == Some(self.key().as_str())
            && state
                .last_repair_unix
                .is_some_and(|last| context.now_unix < last || context.now_unix - last < DAY);
        if attempted {
            return Ok(None);
        }
        store.update(|s| {
            s.last_repair_unix = Some(context.now_unix);
            s.installation_key = Some(self.key());
        })?;
        let result =
            self.execute_with_context(CommandAction::Install, context, source, installer)?;
        if !matches!(
            result.status,
            UpdateStatus::Updated | UpdateStatus::Repaired
        ) {
            return Ok(None);
        }
        let verified = self.inspect()?;
        let lease = Store::open(&self.coordination_directory(), true)?.shared()?;
        Ok(Some(StartupOutcome::Reenter(Reentry {
            updater: Box::new(self.clone()),
            installation: Box::new(verified),
            args: context.args.clone(),
            lease,
            report: result,
        })))
    }

    fn continue_under_lease(
        &self,
        store: &Store,
        lock: OwnedLock,
        current: &VerifiedInstallation,
        report: UpdateResult,
    ) -> Result<StartupOutcome> {
        drop(lock);
        let lease = store.shared()?;
        if self.inspect()?.receipt != current.receipt {
            return Err(Error::new(
                ErrorCode::UnsafeInstallation,
                "Installation changed before product work",
            ));
        }
        Ok(StartupOutcome::Continue {
            lease: Some(lease),
            report,
        })
    }

    /// Migrate a previously *saved* product policy once, before the first startup
    /// call. An existing shared-updater policy always wins. Products must not
    /// import an old implementation's implicit default as an explicit opt-out.
    pub fn initialize_policy_if_absent(&self, saved_policy: Policy) -> Result<Policy> {
        Store::open(&self.paths.state_dir, true)?.initialize_policy(saved_policy)
    }
}

#[cfg(all(test, unix))]
mod lock_tests {
    use super::*;
    use std::sync::atomic::{AtomicU64, Ordering};

    static SERIAL: AtomicU64 = AtomicU64::new(0);

    struct Temporary(std::path::PathBuf);
    impl Temporary {
        fn new() -> Self {
            let path = std::env::temp_dir().canonicalize().unwrap().join(format!(
                "hraness-lock-release-test-{}-{}",
                std::process::id(),
                SERIAL.fetch_add(1, Ordering::Relaxed)
            ));
            Self(path)
        }
    }
    impl Drop for Temporary {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn ending_shared_lease_releases_a_fork_inherited_description() {
        let temporary = Temporary::new();
        let store = Store::open(&temporary.0, true).unwrap();
        let lease = store.shared().unwrap();
        // dup has the same flock lifetime as an unrelated concurrent fork's
        // descriptor before it reaches close-on-exec. Keep it alive to make the
        // previously intermittent macOS CI failure deterministic on Unix.
        let _inherited = lease.file.try_clone().unwrap();
        assert!(store.lock("activity.lock", true).unwrap().is_none());
        drop(lease);
        assert!(store.lock("activity.lock", true).unwrap().is_some());
    }

    #[test]
    fn ending_exclusive_lock_releases_a_fork_inherited_description() {
        let temporary = Temporary::new();
        let store = Store::open(&temporary.0, true).unwrap();
        let lock = store.lock("activity.lock", true).unwrap().unwrap();
        let _inherited = lock.try_clone().unwrap();
        assert!(store.shared().is_err());
        drop(lock);
        assert!(store.shared().is_ok());
    }

    #[test]
    fn another_process_cannot_use_or_unlock_the_owners_lock() {
        let temporary = Temporary::new();
        let store = Store::open(&temporary.0, true).unwrap();
        let mut inherited = store.lock("activity.lock", true).unwrap().unwrap();
        let original_description = inherited.try_clone().unwrap();
        // Model the PID mismatch observed by a child after fork. Its File close
        // is safe; an explicit LOCK_UN would incorrectly release its parent.
        inherited.owner = std::process::id().wrapping_add(1);
        assert_eq!(
            store
                .check_lock(&inherited, "activity.lock")
                .unwrap_err()
                .code,
            ErrorCode::Ownership
        );
        drop(inherited);
        assert!(store.shared().is_err());
        FileExt::unlock(&original_description).unwrap();
        assert!(store.shared().is_ok());
    }
}
