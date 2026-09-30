#![cfg(not(unix))]

use hraness_cli_update::*;

struct Never;
impl ReleaseSource for Never {
    fn releases(&self, _: &Product) -> Result<Vec<Release>> {
        panic!("unsupported platform must not contact release authority")
    }
}
impl Installer for Never {
    fn install(&self, _: &InstallRequest<'_>) -> Result<()> {
        panic!("unsupported platform must not replace code")
    }
}

#[test]
fn unsupported_platform_returns_an_accurate_result_without_writes() {
    let directory =
        std::env::temp_dir().join(format!("hraness-update-unsupported-{}", std::process::id()));
    assert!(!directory.exists());
    let updater = Updater::new(
        Product {
            id: "fixture".into(),
            repository: "hraness/fixture".into(),
            tag_prefix: "v".into(),
            channel: Channel::Stable,
            running_identity: RunningIdentity::Release {
                release_tag: "v1.0.0",
                build_sha: None,
            },
            executable_name: "fixture.exe".into(),
            platform: "windows-x86_64".into(),
            required_assets: vec!["fixture-{tag}-{platform}.zip".into()],
            require_immutable: true,
            manual_instructions: "Use the verified Windows installer.".into(),
        },
        Paths {
            state_dir: directory.join("state"),
            receipt: directory.join("receipt.json"),
        },
    )
    .unwrap();
    for command in [
        CommandAction::Status,
        CommandAction::Enable,
        CommandAction::Disable,
        CommandAction::Check,
        CommandAction::Install,
    ] {
        let result = updater.execute(command, &Never, &Never).unwrap();
        assert_eq!(result.status, UpdateStatus::Unsupported);
        assert!(!result.supported);
    }
    let mut context = StartupContext::from_process();
    context.args = vec!["work".into()];
    match updater.startup(&context, &Never, &Never).unwrap() {
        StartupOutcome::Continue { lease, report } => {
            assert!(lease.is_none());
            assert_eq!(report.status, UpdateStatus::Unsupported);
        }
        StartupOutcome::Reenter(_) => panic!("unsupported platform must not re-enter"),
    }
    assert!(!directory.exists());
}
