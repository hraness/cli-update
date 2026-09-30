import { isAbsolute, join } from 'node:path';
import { detectInstallation, identity, locateGlobalCandidate, verifyInstalled } from './install.js';
import { currentGitHubRelease, latestRelease, prepareGitHubArchive, prepareNpmArchive, retainVerifiedArchive, validateOptions, verifyExistingGitHubArchive } from './provider.js';
import { ProcessLaunchError, runtimeFor } from './runtime.js';
import { compareVersions } from './semver.js';
import { canCoordinate, SafeState } from './state.js';
import type { ManagerMutation, OwnedLock } from './state.js';
import type { CliUpdateOptions, Installation, Release, SavedState, StartupResult, UpdateResult, UpdateRuntime } from './types.js';

export type { CliUpdateOptions, GitHubProvider, NpmProvider, ReleaseProvider, UpdatePolicy, UpdateResult, StartupResult, UpdateRuntime, ProcessOptions, ProcessResult } from './types.js';
export { compareVersions, parseVersion } from './semver.js';

const DAY = 86_400_000;
const noRelease = async () => {};
const completed = (result: UpdateResult, exitCode = 0): StartupResult => ({ handled: true, exitCode, result, release: noRelease });

function automaticSuppressed(options: CliUpdateOptions, argv: readonly string[], runtime: UpdateRuntime): boolean {
  const ci = runtime.env.CI;
  const separator = argv.indexOf('--'), productArgs = separator === -1 ? argv : argv.slice(0, separator);
  return options.offline === true || options.nested === true || options.pinned === true || options.suppressAutomatic === true ||
    runtime.env.HRANESS_NO_UPDATE === '1' || runtime.env.HRANESS_UPDATE_REENTRY === '1' ||
    (ci !== undefined && ci !== '' && ci !== '0' && ci.toLowerCase() !== 'false') ||
    productArgs.some(arg => ['--help', '-h', '--version', '-v', '-V', '--offline', '--completion', '--completions'].includes(arg)) ||
    ['help', 'version', 'completion', 'completions'].includes(argv[0] ?? '');
}

function report(result: UpdateResult, json: boolean, runtime: UpdateRuntime): void {
  if (json) { runtime.writeStdout(JSON.stringify(result) + '\n'); return; }
  const version = result.latestVersion ? ` ${result.currentVersion} → ${result.latestVersion}` : ` ${result.currentVersion}`;
  runtime.writeStdout(`${result.package}${version}: ${result.status}; automatic updates ${result.policy}.\n`);
  if (result.reason) runtime.writeStderr(`${result.reason}\n`);
  if (result.guidance) runtime.writeStderr(`${result.guidance}\n`);
}

function pinned(installation: Installation, state: SavedState, options: CliUpdateOptions): boolean {
  if (options.pinned) return true;
  if (state.trackInstallation === installation.id) return false;
  if (state.managedInstall?.id === installation.id && state.managedInstall.version === installation.version && state.managedInstall.dependencySpec === installation.dependencySpec) return false;
  return installation.pinned;
}

async function installRelease(release: Release, installation: Installation, options: CliUpdateOptions, runtime: UpdateRuntime, store: SafeState): Promise<Installation> {
  let archive: Awaited<ReturnType<typeof prepareGitHubArchive>> | undefined;
  const managerId = identity(`${installation.manager}\0${installation.globalRoot}`);
  try {
    archive = release.provider.kind === 'github' ? await prepareGitHubArchive(release, options, runtime)
      : await prepareNpmArchive(release, options, runtime);
    const archiveDirectory = join(store.coordinationRoot, 'artifacts', identity(options.packageName));
    await store.directory(archiveDirectory);
    const retainedArchive = await retainVerifiedArchive(archive.path, archiveDirectory, archive.sha256, runtime);
    // Naming the package is essential for Bun to replace a prior archive spec
    // instead of treating two local archive paths as a dependency loop.
    const target = `${options.packageName}@file:${retainedArchive}`;
    const args = installation.manager === 'bun'
      ? ['add', '--global', '--no-progress', ...(options.ignoreScripts ? ['--ignore-scripts'] : []), '--', target]
      : ['install', '--global', '--no-audit', '--no-fund', ...(options.ignoreScripts ? ['--ignore-scripts'] : []), '--', target];
    // Do not pass --trust, alter trustedDependencies, or override ignore-scripts.
    // The manager retains its existing trust/lifecycle policy.
    const previousMutation = await store.managerMutation(managerId);
    const custody: ManagerMutation = { schema: 1, installationId: installation.id, packageName: options.packageName, ownerPid: runtime.pid, settled: false,
      selectedVersion: release.version, ...(retainedArchive ? { dependencySpec: retainedArchive } : {}) };
    await store.managerMutation(managerId, custody);
    await store.mutation(installation.id, true);
    let result;
    try {
      result = await runtime.run(installation.managerPath, args, {
        env: { ...runtime.env, HRANESS_NO_UPDATE: '1', HRANESS_UPDATE_REENTRY: '1' },
        timeoutMs: 180_000, maxOutputBytes: 524_288, diagnostics: true,
        onSpawn: async pid => { custody.childPid = pid; await store.managerMutation(managerId, custody); },
      });
    } catch (error) {
      if (error instanceof ProcessLaunchError) {
        await verifyInstalled(options, installation, options.version, runtime, installation.dependencySpec);
        if (previousMutation) await store.managerMutation(managerId, previousMutation);
        else { await store.mutation(installation.id, false); await store.managerMutation(managerId, null); }
      }
      throw error;
    }
    if (custody.childPid !== undefined && (runtime.isProcessAlive(custody.childPid) || runtime.isProcessAlive(-custody.childPid))) {
      throw new Error('The package-manager process group is still active after its leader exited; this installation remains quarantined until it finishes.');
    }
    custody.settled = true; await store.managerMutation(managerId, custody);
    if (result.code !== 0) throw new Error('The package manager did not finish successfully. Re-run the documented installer before using this installation.');
    // Bun records a downloaded archive as a file spec. Accept only this exact
    // verified staged artifact during the post-install proof, then bind a receipt.
    let installed: Installation;
    try { installed = await verifyInstalled(options, installation, release.version, runtime, retainedArchive); }
    catch (error) {
      if (!archive) throw error;
      installed = await verifyInstalled(options, installation, release.version, runtime, `file:${retainedArchive}`);
    }
    const receipt = { id: installed.id, version: installed.version, dependencySpec: installed.dependencySpec };
    await store.managedInstall(installed.id, receipt);
    await store.patch({ managedInstall: receipt });
    await store.mutation(installation.id, false);
    await store.managerMutation(managerId, null);
    return installed;
  } finally { await archive?.cleanup(); }
}

/**
 * Invoke at the executable boundary, before importing or running product work.
 * Importing this module has no effects. A false `handled` result carries a lease
 * held until process exit; release it explicitly when an embedded CLI finishes.
 * Initial supported runtimes: Node 22+ and Bun 1.3.14+ on Unix. Coordination is
 * stored beside the verified global node_modules root, independent of HOME and
 * preference-state overrides, and requires that location to be user-owned.
 * npm does not reliably retain the original global version request. Absent
 * product pins or retained _requested evidence, it follows the automatic default;
 * use update disable or HRANESS_NO_UPDATE=1 to retain an npm-installed version.
 */
export async function runCliUpdate(options: CliUpdateOptions): Promise<StartupResult> {
  const runtime = runtimeFor(options), argv = options.argv ?? process.argv.slice(2);
  const explicit = argv[0] === 'update', json = explicit && argv.includes('--json');
  const effectFree = options.effectFree ?? ((argv.length === 1 &&
    ['--help', '-h', '--version', '-v', '-V', '--completion', '--completions', 'version', 'completion', 'completions'].includes(argv[0] ?? '')) || argv[0] === 'help');
  if (!explicit && effectFree) {
    return { handled: false, exitCode: 0, release: noRelease };
  }
  const argumentsWithoutJson = argv.slice(1).filter(argument => argument !== '--json');
  let operation = argumentsWithoutJson[0] ?? 'install';
  if (operation === '--check') operation = 'check';
  if (operation === '--help' || operation === '-h') {
    if (explicit) {
      runtime.writeStdout('update [check|--check|status|enable|disable] [--json]\nAutomatic updates are enabled for verified global installs. Use update disable to opt out.\n');
      return { handled: true, exitCode: 0, release: noRelease };
    }
  }
  let state: SavedState = { schema: 1 }, installation: Installation | undefined;
  const base = (): UpdateResult => ({ schema: 'hraness.cli-update.v1', package: options.packageName, currentVersion: options.version,
    status: 'skipped', policy: state.policy ?? 'auto', supported: !!installation, ...(installation ? { manager: installation.manager } : {}) });
  const finish = (result: UpdateResult, exitCode = 0): StartupResult => { if (explicit) report(result, json, runtime); return completed(result, exitCode); };
  let installLock: OwnedLock | undefined, managerLock: OwnedLock | undefined, lease: OwnedLock | undefined;
  let store: SafeState | undefined, mayHaveChanged = false, managerIdentity: string | undefined;
  const admit = async (installationId: string): Promise<OwnedLock> => {
    if (!store || !managerIdentity) throw new Error('Missing installation admission identity.');
    managerLock ??= await store.lock(`manager-${managerIdentity}`);
    if (!managerLock) throw new Error('Another CLI update is using this global manager. Retry when it finishes.');
    if (await store.managerMutation(managerIdentity)) throw new Error('A global package-manager update has not finished verification. Repair the owning CLI before running product commands.');
    const own = await store.lease(installationId);
    try {
      const shared = await store.lease(`manager-${managerIdentity}`);
      return { release: async () => { await own.release(); await shared.release(); } };
    } catch (error) { await own.release(); throw error; }
  };
  try {
    validateOptions(options);
    if (!isAbsolute(options.entrypoint)) throw new Error('The actual executable entrypoint must be an absolute path.');
    if (explicit && (argumentsWithoutJson.length > 1 || !['install', 'check', 'status', 'enable', 'disable'].includes(operation))) {
      return finish({ ...base(), status: 'error', reason: 'Usage: update [check|--check|status|enable|disable] [--json]' }, 2);
    }
    const candidate = await locateGlobalCandidate(options, runtime);
    if (!candidate) {
      const result = { ...base(), status: 'unsupported' as const, reason: 'This is not a verified Bun or npm global installation (source, project, runner, linked, and foreign installs are excluded).',
        guidance: `Use the documented installer or the package manager that owns ${options.packageName}.` };
      if (explicit) return finish(result, operation === 'status' ? 0 : 1);
      return { handled: false, exitCode: 0, result, release: noRelease };
    }
    if (!await canCoordinate(candidate.coordinationDirectory, runtime)) {
      const result = { ...base(), status: 'unsupported' as const, reason: 'This shared or protected global prefix cannot safely hold user-owned update coordination.',
        guidance: 'Update this installation with its owning package manager, or use a private user-owned global prefix.' };
      if (explicit) return finish(result, operation === 'status' ? 0 : 1);
      return { handled: false, exitCode: 0, result, release: noRelease };
    }
    managerIdentity = identity(`${candidate.manager}\0${candidate.globalRoot}`);
    store = new SafeState(options, runtime, candidate.coordinationDirectory); await store.initialize(); state = await store.read();
    installLock = await store.lock(`install-${candidate.id}`);
    if (!installLock) return finish({ ...base(), status: 'busy', reason: 'This installation is being updated. Retry when the update finishes.' }, 75);
    state.managedInstall = await store.managedInstall(candidate.id) ?? state.managedInstall;
    const pending = await store.managerMutation(managerIdentity);
    let allowedReceipt = state.managedInstall;
    if (pending?.installationId === candidate.id && pending.selectedVersion === options.version && pending.dependencySpec?.startsWith(join(store.coordinationRoot, 'artifacts', identity(options.packageName)) + '/')) {
      allowedReceipt = { id: candidate.id, version: pending.selectedVersion, dependencySpec: pending.dependencySpec };
    }
    let detection = await detectInstallation(options, runtime, allowedReceipt);
    if (!detection.installation && allowedReceipt?.dependencySpec && pending?.installationId === candidate.id) {
      detection = await detectInstallation(options, runtime, { ...allowedReceipt, dependencySpec: `file:${allowedReceipt.dependencySpec}` });
    }
    if (!detection.installation && detection.archiveEnrollment && explicit && operation === 'enable' &&
        options.provider?.kind === 'github' && options.provider.authenticated) {
      if (options.pinned) return finish({ ...base(), status: 'pinned', reason: 'This product invocation is explicitly version-bound. Change that binding before enabling tracking.' }, 1);
      if (options.offline) return finish({ ...base(), status: 'error', reason: 'Archive enrollment requires an online check of the installed release.' }, 1);
      const enrollment = detection.archiveEnrollment;
      if (enrollment.installation.id !== candidate.id) throw new Error('The global installation changed during enrollment.');
      managerLock = await store.lock(`manager-${managerIdentity}`);
      if (!managerLock) return finish({ ...base(), status: 'busy', reason: 'Another update is using this global package manager.' }, 75);
      if (await store.managerMutation(managerIdentity) || await store.mutation(candidate.id)) throw new Error('An interrupted package-manager update must be repaired before enrollment.');
      const release = await currentGitHubRelease(options, runtime);
      await verifyExistingGitHubArchive(enrollment.path, release, options, runtime);
      const receipt = { id: candidate.id, version: options.version, dependencySpec: enrollment.installation.dependencySpec };
      const verified = await verifyInstalled(options, enrollment.installation, options.version, runtime, receipt.dependencySpec);
      await store.managedInstall(candidate.id, receipt);
      state.managedInstall = receipt;
      detection = { installation: verified };
    }
    installation = detection.installation;
    if (!installation) {
      const result = { ...base(), status: detection.usable ? 'unsupported' as const : 'error' as const, reason: detection.reason, guidance: detection.guidance };
      if (detection.usable && !explicit) {
        lease = await admit(candidate.id);
        return { handled: false, exitCode: 0, result, release: lease.release };
      }
      // A known global owner with temporarily absent or changed files is not a
      // source checkout; it must not fall through to lease-free product work.
      return finish(result, detection.usable && operation === 'status' ? 0 : 1);
    }
    if (installation.id !== candidate.id) throw new Error('The global installation changed during admission.');
    if (explicit && (operation === 'enable' || operation === 'disable')) {
      if (operation === 'enable' && options.pinned) return finish({ ...base(), status: 'pinned', reason: 'This product invocation is explicitly version-bound. Change that binding before enabling tracking.' }, 1);
      state = await store.patch({ policy: operation === 'enable' ? 'auto' : 'disabled', ...(operation === 'enable' ? { trackInstallation: installation.id } : {}) });
      return finish({ ...base(), status: operation === 'enable' ? 'enabled' : 'disabled' });
    }
    const isPinned = pinned(installation, state, options);
    if (explicit && operation === 'status') return finish({ ...base(), status: isPinned ? 'pinned' : 'status', ...(isPinned ? { reason: 'This installation has an explicit version binding.', guidance: options.pinned ? 'Change the product version binding to allow updates.' : 'Run update enable to explicitly track this global installation.' } : {}) });

    // Admissions and code replacements share this lock. A command cannot begin
    // while another updater may be replacing its files.
    let uncertain = await store.mutation(installation.id);
    const managerMutation = await store.managerMutation(managerIdentity);
    if (managerMutation) {
      uncertain = true;
      const childActive = managerMutation.childPid !== undefined && (runtime.isProcessAlive(managerMutation.childPid) || runtime.isProcessAlive(-managerMutation.childPid));
      const custodyUnknown = !managerMutation.settled && managerMutation.childPid === undefined;
      const canRepair = explicit && operation === 'install' && managerMutation.installationId === installation.id && !childActive && !custodyUnknown;
      if (!canRepair) return finish({ ...base(), status: childActive ? 'busy' : 'error', codeMayHaveChanged: true,
        reason: `An update of ${managerMutation.packageName} has not finished verification. ${childActive ? 'Its package-manager process is still active.' : custodyUnknown ? 'Process custody is unknown; use the documented installer after checking the interrupted update.' : 'Run that CLI’s update command to repair it.'}` }, childActive ? 75 : 1);
    }
    if (uncertain && (!explicit || operation !== 'install')) return finish({ ...base(), status: 'error', codeMayHaveChanged: true,
      reason: 'A previous update did not finish verification. Run update or reinstall this CLI before running product commands.' }, 1);
    if (isPinned && explicit && operation !== 'check') return finish({ ...base(), status: 'pinned', reason: 'An explicit version binding prevents this update.', guidance: options.pinned ? 'Change the product version binding first.' : 'Run update enable to explicitly track this global installation.' }, 1);
    const suppressed = automaticSuppressed(options, argv, runtime) || state.policy === 'disabled' || isPinned;
    const elapsed = state.lastChecked === undefined ? Infinity : runtime.now() - state.lastChecked;
    const due = elapsed >= DAY || elapsed < 0;
    if (!explicit && (suppressed || !due)) {
      lease = await admit(installation.id);
      return { handled: false, exitCode: 0, result: { ...base(), status: isPinned ? 'pinned' : 'skipped' }, release: lease.release };
    }
    if (options.offline) return finish({ ...base(), status: 'error', reason: 'This invocation is offline; release checking is disabled.' }, 1);
    // Rate-limit failed checks too; a disconnected CLI should not stall daily work.
    state = await store.patch({ lastChecked: runtime.now() });
    let release: Release;
    try { release = await latestRelease(options, runtime); }
    catch (error) {
      if (explicit) throw error;
      lease = await admit(installation.id);
      return { handled: false, exitCode: 0, result: { ...base(), status: 'skipped', reason: 'Release metadata is unavailable; continuing with the installed version.' }, release: lease.release };
    }
    const newer = compareVersions(release.version, options.version) > 0;
    const selected = { ...base(), latestVersion: release.version };
    if (!newer && !uncertain) {
      if (explicit) return finish({ ...selected, status: 'current' });
      lease = await admit(installation.id);
      return { handled: false, exitCode: 0, result: { ...selected, status: 'current' }, release: lease.release };
    }
    if (compareVersions(release.version, options.version) < 0) return finish({ ...selected, status: 'error', reason: 'Repair would require a downgrade; use the documented installer.' }, 1);
    if ((explicit && operation === 'check') || (!explicit && state.policy === 'notify')) {
      if (explicit) return finish({ ...selected, status: 'available' });
      runtime.writeStderr(`${options.binName} ${release.version} is available; run ${options.binName} update.\n`);
      lease = await admit(installation.id);
      return { handled: false, exitCode: 0, result: { ...selected, status: 'available' }, release: lease.release };
    }
    if (await store.active(installation.id) || await store.active(`manager-${managerIdentity}`)) {
      if (explicit) return finish({ ...selected, status: 'busy', reason: 'Another command is using this installation. Update after it exits.' }, 75);
      lease = await admit(installation.id);
      return { handled: false, exitCode: 0, result: { ...selected, status: 'busy' }, release: lease.release };
    }
    managerLock = await store.lock(`manager-${managerIdentity}`);
    if (!managerLock) {
      if (explicit) return finish({ ...selected, status: 'busy', reason: 'Another CLI update is using this global package manager.' }, 75);
      lease = await admit(installation.id);
      return { handled: false, exitCode: 0, result: { ...selected, status: 'busy' }, release: lease.release };
    }
    if (await store.active(installation.id) || await store.active(`manager-${managerIdentity}`)) {
      if (explicit) return finish({ ...selected, status: 'busy', reason: 'Another command is using this global installation. Update after it exits.' }, 75);
      lease = await admit(installation.id);
      return { handled: false, exitCode: 0, result: { ...selected, status: 'busy' }, release: lease.release };
    }
    // Refresh identity and policy under both locks, immediately before mutation.
    state = await store.read();
    if (!explicit && (state.policy === 'disabled' || state.policy === 'notify')) {
      lease = await admit(installation.id);
      return { handled: false, exitCode: 0, result: { ...base(), status: 'skipped' }, release: lease.release };
    }
    await verifyInstalled(options, installation, options.version, runtime, installation.dependencySpec);
    // Preparing an archive is non-mutating; the persistent mutation marker is the
    // authority for deciding whether an error can safely continue product work.
    try { installation = await installRelease(release, installation, options, runtime, store); }
    catch (error) {
      mayHaveChanged = await store.mutation(installation.id);
      if (!explicit && !mayHaveChanged) {
        await verifyInstalled(options, installation, options.version, runtime, installation.dependencySpec);
        lease = await admit(installation.id);
        return { handled: false, exitCode: 0, result: { ...base(), status: 'skipped', reason: 'The release archive could not be verified; continuing with the unchanged installed version.' }, release: lease.release };
      }
      throw error;
    }
    if (explicit) return finish({ ...selected, status: 'updated' });
    // Hold a reservation through re-entry so another process cannot replace this
    // version between our post-install proof and the child's lease admission.
    lease = await admit(installation.id);
    await managerLock.release(); managerLock = undefined;
    await installLock.release(); installLock = undefined;
    let exitCode: number;
    try {
      exitCode = await runtime.reenter(runtime.execPath, [...runtime.execArgv, installation.entrypoint, ...argv], {
        ...runtime.env, HRANESS_NO_UPDATE: '1', HRANESS_UPDATE_REENTRY: '1',
      });
    } catch { throw new Error('The update succeeded but the updated executable could not start. Run the command again.'); }
    await lease.release(); lease = undefined;
    return completed({ ...selected, status: 'updated' }, exitCode);
  } catch (error) {
    const reason = error instanceof Error ? error.message : 'The updater failed.';
    const result = { ...base(), status: 'error' as const, reason, ...(mayHaveChanged ? { codeMayHaveChanged: true } : {}) };
    // Provenance/state errors fail closed: without admission coordination it is
    // unsafe to run a globally installed command alongside another updater.
    if (!explicit) runtime.writeStderr(`${options.binName} update: ${reason}\n`);
    return finish(result, 1);
  } finally {
    await managerLock?.release(); await installLock?.release();
  }
}

/** Explicit-command convenience entrypoint. Pass args after the word update. */
export function runUpdateCommand(options: CliUpdateOptions): Promise<StartupResult> {
  return runCliUpdate({ ...options, argv: ['update', ...(options.argv ?? process.argv.slice(2))] });
}
