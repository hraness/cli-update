# Contents

- `src/` is the dependency-free Node and Bun updater for installed CLIs.
- `rust/` is the native CLI updater crate, `hraness-cli-update`.
- `spec/` defines behavior shared by the implementations.
- `test/` and `rust/tests/` exercise installation ownership, release selection, concurrency, failures, and command behavior.
- `scripts/` and `.github/workflows/` build, check, and release the library.

# Guidelines

- Keep this library product-neutral. Products supply their public release identity and own their data, services, commands, and installers.
- Automatic updates are enabled by default only for verified supported installations. Honor saved opt-outs, source and project installs, explicit version bindings, and product offline policies. Never update from a moving source branch.
- Handle updates only at executable startup, before product work. SDK imports, help, and version output have no update effects. Preserve stdout, exit status, and stdin for machine consumers.
- Prove installation ownership before a write. Preserve package-manager ownership and native installer receipts. Do not overwrite source builds, foreign files, or another installation.
- Coordinate updates and active commands with owned locks. Never stop services, restart jobs, alter user data, or change a stored executable pin as an update effect.
- Bound metadata, downloads, subprocess output, and waits. Use fixed HTTPS release authorities and argv arrays, never remote shell text. Prevent unintended downgrades and verify the installed identity after an update.
- Keep Node 22 and Bun 1.3.14 compatibility. Keep the native crate independent of GUI libraries and compatible with Rust 1.85 or later.
- Add meaningful deterministic failure and installation tests for changed behavior. Test with temporary install roots, fake registries, and fake managers; do not change the developer's real global installations or product state.
- Follow Hraness documentation and public writing guidelines. Describe actual supported behavior and release boundaries.
- You are not alone in this repository. Preserve other agents' changes and stay within assigned file ownership.
- Use the installed absolute host-run command for broad checks and builds. One owner runs each required final gate and release wait.
- Deliver source through Required checks and immutable releases. Consumers pin a released archive or immutable Git tag; never depend on a sibling checkout or moving main.
