#![cfg(unix)]

use hraness_cli_update::*;
use sha2::{Digest, Sha256};
use std::cell::Cell;
use std::ffi::OsString;
use std::fs;
use std::io::Write;
use std::os::unix::fs::{symlink, PermissionsExt};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;

static SERIAL: AtomicU64 = AtomicU64::new(0);

struct Temporary(PathBuf);
impl Temporary {
    fn new() -> Self {
        let root = std::env::temp_dir().canonicalize().unwrap().join(format!(
            "hraness-native-update-test-{}-{}",
            std::process::id(),
            SERIAL.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir(&root).unwrap();
        fs::set_permissions(&root, fs::Permissions::from_mode(0o700)).unwrap();
        Self(root)
    }
}
impl Drop for Temporary {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

fn product() -> Product {
    Product {
        id: "fixture".into(),
        repository: "hraness/fixture".into(),
        tag_prefix: "v".into(),
        channel: Channel::Stable,
        running_identity: RunningIdentity::Release {
            release_tag: "v1.0.0",
            build_sha: None,
        },
        executable_name: "fixture".into(),
        platform: "test-unix".into(),
        required_assets: vec![
            "fixture-{tag}-{platform}.tar.gz".into(),
            "fixture-{tag}-{platform}.tar.gz.sha256".into(),
        ],
        require_immutable: true,
        manual_instructions: "Use the verified fixture installer.".into(),
    }
}
fn release_for(product: &Product, tag: &str) -> Release {
    Release {
        id: 200,
        tag_name: tag.into(),
        draft: false,
        prerelease: tag.contains('-'),
        immutable: true,
        assets: product
            .asset_names(tag)
            .unwrap()
            .into_iter()
            .enumerate()
            .map(|(i, name)| Asset {
                id: 500 + i as u64,
                size: 80,
                browser_download_url: format!(
                    "https://github.com/{}/releases/download/{tag}/{name}",
                    product.repository
                ),
                name,
            })
            .collect(),
    }
}
fn digest(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}
fn write_private(path: &Path, bytes: &[u8]) {
    fs::write(path, bytes).unwrap();
    fs::set_permissions(path, fs::Permissions::from_mode(0o600)).unwrap();
}

struct Fixture {
    _temporary: Temporary,
    product: Product,
    paths: Paths,
    updater: Updater,
    executable: PathBuf,
}
impl Fixture {
    fn new() -> Self {
        Self::with(product(), "v1.0.0")
    }
    fn with(product: Product, tag: &'static str) -> Self {
        let temporary = Temporary::new();
        Self::at(temporary, product, tag)
    }
    fn at(temporary: Temporary, mut product: Product, tag: &'static str) -> Self {
        let build_sha = if matches!(product.channel, Channel::Prerelease(_)) {
            Some("cccccccccccccccccccccccccccccccccccccccc")
        } else {
            None
        };
        product.running_identity = RunningIdentity::Release {
            release_tag: tag,
            build_sha,
        };
        let bin = temporary.0.join("bin");
        fs::create_dir(&bin).unwrap();
        let executable = bin.join("fixture");
        let bytes = b"#!/bin/sh\nexit 0\n";
        fs::write(&executable, bytes).unwrap();
        fs::set_permissions(&executable, fs::Permissions::from_mode(0o755)).unwrap();
        let paths = Paths {
            state_dir: temporary.0.join("updater"),
            receipt: temporary.0.join("install.json"),
        };
        let receipt = InstallReceipt {
            schema: InstallReceipt::SCHEMA.into(),
            product: product.id.clone(),
            repository: product.repository.clone(),
            kind: InstallationKind::NativeRelease,
            executable: executable.clone(),
            binary_sha256: digest(bytes),
            release_tag: tag.into(),
            build_sha: build_sha.map(str::to_owned),
            release_id: 100,
            archive_name: product.asset_names(tag).unwrap()[0].clone(),
            archive_sha256: "a".repeat(64),
            platform: product.platform.clone(),
            pinned: false,
        };
        receipt.write_verified(&product, &paths.receipt).unwrap();
        let updater =
            Updater::for_executable(product.clone(), paths.clone(), executable.clone()).unwrap();
        Self {
            _temporary: temporary,
            product,
            paths,
            updater,
            executable,
        }
    }
    fn receipt(&self) -> InstallReceipt {
        serde_json::from_slice(&fs::read(&self.paths.receipt).unwrap()).unwrap()
    }
    fn raw_receipt(&self, receipt: &InstallReceipt) {
        write_private(&self.paths.receipt, &serde_json::to_vec(receipt).unwrap());
    }
    fn source(&self, tag: &str) -> Source {
        Source {
            releases: vec![release_for(&self.product, tag)],
            calls: Cell::new(0),
            offline: false,
        }
    }
    fn context(&self) -> StartupContext {
        StartupContext {
            args: vec!["work".into()],
            product_effect_free: false,
            no_update: false,
            ci: false,
            reentered: false,
            offline: false,
            exact_version_bound: false,
            nested: false,
            deployment: false,
            now_unix: 1_000_000,
        }
    }
}
struct Source {
    releases: Vec<Release>,
    calls: Cell<usize>,
    offline: bool,
}
impl ReleaseSource for Source {
    fn releases(&self, _: &Product) -> Result<Vec<Release>> {
        self.calls.set(self.calls.get() + 1);
        if self.offline {
            Err(Error::new(ErrorCode::Network, "offline fixture"))
        } else {
            Ok(self.releases.clone())
        }
    }
}
struct Never;
impl ReleaseSource for Never {
    fn releases(&self, _: &Product) -> Result<Vec<Release>> {
        panic!("unexpected network")
    }
}
impl Installer for Never {
    fn install(&self, _: &InstallRequest<'_>) -> Result<()> {
        panic!("unexpected installation")
    }
}

struct Replace {
    bytes: Vec<u8>,
    calls: Cell<usize>,
    failure: Option<&'static str>,
}
impl Replace {
    fn new() -> Self {
        Self {
            bytes: b"#!/bin/sh\nexit 17\n".to_vec(),
            calls: Cell::new(0),
            failure: None,
        }
    }
}
impl Installer for Replace {
    fn install(&self, request: &InstallRequest<'_>) -> Result<()> {
        self.calls.set(self.calls.get() + 1);
        request.revalidate()?;
        if self.failure == Some("before") {
            return Err(Error::new(
                ErrorCode::Installer,
                "simulated download failure",
            ));
        }
        let target = &request.installation.receipt.executable;
        let stage = target.with_extension("stage");
        fs::write(&stage, &self.bytes).unwrap();
        fs::set_permissions(&stage, fs::Permissions::from_mode(0o755)).unwrap();
        fs::rename(&stage, target).unwrap();
        if self.failure == Some("after") {
            return Err(Error::new(
                ErrorCode::Installer,
                "simulated failed rollback",
            ));
        }
        let mut receipt = request.installation.receipt.clone();
        receipt.binary_sha256 = digest(&self.bytes);
        receipt.release_tag = request.release.tag_name.clone();
        receipt.release_id = request.release.id;
        receipt.archive_name = request.product.asset_names(&receipt.release_tag)?[0].clone();
        request.publish_receipt(&receipt)
    }
}

fn continuing(outcome: StartupOutcome) -> (Option<ActiveLease>, UpdateResult) {
    match outcome {
        StartupOutcome::Continue { lease, report } => (lease, report),
        StartupOutcome::Reenter(_) => panic!("unexpected reentry"),
    }
}

#[test]
fn command_parser_and_json_are_unambiguous() {
    for (words, action, json) in [
        (vec!["update"], CommandAction::Install, false),
        (
            vec!["update", "check", "--json"],
            CommandAction::Check,
            true,
        ),
        (
            vec!["update", "--json", "--check"],
            CommandAction::Check,
            true,
        ),
        (vec!["update", "status"], CommandAction::Status, false),
        (vec!["update", "enable"], CommandAction::Enable, false),
        (vec!["update", "disable"], CommandAction::Disable, false),
    ] {
        let args = words.into_iter().map(OsString::from).collect::<Vec<_>>();
        assert_eq!(
            parse_update_command(&args).unwrap(),
            Some(CommandRequest { action, json })
        );
    }
    for words in [
        vec!["update", "check", "status"],
        vec!["update", "--json", "--json"],
        vec!["update", "v2.0.0"],
    ] {
        assert!(
            parse_update_command(&words.into_iter().map(OsString::from).collect::<Vec<_>>())
                .is_err()
        );
    }
    assert!(parse_update_command(&["sync".into()]).unwrap().is_none());
    let fixture = Fixture::new();
    let result = fixture
        .updater
        .execute(CommandAction::Status, &Never, &Never)
        .unwrap();
    let json: serde_json::Value = serde_json::from_str(&result.json().unwrap()).unwrap();
    assert_eq!(json["policy"], "auto");
    assert_eq!(json["current"], "v1.0.0");
    assert!(
        !fixture.paths.state_dir.exists(),
        "status must have no writes"
    );
}

#[test]
fn unequivocal_root_help_and_version_have_no_effects() {
    let fixture = Fixture::new();
    for args in [
        vec!["--help"],
        vec!["--version"],
        vec!["version"],
        vec!["help"],
    ] {
        let mut context = fixture.context();
        context.args = args.into_iter().map(OsString::from).collect();
        let (lease, report) =
            continuing(fixture.updater.startup(&context, &Never, &Never).unwrap());
        assert!(lease.is_none());
        assert_eq!(report.status, UpdateStatus::Skipped);
        assert!(!fixture.paths.state_dir.exists());
        assert!(!fixture.updater.coordination_directory().exists());
    }
}

#[test]
fn all_incidental_suppressions_preserve_an_active_lease() {
    let fixture = Fixture::new();
    for i in 0..7 {
        let mut context = fixture.context();
        match i {
            0 => context.no_update = true,
            1 => context.ci = true,
            2 => context.reentered = true,
            3 => context.offline = true,
            4 => context.exact_version_bound = true,
            5 => context.nested = true,
            _ => context.deployment = true,
        }
        let (lease, result) =
            continuing(fixture.updater.startup(&context, &Never, &Never).unwrap());
        assert_eq!(result.status, UpdateStatus::Skipped);
        assert!(lease.unwrap().is_held());
    }
}

#[test]
fn automatic_is_default_and_reentry_runs_selected_executable() {
    let fixture = Fixture::new();
    let installer = Replace::new();
    let result = fixture
        .updater
        .startup(&fixture.context(), &fixture.source("v1.1.0"), &installer)
        .unwrap();
    let StartupOutcome::Reenter(reentry) = result else {
        panic!("expected default automatic update");
    };
    assert_eq!(reentry.report.current.as_deref(), Some("v1.1.0"));
    assert_eq!(reentry.run().unwrap().code(), Some(17));
    assert_eq!(installer.calls.get(), 1);
    assert_eq!(
        fixture.updater.inspect().unwrap().receipt.release_tag,
        "v1.1.0"
    );
}

#[test]
fn disable_survives_new_updater_and_explicit_update_still_works() {
    let fixture = Fixture::new();
    fixture
        .updater
        .execute(CommandAction::Disable, &Never, &Never)
        .unwrap();
    let updater = Updater::for_executable(
        fixture.product.clone(),
        fixture.paths.clone(),
        fixture.executable.clone(),
    )
    .unwrap();
    let (lease, report) = continuing(updater.startup(&fixture.context(), &Never, &Never).unwrap());
    assert_eq!(report.policy, Policy::Disabled);
    drop(lease);
    let report = updater
        .execute(
            CommandAction::Install,
            &fixture.source("v1.2.0"),
            &Replace::new(),
        )
        .unwrap();
    assert_eq!(report.status, UpdateStatus::Updated);
    assert_eq!(
        updater
            .execute(CommandAction::Status, &Never, &Never)
            .unwrap()
            .policy,
        Policy::Disabled
    );
    updater
        .execute(CommandAction::Enable, &Never, &Never)
        .unwrap();
    assert_eq!(
        updater
            .execute(CommandAction::Status, &Never, &Never)
            .unwrap()
            .policy,
        Policy::Auto
    );
}

#[test]
fn saved_notify_is_not_replaced_by_auto_default() {
    let fixture = Fixture::new();
    fixture
        .updater
        .execute(CommandAction::Disable, &Never, &Never)
        .unwrap();
    let path = fixture.paths.state_dir.join("state.json");
    let mut state: serde_json::Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
    state["policy"] = "notify".into();
    write_private(&path, &serde_json::to_vec(&state).unwrap());
    let (_, report) = continuing(
        fixture
            .updater
            .startup(&fixture.context(), &fixture.source("v1.1.0"), &Never)
            .unwrap(),
    );
    assert_eq!(report.status, UpdateStatus::Available);
    assert_eq!(fixture.receipt().release_tag, "v1.0.0");
}

#[test]
fn offline_checks_are_nonfatal_and_daily_but_explicit_check_can_retry() {
    let fixture = Fixture::new();
    let mut source = fixture.source("v1.1.0");
    source.offline = true;
    let (lease, report) = continuing(
        fixture
            .updater
            .startup(&fixture.context(), &source, &Never)
            .unwrap(),
    );
    assert_eq!(report.status, UpdateStatus::Failed);
    drop(lease);
    let mut later = fixture.context();
    later.now_unix += 1;
    let (lease, report) = continuing(fixture.updater.startup(&later, &Never, &Never).unwrap());
    assert_eq!(report.status, UpdateStatus::Skipped);
    drop(lease);
    assert_eq!(
        fixture
            .updater
            .execute(CommandAction::Check, &fixture.source("v1.1.0"), &Never)
            .unwrap()
            .status,
        UpdateStatus::Available
    );
    later.now_unix += 86_400;
    let (_, report) = continuing(fixture.updater.startup(&later, &source, &Never).unwrap());
    assert_eq!(report.status, UpdateStatus::Failed);
    assert_eq!(source.calls.get(), 2);
}

#[test]
fn complete_prerelease_tag_is_compared_numerically_without_channel_switch() {
    let mut product = product();
    product.channel = Channel::Prerelease("vm".into());
    let fixture = Fixture::with(product, "v0.2.0-vm.9");
    let source = Source {
        calls: Cell::new(0),
        offline: false,
        releases: vec![
            release_for(&fixture.product, "v0.2.0-vm.10"),
            release_for(&fixture.product, "v0.2.0-vm.11"),
            release_for(&fixture.product, "v0.3.0-beta.1"),
            release_for(&fixture.product, "v1.0.0"),
        ],
    };
    let report = fixture
        .updater
        .execute(CommandAction::Check, &source, &Never)
        .unwrap();
    assert_eq!(report.current.as_deref(), Some("v0.2.0-vm.9"));
    assert_eq!(report.latest.as_deref(), Some("v0.2.0-vm.11"));
}

#[test]
fn older_prereleases_incomplete_and_mutable_releases_cannot_replace_stable() {
    let fixture = Fixture::new();
    let mut mutable = release_for(&fixture.product, "v1.2.0");
    mutable.immutable = false;
    let mut incomplete = release_for(&fixture.product, "v1.3.0");
    incomplete.assets.pop();
    let source = Source {
        calls: Cell::new(0),
        offline: false,
        releases: vec![
            release_for(&fixture.product, "v0.9.0"),
            release_for(&fixture.product, "v2.0.0-beta.1"),
            mutable,
            incomplete,
        ],
    };
    assert_eq!(
        fixture
            .updater
            .execute(CommandAction::Install, &source, &Never)
            .unwrap()
            .status,
        UpdateStatus::Current
    );
}

#[test]
fn malicious_release_urls_and_ambiguous_versions_fail_closed() {
    let fixture = Fixture::new();
    for url in [
        "http://github.com/hraness/fixture/file",
        "https://evil.example/archive",
        "https://github.com.evil.example/archive",
        "https://github.com/other/fixture/releases/download/v1.1.0/archive",
        "https://github.com/hraness/fixture/releases/download/v1.1.0/archive?x=1",
    ] {
        let mut source = fixture.source("v1.1.0");
        source.releases[0].assets[0].browser_download_url = url.into();
        assert_eq!(
            fixture
                .updater
                .execute(CommandAction::Check, &source, &Never)
                .unwrap_err()
                .code,
            ErrorCode::Release
        );
    }
    let source = Source {
        calls: Cell::new(0),
        offline: false,
        releases: vec![
            release_for(&fixture.product, "v1.2.0+one"),
            release_for(&fixture.product, "v1.2.0+two"),
        ],
    };
    assert_eq!(
        fixture
            .updater
            .execute(CommandAction::Check, &source, &Never)
            .unwrap_err()
            .code,
        ErrorCode::Release
    );
}

#[test]
fn ownership_rejects_tamper_wrong_executable_and_manager_or_pin_boundaries() {
    let fixture = Fixture::new();
    let original = fixture.receipt();
    for kind in [
        InstallationKind::Source,
        InstallationKind::Cargo,
        InstallationKind::Homebrew,
        InstallationKind::Unknown,
    ] {
        let mut receipt = original.clone();
        receipt.kind = kind;
        fixture.raw_receipt(&receipt);
        assert_eq!(
            fixture
                .updater
                .execute(CommandAction::Install, &Never, &Never)
                .unwrap()
                .status,
            UpdateStatus::Unsupported
        );
    }
    let mut receipt = original.clone();
    receipt.pinned = true;
    fixture.raw_receipt(&receipt);
    assert_eq!(
        fixture.updater.inspect().unwrap_err().code,
        ErrorCode::Unsupported
    );
    receipt = original.clone();
    receipt.executable = fixture.executable.with_file_name("different");
    fixture.raw_receipt(&receipt);
    assert_eq!(
        fixture.updater.inspect().unwrap_err().code,
        ErrorCode::Ownership
    );
    fixture.raw_receipt(&original);
    fs::write(&fixture.executable, b"tampered").unwrap();
    assert_eq!(
        fixture.updater.inspect().unwrap_err().code,
        ErrorCode::Ownership
    );
}

#[test]
fn absent_receipt_does_not_infer_ownership_from_install_path() {
    let fixture = Fixture::new();
    fs::remove_file(&fixture.paths.receipt).unwrap();
    let (_, report) = continuing(
        fixture
            .updater
            .startup(&fixture.context(), &Never, &Never)
            .unwrap(),
    );
    assert_eq!(report.status, UpdateStatus::Unsupported);
    assert!(!fixture.paths.state_dir.exists());
}

#[test]
fn foreign_state_symlinks_hardlinks_and_open_permissions_are_refused() {
    let fixture = Fixture::new();
    let other = fixture._temporary.0.join("foreign");
    fs::create_dir(&other).unwrap();
    symlink(&other, &fixture.paths.state_dir).unwrap();
    assert!(fixture
        .updater
        .execute(CommandAction::Disable, &Never, &Never)
        .is_err());
    assert_eq!(fs::read_dir(&other).unwrap().count(), 0);
    fs::remove_file(&fixture.paths.state_dir).unwrap();
    fs::create_dir(&fixture.paths.state_dir).unwrap();
    fs::set_permissions(&fixture.paths.state_dir, fs::Permissions::from_mode(0o755)).unwrap();
    assert!(fixture
        .updater
        .execute(CommandAction::Disable, &Never, &Never)
        .is_err());
    fs::set_permissions(&fixture.paths.state_dir, fs::Permissions::from_mode(0o700)).unwrap();
    let protected = other.join("personal");
    write_private(&protected, b"preserve");
    symlink(&protected, fixture.paths.state_dir.join("state.json")).unwrap();
    assert!(fixture
        .updater
        .execute(CommandAction::Disable, &Never, &Never)
        .is_err());
    assert_eq!(fs::read(&protected).unwrap(), b"preserve");
    fs::remove_file(fixture.paths.state_dir.join("state.json")).unwrap();
    fs::hard_link(&protected, fixture.paths.state_dir.join("state.json")).unwrap();
    assert!(fixture
        .updater
        .execute(CommandAction::Disable, &Never, &Never)
        .is_err());
    assert_eq!(fs::read(&protected).unwrap(), b"preserve");
}

#[test]
fn symlinked_receipt_executable_and_lock_are_refused() {
    let fixture = Fixture::new();
    let original = fixture.paths.receipt.with_extension("original");
    fs::rename(&fixture.paths.receipt, &original).unwrap();
    symlink(&original, &fixture.paths.receipt).unwrap();
    assert!(fixture.updater.inspect().is_err());
    fs::remove_file(&fixture.paths.receipt).unwrap();
    fs::rename(&original, &fixture.paths.receipt).unwrap();
    let executable = fixture.executable.with_extension("original");
    fs::rename(&fixture.executable, &executable).unwrap();
    symlink(&executable, &fixture.executable).unwrap();
    assert!(fixture.updater.inspect().is_err());
    fs::remove_file(&fixture.executable).unwrap();
    fs::rename(&executable, &fixture.executable).unwrap();
    fixture
        .updater
        .execute(CommandAction::Disable, &Never, &Never)
        .unwrap();
    let coordination = fixture.updater.coordination_directory();
    fs::create_dir(&coordination).unwrap();
    fs::set_permissions(&coordination, fs::Permissions::from_mode(0o700)).unwrap();
    symlink(&original, coordination.join("activity.lock")).unwrap();
    assert!(fixture
        .updater
        .execute(CommandAction::Install, &Never, &Never)
        .is_err());
}

#[test]
fn oversized_receipts_are_not_read_unboundedly() {
    let fixture = Fixture::new();
    write_private(&fixture.paths.receipt, &vec![b'x'; 65_537]);
    assert_eq!(
        fixture.updater.inspect().unwrap_err().code,
        ErrorCode::Limit
    );
}

#[test]
fn active_leases_block_replacement_but_allow_policy_opt_out() {
    let fixture = Fixture::new();
    let mut context = fixture.context();
    context.no_update = true;
    let (lease, _) = continuing(fixture.updater.startup(&context, &Never, &Never).unwrap());
    assert_eq!(
        fixture
            .updater
            .execute(CommandAction::Install, &Never, &Never)
            .unwrap()
            .status,
        UpdateStatus::Busy
    );
    fixture
        .updater
        .execute(CommandAction::Disable, &Never, &Never)
        .unwrap();
    assert_eq!(
        fixture
            .updater
            .execute(CommandAction::Status, &Never, &Never)
            .unwrap()
            .policy,
        Policy::Disabled
    );
    drop(lease);
    assert_eq!(
        fixture
            .updater
            .execute(
                CommandAction::Install,
                &fixture.source("v1.1.0"),
                &Replace::new()
            )
            .unwrap()
            .status,
        UpdateStatus::Updated
    );
}

#[test]
fn failed_installer_only_allows_work_if_old_bytes_and_receipt_still_verify() {
    let fixture = Fixture::new();
    let mut installer = Replace::new();
    installer.failure = Some("before");
    let (_, report) = continuing(
        fixture
            .updater
            .startup(&fixture.context(), &fixture.source("v1.1.0"), &installer)
            .unwrap(),
    );
    assert_eq!(report.status, UpdateStatus::Failed);
    assert_eq!(fixture.receipt().release_tag, "v1.0.0");
    let fixture = Fixture::new();
    installer.failure = Some("after");
    let result = fixture
        .updater
        .startup(&fixture.context(), &fixture.source("v1.1.0"), &installer);
    assert!(matches!(
        result,
        Err(Error {
            code: ErrorCode::UnsafeInstallation,
            ..
        })
    ));
}

#[test]
fn opt_out_during_release_fetch_wins_before_replacement() {
    struct OptOut<'a>(&'a Fixture);
    impl ReleaseSource for OptOut<'_> {
        fn releases(&self, product: &Product) -> Result<Vec<Release>> {
            self.0
                .updater
                .execute(CommandAction::Disable, &Never, &Never)?;
            Ok(vec![release_for(product, "v1.1.0")])
        }
    }
    let fixture = Fixture::new();
    let (_, report) = continuing(
        fixture
            .updater
            .startup(&fixture.context(), &OptOut(&fixture), &Never)
            .unwrap(),
    );
    assert_eq!(report.policy, Policy::Disabled);
    assert_eq!(fixture.receipt().release_tag, "v1.0.0");
}

#[test]
fn subprocess_output_time_and_descendant_pipes_are_bounded() {
    let mut command = Command::new("/bin/sh");
    command.args(["-c", "while :; do printf '1234567890'; done"]);
    assert_eq!(
        run_bounded(&mut command, 100, 100, Duration::from_secs(2))
            .unwrap_err()
            .code,
        ErrorCode::Limit
    );
    let mut command = Command::new("/bin/sh");
    command.args(["-c", "sleep 20 & wait"]);
    let started = std::time::Instant::now();
    assert_eq!(
        run_bounded(&mut command, 100, 100, Duration::from_millis(100))
            .unwrap_err()
            .code,
        ErrorCode::Network
    );
    assert!(started.elapsed() < Duration::from_secs(3));
    let mut command = Command::new("/bin/sh");
    command.args(["-c", "printf abc; printf err >&2; exit 7"]);
    let output = run_bounded(&mut command, 100, 100, Duration::from_secs(2)).unwrap();
    assert_eq!(output.stdout, b"abc");
    assert_eq!(output.stderr, b"err");
    assert_eq!(output.status.code(), Some(7));
}

#[test]
fn reentry_preserves_stdin_literal_arguments_and_exit_code() {
    let directory = Temporary::new();
    let mut child = Command::new(std::env::current_exe().unwrap())
        .args(["--exact", "reentry_probe", "--nocapture"])
        .env("HRANESS_TEST_REENTRY_ROOT", &directory.0)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    child
        .stdin
        .take()
        .unwrap()
        .write_all(b"unchanged input\nsecond line\n")
        .unwrap();
    let output = child.wait_with_output().unwrap();
    assert_eq!(
        output.status.code(),
        Some(17),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let bytes = fs::read(directory.0.join("result")).unwrap();
    assert_eq!(
        bytes,
        b"1\n1\n2\nfirst space\n$(must-not-run)\nunchanged input\nsecond line\n"
    );
}

#[test]
fn reentry_probe() {
    let Some(directory) = std::env::var_os("HRANESS_TEST_REENTRY_ROOT") else {
        return;
    };
    let directory = PathBuf::from(directory);
    let fixture_root = directory.join("fixture");
    fs::create_dir(&fixture_root).unwrap();
    fs::set_permissions(&fixture_root, fs::Permissions::from_mode(0o700)).unwrap();
    let fixture = Fixture::at(Temporary(fixture_root), product(), "v1.0.0");
    let path = directory.join("result");
    let quoted = format!("'{}'", path.to_str().unwrap().replace('\'', "'\\''"));
    let mut installer = Replace::new();
    installer.bytes = format!("#!/bin/sh\nprintf '%s\\n' \"$HRANESS_NO_UPDATE\" \"$HRANESS_CLI_UPDATE_REENTERED\" \"$#\" \"$1\" \"$2\" > {quoted}\ncat >> {quoted}\nexit 17\n").into_bytes();
    let mut context = fixture.context();
    context.args = vec!["first space".into(), "$(must-not-run)".into()];
    match fixture
        .updater
        .startup(&context, &fixture.source("v1.1.0"), &installer)
        .unwrap()
    {
        StartupOutcome::Reenter(reentry) => reentry.run_and_exit(),
        _ => panic!("expected reentry"),
    }
}

fn fake_curl(directory: &Path, script: &str) -> CurlGithub {
    let path = directory.join("fake-curl");
    fs::write(
        &path,
        format!("#!/bin/sh\n[ \"$1\" = --disable ] || exit 91\n{script}\n"),
    )
    .unwrap();
    fs::set_permissions(&path, fs::Permissions::from_mode(0o755)).unwrap();
    CurlGithub::new(path).unwrap()
}

#[test]
fn verified_download_checks_digest_size_and_refuses_overwrite() {
    let temporary = Temporary::new();
    let transport = fake_curl(
        &temporary.0,
        "printf 'HTTP/2 200\\r\\n\\r\\nverified archive'",
    );
    let product = product();
    let mut release = release_for(&product, "v1.1.0");
    let payload = b"verified archive";
    release.assets[0].size = payload.len() as u64;
    let destination = temporary.0.join("archive");
    let digest = digest(payload);
    transport
        .download_verified(
            &product,
            &release,
            &release.assets[0],
            &digest,
            &destination,
            100,
        )
        .unwrap();
    assert_eq!(fs::read(&destination).unwrap(), payload);
    assert!(transport
        .download_verified(
            &product,
            &release,
            &release.assets[0],
            &digest,
            &destination,
            100
        )
        .is_err());
    assert_eq!(fs::read(&destination).unwrap(), payload);
    let wrong = temporary.0.join("wrong-digest");
    assert_eq!(
        transport
            .download_verified(
                &product,
                &release,
                &release.assets[0],
                &"a".repeat(64),
                &wrong,
                100
            )
            .unwrap_err()
            .code,
        ErrorCode::Release
    );
    assert!(!wrong.exists());
}

#[test]
fn download_rejects_redirects_before_contacting_an_untrusted_host() {
    let temporary = Temporary::new();
    let counter = temporary.0.join("calls");
    let transport = fake_curl(&temporary.0, &format!("printf x >> '{}'\nprintf 'HTTP/2 302\\r\\nLocation: https://evil.example/archive\\r\\n\\r\\n'", counter.display()));
    let product = product();
    let release = release_for(&product, "v1.1.0");
    let destination = temporary.0.join("archive");
    assert_eq!(
        transport
            .download_verified(
                &product,
                &release,
                &release.assets[0],
                &"a".repeat(64),
                &destination,
                100
            )
            .unwrap_err()
            .code,
        ErrorCode::Release
    );
    assert_eq!(
        fs::read(&counter).unwrap(),
        b"x",
        "must not issue the redirected request"
    );
    assert!(!destination.exists());
}

#[test]
fn release_metadata_and_transport_output_are_bounded() {
    let temporary = Temporary::new();
    let transport = fake_curl(&temporary.0, "printf 'HTTP/2 200\\r\\n\\r\\n[]'");
    assert!(transport.releases(&product()).unwrap().is_empty());
    let transport = fake_curl(&temporary.0, "printf 'HTTP/2 200\\r\\n\\r\\n'; while :; do printf '01234567890123456789012345678901234567890123456789'; done");
    assert_eq!(
        transport.releases(&product()).unwrap_err().code,
        ErrorCode::Limit
    );
}

#[test]
fn source_checkouts_and_privileged_executables_are_not_supported() {
    let fixture = Fixture::new();
    fs::create_dir(fixture._temporary.0.join(".git")).unwrap();
    fs::write(fixture._temporary.0.join("Cargo.toml"), b"[workspace]").unwrap();
    assert_eq!(
        fixture.updater.inspect().unwrap_err().code,
        ErrorCode::Unsupported
    );
    fs::remove_dir(fixture._temporary.0.join(".git")).unwrap();
    fs::set_permissions(&fixture.executable, fs::Permissions::from_mode(0o4755)).unwrap();
    assert_eq!(
        fixture.updater.inspect().unwrap_err().code,
        ErrorCode::Ownership
    );
}

#[test]
fn verified_initial_pin_is_recorded_and_preserved() {
    let fixture = Fixture::new();
    let mut receipt = fixture.receipt();
    receipt.pinned = true;
    receipt
        .write_verified(&fixture.product, &fixture.paths.receipt)
        .unwrap();
    assert_eq!(
        fixture
            .updater
            .execute(CommandAction::Install, &Never, &Never)
            .unwrap()
            .status,
        UpdateStatus::Unsupported
    );
    assert!(fixture.receipt().pinned);
}

#[test]
fn explicit_product_offline_and_runtime_pin_policies_are_preserved() {
    let fixture = Fixture::new();
    for index in 0..4 {
        let mut context = fixture.context();
        match index {
            0 => context.offline = true,
            1 => context.exact_version_bound = true,
            2 => context.nested = true,
            _ => context.deployment = true,
        }
        assert_eq!(
            fixture
                .updater
                .execute_with_context(CommandAction::Install, &context, &Never, &Never)
                .unwrap()
                .status,
            UpdateStatus::Skipped
        );
        assert_eq!(
            fixture
                .updater
                .execute_with_context(CommandAction::Status, &context, &Never, &Never)
                .unwrap()
                .status,
            UpdateStatus::Current
        );
    }
    assert!(!fixture.paths.state_dir.exists());
}

#[test]
fn startup_never_continues_through_a_managed_replacement_transition() {
    struct DuringReplacement<'a>(&'a Fixture);
    impl Installer for DuringReplacement<'_> {
        fn install(&self, request: &InstallRequest<'_>) -> Result<()> {
            request.revalidate()?;
            let old_binary = fs::read(&self.0.executable).unwrap();
            let old_receipt = fs::read(&self.0.paths.receipt).unwrap();
            for transition in 0..3 {
                fs::write(&self.0.executable, b"temporarily different bytes").unwrap();
                match transition {
                    1 => fs::remove_file(&self.0.paths.receipt).unwrap(),
                    2 => write_private(&self.0.paths.receipt, b"incomplete receipt"),
                    _ => {}
                }
                let result = self.0.updater.startup(&self.0.context(), &Never, &Never);
                assert!(
                    matches!(
                        result,
                        Err(Error {
                            code: ErrorCode::Busy,
                            ..
                        })
                    ),
                    "replacement must deny new product admission before reading transient identity"
                );
                fs::write(&self.0.executable, &old_binary).unwrap();
                write_private(&self.0.paths.receipt, &old_receipt);
            }
            Err(Error::new(ErrorCode::Installer, "fixture rolled back"))
        }
    }
    let fixture = Fixture::new();
    assert_eq!(
        fixture
            .updater
            .execute(
                CommandAction::Install,
                &fixture.source("v1.1.0"),
                &DuringReplacement(&fixture)
            )
            .unwrap_err()
            .code,
        ErrorCode::Installer
    );
    assert_eq!(
        fixture.updater.inspect().unwrap().receipt.release_tag,
        "v1.0.0"
    );
}

#[test]
fn managed_corruption_is_a_hard_startup_error_even_when_updates_are_disabled() {
    let fixture = Fixture::new();
    let mut context = fixture.context();
    context.no_update = true;
    let (lease, _) = continuing(fixture.updater.startup(&context, &Never, &Never).unwrap());
    drop(lease);
    fs::remove_file(&fixture.paths.receipt).unwrap();
    assert!(matches!(
        fixture.updater.startup(&context, &Never, &Never),
        Err(Error {
            code: ErrorCode::UnsafeInstallation,
            ..
        })
    ));
    write_private(&fixture.paths.receipt, b"bad receipt");
    assert!(matches!(
        fixture.updater.startup(&context, &Never, &Never),
        Err(Error {
            code: ErrorCode::UnsafeInstallation,
            ..
        })
    ));
    let fixture = Fixture::new();
    fs::write(&fixture.executable, b"foreign bytes").unwrap();
    assert!(matches!(
        fixture.updater.startup(&context, &Never, &Never),
        Err(Error {
            code: ErrorCode::Ownership,
            ..
        })
    ));
}

#[test]
fn preference_and_receipt_overrides_cannot_bypass_installation_activity_lock() {
    let fixture = Fixture::new();
    let mut context = fixture.context();
    context.no_update = true;
    let (lease, _) = continuing(fixture.updater.startup(&context, &Never, &Never).unwrap());
    let alternate_receipt = fixture._temporary.0.join("alternate-receipt.json");
    write_private(
        &alternate_receipt,
        &fs::read(&fixture.paths.receipt).unwrap(),
    );
    let alternate = Updater::for_executable(
        fixture.product.clone(),
        Paths {
            state_dir: fixture._temporary.0.join("other-profile"),
            receipt: alternate_receipt,
        },
        fixture.executable.clone(),
    )
    .unwrap();
    assert_eq!(
        alternate.coordination_directory(),
        fixture.updater.coordination_directory()
    );
    assert_eq!(
        alternate
            .execute(CommandAction::Install, &Never, &Never)
            .unwrap()
            .status,
        UpdateStatus::Busy
    );
    drop(lease);
}

#[test]
fn legacy_saved_policy_migration_does_not_override_newer_choices() {
    let fixture = Fixture::new();
    assert_eq!(
        fixture
            .updater
            .initialize_policy_if_absent(Policy::Notify)
            .unwrap(),
        Policy::Notify
    );
    assert_eq!(
        fixture
            .updater
            .initialize_policy_if_absent(Policy::Auto)
            .unwrap(),
        Policy::Notify
    );
    fixture
        .updater
        .execute(CommandAction::Disable, &Never, &Never)
        .unwrap();
    assert_eq!(
        fixture
            .updater
            .initialize_policy_if_absent(Policy::Notify)
            .unwrap(),
        Policy::Disabled
    );
}

#[test]
fn opt_out_during_installer_staging_is_rechecked_before_writes() {
    struct StageOptOut<'a>(&'a Fixture);
    impl Installer for StageOptOut<'_> {
        fn install(&self, request: &InstallRequest<'_>) -> Result<()> {
            assert!(request.automatic);
            self.0
                .updater
                .execute(CommandAction::Disable, &Never, &Never)?;
            request.revalidate()?;
            panic!("opt-out should prevent the write stage");
        }
    }
    let fixture = Fixture::new();
    let (lease, result) = continuing(
        fixture
            .updater
            .startup(
                &fixture.context(),
                &fixture.source("v1.1.0"),
                &StageOptOut(&fixture),
            )
            .unwrap(),
    );
    assert_eq!(result.status, UpdateStatus::Failed);
    assert_eq!(fixture.receipt().release_tag, "v1.0.0");
    assert_eq!(
        fixture
            .updater
            .execute(CommandAction::Status, &Never, &Never)
            .unwrap()
            .policy,
        Policy::Disabled
    );
    drop(lease);
}

#[test]
fn activity_authority_is_revalidated_after_metadata_fetch() {
    struct ReplaceLock<'a>(&'a Fixture);
    impl ReleaseSource for ReplaceLock<'_> {
        fn releases(&self, product: &Product) -> Result<Vec<Release>> {
            let path = self
                .0
                .updater
                .coordination_directory()
                .join("activity.lock");
            fs::rename(&path, path.with_extension("old")).unwrap();
            write_private(&path, b"");
            Ok(vec![release_for(product, "v1.1.0")])
        }
    }
    let fixture = Fixture::new();
    assert_eq!(
        fixture
            .updater
            .execute(CommandAction::Install, &ReplaceLock(&fixture), &Never)
            .unwrap_err()
            .code,
        ErrorCode::UnsafePath
    );
    assert_eq!(fixture.receipt().release_tag, "v1.0.0");
}

#[test]
fn native_active_lease_is_shared_across_processes_and_released_on_exit() {
    let fixture = Fixture::new();
    let mut child = Command::new(std::env::current_exe().unwrap())
        .args(["--exact", "cross_process_lease_probe", "--nocapture"])
        .env("HRANESS_TEST_LEASE_ROOT", &fixture._temporary.0)
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    let ready = fixture._temporary.0.join("lease-ready");
    let deadline = std::time::Instant::now() + Duration::from_secs(10);
    while !ready.exists() && std::time::Instant::now() < deadline {
        if let Some(status) = child.try_wait().unwrap() {
            panic!("lease probe exited early: {status}");
        }
        std::thread::sleep(Duration::from_millis(10));
    }
    if !ready.exists() {
        let _ = child.kill();
        let _ = child.wait();
        panic!("lease probe did not start");
    }
    let report = fixture
        .updater
        .execute(CommandAction::Install, &Never, &Never)
        .unwrap();
    let held = report.status == UpdateStatus::Busy;
    child.stdin.take().unwrap().write_all(b"x").unwrap();
    let output = child.wait_with_output().unwrap();
    assert!(
        held,
        "a different process's active lease must prevent replacement"
    );
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert_eq!(
        fixture
            .updater
            .execute(
                CommandAction::Install,
                &fixture.source("v1.1.0"),
                &Replace::new()
            )
            .unwrap()
            .status,
        UpdateStatus::Updated
    );
}

#[test]
fn cross_process_lease_probe() {
    let Some(root) = std::env::var_os("HRANESS_TEST_LEASE_ROOT") else {
        return;
    };
    let root = PathBuf::from(root);
    let updater = Updater::for_executable(
        product(),
        Paths {
            state_dir: root.join("updater"),
            receipt: root.join("install.json"),
        },
        root.join("bin/fixture"),
    )
    .unwrap();
    let context = StartupContext {
        args: vec!["work".into()],
        product_effect_free: false,
        no_update: true,
        ci: false,
        reentered: false,
        offline: false,
        exact_version_bound: false,
        nested: false,
        deployment: false,
        now_unix: 1_000_000,
    };
    let (lease, _) = continuing(updater.startup(&context, &Never, &Never).unwrap());
    write_private(&root.join("lease-ready"), b"ready");
    let mut byte = [0_u8];
    std::io::Read::read_exact(&mut std::io::stdin(), &mut byte).unwrap();
    drop(lease);
}

#[test]
fn help_tokens_used_as_command_data_keep_the_active_lease() {
    for args in [
        vec!["work", "--version"],
        vec!["work", "--label", "--help"],
        vec!["--option-value", "--version", "work"],
        vec!["update", "status"],
    ] {
        let fixture = Fixture::new();
        let mut context = fixture.context();
        context.args = args.into_iter().map(OsString::from).collect();
        let (lease, report) =
            continuing(fixture.updater.startup(&context, &Never, &Never).unwrap());
        assert!(lease.as_ref().is_some_and(ActiveLease::is_held));
        assert_eq!(report.status, UpdateStatus::Skipped);
        assert_eq!(
            fixture
                .updater
                .execute(CommandAction::Install, &Never, &Never)
                .unwrap()
                .status,
            UpdateStatus::Busy
        );
    }
    let fixture = Fixture::new();
    let mut context = fixture.context();
    context.args = ["run", "--", "child", "--version"]
        .into_iter()
        .map(OsString::from)
        .collect();
    let source = Source {
        releases: vec![],
        calls: Cell::new(0),
        offline: false,
    };
    let (lease, _) = continuing(fixture.updater.startup(&context, &source, &Never).unwrap());
    assert_eq!(
        source.calls.get(),
        1,
        "must not infer help from data after --"
    );
    assert!(lease.as_ref().is_some_and(ActiveLease::is_held));
    assert_eq!(
        fixture
            .updater
            .execute(CommandAction::Install, &Never, &Never)
            .unwrap()
            .status,
        UpdateStatus::Busy
    );
}

#[test]
fn product_parser_can_declare_effect_free_nested_help() {
    let fixture = Fixture::new();
    let mut context = fixture.context();
    context.args = ["nested", "command", "--help"]
        .into_iter()
        .map(OsString::from)
        .collect();
    context.product_effect_free = true;
    let (lease, report) = continuing(fixture.updater.startup(&context, &Never, &Never).unwrap());
    assert!(lease.is_none());
    assert_eq!(report.status, UpdateStatus::Skipped);
    assert!(!fixture.paths.state_dir.exists());
    assert!(!fixture.updater.coordination_directory().exists());
}

#[test]
fn stable_tag_only_image_identity_rejects_old_processes_but_admits_new_ones() {
    let fixture = Fixture::new();
    fixture
        .updater
        .execute(
            CommandAction::Install,
            &fixture.source("v1.1.0"),
            &Replace::new(),
        )
        .unwrap();
    let mut context = fixture.context();
    context.no_update = true;
    assert!(matches!(
        fixture.updater.startup(&context, &Never, &Never),
        Err(Error {
            code: ErrorCode::UnsafeInstallation,
            ..
        })
    ));
    let mut profile = fixture.product.clone();
    profile.running_identity = RunningIdentity::Release {
        release_tag: "v1.1.0",
        build_sha: None,
    };
    let current =
        Updater::for_executable(profile, fixture.paths.clone(), fixture.executable.clone())
            .unwrap();
    let (lease, _) = continuing(current.startup(&context, &Never, &Never).unwrap());
    assert!(lease.as_ref().is_some_and(ActiveLease::is_held));
}

#[test]
fn pinned_release_still_checks_the_loaded_image_and_holds_a_lease() {
    let fixture = Fixture::new();
    let mut receipt = fixture.receipt();
    receipt.pinned = true;
    receipt
        .write_verified(&fixture.product, &fixture.paths.receipt)
        .unwrap();
    let (lease, report) = continuing(
        fixture
            .updater
            .startup(&fixture.context(), &Never, &Never)
            .unwrap(),
    );
    assert!(lease.as_ref().is_some_and(ActiveLease::is_held));
    assert!(!report.supported);
    assert_eq!(report.status, UpdateStatus::Unsupported);
    drop(lease);
    let mut old = fixture.product.clone();
    old.running_identity = RunningIdentity::Release {
        release_tag: "v0.9.0",
        build_sha: None,
    };
    let updater =
        Updater::for_executable(old, fixture.paths.clone(), fixture.executable.clone()).unwrap();
    assert!(matches!(
        updater.startup(&fixture.context(), &Never, &Never),
        Err(Error {
            code: ErrorCode::UnsafeInstallation,
            ..
        })
    ));
}

#[test]
fn admission_binds_the_full_prerelease_tag_and_build_sha() {
    let mut profile = product();
    profile.channel = Channel::Prerelease("vm".into());
    profile.running_identity = RunningIdentity::Release {
        release_tag: "v0.2.0",
        build_sha: Some("cccccccccccccccccccccccccccccccccccccccc"),
    };
    assert!(
        profile.validate().is_err(),
        "CARGO's shared 0.2.0 cannot identify a vm release"
    );
    profile.running_identity = RunningIdentity::Release {
        release_tag: "v0.2.0-vm.9",
        build_sha: None,
    };
    assert!(
        profile.validate().is_err(),
        "a prerelease needs an embedded immutable build SHA"
    );
    for (tag, build) in [
        ("v0.2.0-vm.10", "cccccccccccccccccccccccccccccccccccccccc"),
        ("v0.2.0-vm.9", "dddddddddddddddddddddddddddddddddddddddd"),
    ] {
        let fixture = Fixture::with(profile.clone(), "v0.2.0-vm.9");
        let mut receipt = fixture.receipt();
        receipt.release_tag = tag.into();
        receipt.build_sha = Some(build.into());
        receipt.archive_name = fixture.product.asset_names(tag).unwrap()[0].clone();
        receipt
            .write_verified(&fixture.product, &fixture.paths.receipt)
            .unwrap();
        // Disk inspection remains available for an old updating parent; command
        // admission is the separate loaded-image check.
        assert_eq!(fixture.updater.inspect().unwrap().receipt.release_tag, tag);
        let mut context = fixture.context();
        context.no_update = true;
        assert!(matches!(
            fixture.updater.startup(&context, &Never, &Never),
            Err(Error {
                code: ErrorCode::UnsafeInstallation,
                ..
            })
        ));
        assert!(
            !fixture.paths.state_dir.exists(),
            "identity rejection must precede product preferences or work"
        );
    }
}

fn compile_loaded_image(destination: &Path, tag: &str, build: &str) {
    let dependencies = std::env::current_exe()
        .unwrap()
        .parent()
        .unwrap()
        .to_path_buf();
    let mut candidates = fs::read_dir(&dependencies)
        .unwrap()
        .map(|entry| entry.unwrap().path())
        .filter(|path| {
            path.file_name()
                .unwrap()
                .to_string_lossy()
                .starts_with("libhraness_cli_update-")
                && path.extension().is_some_and(|ext| ext == "rlib")
        })
        .collect::<Vec<_>>();
    candidates.sort_by_key(|path| fs::metadata(path).unwrap().modified().unwrap());
    let library = candidates.last().expect("cargo-built updater library");
    let rustc = std::env::var_os("RUSTC").unwrap_or_else(|| "rustc".into());
    let mut command = Command::new(rustc);
    command
        .args([
            "--edition=2021",
            "--crate-name",
            "hraness_loaded_image_fixture",
        ])
        .arg(Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/loaded_image.rs"))
        .arg("-L")
        .arg(format!("dependency={}", dependencies.display()))
        .arg("--extern")
        .arg(format!("hraness_cli_update={}", library.display()))
        .arg("-o")
        .arg(destination)
        .env("HRANESS_TEST_COMPILED_TAG", tag)
        .env("HRANESS_TEST_COMPILED_BUILD", build);
    let output = run_bounded(&mut command, 8192, 64 * 1024, Duration::from_secs(60)).unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
}

#[test]
fn delayed_old_compiled_image_is_rejected_after_atomic_path_replacement() {
    struct CompiledReplacement {
        stage: PathBuf,
    }
    impl Installer for CompiledReplacement {
        fn install(&self, request: &InstallRequest<'_>) -> Result<()> {
            request.revalidate()?;
            let bytes = fs::read(&self.stage).unwrap();
            fs::rename(&self.stage, &request.installation.receipt.executable).unwrap();
            let mut receipt = request.installation.receipt.clone();
            receipt.binary_sha256 = digest(&bytes);
            receipt.release_tag = request.release.tag_name.clone();
            receipt.release_id = request.release.id;
            receipt.build_sha = Some("bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb".into());
            receipt.archive_name = request.product.asset_names(&receipt.release_tag)?[0].clone();
            request.publish_receipt(&receipt)
        }
    }
    let fixture = Fixture::new();
    let old = fixture._temporary.0.join("old-image");
    let newer = fixture._temporary.0.join("new-image");
    compile_loaded_image(&old, "v1.0.0", "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
    compile_loaded_image(&newer, "v1.1.0", "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb");
    assert_ne!(
        digest(&fs::read(&old).unwrap()),
        digest(&fs::read(&newer).unwrap())
    );
    fs::rename(old, &fixture.executable).unwrap();
    let mut receipt = fixture.receipt();
    receipt.binary_sha256 = digest(&fs::read(&fixture.executable).unwrap());
    receipt.build_sha = Some("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa".into());
    receipt
        .write_verified(&fixture.product, &fixture.paths.receipt)
        .unwrap();

    let mut child = Command::new(&fixture.executable)
        .arg(&fixture._temporary.0)
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    let ready = fixture._temporary.0.join("image-loaded");
    let deadline = std::time::Instant::now() + Duration::from_secs(10);
    while !ready.exists() && std::time::Instant::now() < deadline {
        if let Some(status) = child.try_wait().unwrap() {
            panic!("compiled fixture exited before pausing: {status}");
        }
        std::thread::sleep(Duration::from_millis(10));
    }
    if !ready.exists() {
        let _ = child.kill();
        let _ = child.wait();
        panic!("old image did not pause");
    }
    assert_eq!(fs::read(&ready).unwrap(), b"v1.0.0");
    fixture
        .updater
        .execute(
            CommandAction::Install,
            &fixture.source("v1.1.0"),
            &CompiledReplacement { stage: newer },
        )
        .unwrap();
    child.stdin.take().unwrap().write_all(b"x").unwrap();
    let output = child.wait_with_output().unwrap();
    assert_eq!(
        output.status.code(),
        Some(42),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert_eq!(
        fs::read(fixture._temporary.0.join("image-rejected")).unwrap(),
        b"UnsafeInstallation"
    );
    assert!(
        !fixture._temporary.0.join("product-work").exists(),
        "old loaded code must not start work against new installation"
    );

    let mut current = Command::new(&fixture.executable);
    current.arg(&fixture._temporary.0).arg("--admit-now");
    let output = run_bounded(&mut current, 8192, 8192, Duration::from_secs(10)).unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert_eq!(
        fs::read(fixture._temporary.0.join("product-work")).unwrap(),
        b"v1.1.0"
    );
}

fn drift_executable(fixture: &Fixture, bytes: &[u8]) {
    // Simulate a manual copy over the managed path: the receipt stays the
    // record of a verified install while the bytes no longer match it.
    fs::write(&fixture.executable, bytes).unwrap();
    fs::set_permissions(&fixture.executable, fs::Permissions::from_mode(0o755)).unwrap();
}

fn startup_error(outcome: Result<StartupOutcome>) -> Error {
    match outcome {
        Err(error) => error,
        _ => panic!("expected startup error"),
    }
}

fn preserved_drift(fixture: &Fixture, drifted: &[u8]) -> PathBuf {
    fixture
        .executable
        .parent()
        .unwrap()
        .join(format!(".hraness-cli-update-{}", fixture.product.id))
        .join(format!("replaced-{}", digest(drifted)))
}

#[test]
fn drifted_executable_reports_mismatch_and_explicit_update_repairs() {
    let fixture = Fixture::new();
    let drifted = b"#!/bin/sh\nexit 99\n";
    drift_executable(&fixture, drifted);

    // Read-only actions diagnose the drift instead of failing before dispatch.
    let status = fixture
        .updater
        .execute(CommandAction::Status, &Never, &Never)
        .unwrap();
    assert_eq!(status.status, UpdateStatus::Mismatch);
    assert_eq!(status.current.as_deref(), Some("v1.0.0"));
    assert!(status.reason.unwrap().contains("receipt"));
    let check = fixture
        .updater
        .execute(CommandAction::Check, &fixture.source("v1.1.0"), &Never)
        .unwrap();
    assert_eq!(check.status, UpdateStatus::Mismatch);
    assert_eq!(check.current.as_deref(), Some("v1.0.0"));
    assert_eq!(check.latest.as_deref(), Some("v1.1.0"));

    // An explicit update reinstalls a verified release: drifted bytes are
    // preserved beside the install record and the receipt again matches the
    // executable it describes.
    let installer = Replace::new();
    let report = fixture
        .updater
        .execute(
            CommandAction::Install,
            &fixture.source("v1.1.0"),
            &installer,
        )
        .unwrap();
    assert_eq!(report.status, UpdateStatus::Repaired);
    assert_eq!(report.current.as_deref(), Some("v1.1.0"));
    assert_eq!(report.latest.as_deref(), Some("v1.1.0"));
    assert!(report.reason.unwrap().contains("preserved"));
    assert_eq!(fs::read(&fixture.executable).unwrap(), installer.bytes);
    assert_eq!(fixture.receipt().release_tag, "v1.1.0");
    assert_eq!(
        fs::read(preserved_drift(&fixture, drifted)).unwrap(),
        drifted
    );
    fixture.updater.inspect().unwrap();
}

#[test]
fn drift_repairs_to_recorded_release_when_nothing_newer_exists() {
    let fixture = Fixture::new();
    drift_executable(&fixture, b"drifted");
    let report = fixture
        .updater
        .execute(
            CommandAction::Install,
            &fixture.source("v1.0.0"),
            &Replace::new(),
        )
        .unwrap();
    assert_eq!(report.status, UpdateStatus::Repaired);
    assert_eq!(report.latest.as_deref(), Some("v1.0.0"));
    assert_eq!(fixture.receipt().release_tag, "v1.0.0");
    fixture.updater.inspect().unwrap();
}

#[test]
fn drifted_install_without_published_recorded_release_fails_closed() {
    let fixture = Fixture::new();
    drift_executable(&fixture, b"drifted");
    let source = Source {
        releases: vec![release_for(&fixture.product, "v0.9.0")],
        calls: Cell::new(0),
        offline: false,
    };
    let error = fixture
        .updater
        .execute(CommandAction::Install, &source, &Replace::new())
        .unwrap_err();
    assert_eq!(error.code, ErrorCode::Release);
    assert_eq!(fs::read(&fixture.executable).unwrap(), b"drifted");
}

#[test]
fn drifted_pinned_install_repairs_to_its_pin() {
    let fixture = Fixture::new();
    let mut receipt = fixture.receipt();
    receipt.pinned = true;
    fixture.raw_receipt(&receipt);
    drift_executable(&fixture, b"drifted");
    // Both tags remain published; the pin wins over the newer release.
    let source = Source {
        releases: vec![
            release_for(&fixture.product, "v1.0.0"),
            release_for(&fixture.product, "v1.1.0"),
        ],
        calls: Cell::new(0),
        offline: false,
    };
    let report = fixture
        .updater
        .execute(CommandAction::Install, &source, &Replace::new())
        .unwrap();
    assert_eq!(report.status, UpdateStatus::Repaired);
    assert_eq!(report.latest.as_deref(), Some("v1.0.0"));
    // The pin is preserved and the receipt again describes the bytes on disk.
    let receipt = fixture.receipt();
    assert_eq!(receipt.release_tag, "v1.0.0");
    assert!(receipt.pinned);
    assert_eq!(
        receipt.binary_sha256,
        digest(&fs::read(&fixture.executable).unwrap())
    );
}

#[test]
fn startup_repairs_drift_and_reenters_verified_image() {
    let fixture = Fixture::new();
    drift_executable(&fixture, b"drifted");
    let outcome = fixture
        .updater
        .startup(
            &fixture.context(),
            &fixture.source("v1.1.0"),
            &Replace::new(),
        )
        .unwrap();
    let reentry = match outcome {
        StartupOutcome::Reenter(reentry) => reentry,
        _ => panic!("expected reentry after automatic repair"),
    };
    assert_eq!(reentry.report.status, UpdateStatus::Repaired);
    assert_eq!(reentry.report.latest.as_deref(), Some("v1.1.0"));
    drop(reentry);
    fixture.updater.inspect().unwrap();

    // The re-entered process is the repaired image: model it with the new
    // embedded release identity and confirm it continues as an ordinary
    // current installation without repeating repair or touching the network.
    let mut product = fixture.product.clone();
    product.running_identity = RunningIdentity::Release {
        release_tag: "v1.1.0",
        build_sha: None,
    };
    let reentered =
        Updater::for_executable(product, fixture.paths.clone(), fixture.executable.clone())
            .unwrap();
    let mut context = fixture.context();
    context.reentered = true;
    let source = fixture.source("v1.1.0");
    let (lease, report) = continuing(reentered.startup(&context, &source, &Never).unwrap());
    assert_eq!(report.status, UpdateStatus::Skipped);
    assert_eq!(source.calls.get(), 0);
    assert!(lease.is_some());
}

#[test]
fn drifted_startup_fails_closed_under_disabled_policy_but_update_repairs() {
    let fixture = Fixture::new();
    // A prior healthy startup leaves the coordination records a real managed
    // installation has, so the drifted startup exercises the admission arm.
    let _ = continuing(
        fixture
            .updater
            .startup(&fixture.context(), &fixture.source("v1.0.0"), &Never)
            .unwrap(),
    );
    drift_executable(&fixture, b"drifted");
    fixture
        .updater
        .execute(CommandAction::Disable, &Never, &Never)
        .unwrap();
    let source = fixture.source("v1.1.0");
    let installer = Replace::new();
    let error = startup_error(
        fixture
            .updater
            .startup(&fixture.context(), &source, &installer),
    );
    assert_eq!(error.code, ErrorCode::UnsafeInstallation);
    assert_eq!(source.calls.get(), 0);
    assert_eq!(installer.calls.get(), 0);

    // The saved opt-out suppresses only automatic repair; an explicit update
    // still restores a verified release.
    let report = fixture
        .updater
        .execute(
            CommandAction::Install,
            &fixture.source("v1.0.0"),
            &installer,
        )
        .unwrap();
    assert_eq!(report.status, UpdateStatus::Repaired);
    fixture.updater.inspect().unwrap();
}

#[test]
fn drifted_startup_suppressing_contexts_never_repair() {
    let fixture = Fixture::new();
    drift_executable(&fixture, b"drifted");
    for context in [
        StartupContext {
            offline: true,
            ..fixture.context()
        },
        StartupContext {
            ci: true,
            ..fixture.context()
        },
        StartupContext {
            reentered: true,
            ..fixture.context()
        },
        StartupContext {
            no_update: true,
            ..fixture.context()
        },
    ] {
        let source = fixture.source("v1.1.0");
        let installer = Replace::new();
        let error = startup_error(fixture.updater.startup(&context, &source, &installer));
        assert_eq!(error.code, ErrorCode::Ownership);
        assert_eq!(source.calls.get(), 0);
        assert_eq!(installer.calls.get(), 0);
    }
}

#[test]
fn failed_startup_repair_stays_closed_and_is_daily_bounded() {
    let fixture = Fixture::new();
    drift_executable(&fixture, b"drifted");
    let failing = Source {
        releases: vec![release_for(&fixture.product, "v1.1.0")],
        calls: Cell::new(0),
        offline: true,
    };
    let error = startup_error(fixture.updater.startup(
        &fixture.context(),
        &failing,
        &Replace::new(),
    ));
    assert_eq!(error.code, ErrorCode::UnsafeInstallation);
    assert!(error.message.contains("repair failed"));
    assert_eq!(failing.calls.get(), 1);

    // The attempt is recorded like the daily check: the next startup does not
    // retry the network even though a healthy source would now succeed.
    let healthy = fixture.source("v1.1.0");
    let error = startup_error(fixture.updater.startup(
        &fixture.context(),
        &healthy,
        &Replace::new(),
    ));
    assert_eq!(error.code, ErrorCode::UnsafeInstallation);
    assert_eq!(healthy.calls.get(), 0);
}

#[test]
fn drifted_executable_still_rejects_foreign_receipts() {
    let fixture = Fixture::new();
    drift_executable(&fixture, b"drifted");
    let mut receipt = fixture.receipt();
    receipt.executable = fixture.executable.with_file_name("different");
    fixture.raw_receipt(&receipt);
    for action in [CommandAction::Install, CommandAction::Check] {
        assert_eq!(
            fixture
                .updater
                .execute(action, &fixture.source("v1.1.0"), &Replace::new())
                .unwrap_err()
                .code,
            ErrorCode::Ownership
        );
    }
}

#[test]
fn drifted_installer_failure_leaves_mismatch_closed() {
    let fixture = Fixture::new();
    drift_executable(&fixture, b"drifted");
    // A failure after replacing bytes but before publishing the receipt leaves
    // an uncertain installation: still mismatched, still refusing admission,
    // still repairable by a subsequent explicit update.
    let mut installer = Replace::new();
    installer.failure = Some("after");
    let error = fixture
        .updater
        .execute(
            CommandAction::Install,
            &fixture.source("v1.1.0"),
            &installer,
        )
        .unwrap_err();
    assert_eq!(error.code, ErrorCode::UnsafeInstallation);
    assert_eq!(
        fixture.updater.inspect().unwrap_err().code,
        ErrorCode::Ownership
    );
    let report = fixture
        .updater
        .execute(
            CommandAction::Install,
            &fixture.source("v1.0.0"),
            &Replace::new(),
        )
        .unwrap();
    assert_eq!(report.status, UpdateStatus::Repaired);
    fixture.updater.inspect().unwrap();
}
