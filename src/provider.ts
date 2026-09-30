import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import * as fs from 'node:fs/promises';
import { dirname, join, parse, posix, sep } from 'node:path';
import { createGunzip } from 'node:zlib';
import { discoverExecutable } from './install.js';
import { compareVersions, parseVersion } from './semver.js';
import { canCoordinate, syncDirectory } from './state.js';
import type { CliUpdateOptions, GitHubProvider, Release, UpdateRuntime } from './types.js';

const METADATA_BYTES = 2_097_152;
const ARCHIVE_BYTES = 536_870_912;
const ARCHIVE_TIMEOUT = 120_000;
const METADATA_TIMEOUT = 5_000;

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid release metadata.');
  return value as Record<string, unknown>;
}

export function validateOptions(options: CliUpdateOptions): void {
  if (!/^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/.test(options.packageName) || options.packageName.length > 214) throw new Error('Invalid fixed package identity.');
  if (!parseVersion(options.version)) throw new Error('The current version must be a semantic version.');
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(options.binName)) throw new Error('Invalid executable name.');
  const provider = options.provider;
  if (provider?.kind === 'github') {
    if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(provider.repository) || provider.repository.split('/').some(p => p === '.' || p === '..')) throw new Error('Invalid fixed GitHub release repository.');
    if (!/^[A-Za-z0-9._{}-]+$/.test(provider.assetName) || provider.assetName.replaceAll('{version}', '').includes('{') || !provider.assetName.endsWith('.tgz')) throw new Error('GitHub package asset must be one exact .tgz filename template.');
    if (!/^[A-Za-z0-9._-]{0,64}$/.test(provider.tagPrefix ?? 'v')) throw new Error('Invalid release tag prefix.');
  } else if (provider?.kind === 'npm' && !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(provider.tag ?? 'latest')) throw new Error('Invalid fixed npm release tag.');
}

async function fetchBytes(url: string, runtime: UpdateRuntime): Promise<Buffer> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(new Error('Release metadata request timed out.')); }, METADATA_TIMEOUT); });
  const request = (async () => {
    const response = await runtime.fetch(url, { headers: { Accept: 'application/json' }, redirect: 'error', signal: controller.signal });
    if (!response.ok || !response.body || (response.url && response.url !== url)) throw new Error('Release metadata request failed.');
    const length = response.headers.get('content-length');
    if (length !== null && (!/^\d+$/.test(length) || Number(length) > METADATA_BYTES)) throw new Error('Release metadata exceeds its size limit.');
    const chunks: Uint8Array[] = [];
    let total = 0;
    const reader = response.body.getReader();
    try {
      while (true) {
        const chunk = await reader.read(); if (chunk.done) break;
        total += chunk.value.length;
        if (total > METADATA_BYTES) { await reader.cancel(); throw new Error('Release metadata exceeds its size limit.'); }
        chunks.push(chunk.value);
      }
    } finally { reader.releaseLock(); }
    return Buffer.concat(chunks);
  })();
  try { return await Promise.race([request, timeout]); }
  finally { if (timer) clearTimeout(timer); controller.abort(); }
}

async function githubMetadata(provider: GitHubProvider, options: CliUpdateOptions, runtime: UpdateRuntime, version?: string): Promise<unknown> {
  const endpoint = version === undefined ? `repos/${provider.repository}/releases?per_page=30`
    : `repos/${provider.repository}/releases/tags/${encodeURIComponent((provider.tagPrefix ?? 'v') + version)}`;
  if (!provider.authenticated) return JSON.parse((await fetchBytes(`https://api.github.com/${endpoint}`, runtime)).toString('utf8')) as unknown;
  const gh = await discoverExecutable('gh', options, runtime);
  if (!gh) throw new Error('This release channel requires an authenticated GitHub CLI (gh).');
  const result = await runtime.run(gh, ['api', '--hostname', 'github.com', '-H', 'Accept: application/vnd.github+json', endpoint], {
    env: runtime.env, timeoutMs: METADATA_TIMEOUT, maxOutputBytes: METADATA_BYTES,
  });
  if (result.code !== 0) throw new Error('GitHub release metadata could not be read; check gh authentication and repository access.');
  return JSON.parse(result.stdout) as unknown;
}

export async function latestRelease(options: CliUpdateOptions, runtime: UpdateRuntime): Promise<Release> {
  const provider = options.provider ?? { kind: 'npm' as const };
  if (provider.kind === 'npm') {
    const url = `https://registry.npmjs.org/${encodeURIComponent(options.packageName)}/${encodeURIComponent(provider.tag ?? 'latest')}`;
    const metadata = object(JSON.parse((await fetchBytes(url, runtime)).toString('utf8')) as unknown);
    if (metadata.name !== options.packageName || typeof metadata.version !== 'string' || !parseVersion(metadata.version)) throw new Error('Registry package identity or version is invalid.');
    const dist = object(metadata.dist);
    if (typeof dist.tarball !== 'string' || typeof dist.integrity !== 'string' || !/^(?:sha512-[A-Za-z0-9+/]{86}==|sha256-[A-Za-z0-9+/]{43}=)$/.test(dist.integrity)) throw new Error('Registry package integrity metadata is invalid.');
    const archive = new URL(dist.tarball);
    const unscoped = options.packageName.split('/').at(-1)!;
    if (archive.origin !== 'https://registry.npmjs.org' || archive.username || archive.password || archive.search || archive.hash ||
        decodeURIComponent(archive.pathname) !== `/${options.packageName}/-/${unscoped}-${metadata.version}.tgz`) throw new Error('Registry package archive has an unexpected authority or identity.');
    if (parseVersion(metadata.version)!.prerelease.length && !parseVersion(options.version)!.prerelease.length && (provider.tag ?? 'latest') === 'latest') throw new Error('A stable installation cannot silently switch to a prerelease.');
    return { provider, packageName: options.packageName, version: metadata.version, archiveUrl: archive.href, integrity: dist.integrity };
  }
  const metadata = await githubMetadata(provider, options, runtime);
  if (!Array.isArray(metadata) || metadata.length > 30) throw new Error('Invalid GitHub releases response.');
  const candidates = metadata.map(item => githubRelease(item, provider, options)).filter((release): release is Release => release !== undefined);
  candidates.sort((a, b) => compareVersions(b.version, a.version));
  if (!candidates[0]) throw new Error('No verified compatible GitHub package release was found.');
  return candidates[0];
}

function githubRelease(item: unknown, provider: GitHubProvider, options: CliUpdateOptions): Release | undefined {
    const release = object(item);
    if (release.draft !== false || release.immutable !== true || typeof release.prerelease !== 'boolean' || typeof release.tag_name !== 'string') return undefined;
    const prefix = provider.tagPrefix ?? 'v';
    if (!release.tag_name.startsWith(prefix)) return undefined;
    const version = release.tag_name.slice(prefix.length), parsed = parseVersion(version);
    if (!parsed || release.prerelease !== (parsed.prerelease.length > 0)) return undefined;
    if (provider.channel !== 'prerelease' && release.prerelease) return undefined;
    if (provider.channel === 'prerelease' && !release.prerelease) return undefined;
    if (provider.channel === 'prerelease' && parsed.prerelease.length && parseVersion(options.version)!.prerelease.length &&
        parsed.prerelease[0] !== parseVersion(options.version)!.prerelease[0]) return undefined;
    const expectedAsset = provider.assetName.replaceAll('{version}', version);
    if (!Array.isArray(release.assets)) return undefined;
    const assets = release.assets.map(object).filter(asset => asset.name === expectedAsset);
    if (assets.length !== 1) return undefined;
    const asset = assets[0]!;
    const url = `https://github.com/${provider.repository}/releases/download/${release.tag_name}/${expectedAsset}`;
    if (asset.browser_download_url !== url || typeof asset.digest !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(asset.digest) ||
        !Number.isSafeInteger(asset.id) || (asset.id as number) <= 0 ||
        !Number.isSafeInteger(asset.size) || (asset.size as number) <= 0 || (asset.size as number) > ARCHIVE_BYTES) return undefined;
    return { provider, version, packageName: options.packageName, archiveUrl: url,
      sha256: asset.digest.slice(7), tag: release.tag_name, assetName: expectedAsset, assetId: asset.id as number };
}

/** Enrollment reads the exact installed release, even when it is no longer latest. */
export async function currentGitHubRelease(options: CliUpdateOptions, runtime: UpdateRuntime): Promise<Release> {
  const provider = options.provider;
  if (provider?.kind !== 'github' || !provider.authenticated) throw new Error('Archive enrollment requires the configured authenticated GitHub release channel.');
  const selected = githubRelease(await githubMetadata(provider, options, runtime, options.version), provider, options);
  if (!selected || selected.version !== options.version) throw new Error('The installed version has no matching immutable GitHub package release.');
  return selected;
}

/** Verify the exact existing local source without changing its path or installing it. */
export async function verifyExistingGitHubArchive(path: string, release: Release, options: CliUpdateOptions, runtime: UpdateRuntime): Promise<void> {
  const sourcePath = async () => {
    if (!(await fs.lstat(path)).isFile()) throw new Error('Archive enrollment requires a regular file, not a symbolic link or special file.');
    // macOS spells its system temporary directory through root-owned /var.
    // Accept that OS alias while rejecting user-controlled symbolic parents.
    const root = parse(path).root; let parent = root;
    for (const part of dirname(path).slice(root.length).split(sep).filter(Boolean)) {
      parent = join(parent, part); const stat = await fs.lstat(parent);
      if (stat.isSymbolicLink()) { if (stat.uid !== 0) throw new Error('Archive source aliases must be owned by the operating system.'); }
      else if (!stat.isDirectory() || (runtime.uid !== undefined && stat.uid !== runtime.uid && stat.uid !== 0) ||
          ((stat.mode & 0o022) !== 0 && !(stat.uid === 0 && (stat.mode & 0o1000) !== 0))) throw new Error('Archive source ancestors can be changed by another user.');
    }
    const canonical = await fs.realpath(path);
    if (!await canCoordinate(dirname(canonical), runtime)) throw new Error('Archive enrollment requires an owned source directory that others cannot change.');
    return canonical;
  };
  const canonical = await sourcePath();
  const hash = async () => {
    const handle = await fs.open(canonical, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size <= 0 || stat.size > ARCHIVE_BYTES || (stat.mode & 0o022) !== 0 ||
          (runtime.uid !== undefined && stat.uid !== runtime.uid)) throw new Error('Archive enrollment requires a user-owned, non-writable-by-others regular archive.');
      const digest = createHash('sha256'); let bytes = 0;
      for await (const chunk of handle.createReadStream({ autoClose: false })) {
        bytes += (chunk as Buffer).length;
        if (bytes > ARCHIVE_BYTES) throw new Error('The enrollment archive exceeds its size limit.');
        digest.update(chunk);
      }
      if (digest.digest('hex') !== release.sha256) throw new Error('The installed archive does not match its immutable GitHub release digest.');
    } finally { await handle.close(); }
  };
  await hash();
  await verifyPackageArchive(canonical, options.packageName, release.version);
  await options.verifyArtifact?.({ path: canonical, version: release.version, sha256: release.sha256! });
  // The callback may perform asynchronous checks; bind the final bytes too.
  if (await sourcePath() !== canonical) throw new Error('The enrollment archive changed path during verification.');
  await hash();
}

function parsePax(buffer: Buffer): Record<string, string> {
  const fields: Record<string, string> = Object.create(null) as Record<string, string>;
  let offset = 0;
  while (offset < buffer.length) {
    const space = buffer.indexOf(32, offset);
    if (space < 0) throw new Error('Invalid PAX archive header.');
    const digits = buffer.subarray(offset, space).toString('ascii');
    if (!/^[1-9]\d{0,6}$/.test(digits)) throw new Error('Invalid PAX archive record length.');
    const length = Number(digits), end = offset + length;
    if (end > buffer.length || end <= space + 2 || buffer[end - 1] !== 10) throw new Error('Invalid PAX archive record.');
    const text = new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(space + 1, end - 1));
    const equal = text.indexOf('=');
    if (equal < 1) throw new Error('Invalid PAX archive field.');
    const key = text.slice(0, equal), value = text.slice(equal + 1);
    if (key.startsWith('GNU.sparse') || key === 'linkpath') throw new Error('Unsupported PAX archive extension.');
    fields[key] = value; offset = end;
  }
  return fields;
}

/** Stream the tar to inspect effective PAX names; never extract archive paths. */
export async function verifyPackageArchive(path: string, name: string, version: string): Promise<void> {
  const handle = await fs.open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    if (!(await handle.stat()).isFile()) throw new Error('Release archive must be a regular file.');
  } catch (error) { await handle.close(); throw error; }
  const input = handle.createReadStream();
  const stream = input.pipe(createGunzip());
  input.on('error', error => { stream.destroy(error); });
  let buffer = Buffer.alloc(0), remaining = 0, padding = 0, expanded = 0;
  let reading: 'manifest' | 'pax' | 'global' | undefined, found = false, chunks: Buffer[] = [];
  let pax: Record<string, string> = {}, globalPax: Record<string, string> = {};
  try {
    for await (const raw of stream) {
      const chunk = raw as Buffer; expanded += chunk.length;
      if (expanded > 2_147_483_648) throw new Error('Release archive expands beyond its limit.');
      buffer = Buffer.concat([buffer, chunk]);
      while (true) {
        if (remaining) {
          const take = Math.min(remaining, buffer.length);
          if (reading) chunks.push(Buffer.from(buffer.subarray(0, take)));
          buffer = buffer.subarray(take); remaining -= take;
          if (remaining) break;
          if (reading) {
            const contents = Buffer.concat(chunks);
            if (reading === 'manifest') {
              const manifest = object(JSON.parse(contents.toString('utf8')) as unknown);
              if (manifest.name !== name || manifest.version !== version) throw new Error('Release archive package identity does not match the selected release.');
              found = true;
            } else if (reading === 'pax') pax = { ...pax, ...parsePax(contents) };
            else {
              const fields = parsePax(contents);
              if ('path' in fields || 'size' in fields) throw new Error('Global PAX identity overrides are unsupported.');
              globalPax = { ...globalPax, ...fields };
            }
            reading = undefined; chunks = [];
          }
        }
        if (padding) { const take = Math.min(padding, buffer.length); buffer = buffer.subarray(take); padding -= take; if (padding) break; }
        if (buffer.length < 512) break;
        const header = buffer.subarray(0, 512); buffer = buffer.subarray(512);
        if (header.every(byte => byte === 0)) continue;
        const field = (start: number, end: number) => header.subarray(start, end).toString('utf8').replace(/\0.*$/s, '');
        const rawSize = field(124, 136).trim(), rawChecksum = field(148, 156).trim();
        if (!/^[0-7]+$/.test(rawSize) || !/^[0-7]+$/.test(rawChecksum)) throw new Error('Invalid package archive header.');
        const checksum = header.reduce((sum, byte, index) => sum + (index >= 148 && index < 156 ? 32 : byte), 0);
        if (checksum !== Number.parseInt(rawChecksum, 8)) throw new Error('Invalid package archive header checksum.');
        const type = header[156]!;
        if ([75, 76, 83].includes(type)) throw new Error('GNU name, link, and sparse archive extensions are unsupported.');
        let size = Number.parseInt(rawSize, 8);
        const prefix = field(345, 500);
        let pathName = `${prefix ? prefix + '/' : ''}${field(0, 100)}`;
        if (type === 120 || type === 103) {
          if (size <= 0 || size > 65_536) throw new Error('Invalid PAX archive header size.');
          reading = type === 120 ? 'pax' : 'global';
        } else {
          const effective = { ...globalPax, ...pax }; pax = {};
          if (effective.path !== undefined) pathName = effective.path;
          if (effective.size !== undefined) {
            if (!/^\d+$/.test(effective.size)) throw new Error('Invalid PAX archive entry size.');
            size = Number(effective.size);
          }
          if ([49, 50].includes(type)) throw new Error('Package archive links are unsupported.');
          if (pathName.startsWith('/') || pathName.split('/').includes('..') || pathName.includes('\0')) throw new Error('Unsafe package archive path.');
          pathName = posix.normalize(pathName);
          reading = pathName === 'package/package.json' ? 'manifest' : undefined;
          if (reading && (found || size === 0 || size > 262_144 || ![0, 48].includes(type))) throw new Error('Invalid or duplicate package archive manifest.');
        }
        if (!Number.isSafeInteger(size) || size > 2_147_483_648 || size < 0) throw new Error('Invalid package archive entry size.');
        remaining = size; padding = (512 - (size % 512)) % 512;
      }
    }
    if (!found || remaining || padding || buffer.length || Object.keys(pax).length) throw new Error('Release archive is incomplete or has no package manifest.');
  } finally { stream.destroy(); input.destroy(); }
}

export interface PreparedArchive { path: string; sha256: string; cleanup(): Promise<void> }

/** Install the selected bytes even when a user configures another scoped registry. */
export async function prepareNpmArchive(release: Release, options: CliUpdateOptions, runtime: UpdateRuntime): Promise<PreparedArchive> {
  if (release.provider.kind !== 'npm' || !release.integrity || !/^(?:sha512-[A-Za-z0-9+/]{86}==|sha256-[A-Za-z0-9+/]{43}=)$/.test(release.integrity)) throw new Error('Invalid npm archive integrity selection.');
  const url = new URL(release.archiveUrl), unscoped = options.packageName.split('/').at(-1)!;
  if (release.packageName !== options.packageName || !parseVersion(release.version) || url.origin !== 'https://registry.npmjs.org' ||
      url.username || url.password || url.search || url.hash ||
      decodeURIComponent(url.pathname) !== `/${options.packageName}/-/${unscoped}-${release.version}.tgz`) throw new Error('Invalid npm archive authority or identity.');
  const directory = await fs.mkdtemp(join(await fs.realpath(runtime.temporaryDirectory), 'hraness-cli-update-'));
  await fs.chmod(directory, 0o700);
  const path = join(directory, 'package.tgz'), cleanup = async () => { await fs.rm(directory, { recursive: true, force: true }); };
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined, reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let output: fs.FileHandle | undefined;
  const deadline = new Promise<never>((_, reject) => { timer = setTimeout(() => {
    controller.abort(); reject(new Error('The npm release archive download timed out.'));
  }, ARCHIVE_TIMEOUT); });
  try {
    const response = await Promise.race([runtime.fetch(url.href, { redirect: 'error', signal: controller.signal }), deadline]);
    if (!response.ok || !response.body || response.redirected || (response.url && response.url !== url.href)) throw new Error('The canonical npm release archive could not be downloaded.');
    const length = response.headers.get('content-length');
    if (length !== null && (!/^\d+$/.test(length) || Number(length) <= 0 || Number(length) > ARCHIVE_BYTES)) throw new Error('The npm release archive exceeds its size limit.');
    reader = response.body.getReader();
    output = await fs.open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    const algorithm = release.integrity.startsWith('sha512-') ? 'sha512' : 'sha256';
    const integrity = createHash(algorithm), sha256 = createHash('sha256'); let bytes = 0;
    while (true) {
      const chunk = await Promise.race([reader.read(), deadline]); if (chunk.done) break;
      bytes += chunk.value.length;
      if (bytes > ARCHIVE_BYTES) throw new Error('The npm release archive exceeds its size limit.');
      integrity.update(chunk.value); sha256.update(chunk.value);
      await output.writeFile(chunk.value);
      if (controller.signal.aborted) throw new Error('The npm release archive download timed out.');
    }
    if (!bytes || `${algorithm}-${integrity.digest('base64')}` !== release.integrity) throw new Error('The npm release archive does not match its selected integrity.');
    await output.sync(); await output.close(); output = undefined;
    if (timer) clearTimeout(timer); timer = undefined;
    const digest = sha256.digest('hex');
    await verifyPackageArchive(path, options.packageName, release.version);
    await options.verifyArtifact?.({ path, version: release.version, sha256: digest });
    return { path, sha256: digest, cleanup };
  } catch (error) { await output?.close(); output = undefined; await cleanup(); throw error; }
  finally {
    if (timer) clearTimeout(timer); controller.abort();
    if (reader) { void reader.cancel().catch(() => {}); reader.releaseLock(); }
  }
}

export async function prepareGitHubArchive(release: Release, options: CliUpdateOptions, runtime: UpdateRuntime): Promise<PreparedArchive> {
  if (release.provider.kind !== 'github' || !release.sha256 || !release.assetName || !release.tag || !release.assetId) throw new Error('Invalid GitHub release selection.');
  const gh = await discoverExecutable('gh', options, runtime);
  if (!gh) throw new Error('GitHub package updates require the GitHub CLI (gh).');
  const directory = await fs.mkdtemp(join(await fs.realpath(runtime.temporaryDirectory), 'hraness-cli-update-'));
  await fs.chmod(directory, 0o700);
  const path = join(directory, release.assetName);
  const cleanup = async () => { await fs.rm(directory, { recursive: true, force: true }); };
  try {
    const result = await runtime.download(gh, ['api', '--hostname', 'github.com', '-H', 'Accept: application/octet-stream', `repos/${release.provider.repository}/releases/assets/${release.assetId}`], path, {
      env: { ...runtime.env, GH_HOST: 'github.com' }, timeoutMs: ARCHIVE_TIMEOUT, maxOutputBytes: 131_072,
    }, ARCHIVE_BYTES);
    if (result.code !== 0) throw new Error('The verified release archive could not be downloaded.');
    const stat = await fs.lstat(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > ARCHIVE_BYTES || (runtime.uid !== undefined && stat.uid !== runtime.uid)) throw new Error('The release archive is not a safe regular file.');
    const handle = await fs.open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const hash = createHash('sha256');
    try { for await (const chunk of handle.createReadStream({ autoClose: false })) hash.update(chunk); }
    finally { await handle.close(); }
    if (hash.digest('hex') !== release.sha256) throw new Error('The release archive digest does not match GitHub release metadata.');
    await verifyPackageArchive(path, options.packageName, release.version);
    await options.verifyArtifact?.({ path, version: release.version, sha256: release.sha256 });
    return { path, sha256: release.sha256, cleanup };
  } catch (error) { await cleanup(); throw error; }
}

/** Keep manager-referenced file sources durable across later global installs. */
export async function retainVerifiedArchive(source: string, directory: string, sha256: string, runtime: UpdateRuntime): Promise<string> {
  const destination = join(directory, `${sha256}.tgz`);
  const verify = async (path: string) => {
    const handle = await fs.open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size > ARCHIVE_BYTES || (stat.mode & 0o022) !== 0 || (runtime.uid !== undefined && stat.uid !== runtime.uid)) throw new Error('Unsafe retained package archive.');
      const hash = createHash('sha256');
      for await (const chunk of handle.createReadStream({ autoClose: false })) hash.update(chunk);
      if (hash.digest('hex') !== sha256) throw new Error('Retained archive digest does not match its release.');
    } finally { await handle.close(); }
  };
  try { await verify(destination); return destination; }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  const temporary = join(directory, `.${runtime.randomId()}.tmp`);
  const input = await fs.open(source, constants.O_RDONLY | constants.O_NOFOLLOW);
  const output = await fs.open(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
  try {
    let bytes = 0;
    for await (const chunk of input.createReadStream({ autoClose: false })) {
      const buffer = chunk as Buffer; bytes += buffer.length;
      if (bytes > ARCHIVE_BYTES) throw new Error('Release archive exceeds its size limit.');
      await output.writeFile(buffer);
    }
    await output.sync(); await output.close();
    await verify(temporary);
    // Link is exclusive; a concurrent or foreign destination is never replaced.
    await fs.link(temporary, destination);
    await syncDirectory(directory);
    return destination;
  } finally { await input.close(); await output.close().catch(() => {}); await fs.unlink(temporary).catch(() => {}); }
}
