import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import * as fs from 'node:fs/promises';
import { basename, delimiter, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { parseVersion } from './semver.js';
import type { CliUpdateOptions, Installation, UpdateRuntime } from './types.js';

export interface PackageManifest {
  name: string;
  version: string;
  bin?: string | Record<string, string>;
  dependencies?: Record<string, string>;
  _requested?: { rawSpec?: string };
}

export interface Detection {
  installation?: Installation; reason?: string; guidance?: string; unsafe?: boolean; usable?: boolean;
  /** Identity-proven global owner, but the local archive source is not yet trusted. */
  archiveEnrollment?: { installation: Installation; path: string };
}
export interface GlobalCandidate { id: string; manager: 'bun' | 'npm'; managerPath: string; globalRoot: string; packageRoot: string; coordinationDirectory: string }

export function identity(value: string): string { return createHash('sha256').update(value).digest('hex').slice(0, 32); }

export async function readManifest(path: string): Promise<PackageManifest> {
  const stat = await fs.lstat(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 262_144) throw new Error('Invalid installed package manifest.');
  const handle = await fs.open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const actual = await handle.stat();
    if (!actual.isFile() || actual.size > 262_144) throw new Error('Invalid installed package manifest.');
    const value: unknown = JSON.parse(await handle.readFile('utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid installed package manifest.');
    return value as PackageManifest;
  } finally { await handle.close(); }
}

function binEntry(manifest: PackageManifest, binName: string): string | undefined {
  if (typeof manifest.bin === 'string') return binName === manifest.name.split('/').at(-1) ? manifest.bin : undefined;
  return manifest.bin && typeof manifest.bin[binName] === 'string' ? manifest.bin[binName] : undefined;
}

export async function discoverExecutable(name: 'bun' | 'npm' | 'gh', options: CliUpdateOptions, runtime: UpdateRuntime): Promise<string | undefined> {
  const configured = options.managers?.[name];
  if (configured && !isAbsolute(configured)) throw new Error('Configured manager paths must be absolute.');
  const candidates = configured ? [configured] : [
    ...(basename(runtime.execPath) === name ? [runtime.execPath] : []),
    ...(runtime.env.PATH ?? '').split(delimiter).filter(isAbsolute).map(part => join(part, name)),
    ...(name === 'bun' ? [join(runtime.homeDirectory, '.bun/bin/bun')] : []),
    `/opt/homebrew/bin/${name}`, `/usr/local/bin/${name}`, `/usr/bin/${name}`,
  ];
  for (const candidate of new Set(candidates)) {
    try { await fs.access(candidate, constants.X_OK); if ((await fs.stat(candidate)).isFile()) return candidate; } catch { /* try next */ }
  }
  return undefined;
}

async function managerQuery(executable: string, args: string[], runtime: UpdateRuntime): Promise<string> {
  const result = await runtime.run(executable, args, {
    env: runtime.env, timeoutMs: 5_000, maxOutputBytes: 131_072,
  });
  if (result.code !== 0) throw new Error('Could not verify the global package manager.');
  return result.stdout.trim();
}

function canonicalGitHubSpec(spec: string, options: CliUpdateOptions, version: string): boolean {
  const provider = options.provider;
  if (provider?.kind !== 'github') return false;
  const tag = `${provider.tagPrefix ?? 'v'}${version}`;
  const asset = provider.assetName.replaceAll('{version}', version);
  return spec === `https://github.com/${provider.repository}/releases/download/${tag}/${asset}`;
}

/** Establish the stable owning root before inspecting files a manager can replace. */
export async function locateGlobalCandidate(options: CliUpdateOptions, runtime: UpdateRuntime): Promise<GlobalCandidate | undefined> {
  if (process.platform === 'win32') return undefined;
  const lexical = resolve(options.entrypoint);
  const actual = await fs.realpath(lexical).catch(() => lexical);
  // Ordinary source executables have no global package relationship to discover.
  if (!lexical.includes(`${sep}node_modules${sep}`) && !actual.includes(`${sep}node_modules${sep}`) &&
      !lexical.endsWith(`${sep}bin${sep}${options.binName}`)) return undefined;
  for (const manager of ['bun', 'npm'] as const) {
    const executable = await discoverExecutable(manager, options, runtime);
    if (!executable) continue;
    try {
      let globalRoot: string, modules: string, binDirectory: string;
      if (manager === 'bun') {
        const firstLine = (await managerQuery(executable, ['pm', '-g', 'ls'], runtime)).split('\n')[0] ?? '';
        const match = /^(.*) node_modules \(\d+\)$/.exec(firstLine);
        if (!match || !isAbsolute(match[1]!)) continue;
        globalRoot = await fs.realpath(match[1]!); modules = join(globalRoot, 'node_modules');
        // The package path itself is sufficient for stable admission; do not
        // require a live bin target during the manager's replacement window.
        binDirectory = '';
        if (!lexical.includes(`${sep}node_modules${sep}`) && !actual.includes(`${sep}node_modules${sep}`)) binDirectory = await managerQuery(executable, ['pm', 'bin', '-g'], runtime);
      } else {
        const rawRoot = await managerQuery(executable, ['root', '--global'], runtime);
        if (!isAbsolute(rawRoot) || rawRoot.includes('\n')) continue;
        modules = await fs.realpath(rawRoot);
        const prefix = await managerQuery(executable, ['prefix', '--global'], runtime);
        if (!isAbsolute(prefix) || prefix.includes('\n')) continue;
        globalRoot = await fs.realpath(prefix); binDirectory = join(globalRoot, 'bin');
      }
      const packageRoot = join(modules, options.packageName);
      if (lexical.startsWith(packageRoot + sep) || actual.startsWith(packageRoot + sep) || (binDirectory && lexical === join(binDirectory, options.binName))) {
        return { id: identity([manager, globalRoot, packageRoot].join('\0')), manager, managerPath: executable, globalRoot, packageRoot,
          coordinationDirectory: join(dirname(modules), '.hraness-cli-update') };
      }
    } catch { /* Unknown manager is not write authority. */ }
  }
  return undefined;
}

export async function detectInstallation(options: CliUpdateOptions, runtime: UpdateRuntime, managed?: { id?: string; version: string; dependencySpec?: string }): Promise<Detection> {
  const guidance = `Reinstall ${options.packageName} with its documented installer or the package manager that owns this installation.`;
  const unsupported = (reason: string): Detection => ({ reason, guidance });
  if (process.platform === 'win32') return unsupported('Automatic updates do not yet support Windows package-manager shims.');
  let entrypoint: string;
  try { entrypoint = await fs.realpath(options.entrypoint); }
  catch { return unsupported('The running executable could not be resolved.'); }
  let packageRoot = dirname(entrypoint), manifest: PackageManifest | undefined;
  for (let i = 0; i < 16; i++) {
    try { const candidate = await readManifest(join(packageRoot, 'package.json')); if (candidate.name === options.packageName) { manifest = candidate; break; } }
    catch { /* walk toward package root */ }
    const parent = dirname(packageRoot);
    if (parent === packageRoot) break;
    packageRoot = parent;
  }
  if (!manifest || manifest.version !== options.version || !parseVersion(manifest.version)) return { ...unsupported('The running package identity or version does not match its installed manifest.'), unsafe: !!manifest && packageRoot.includes(`${sep}node_modules${sep}`) };
  const bin = binEntry(manifest, options.binName);
  if (!bin || isAbsolute(bin) || relative(packageRoot, resolve(packageRoot, bin)).split(sep).includes('..')) return unsupported('The running module is not a declared package executable.');
  try { if (await fs.realpath(resolve(packageRoot, bin)) !== entrypoint) return unsupported('The running module is not the declared package executable.'); }
  catch { return unsupported('The package executable could not be verified.'); }
  if (!packageRoot.includes(`${sep}node_modules${sep}`)) return unsupported('Source checkouts and linked development installations are not self-updated.');
  try { await fs.lstat(join(packageRoot, '.git')); return unsupported('Source checkouts are not self-updated.'); } catch { /* expected */ }

  for (const manager of ['bun', 'npm'] as const) {
    const executable = await discoverExecutable(manager, options, runtime);
    if (!executable) continue;
    try {
      let globalRoot: string, modules: string, binDirectory: string, spec: string | undefined;
      if (manager === 'bun') {
        const firstLine = (await managerQuery(executable, ['pm', '-g', 'ls'], runtime)).split('\n')[0] ?? '';
        const match = /^(.*) node_modules \(\d+\)$/.exec(firstLine);
        if (!match || !isAbsolute(match[1]!)) continue;
        globalRoot = await fs.realpath(match[1]!);
        modules = join(globalRoot, 'node_modules');
        const expected = join(modules, options.packageName);
        if (await fs.realpath(expected) !== expected || expected !== packageRoot) continue;
        const globalManifest = await readManifest(join(globalRoot, 'package.json'));
        spec = globalManifest.dependencies?.[options.packageName];
        if (typeof spec !== 'string') continue;
        binDirectory = await managerQuery(executable, ['pm', 'bin', '-g'], runtime);
      } else {
        const rawRoot = await managerQuery(executable, ['root', '--global'], runtime);
        if (!isAbsolute(rawRoot) || rawRoot.includes('\n')) continue;
        modules = await fs.realpath(rawRoot);
        const expected = join(modules, options.packageName);
        if (await fs.realpath(expected) !== expected || expected !== packageRoot) continue;
        globalRoot = await managerQuery(executable, ['prefix', '--global'], runtime);
        if (!isAbsolute(globalRoot) || globalRoot.includes('\n')) continue;
        globalRoot = await fs.realpath(globalRoot);
        binDirectory = join(globalRoot, 'bin');
        spec = manifest._requested?.rawSpec;
      }
      if (!isAbsolute(binDirectory) || binDirectory.includes('\n')) continue;
      const binPath = join(binDirectory, options.binName);
      if (await fs.realpath(binPath) !== entrypoint) continue;
      const rootStat = await fs.lstat(packageRoot);
      if (!rootStat.isDirectory() || rootStat.isSymbolicLink() || (runtime.uid !== undefined && rootStat.uid !== runtime.uid)) return unsupported('This installation is owned by another user; update it with its owner’s package manager.');
      await fs.access(packageRoot, constants.W_OK);
      // Every executable alias in one owning package shares code and admission.
      const installId = identity([manager, globalRoot, packageRoot].join('\0'));
      const installation: Installation = {
        id: installId, manager, managerPath: executable, globalRoot, packageRoot, entrypoint, binPath,
        version: manifest.version, dependencySpec: spec,
        pinned: options.pinned === true || (spec !== undefined && parseVersion(spec) !== undefined),
      };
      const managedSpec = managed?.version === manifest.version && (!managed.id || managed.id === installId) && managed.dependencySpec === spec;
      if (spec && !managedSpec && !parseVersion(spec) && !/^(?:latest|next|beta|alpha|canary|[~^]\d[^\s]*|\*)$/.test(spec) && !canonicalGitHubSpec(spec, options, manifest.version)) {
        const path = spec.startsWith('file:') ? spec.slice(5) : spec;
        const localArchive = isAbsolute(path) && resolve(path) === path && path.endsWith('.tgz');
        return { ...unsupported('This installation uses a file, Git, noncanonical archive, or unsupported version binding.'), usable: true,
          ...(localArchive ? { archiveEnrollment: { installation, path } } : {}) };
      }
      return { installation };
    } catch { /* A manager that cannot prove ownership is never used to write. */ }
  }
  return unsupported('This is not a verified Bun or npm global installation (project dependencies, runner caches, and foreign or linked installs are excluded).');
}

export async function verifyInstalled(options: CliUpdateOptions, installation: Installation, version: string, runtime: UpdateRuntime, allowedSpec?: string): Promise<Installation> {
  const detected = await detectInstallation({ ...options, version }, runtime, allowedSpec ? { id: installation.id, version, dependencySpec: allowedSpec } : undefined);
  if (!detected.installation || detected.installation.id !== installation.id || detected.installation.managerPath !== installation.managerPath) {
    throw new Error('Post-install package identity or executable ownership verification failed.');
  }
  return detected.installation;
}
