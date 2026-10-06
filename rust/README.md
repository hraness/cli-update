# hraness-cli-update

Rust 2021 / MSRV 1.85 library for native CLI updates at executable startup. It has no GUI or asynchronous runtime dependency. Products provide their fixed release profile and trusted bundled installer.

Automatic updates are enabled by default for verified, unpinned native installations on Unix. Source builds, Cargo, Homebrew, foreign paths, missing or mismatched receipts, and pinned installations are ineligible. Windows currently returns an explicit unsupported result; use the product's verified Windows installer. The library does not download and execute installer scripts.

## Install

Add the crate from an immutable release tag:

```toml
[dependencies]
hraness-cli-update = { git = "https://github.com/hraness/cli-update", tag = "v0.1.2" }
```

## Executable integration

Construct `Updater::new(Product, Paths)` only at the real executable boundary. `new` obtains the actual running path from `std::env::current_exe()`. Never initialize an updater from an SDK import, service callback, or a PATH-selected different binary. `for_executable` is the deterministic fixture/adaptation boundary; production adapters must supply the same OS-reported running path.

The product sets a fixed `owner/repository`, release tag prefix, channel, platform, executable filename, required asset templates, immutability requirement, manual installation instructions, and required `running_identity`. The identity must come from constants embedded in the loaded executable, such as `RunningIdentity::Release { release_tag: concat!("v", env!("CARGO_PKG_VERSION")), build_sha: None }` for products with unique stable package versions. Never read it from the current executable pathname, installed receipt, runtime environment, or release metadata: those may already describe a newer installed image. `RunningIdentity::Source` explicitly marks an unpublished source build and cannot be admitted as a managed release.

Asset templates accept `{tag}`, `{version}` and `{platform}`. `Channel::Prerelease("vm".into())` retains the vm channel and compares `vm.9 < vm.10`; it never silently promotes to stable or another prerelease channel. Prerelease profiles require both the full embedded release tag and full immutable source/build SHA in `running_identity`. When prereleases share a compiled package version, that version alone is insufficient: embed the full tag, such as `v0.2.0-vm.11`, and the verified build SHA, and retain both in the installation receipt.

```rust,ignore
let updater = Updater::new(product_profile(), product_update_paths())?;
let mut context = StartupContext::from_process();
context.offline = existing_offline_policy();
context.exact_version_bound = runtime_has_an_executable_digest_pin();
context.nested = existing_nested_invocation_policy();
context.deployment = existing_deployment_policy();
// Only when the real product parser guarantees no product work will occur:
context.product_effect_free = parsed_command_only_prints_help_or_completions();

// Use a fixed trusted installed curl path, not an unreviewed PATH lookup.
let source = CurlGithub::new(trusted_curl_path())?;
let installer = BundledProductInstaller;
if let Some(command) = parse_update_command(&context.args)? {
    let result = updater.execute_with_context(
        command.action, &context, &source, &installer,
    )?;
    print_update_result(result, command.json)?;
    return Ok(());
}

let _active_command = match updater.startup(&context, &source, &installer)? {
    StartupOutcome::Continue { lease, report } => {
        optional_update_diagnostic_on_stderr(report);
        lease
    }
    StartupOutcome::Reenter(reentry) => reentry.run_and_exit(),
};
run_product_command().await?;
// Keep _active_command alive until all product work has finished.
```

Do not catch a startup error and continue product work. A failed metadata check is returned as a nonfatal `Continue` report; an error after uncertain replacement requires stopping. Re-entry inherits stdin/stdout/stderr, keeps the original literal arguments, sets `HRANESS_NO_UPDATE=1`, and preserves the child exit code or terminating Unix signal. It occurs before product work, so completed work is never replayed.

Only a single unequivocal root help/version token, or an explicit effect-free declaration from the product parser, bypasses command leases. Nested or ambiguous help-looking arguments and completion routing suppress incidental networking while retaining a lease. Arguments after `--` are data and are never inferred as help. Route explicit update commands before `startup` as shown above. Normal commands respect `HRANESS_NO_UPDATE=1`, true `CI` values, saved disabled/notify policy, the daily check interval, and product admission flags. The `execute_with_context` boundary preserves product offline, pin, nesting and deployment guards for explicit network operations too. An explicit update may still run with automatic updates disabled or in CI.

After acquiring an installation lease, command admission compares the loaded image's embedded release/build identity with the verified receipt. A delayed old process whose pathname now names a newer installation is rejected before product work, even when incidental updating is disabled. Installed-target inspection is separate: the old updater can verify its newly installed target and re-enter it once without pretending its own loaded image changed.

`parse_update_command` accepts `update`, `update check`, `update --check`, `update status`, `update enable`, `update disable`, and `--json`; `update install` is also accepted. It returns data without printing. `UpdateResult::json()` emits one JSON object for stdout. Automatic diagnostics belong on stderr and may be suppressed by the product's machine-output policy.

## Receipt and installer contract

Products must extend their verified initial installer to write `InstallReceipt::SCHEMA` receipts containing the actual executable path and SHA256, complete release tag and numeric GitHub release ID, verified `build_sha` when declared by the running identity (required for prereleases), archive name and SHA256, platform, installation kind, and pin flag. `InstallReceipt::write_verified` verifies current executable bytes and writes the receipt atomically. Retain the product's existing installation metadata too.

The installer must obtain the receipt tag and archive identity from verified release metadata. A binary's `CARGO_PKG_VERSION` alone cannot identify prereleases that intentionally share a compiled package version. A receipt is not a substitute for the product's archive or provenance checks, and the shared library never guesses one for old or copied installations.

Implement `Installer::install(&InstallRequest)` with bundled, reviewed code. The callback runs under the exclusive installation lock and must:

1. Download only the selected exact release assets with bounded IO and time.
2. Preserve SHA256, existing attestation checks, platform/feature identity, archive member allowlists, unpack bounds and layout checks.
3. Stage beside the destination and verify the staged executable's complete product identity.
4. Call `request.revalidate()` immediately before the first installed-code write, after staging. This also honors a saved automatic opt-out during download.
5. Replace atomically with the product's existing rollback guarantees, smoke-check the installed executable, then call `request.publish_receipt(&new_receipt)`.
6. Roll back executable and receipt on failure. If the original installation cannot be verified, return an error and stop; never continue product work.

Installed-code writes, receipt publication, and rollback must execute in the same process as the updater. Child helpers may only download, verify, or stage artifacts; they must never replace installed code or receipts after their parent could exit and release its activity lock. This API does not transfer transaction custody to helper processes. A bundled shell installer that performs the final replacement is therefore not an eligible callback: adapt its verification/staging primitives and perform the final atomic transaction in the Rust caller.

The callback must not change package-manager/source installations, trust policy, stored runtime pins, services, jobs, databases, settings, credentials, plugins, or other product state. Existing services continue running their current executable image. A service restart is a separate product lifecycle operation.

`CurlGithub` reads bounded public GitHub metadata from the configured repository. `download_verified` accepts a selected asset and published SHA256, checks each HTTPS redirect authority, bounds the body, verifies size and digest, and creates a new file in a private staging directory. It does not unpack, execute or replace anything. Products with stronger attestation requirements must apply those too. `run_bounded` provides bounded stdout, stderr and elapsed time for owned noninteractive transports/verifiers; it is not for product work or services.

## State and concurrency

Use one dedicated user-owned 0700 preference directory shared by a product's aliases and one product-owned receipt path. Activity-lock authority is separately fixed to `.hraness-cli-update-PRODUCT_ID` beside the actual OS-reported executable. Changing HOME, XDG, preference or receipt lookup paths cannot bypass an active installation lease; products must keep the same fixed product ID across aliases. The library traverses directories with `openat`/`O_NOFOLLOW`, rejects foreign, group-writable, symlinked or hardlinked files, and writes private state atomically. It stores only policy, daily cadence and installation identity. It does not store credentials or user command input.

Shared active-command locks prevent replacement while another admitted command runs. Exclusive updates do not wait for or terminate active processes. OS locks disappear on process death; no stale PID timeout can release a live lease. A separate short policy lock lets `update disable` work while commands are active. On replacement contention, new work must retry after the update finishes.

For products with an existing updater, read their saved policy using the product's existing ownership checks, then call `initialize_policy_if_absent(saved_policy)` before startup. Preserve explicit notify/disabled settings; do not migrate an old unsaved default as an opt-out. Existing shared-updater policy always wins.

## Validation

Tests use temporary native fixtures, fake GitHub metadata, fake curl, and bounded child processes. A regression compiles two small executables with distinct embedded identities, pauses the old loaded image, atomically installs the new one, and proves the old process cannot begin product work. They never update installed developer tools or product state. Run from the repository workspace with Rust 1.85:

```sh
cargo test --locked -p hraness-cli-update
cargo clippy --locked -p hraness-cli-update --all-targets -- -D warnings
```

On a scheduler-managed Hraness machine, wrap these with the installed absolute `host-run` command. The repository integration owner runs the final aggregate gate.
