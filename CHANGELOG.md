# Changelog

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
