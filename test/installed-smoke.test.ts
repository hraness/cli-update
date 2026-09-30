import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { runCliUpdate } from '../src/index.js';
import { detectInstallation, discoverExecutable, locateGlobalCandidate, readManifest } from '../src/install.js';
import { runtimeFor, runProcess } from '../src/runtime.js';
import { retainVerifiedArchive } from '../src/provider.js';
import { SafeState } from '../src/state.js';
import { packageArchive, packageName, registryMetadata } from './helpers.js';
import type { CliUpdateOptions } from '../src/types.js';

for (const manager of ['bun', 'npm'] as const) {
  test(`real ${manager} isolated global archive layout, aliases, and ownership detection`, async t => {
    const directory = await fs.mkdtemp(join(await fs.realpath(tmpdir()), 'hraness-update-installed-test-'));
    t.after(() => fs.rm(directory, { recursive: true, force: true }));
    const home = join(directory, 'home'), prefix = join(directory, 'prefix'), archive = join(directory, 'example-1.0.0.tgz');
    await fs.mkdir(home); await fs.mkdir(prefix); await fs.writeFile(archive, packageArchive(packageName, '1.0.0'));
    const npmConfig = '@hraness:registry=http://127.0.0.1:9/\nfetch-retries=0\nignore-scripts=true\n';
    await fs.writeFile(join(home, '.npmrc'), npmConfig);
    const dummy: CliUpdateOptions = { packageName, version: '1.0.0', binName: 'example', entrypoint: archive };
    const supplied = process.env[`HRANESS_TEST_${manager.toUpperCase()}`];
    const executable = supplied ?? await discoverExecutable(manager, dummy, runtimeFor({ ...dummy, runtime: { homeDirectory: homedir() } }));
    if (!executable) { t.skip(`No ${manager} executable was discovered; supply HRANESS_TEST_${manager.toUpperCase()} for the isolated smoke.`); return; }
    const modules = manager === 'bun' ? join(prefix, 'install/global/node_modules') : join(prefix, 'lib/node_modules');
    const globalRoot = manager === 'bun' ? dirname(modules) : prefix, binDirectory = join(prefix, 'bin');
    const env: NodeJS.ProcessEnv = {
      PATH: [dirname(executable), dirname(process.execPath), '/usr/bin', '/bin'].join(':'), HOME: home,
      BUN_INSTALL: prefix, BUN_INSTALL_GLOBAL_DIR: manager === 'bun' ? globalRoot : join(directory, 'unused-bun'), BUN_INSTALL_BIN: binDirectory,
      NPM_CONFIG_PREFIX: prefix, NPM_CONFIG_CACHE: join(directory, 'npm-cache'), NPM_CONFIG_USERCONFIG: join(home, '.npmrc'),
      NPM_CONFIG_IGNORE_SCRIPTS: 'true', NPM_CONFIG_UPDATE_NOTIFIER: 'false',
      HRANESS_NO_UPDATE: '1',
    };
    await fs.mkdir(globalRoot, { recursive: true });
    if (manager === 'bun') {
      await fs.writeFile(join(home, '.bunfig.toml'), `[install]\nglobalDir = ${JSON.stringify(globalRoot)}\nglobalBinDir = ${JSON.stringify(binDirectory)}\n`);
      await fs.writeFile(join(globalRoot, 'package.json'), '{"dependencies":{}}');
      // Prove all manager write roots are confined before invoking installation.
      const bin = await runProcess(executable, ['pm', 'bin', '-g'], { env, timeoutMs: 5000, maxOutputBytes: 16_384 });
      assert.equal(bin.code, 0); assert.equal(bin.stdout.trim(), binDirectory);
      const list = await runProcess(executable, ['pm', '-g', 'ls'], { env, timeoutMs: 5000, maxOutputBytes: 16_384 });
      // Bun prints no tree before the first global lockfile exists. Every path
      // is nevertheless bound by the isolated HOME, BUN_INSTALL and bunfig.
      if (list.stdout.trim()) assert(list.stdout.startsWith(globalRoot + ' node_modules '), list.stdout);
    } else {
      const actual = await runProcess(executable, ['prefix', '--global'], { env, timeoutMs: 5000, maxOutputBytes: 16_384 });
      assert.equal(actual.code, 0); assert.equal(actual.stdout.trim(), prefix);
    }
    const retainedDirectory = join(prefix, 'retained-fixture-archives'); await fs.mkdir(retainedDirectory, { mode: 0o700 });
    const retain = async (source: string) => retainVerifiedArchive(source, retainedDirectory,
      createHash('sha256').update(await fs.readFile(source)).digest('hex'), runtimeFor({ ...dummy, runtime: { env, homeDirectory: home } }));
    const retained = await retain(archive); await fs.unlink(archive);
    const installArgs = (source: string, name = packageName) => manager === 'bun' ? ['add', '--global', '--ignore-scripts', '--', `${name}@file:${source}`]
      : ['install', '--global', '--offline', '--ignore-scripts', '--no-audit', '--no-fund', '--', `${name}@file:${source}`];
    const args = installArgs(retained);
    const installed = await runProcess(executable, args, { env, timeoutMs: 30_000, maxOutputBytes: 131_072, cwd: directory });
    assert.equal(installed.code, 0, installed.stderr);
    const packageRoot = join(modules, packageName), entrypoint = join(packageRoot, 'bin/cli.js');
    const options: CliUpdateOptions = { ...dummy, entrypoint, managers: { [manager]: executable, [manager === 'bun' ? 'npm' : 'bun']: join(directory, 'absent-manager') }, runtime: { env, homeDirectory: home } };
    const runtime = runtimeFor(options), candidate = await locateGlobalCandidate(options, runtime); assert(candidate);
    let dependencySpec: string | undefined;
    if (manager === 'bun') dependencySpec = (await readManifest(join(globalRoot, 'package.json'))).dependencies?.[packageName];
    // A task-created local archive is intentionally noncanonical. Its exact
    // verified archive receipt exercises the same path as library-owned GHR installs.
    const receipt = { id: candidate.id, version: '1.0.0', dependencySpec };
    const detected = await detectInstallation(options, runtime, receipt);
    assert(detected.installation, detected.reason); assert.equal(detected.installation.manager, manager);
    assert.equal(detected.installation.packageRoot, packageRoot); assert.equal(detected.installation.version, '1.0.0');
    assert.equal(detected.installation.dependencySpec, dependencySpec);
    const store = new SafeState(options, runtime, candidate.coordinationDirectory);
    await store.initialize(); await store.managedInstall(candidate.id, receipt);
    if (manager === 'npm' && !(await readManifest(join(packageRoot, 'package.json')))._requested?.rawSpec) assert.equal(detected.installation.pinned, false);
    const alias = await detectInstallation({ ...options, binName: 'example-builder', entrypoint: join(packageRoot, 'bin/builder.js') }, runtime, receipt);
    assert(alias.installation, alias.reason); assert.equal(alias.installation.id, detected.installation.id);
    assert.equal(await fs.realpath(join(binDirectory, 'example')), entrypoint);
    assert.equal(await fs.realpath(join(binDirectory, 'example-builder')), join(packageRoot, 'bin/builder.js'));
    const executed = await runProcess(executable === process.execPath && manager === 'bun' ? executable : process.execPath,
      [entrypoint], { env, timeoutMs: 5000, maxOutputBytes: 16_384 });
    assert.equal(executed.code, 0); assert.equal(executed.stdout, '1.0.0');
    const otherName = '@hraness/other-fixture', otherSource = join(directory, 'other.tgz');
    await fs.writeFile(otherSource, packageArchive(otherName, '1.0.0', 'other-fixture'));
    const otherRetained = await retain(otherSource); await fs.unlink(otherSource);
    assert.equal((await runProcess(executable, installArgs(otherRetained, otherName), { env, timeoutMs: 30_000, maxOutputBytes: 131_072, cwd: directory })).code, 0);
    for (const next of ['1.1.0', '1.2.0']) {
      const bytes = packageArchive(packageName, next), metadata = registryMetadata(next), requests: string[] = [];
      let output = '';
      const updated = await runCliUpdate({ ...options, version: next === '1.1.0' ? '1.0.0' : '1.1.0',
        argv: next === '1.1.0' ? ['update', '--json'] : ['work'], ignoreScripts: true,
        runtime: { ...options.runtime, env: { ...env, HRANESS_NO_UPDATE: '0' }, temporaryDirectory: directory,
          now: () => next === '1.1.0' ? 1_800_000_000_000 : 1_800_000_000_000 + 86_400_000,
          writeStdout: text => { output += text; }, writeStderr: () => {},
          fetch: async (input, init) => {
            requests.push(String(input)); assert.equal(init?.redirect, 'error');
            if (String(input) === metadata.dist.tarball) return new Response(new Uint8Array(bytes));
            assert.equal(String(input), `https://registry.npmjs.org/${encodeURIComponent(packageName)}/latest`);
            return new Response(JSON.stringify(metadata));
          },
          reenter: async () => 37,
        } });
      assert.equal(updated.result?.status, 'updated', updated.result?.reason);
      assert.equal(updated.exitCode, next === '1.1.0' ? 0 : 37);
      if (next === '1.2.0') assert.equal(output, '');
      assert(requests.includes(metadata.dist.tarball));
      assert.equal((await store.managedInstall(candidate.id))?.version, next);
      assert.equal((await readManifest(join(packageRoot, 'package.json'))).version, next);
      assert.equal((await readManifest(join(modules, otherName, 'package.json'))).version, '1.0.0');
      assert.equal(await fs.realpath(join(binDirectory, 'example-builder')), join(packageRoot, 'bin/builder.js'));
    }
    assert.equal(await fs.readFile(join(home, '.npmrc'), 'utf8'), npmConfig);
    if (manager === 'bun') {
      const replay = await runProcess(executable, ['install', '--global', '--ignore-scripts'], { env, timeoutMs: 30_000, maxOutputBytes: 131_072, cwd: directory });
      assert.equal(replay.code, 0, replay.stderr);
      const specs = (await readManifest(join(globalRoot, 'package.json'))).dependencies!;
      for (const name of [packageName, otherName]) assert.equal((await fs.stat(specs[name]!.replace(/^file:/, ''))).isFile(), true);
    }
    t.diagnostic(`${manager}: isolated prefix ${prefix}; aliases and two-package/two-upgrade retained-archive replay verified; no user-global writes.`);
  });
}
