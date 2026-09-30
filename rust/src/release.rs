use crate::{filesystem, run_bounded, Error, ErrorCode, Result};
use semver::Version;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::HashSet;
#[cfg(unix)]
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::Duration;

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", content = "name", rename_all = "snake_case")]
pub enum Channel {
    Stable,
    Prerelease(String),
}

/// Identity embedded in the loaded executable at build time. Never populate this
/// from a receipt, the current executable pathname, runtime environment or a
/// network response: those can describe bytes installed after this image loaded.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum RunningIdentity {
    Release {
        release_tag: &'static str,
        /// Full immutable source/build SHA. Required for prerelease profiles.
        build_sha: Option<&'static str>,
    },
    /// An explicitly unpublished source build is never admitted as a release.
    Source,
}

pub(crate) fn valid_build_sha(value: &str) -> bool {
    matches!(value.len(), 40 | 64)
        && value
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

#[derive(Clone, Debug)]
pub struct Product {
    pub id: String,
    /// Fixed `owner/repository`, compiled into the product.
    pub repository: String,
    /// E.g. `v` or `peopleblade-v`; never a moving branch.
    pub tag_prefix: String,
    pub channel: Channel,
    pub running_identity: RunningIdentity,
    pub executable_name: String,
    pub platform: String,
    /// Exact filenames with optional `{tag}`, `{version}`, `{platform}` slots.
    pub required_assets: Vec<String>,
    pub require_immutable: bool,
    pub manual_instructions: String,
}

fn identifier(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 200
        && value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"._-+".contains(&b))
        && value != "."
        && value != ".."
}

impl Product {
    pub fn validate(&self) -> Result<()> {
        let parts: Vec<_> = self.repository.split('/').collect();
        if !identifier(&self.id)
            || parts.len() != 2
            || parts.iter().any(|p| !identifier(p))
            || !identifier(&self.executable_name)
            || !identifier(&self.platform)
            || self.tag_prefix.len() > 100
            || !self
                .tag_prefix
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b"._-".contains(&b))
            || self.required_assets.is_empty()
            || self.required_assets.len() > 16
            || self.manual_instructions.len() > 4096
        {
            return Err(Error::new(
                ErrorCode::Configuration,
                "Invalid native updater product profile",
            ));
        }
        if let Channel::Prerelease(name) = &self.channel {
            if !identifier(name) || name.contains('.') {
                return Err(Error::new(
                    ErrorCode::Configuration,
                    "Prerelease channel must be one identifier, such as vm or beta",
                ));
            }
        }
        if let RunningIdentity::Release {
            release_tag,
            build_sha,
        } = &self.running_identity
        {
            if !self.accepts(&self.version(release_tag)?)
                || build_sha.is_some_and(|sha| !valid_build_sha(sha))
                || (matches!(self.channel, Channel::Prerelease(_)) && build_sha.is_none())
            {
                return Err(Error::new(ErrorCode::Configuration, "Running release identity must match the channel; prereleases require the full embedded tag and build SHA"));
            }
        }
        self.asset_names(&format!("{}1.0.0", self.tag_prefix))?;
        Ok(())
    }

    pub fn version(&self, tag: &str) -> Result<Version> {
        let raw = tag.strip_prefix(&self.tag_prefix).ok_or_else(|| {
            Error::new(
                ErrorCode::Release,
                "Release tag has the wrong product prefix",
            )
        })?;
        let version = Version::parse(raw)
            .map_err(|_| Error::new(ErrorCode::Release, "Release tag is not a semantic version"))?;
        if tag.len() > 200 || format!("{}{}", self.tag_prefix, version) != tag {
            return Err(Error::new(
                ErrorCode::Release,
                "Release tag is not canonical",
            ));
        }
        Ok(version)
    }

    pub fn accepts(&self, version: &Version) -> bool {
        match &self.channel {
            Channel::Stable => version.pre.is_empty(),
            Channel::Prerelease(name) => {
                !version.pre.is_empty()
                    && version.pre.as_str().split('.').next() == Some(name.as_str())
            }
        }
    }

    pub fn asset_names(&self, tag: &str) -> Result<Vec<String>> {
        let version = self.version(tag)?;
        let names: Vec<_> = self
            .required_assets
            .iter()
            .map(|template| {
                template
                    .replace("{tag}", tag)
                    .replace("{version}", &version.to_string())
                    .replace("{platform}", &self.platform)
            })
            .collect();
        let mut unique = HashSet::new();
        if names
            .iter()
            .any(|name| !identifier(name) || !unique.insert(name))
        {
            return Err(Error::new(
                ErrorCode::Configuration,
                "Release asset templates must produce distinct safe filenames",
            ));
        }
        Ok(names)
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Asset {
    pub id: u64,
    pub name: String,
    pub browser_download_url: String,
    pub size: u64,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Release {
    pub id: u64,
    pub tag_name: String,
    pub draft: bool,
    pub prerelease: bool,
    #[serde(default)]
    pub immutable: bool,
    pub assets: Vec<Asset>,
}

fn encoded_segment(value: &str) -> String {
    value.replace('+', "%2B")
}

impl Release {
    pub fn validate(&self, product: &Product) -> Result<Version> {
        let version = product.version(&self.tag_name)?;
        if self.id == 0
            || self.draft
            || self.prerelease == version.pre.is_empty()
            || (product.require_immutable && !self.immutable)
            || !product.accepts(&version)
        {
            return Err(Error::new(
                ErrorCode::Release,
                "Release does not satisfy this product's identity, channel, or immutability policy",
            ));
        }
        if self.assets.len() > 200 {
            return Err(Error::new(ErrorCode::Limit, "Release has too many assets"));
        }
        let expected = product.asset_names(&self.tag_name)?;
        for name in expected {
            let matches: Vec<_> = self
                .assets
                .iter()
                .filter(|asset| asset.name == name)
                .collect();
            if matches.len() != 1 {
                return Err(Error::new(
                    ErrorCode::Release,
                    "Release is missing a required unique platform asset",
                ));
            }
            validate_asset(product, self, matches[0])?;
        }
        Ok(version)
    }

    pub fn asset(&self, name: &str) -> Option<&Asset> {
        self.assets.iter().find(|asset| asset.name == name)
    }
}

fn validate_asset(product: &Product, release: &Release, asset: &Asset) -> Result<()> {
    let prefix = format!(
        "https://github.com/{}/releases/download/",
        product.repository
    );
    let raw = format!("{prefix}{}/{}", release.tag_name, asset.name);
    let encoded = format!(
        "{prefix}{}/{}",
        encoded_segment(&release.tag_name),
        encoded_segment(&asset.name)
    );
    if asset.id == 0
        || !identifier(&asset.name)
        || asset.size == 0
        || asset.size > 512 * 1024 * 1024
        || (asset.browser_download_url != raw && asset.browser_download_url != encoded)
    {
        return Err(Error::new(
            ErrorCode::Release,
            "Asset URL, size, or identity does not belong to the configured GitHub release",
        ));
    }
    Ok(())
}

pub trait ReleaseSource {
    /// A bounded published-release listing. The updater validates every selected
    /// identity and requires platform assets before invoking an installer.
    fn releases(&self, product: &Product) -> Result<Vec<Release>>;
}

pub(crate) fn select(
    product: &Product,
    current: &str,
    releases: Vec<Release>,
) -> Result<Option<Release>> {
    if releases.len() > 300 {
        return Err(Error::new(
            ErrorCode::Limit,
            "Release listing exceeds 300 entries",
        ));
    }
    let current_version = product.version(current)?;
    if !product.accepts(&current_version) {
        return Err(Error::new(
            ErrorCode::Ownership,
            "Installed release tag does not match the configured channel",
        ));
    }
    let mut candidates = Vec::new();
    let mut tags = HashSet::new();
    for release in releases {
        // GitHub listings include drafts, old channels and assets for other targets.
        let Ok(version) = product.version(&release.tag_name) else {
            continue;
        };
        if release.draft || !product.accepts(&version) {
            continue;
        }
        if !tags.insert(release.tag_name.clone()) {
            return Err(Error::new(
                ErrorCode::Release,
                "Release listing contains duplicate tags",
            ));
        }
        if version.cmp_precedence(&current_version).is_le() {
            continue;
        }
        if product.require_immutable && !release.immutable {
            continue;
        }
        // An incomplete platform release is not an install candidate. Invalid
        // assets on an otherwise complete candidate fail closed.
        let expected = product.asset_names(&release.tag_name)?;
        if expected
            .iter()
            .any(|name| !release.assets.iter().any(|asset| &asset.name == name))
        {
            continue;
        }
        release.validate(product)?;
        candidates.push((version, release));
    }
    candidates.sort_by(|a, b| a.0.cmp_precedence(&b.0));
    if candidates
        .windows(2)
        .any(|pair| pair[0].0.cmp_precedence(&pair[1].0).is_eq())
    {
        return Err(Error::new(
            ErrorCode::Release,
            "Release versions have ambiguous equal semantic precedence",
        ));
    }
    Ok(candidates.pop().map(|(_, release)| release))
}

/// Public GitHub transport using a trusted installed curl executable. No auth
/// state is stored; no user curl config is loaded; redirects are checked one hop
/// at a time. Native private products must supply a separately reviewed source.
#[derive(Clone, Debug)]
pub struct CurlGithub {
    curl: PathBuf,
}

impl CurlGithub {
    pub fn new(curl: impl Into<PathBuf>) -> Result<Self> {
        let curl = curl.into();
        if !curl.is_absolute() {
            return Err(Error::new(
                ErrorCode::Configuration,
                "curl must be a trusted absolute installed path",
            ));
        }
        Ok(Self { curl })
    }

    fn request(&self, url: &str, limit: usize, allow_asset_redirects: bool) -> Result<Vec<u8>> {
        let mut next = url.to_owned();
        for _ in 0..=3 {
            if !trusted_url(&next, allow_asset_redirects) {
                return Err(Error::new(
                    ErrorCode::Release,
                    "GitHub redirected outside the trusted HTTPS asset authorities",
                ));
            }
            let mut command = Command::new(&self.curl);
            command.args([
                "--disable",
                "--silent",
                "--show-error",
                "--include",
                "--proto",
                "=https",
                "--connect-timeout",
                "5",
                "--max-time",
                "30",
                "--max-filesize",
                &limit.to_string(),
                "--user-agent",
                "hraness-cli-update/0.1.0",
                "--header",
                "Accept: application/vnd.github+json",
                "--url",
                &next,
            ]);
            let output = run_bounded(
                &mut command,
                limit.saturating_add(64 * 1024),
                8192,
                Duration::from_secs(32),
            )?;
            if !output.status.success() {
                return Err(Error::new(
                    ErrorCode::Network,
                    "GitHub request failed; installed CLI was not changed",
                ));
            }
            let (status, location, body) = response(&output.stdout)?;
            if (200..300).contains(&status) {
                if body.len() > limit {
                    return Err(Error::new(
                        ErrorCode::Limit,
                        "GitHub response exceeded its limit",
                    ));
                }
                return Ok(body.to_vec());
            }
            if allow_asset_redirects && [301, 302, 303, 307, 308].contains(&status) {
                next = location.ok_or_else(|| {
                    Error::new(ErrorCode::Release, "GitHub redirect has no location")
                })?;
                continue;
            }
            return Err(Error::new(
                ErrorCode::Network,
                format!("GitHub returned HTTP {status}"),
            ));
        }
        Err(Error::new(
            ErrorCode::Network,
            "GitHub exceeded the redirect limit",
        ))
    }

    /// Fetch one exact asset, verify its published SHA256, and create a new file
    /// inside a private staging directory. This never unpacks or executes bytes;
    /// the product still owns archive and stronger attestation checks.
    pub fn download_verified(
        &self,
        product: &Product,
        release: &Release,
        asset: &Asset,
        sha256: &str,
        destination: &Path,
        limit: usize,
    ) -> Result<()> {
        product.validate()?;
        release.validate(product)?;
        validate_asset(product, release, asset)?;
        if !release.assets.iter().any(|a| {
            a.id == asset.id
                && a.name == asset.name
                && a.browser_download_url == asset.browser_download_url
                && a.size == asset.size
        }) {
            return Err(Error::new(
                ErrorCode::Release,
                "Asset is not in the selected release",
            ));
        }
        if !filesystem::valid_digest(sha256)
            || limit == 0
            || limit > 512 * 1024 * 1024
            || asset.size > limit as u64
        {
            return Err(Error::new(
                ErrorCode::Configuration,
                "Invalid verified download bound or digest",
            ));
        }
        let bytes = self.request(&asset.browser_download_url, limit, true)?;
        if bytes.len() as u64 != asset.size || format!("{:x}", Sha256::digest(&bytes)) != sha256 {
            return Err(Error::new(
                ErrorCode::Release,
                "Downloaded asset does not match its published size and digest",
            ));
        }
        filesystem::absolute(destination)?;
        let parent = destination.parent().ok_or_else(|| {
            Error::new(ErrorCode::UnsafePath, "Download destination has no parent")
        })?;
        let directory = filesystem::open_dir(parent, false, true)?;
        write_new(&directory, destination, &bytes)
    }
}

#[cfg(unix)]
fn write_new(directory: &std::fs::File, destination: &Path, bytes: &[u8]) -> Result<()> {
    use std::os::fd::{AsRawFd, FromRawFd};
    use std::os::unix::ffi::OsStrExt;
    let name = destination.file_name().ok_or_else(|| {
        Error::new(
            ErrorCode::UnsafePath,
            "Download destination has no filename",
        )
    })?;
    let name = std::ffi::CString::new(name.as_bytes())
        .map_err(|_| Error::new(ErrorCode::UnsafePath, "Invalid download filename"))?;
    let fd = unsafe {
        libc::openat(
            directory.as_raw_fd(),
            name.as_ptr(),
            libc::O_WRONLY | libc::O_CREAT | libc::O_EXCL | libc::O_NOFOLLOW | libc::O_CLOEXEC,
            0o600,
        )
    };
    if fd < 0 {
        return Err(Error::io(
            "Create verified download",
            std::io::Error::last_os_error(),
        ));
    }
    let mut file = unsafe { std::fs::File::from_raw_fd(fd) };
    let result = file
        .write_all(bytes)
        .and_then(|_| file.sync_all())
        .and_then(|_| directory.sync_all())
        .map_err(|e| Error::io("Write verified download", e));
    if result.is_err() {
        unsafe { libc::unlinkat(directory.as_raw_fd(), name.as_ptr(), 0) };
    }
    result
}

#[cfg(not(unix))]
fn write_new(_directory: &std::fs::File, _destination: &Path, _bytes: &[u8]) -> Result<()> {
    Err(Error::new(
        ErrorCode::Unsupported,
        "Verified native staging is not supported on this platform",
    ))
}

impl ReleaseSource for CurlGithub {
    fn releases(&self, product: &Product) -> Result<Vec<Release>> {
        product.validate()?;
        let mut releases = Vec::new();
        for page in 1..=3 {
            let url = format!(
                "https://api.github.com/repos/{}/releases?per_page=100&page={page}",
                product.repository
            );
            let bytes = self.request(&url, 2 * 1024 * 1024, false)?;
            let batch: Vec<Release> = serde_json::from_slice(&bytes)
                .map_err(|_| Error::new(ErrorCode::Release, "Invalid GitHub release metadata"))?;
            if batch.len() > 100 {
                return Err(Error::new(
                    ErrorCode::Limit,
                    "GitHub release page exceeds 100 entries",
                ));
            }
            let done = batch.len() < 100;
            releases.extend(batch);
            if done {
                break;
            }
        }
        Ok(releases)
    }
}

fn trusted_url(url: &str, assets: bool) -> bool {
    if url.len() > 16 * 1024 || url.bytes().any(|b| b.is_ascii_control() || b == b'\\') {
        return false;
    }
    let Some(rest) = url.strip_prefix("https://") else {
        return false;
    };
    let Some((host, _)) = rest.split_once('/') else {
        return false;
    };
    if url.contains('#') {
        return false;
    }
    if assets {
        matches!(
            host,
            "github.com" | "release-assets.githubusercontent.com" | "objects.githubusercontent.com"
        )
    } else {
        host == "api.github.com"
    }
}

fn response(mut bytes: &[u8]) -> Result<(u16, Option<String>, &[u8])> {
    let mut total_headers = 0;
    loop {
        let end = bytes
            .windows(4)
            .position(|part| part == b"\r\n\r\n")
            .ok_or_else(|| Error::new(ErrorCode::Network, "Invalid GitHub HTTP headers"))?;
        total_headers += end + 4;
        if total_headers > 64 * 1024 {
            return Err(Error::new(
                ErrorCode::Limit,
                "GitHub HTTP headers exceed 64 KiB",
            ));
        }
        let header = std::str::from_utf8(&bytes[..end])
            .map_err(|_| Error::new(ErrorCode::Network, "Invalid GitHub header encoding"))?;
        let mut lines = header.split("\r\n");
        let status_line = lines.next().unwrap_or_default();
        let mut parts = status_line.split_whitespace();
        if !parts.next().unwrap_or_default().starts_with("HTTP/") {
            return Err(Error::new(ErrorCode::Network, "Invalid GitHub HTTP status"));
        }
        let status: u16 = parts
            .next()
            .and_then(|s| s.parse().ok())
            .ok_or_else(|| Error::new(ErrorCode::Network, "Invalid GitHub HTTP status"))?;
        let mut location = None;
        for line in lines {
            if let Some((name, value)) = line.split_once(':') {
                if name.eq_ignore_ascii_case("location") {
                    if location.is_some() {
                        return Err(Error::new(ErrorCode::Network, "Ambiguous GitHub redirect"));
                    }
                    location = Some(value.trim().to_owned());
                }
            }
        }
        bytes = &bytes[end + 4..];
        // curl --include may emit proxy CONNECT or informational headers first.
        if (100..200).contains(&status)
            || (status == 200
                && status_line
                    .to_ascii_lowercase()
                    .contains("connection established"))
        {
            continue;
        }
        return Ok((status, location, bytes));
    }
}
