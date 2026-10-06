# CLI Update

Updates installed CLIs automatically, with installation checks and an opt-out.
The TypeScript library supports Node and Bun. The Rust crate gives native
tools the same update commands and preferences while keeping their own
verified installer.

Call the updater before a command starts. It checks for a newer release at
most once a day, checks that the installation is idle, and starts the updated
command with the original arguments. If another command is using the
installation, the automatic update waits for a later invocation. A user can turn
automatic updates off or request an update directly.

## Add it to a JavaScript CLI

Requires Node 22 or Bun 1.3.14 or later. Install the released library archive:

```sh
bun add https://github.com/hraness/cli-update/releases/download/v0.1.2/hraness-cli-update-0.1.2.tgz
```

Automatic package replacement currently supports macOS and Linux global
installations. Windows package-manager shims report an unsupported installation;
update those packages through their package manager.

Add this to the executable entrypoint, before opening application files or
starting work. Set the package name, version, and command to your CLI's
published values:

```ts
import { fileURLToPath } from 'node:url';
import { runCliUpdate } from '@hraness/cli-update';

const update = await runCliUpdate({
  packageName: '@example/tool',
  version: '1.0.0',
  binName: 'tool',
  entrypoint: fileURLToPath(import.meta.url),
  argv: process.argv.slice(2),
  provider: { kind: 'npm' },
});

if (update.handled) process.exit(update.exitCode);

try {
  await main(); // Your CLI's existing command handler.
} finally {
  await update.release();
}
```

`tool update status` reports the installation and its update preference.
`tool update check` contacts the configured release service without changing
installed code. `tool update` installs a newer release when the installation
is supported. Each command accepts `--json`.

Importing the library has no update effects. Keep this hook out of SDK entry
points and set the adapter's `offline`, `pinned`, or `nested` flag when the
invocation must retain its current code or network policy.
When command words can also be inputs, pass `effectFree` from the product's
parser. An explicit `false` keeps the command's installation lease even when
an argument is named `version` or `completion`.

## Choose when updates run

Automatic updates are enabled by default for supported installations.

```sh
tool update disable
tool update enable
tool update check --json
```

The saved preference applies to this tool. Set `HRANESS_NO_UPDATE=1` to
suppress automatic updates across tools using this library. CI invocations,
help, version output, and the update commands themselves do not trigger an
additional automatic check.

An offline release service does not prevent an ordinary command from
running. If replacing installed code fails or its result cannot be verified,
the updater stops before running application work and reports the recovery
step.

## Verify the integration without replacing code

After adding the startup hook, run your CLI's `update status --json`. In the
example above, the command is `tool update status --json`. A source checkout
reports `unsupported`; that is expected, not evidence that global installation
updates are broken. Test supported installation behavior with the repository's
fake registries and temporary installation roots before using a real global
package.

On a supported install, `tool update check --json` reports `current` or
`available` and includes `latestVersion` without replacing installed code. This
check contacts your configured release service and records the check time.
`tool update disable` saves an opt-out; it is not a rollback of an update.

## Recover an interrupted update

| Report | Next action |
| --- | --- |
| `busy` | Wait for the active command or package-manager operation to finish, then retry. Do not kill unrelated processes or remove their locks. |
| `mismatch` | The installed executable does not match its verified install receipt. An explicit `update` reinstalls a verified release; automatic-policy startups already repaired and re-entered. |
| A previous update did not finish verification | Run the CLI's explicit `update` command or follow its documented reinstall procedure before running product commands. |
| Repair would require a downgrade | Use the product's documented installer rather than forcing automatic replacement. |
| `unsupported` | Update through the installation method you already use, such as your package manager. |

Keep release archives referenced by the global installation. Deleting them or
coordination records is not a repair procedure. If the report says process
ownership is unknown, inspect the interrupted update and follow the product's
installer guidance instead of bypassing the check.

## Supported installations

The TypeScript adapter checks the running entrypoint against the package
manager's global package root and executable link. It supports verified Bun
and npm global installations. Source checkouts, linked development copies,
project dependencies, and temporary `bunx` or `npx` installations keep their
existing update process. Windows package-manager shims are not supported.
A version pin remains in effect until the user
explicitly enables release tracking; product-enforced pins remain in effect.

Bun's recorded exact versions stay pinned until `update enable`. Its ordinary
range or tag installs track newer releases from the product's configured
channel, including releases outside a saved range. npm does not retain the
original global install constraint reliably; verified npm globals update by
default unless a product pin or saved opt-out applies. Use `update disable`
when an npm global must retain its current version.

An authenticated GitHub product can enroll an initial local archive install
with `update enable`. The archive must remain at its recorded, private path
and match the current immutable release's digest and package identity. Source
directories and unrelated archives cannot enroll. This is an explicit initial
installation step; normal upgrades must preserve existing opt-outs.

The native adapter requires an installation record that matches the running
executable's path and SHA-256. A product supplies its release naming rules
and installer. That installer must check the release artifact, preserve its
existing signature or attestation requirements, and verify the replacement.
See the [Rust integration guide](rust/README.md).
The first native implementation supports Unix installations. Windows requires
a product adapter with a safe replacement mechanism and is not supported by
this version.

Both implementations check for active commands using this library before
updating an installation. They do not restart services, repeat completed commands, or
change application data or stored executable pins.

## Release sources and privacy

The product selects its package or GitHub repository in code. Updates use
published versions from that source and preserve the configured stable or
prerelease channel. They never install from a moving source branch or
silently downgrade a version.

For npm products, the library downloads the selected canonical npm tarball and
checks its SHA-512 or SHA-256 integrity and package identity before asking the
owning manager to install it. A scoped registry setting cannot substitute
different root-package bytes. GitHub archives require their published SHA-256
digest and an immutable release. Product verification hooks can enforce
additional checks. Dependency and lifecycle-script settings stay under the
package manager's existing policy.

Update checks send requests to the configured release service. Local state
stores the update preference, last check time, installation identity, and
process coordination records. Package installs also retain verified release
archives beside the global installation because Bun and npm can reference
those files as dependency sources. Keep each archive while an installation
references it; these files are not disposable download caches.

Updater state contains no application data or account
credentials. A private GitHub release adapter uses the user's existing
authenticated GitHub CLI.

If an interruption leaves a package-manager process running, new commands
refuse to run. After that process stops, an explicit `update` repairs and
verifies the installation. An interruption before its process ID is recorded requires
checking that the installer has stopped and using the documented product
installer. The updater cannot establish completion from a timeout alone.

The JavaScript package is distributed as a GitHub release archive; the Rust
crate is consumed through an immutable Git tag. Neither is published to a
package registry.

## Check the implementation

The [TypeScript tests](test/), [Rust tests](rust/tests/), and
[package smoke check](scripts/package-smoke.mjs) use temporary installations
and fake release services. They cover unsupported installation paths,
version selection, disabled updates, concurrent commands, and failed
updates. The shared behavior is recorded in [spec/contract.json](spec/contract.json).

See [CONTRIBUTING.md](CONTRIBUTING.md) to run the checks and
[CHANGELOG.md](CHANGELOG.md) for releases. The [verification guide](VERIFY.md)
explains how to check a release archive. MIT licensed.
