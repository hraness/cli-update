import { constants, unlinkSync } from 'node:fs';
import * as fs from 'node:fs/promises';
import { dirname, isAbsolute, join, parse, sep } from 'node:path';
import { identity } from './install.js';
import { parseVersion } from './semver.js';
import type { CliUpdateOptions, SavedState, UpdateRuntime } from './types.js';

const MAX_STATE = 16_384;
interface Owner { schema: 1; pid: number; token: string; created: number }
interface Claim extends Owner { choosing: boolean; ticket: number }
export interface ManagerMutation { schema: 1; installationId: string; packageName: string; ownerPid: number; childPid?: number; settled: boolean; selectedVersion?: string; dependencySpec?: string }
export interface OwnedLock { release(): Promise<void> }

function missing(error: unknown): boolean { return (error as NodeJS.ErrnoException).code === 'ENOENT'; }

export async function syncDirectory(path: string): Promise<void> {
  const handle = await fs.open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try { await handle.sync(); } finally { await handle.close(); }
}

/** Read-only eligibility check: an unsupported shared prefix is never modified. */
export async function canCoordinate(path: string, runtime: UpdateRuntime): Promise<boolean> {
  const root = parse(path).root; let current = root;
  for (const part of path.slice(root.length).split(sep).filter(Boolean)) {
    const parent = current; current = join(current, part);
    let stat;
    try { stat = await fs.lstat(current); }
    catch (error) {
      if (!missing(error)) return false;
      try { await fs.access(parent, constants.W_OK); return true; } catch { return false; }
    }
    if (!stat.isDirectory() || stat.isSymbolicLink()) return false;
    const owned = runtime.uid === undefined || stat.uid === runtime.uid;
    const stickyRoot = stat.uid === 0 && (stat.mode & 0o1000) !== 0;
    if ((!owned && stat.uid !== 0) || ((stat.mode & 0o022) !== 0 && !stickyRoot)) return false;
    if (current === path && !owned) return false;
  }
  try { await fs.access(path, constants.W_OK); return true; } catch { return false; }
}

export class SafeState {
  readonly root: string;
  readonly product: string;
  readonly coordinationRoot: string;
  private readonly directories = new Map<string, string>();
  constructor(readonly options: CliUpdateOptions, readonly runtime: UpdateRuntime, coordinationDirectory?: string) {
    this.root = options.stateDirectory ?? join(runtime.homeDirectory, '.local', 'state', 'hraness-cli-update');
    this.product = join(this.root, 'products', identity(options.packageName));
    this.coordinationRoot = coordinationDirectory ?? this.root;
    if (!isAbsolute(this.root)) throw new Error('Updater state directory must be absolute.');
  }

  async initialize(): Promise<void> {
    await this.directory(this.product);
    await this.directory(join(this.coordinationRoot, 'locks'));
    await this.directory(join(this.coordinationRoot, 'leases'));
  }

  /** Validate every path component; never follow a state symlink, including on writes. */
  async directory(path: string): Promise<void> {
    const filesystemRoot = parse(path).root;
    let current = filesystemRoot;
    for (const component of path.slice(filesystemRoot.length).split(sep).filter(Boolean)) {
      current = join(current, component);
      let stat;
      try { stat = await fs.lstat(current); }
      catch (error) {
        if (!missing(error)) throw error;
        try { await fs.mkdir(current, { mode: 0o700 }); await syncDirectory(dirname(current)); }
        catch (createError) { if ((createError as NodeJS.ErrnoException).code !== 'EEXIST') throw createError; }
        stat = await fs.lstat(current);
      }
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Updater state paths must be real directories.');
      const owned = this.runtime.uid === undefined || stat.uid === this.runtime.uid;
      const trustedStickyTemporary = stat.uid === 0 && (stat.mode & 0o1000) !== 0;
      if ((!owned && stat.uid !== 0) || ((stat.mode & 0o022) !== 0 && !trustedStickyTemporary)) {
        throw new Error('Updater state requires trusted directory ancestors.');
      }
      if ((current === this.root || current.startsWith(this.root + sep) || current === this.coordinationRoot || current.startsWith(this.coordinationRoot + sep)) &&
          ((this.runtime.uid !== undefined && stat.uid !== this.runtime.uid) || (stat.mode & 0o022) !== 0)) {
        throw new Error('Updater state directory must be owned by this user and not writable by others.');
      }
      const identity = `${stat.dev}:${stat.ino}`;
      const previous = this.directories.get(current);
      if (previous !== undefined && previous !== identity) throw new Error('An updater state directory changed identity.');
      this.directories.set(current, identity);
    }
  }

  async readJson(path: string): Promise<unknown | undefined> {
    await this.directory(dirname(path));
    let handle;
    try { handle = await fs.open(path, constants.O_RDONLY | constants.O_NOFOLLOW); }
    catch (error) { if (missing(error)) return undefined; throw error; }
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size > MAX_STATE || (stat.mode & 0o022) !== 0 ||
          (this.runtime.uid !== undefined && stat.uid !== this.runtime.uid)) throw new Error('Unsafe updater state file.');
      return JSON.parse(await handle.readFile('utf8')) as unknown;
    } finally { await handle.close(); }
  }

  async writeJson(path: string, value: unknown): Promise<void> {
    await this.directory(dirname(path));
    // A pre-existing symlink or foreign destination is not replaced even by atomic rename.
    await this.readJson(path);
    const contents = JSON.stringify(value) + '\n';
    if (Buffer.byteLength(contents) > MAX_STATE) throw new Error('Updater state is too large.');
    const temporary = `${path}.${this.runtime.pid}.${this.runtime.randomId()}.tmp`;
    const handle = await fs.open(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
    try {
      await handle.writeFile(contents); await handle.sync(); await handle.close();
      await this.readJson(path);
      await fs.rename(temporary, path);
      await syncDirectory(dirname(path));
    } finally { await handle.close().catch(() => {}); await fs.unlink(temporary).catch(() => {}); }
  }

  async read(): Promise<SavedState> {
    const value = await this.readJson(join(this.product, 'state.json'));
    if (value === undefined) return { schema: 1 };
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid updater policy state.');
    const state = value as SavedState;
    if (state.schema !== 1 || (state.policy !== undefined && !['auto', 'notify', 'disabled'].includes(state.policy)) ||
        (state.lastChecked !== undefined && (!Number.isSafeInteger(state.lastChecked) || state.lastChecked < 0)) ||
        (state.trackInstallation !== undefined && !/^[a-f0-9]{32}$/.test(state.trackInstallation))) throw new Error('Invalid updater policy state.');
    if (state.managedInstall && (typeof state.managedInstall.id !== 'string' || !/^[a-f0-9]{32}$/.test(state.managedInstall.id) ||
        typeof state.managedInstall.version !== 'string' ||
        (state.managedInstall.dependencySpec !== undefined && typeof state.managedInstall.dependencySpec !== 'string'))) throw new Error('Invalid managed-install receipt.');
    return state;
  }

  async save(state: SavedState): Promise<void> { await this.writeJson(join(this.product, 'state.json'), state); }

  async patch(patch: Partial<SavedState>): Promise<SavedState> {
    const lock = await this.lock(`policy-${identity(this.options.packageName)}`, 'policy');
    if (!lock) throw new Error('Another updater is changing policy state.');
    try { const state = { ...await this.read(), ...patch, schema: 1 as const }; await this.save(state); return state; }
    finally { await lock.release(); }
  }

  async mutation(installationId: string, pending?: boolean): Promise<boolean> {
    const path = join(this.coordinationRoot, 'mutations', `${installationId}.json`);
    const record = await this.readJson(path);
    if (pending === undefined) return record !== undefined;
    if (pending) await this.writeJson(path, { schema: 1, pending: true });
    else if (record !== undefined) { await fs.unlink(path); await syncDirectory(dirname(path)); }
    return pending;
  }

  async managerMutation(managerId: string, record?: ManagerMutation | null): Promise<ManagerMutation | undefined> {
    const path = join(this.coordinationRoot, 'manager-mutations', `${managerId}.json`);
    const existing = await this.readJson(path);
    if (record === null) { if (existing !== undefined) { await fs.unlink(path); await syncDirectory(dirname(path)); } return undefined; }
    if (record !== undefined) { await this.writeJson(path, record); return record; }
    if (existing === undefined) return undefined;
    const value = existing as ManagerMutation;
    if (!value || value.schema !== 1 || !/^[a-f0-9]{32}$/.test(value.installationId) || typeof value.packageName !== 'string' ||
        !Number.isSafeInteger(value.ownerPid) || value.ownerPid <= 0 || typeof value.settled !== 'boolean' ||
        (value.childPid !== undefined && (!Number.isSafeInteger(value.childPid) || value.childPid <= 0)) ||
        (value.selectedVersion !== undefined && !parseVersion(value.selectedVersion)) ||
        (value.dependencySpec !== undefined && (typeof value.dependencySpec !== 'string' || value.dependencySpec.length > 4096))) throw new Error('Invalid global manager mutation record.');
    return value;
  }

  async managedInstall(installationId: string, receipt?: NonNullable<SavedState['managedInstall']>): Promise<SavedState['managedInstall']> {
    const path = join(this.coordinationRoot, 'installations', `${installationId}.json`);
    if (receipt) { await this.writeJson(path, receipt); return receipt; }
    const value = await this.readJson(path);
    if (value === undefined) return undefined;
    const record = value as NonNullable<SavedState['managedInstall']>;
    if (!record || record.id !== installationId || !parseVersion(record.version) ||
        (record.dependencySpec !== undefined && (typeof record.dependencySpec !== 'string' || record.dependencySpec.length > 4096))) throw new Error('Invalid installed update receipt.');
    return record;
  }

  async owner(path: string): Promise<Owner | undefined> {
    const value = await this.readJson(path);
    if (value === undefined) return undefined;
    const owner = value as Owner;
    if (!owner || owner.schema !== 1 || !Number.isSafeInteger(owner.pid) || owner.pid <= 0 ||
        typeof owner.token !== 'string' || !/^[A-Za-z0-9-]{8,128}$/.test(owner.token) ||
        !Number.isSafeInteger(owner.created) || owner.created < 0) throw new Error('Invalid updater lock owner.');
    return owner;
  }

  async lock(name: string, scope: 'coordination' | 'policy' = 'coordination'): Promise<OwnedLock | undefined> {
    if (!/^[a-z-]+-[a-f0-9]{32}$/.test(name)) throw new Error('Invalid updater lock name.');
    const directory = join(scope === 'policy' ? this.root : this.coordinationRoot, 'locks', name);
    await this.directory(directory);
    const token = this.runtime.randomId();
    const fileName = `${this.runtime.pid}.${token}.json`, path = join(directory, fileName);
    const own: Claim = { schema: 1, pid: this.runtime.pid, token, created: this.runtime.now(), choosing: true, ticket: 0 };
    // A process never reuses another process's claim path. A partially written
    // live claim means choosing; a dead claim can be unlinked without an ABA race.
    const handle = await fs.open(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
    try { await handle.writeFile(JSON.stringify(own)); } finally { await handle.close(); }
    const claims = async (): Promise<Array<{ name: string; claim?: Claim }>> => {
      await this.directory(directory);
      const entries = await fs.readdir(directory);
      if (entries.length > 4096) throw new Error('Updater lock state exceeds its limit.');
      const result: Array<{ name: string; claim?: Claim }> = [];
      for (const name of entries) {
        if (name.endsWith('.tmp')) continue;
        const match = /^(\d+)\.([A-Za-z0-9-]{8,128})\.json$/.exec(name);
        if (!match) throw new Error('Unexpected updater lock claim.');
        const pid = Number(match[1]), claimPath = join(directory, name);
        if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error('Invalid lock claim PID.');
        if (!this.runtime.isProcessAlive(pid)) {
          // Validate owner/mode before reclaiming even an incomplete dead claim.
          const stat = await fs.lstat(claimPath).catch(error => { if (missing(error)) return undefined; throw error; });
          if (!stat) continue;
          if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o022) !== 0 || (this.runtime.uid !== undefined && stat.uid !== this.runtime.uid)) throw new Error('Unsafe dead updater claim.');
          await fs.unlink(claimPath).catch(error => { if (!missing(error)) throw error; });
          continue;
        }
        let value: unknown;
        try { value = await this.readJson(claimPath); }
        catch (error) { if (error instanceof SyntaxError) { result.push({ name }); continue; } throw error; }
        if (value === undefined) continue;
        const claim = value as Claim;
        if (!claim || claim.schema !== 1 || claim.pid !== pid || claim.token !== match[2] ||
            typeof claim.choosing !== 'boolean' || !Number.isSafeInteger(claim.ticket) || claim.ticket < 0) throw new Error('Invalid updater lock claim.');
        result.push({ name, claim });
      }
      return result;
    };
    let acquired = false, released = false;
    const release = async () => {
      if (released) return;
      released = true;
      await this.directory(directory);
      await fs.unlink(path).catch(error => { if (!missing(error)) throw error; });
    };
    try {
      const existing = await claims();
      const maximum = Math.max(0, ...existing.map(record => record.claim?.ticket ?? 0));
      if (maximum >= Number.MAX_SAFE_INTEGER) throw new Error('Updater lock ticket exceeds its limit.');
      own.ticket = maximum + 1; own.choosing = false;
      await this.writeJson(path, own);
      for (const other of await claims()) {
        if (other.name === fileName) continue;
        // Non-waiting bakery protocol: a choosing process or a lower ticket
        // yields busy. Simultaneous contenders may both retry, never both enter.
        if (!other.claim || other.claim.choosing || other.claim.ticket < own.ticket ||
            (other.claim.ticket === own.ticket && other.name < fileName)) return undefined;
      }
      acquired = true;
      return { release };
    } finally { if (!acquired) await release(); }
  }

  async active(installationId: string): Promise<boolean> {
    const path = join(this.coordinationRoot, 'leases', installationId);
    await this.directory(path);
    for (const entry of await fs.readdir(path)) {
      if (!/^[\d]+\.[A-Za-z0-9-]{8,128}\.json$/.test(entry)) throw new Error('Unexpected updater lease state.');
      const file = join(path, entry), owner = await this.owner(file);
      if (!owner) continue;
      if (this.runtime.isProcessAlive(owner.pid)) return true;
      await fs.unlink(file);
    }
    return false;
  }

  /** Called under the install lock, so admission cannot race an update. */
  async lease(installationId: string): Promise<OwnedLock> {
    const token = this.runtime.randomId();
    const path = join(this.coordinationRoot, 'leases', installationId, `${this.runtime.pid}.${token}.json`);
    await this.writeJson(path, { schema: 1, pid: this.runtime.pid, token, created: this.runtime.now() });
    let released = false;
    const removeExit = this.runtime.onExit(() => { if (!released) { try { unlinkSync(path); } catch { /* stale lease can be reclaimed */ } } });
    return { release: async () => {
      if (released) return;
      released = true; removeExit();
      const owner = await this.owner(path);
      if (owner?.token === token) await fs.unlink(path);
    } };
  }
}
