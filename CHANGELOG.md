# Changelog

## 0.1.2

Native installations whose executable bytes drifted from their verified
install receipt repair instead of deadlocking.

- An explicit `update` reinstalls a verified release, preserving the drifted
  bytes beside the install record and restoring a pinned install to its pin.
- `update status` and `update check` report `mismatch` instead of failing
  before command dispatch.
- Automatic-policy startups repair and re-enter the verified image before
  product work; saved opt-outs and incidental-suppression contexts fail closed
  exactly as before. Attempts are bounded daily by a dedicated stamp.
- Replacement transactions keep every ownership check: the stored receipt is
  the invariant, the recorded pin may no longer be changed by a replacement,
  and foreign or ambiguous installations still refuse to run.

## 0.1.1

Consumers can independently pin direct and transitive updater releases.

- Publish the compiled Node/Bun API at a distinct patch coordinate.
- Keep updater behavior and safety checks unchanged; only package identity and
  installation documentation change.

## 0.1.0

Supported installed CLIs can update before a command starts. Integrators get
shared update controls and installation checks for Node, Bun, and native Unix
tools.

- Add automatic update checks for supported installed CLIs, with daily
  checking, saved preferences, and explicit update commands.
- Check installation ownership and coordinate active commands before
  replacing code.
- Provide Node/Bun package-manager support and a Rust API for native
  products with verified installers.
- Preserve machine output, offline commands, version channels, and
  product-enforced pins.
