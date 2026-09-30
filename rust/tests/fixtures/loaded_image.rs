//! Compiled twice by native.rs with distinct embedded release/build constants.
//! The first image pauses before updater construction while its pathname and
//! receipt are atomically replaced with the second compiled image.
use hraness_cli_update::*;
use std::io::Read;
use std::path::PathBuf;

const TAG: &str = env!("HRANESS_TEST_COMPILED_TAG");
const BUILD: &str = env!("HRANESS_TEST_COMPILED_BUILD");

struct Never;
impl ReleaseSource for Never {
    fn releases(&self, _: &Product) -> Result<Vec<Release>> {
        panic!("fixture must not contact the network")
    }
}
impl Installer for Never {
    fn install(&self, _: &InstallRequest<'_>) -> Result<()> {
        panic!("fixture must not install")
    }
}

fn main() {
    let mut args = std::env::args_os().skip(1);
    let root = PathBuf::from(args.next().expect("fixture root"));
    let admit_now = args.next().is_some_and(|arg| arg == "--admit-now");
    if !admit_now {
        std::fs::write(root.join("image-loaded"), TAG).unwrap();
        std::io::stdin().read_exact(&mut [0_u8]).unwrap();
    }
    let product = Product {
        id: "fixture".into(),
        repository: "hraness/fixture".into(),
        tag_prefix: "v".into(),
        channel: Channel::Stable,
        running_identity: RunningIdentity::Release {
            release_tag: TAG,
            build_sha: Some(BUILD),
        },
        executable_name: "fixture".into(),
        platform: "test-unix".into(),
        required_assets: vec![
            "fixture-{tag}-{platform}.tar.gz".into(),
            "fixture-{tag}-{platform}.tar.gz.sha256".into(),
        ],
        require_immutable: true,
        manual_instructions: "Use the verified fixture installer.".into(),
    };
    let paths = Paths {
        state_dir: root.join("updater"),
        receipt: root.join("install.json"),
    };
    #[cfg(target_os = "macos")]
    let updater = Updater::new(product, paths);
    // Linux current_exe would append '(deleted)' after replacement. Inject the
    // original pathname to exercise the macOS semantics on Linux runners too.
    #[cfg(not(target_os = "macos"))]
    let updater = Updater::for_executable(product, paths, root.join("bin/fixture"));
    let outcome = updater.and_then(|updater| {
        let mut context = StartupContext::from_process();
        context.args = vec!["work".into()];
        context.no_update = true;
        updater.startup(&context, &Never, &Never)
    });
    match outcome {
        Ok(StartupOutcome::Continue { lease, .. }) => {
            assert!(lease.is_some());
            std::fs::write(root.join("product-work"), TAG).unwrap();
            drop(lease);
        }
        Ok(StartupOutcome::Reenter(_)) => panic!("no-update fixture cannot replace code"),
        Err(error) => {
            std::fs::write(root.join("image-rejected"), format!("{:?}", error.code)).unwrap();
            std::process::exit(42);
        }
    }
}
