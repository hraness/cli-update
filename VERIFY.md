# Verify a release

CLI Update releases include a JavaScript package archive, `SHA256SUMS`, and
a GitHub build provenance attestation. The release page names the source
commit and the matching immutable Git tag. Rust consumers use that tag.

Choose a release and download its assets with the GitHub CLI:

```sh
tag=v0.1.1
gh release download "$tag" --repo hraness/cli-update --pattern '*.tgz' --pattern SHA256SUMS
shasum -a 256 -c SHA256SUMS
gh attestation verify hraness-cli-update-${tag#v}.tgz --repo hraness/cli-update --signer-workflow hraness/cli-update/.github/workflows/release.yml --source-ref "refs/tags/$tag"
```

Run these commands in an empty directory. Both verification commands must
succeed before using the archive. The checksum detects damaged or mismatched
bytes; the attestation ties the archive to this repository's release workflow
and source tag.

To inspect the source, fetch the tag and compare its full commit SHA with
the release page. The JavaScript and Rust manifests carry the same version.
Release assets and tags are immutable; corrections ship as another version.
