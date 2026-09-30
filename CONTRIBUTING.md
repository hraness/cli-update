# Contributing

Use Bun 1.3.14, Node 22 or later, and the pinned Rust toolchain.

```sh
bun install --frozen-lockfile
bun run check
```

Tests must use temporary installation roots and fake package managers or
release services. Do not update global tools, contact product services, or
open application data while testing the updater.

Keep the Node/Bun and Rust implementations consistent with
[`spec/contract.json`](spec/contract.json). Include a failing example for a
bug fix, especially for installation ownership, version comparisons,
concurrent commands, and interrupted updates.

Follow the shared [documentation guidelines](https://github.com/hraness/.github/blob/main/DOCUMENTATION_GUIDELINES.md)
and [public writing style](https://github.com/hraness/.github/blob/main/STYLE.md).
Keep command help and supported-installation documentation aligned with
the implementation.

Changes use pull requests with the repository checks. Releases use matching
TypeScript and Rust versions, an immutable `vX.Y.Z` tag, and the automated
release workflow. It builds the JavaScript archive, records its checksum,
attests the archive, and publishes the release after validation. Products
consume the released archive or tag rather than a sibling checkout.

Before creating a release tag, the delivery owner verifies that the repository
requires the `Required` check on main, protects version tags from updates and
deletion, and has immutable releases enabled. Read the last setting with
`gh api repos/hraness/cli-update/immutable-releases`; it must report
`enabled: true`. This administration readback uses the owner's existing access.
The release workflow uses its repository token without administration access
and checks that the published release is immutable.
