import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { runCliUpdate, runUpdateCommand } from '../src/index.js';
import { detectInstallation } from '../src/install.js';
import { ProcessLaunchError, runtimeFor, runProcess } from '../src/runtime.js';
import { SafeState } from '../src/state.js';
import { fixture, packageArchive, packageName, registryMetadata } from './helpers.js';

test('verified Bun global installs update by default and re-enter once with exact args, environment, and child exit status', async t => {
  const f = await fixture(); t.after(f.cleanup);
  const argv = ['work', '--json', 'a value', '$(not a command)'];
  const result = await runCliUpdate({ ...f.options, argv, runtime: { ...f.runtime, env: { CUSTOM: 'retained' }, execArgv: ['--no-warnings'] } });
  assert.equal(result.handled, true); assert.equal(result.exitCode, 42); assert.equal(result.result?.status, 'updated');
  assert.equal(f.installations, 1); assert.equal(f.restarts.length, 1); assert.equal(f.stdout, '');
  assert.deepEqual(f.restarts[0]?.args, ['--no-warnings', f.entrypoint, ...argv]);
  assert.equal(f.restarts[0]?.env.CUSTOM, 'retained'); assert.equal(f.restarts[0]?.env.HRANESS_NO_UPDATE, '1');
  const installer = f.calls.find(call => call.args[0] === 'add')!;
  assert.deepEqual(installer.args.slice(0, -1), ['add', '--global', '--no-progress', '--']);
  assert(installer.args.at(-1)?.startsWith(`${packageName}@file:`));
  assert.equal(installer.options.diagnostics, true);
  assert(!installer.args.some(arg => arg.includes('trust') || arg.includes('ignore-scripts')));
});

test('npm global ownership uses its original manager and exact registry release', async t => {
  const f = await fixture({ manager: 'npm' }); t.after(f.cleanup);
  const result = await runCliUpdate({ ...f.options, argv: ['update', '--json'] });
  assert.equal(result.result?.status, 'updated'); assert.equal(f.restarts.length, 0);
  assert.equal(f.calls.find(call => call.args[0] === 'install')?.executable, f.options.managers?.npm);
  const output = JSON.parse(f.stdout); assert.equal(output.schema, 'hraness.cli-update.v1'); assert.equal(output.manager, 'npm');
  assert.equal(f.stdout.trim().split('\n').length, 1);
});

test('retained npm exact-request evidence and product pins are respected', async t => {
  const f = await fixture({ manager: 'npm' }); t.after(f.cleanup);
  const path = join(f.packageRoot, 'package.json'), manifest = JSON.parse(await fs.readFile(path, 'utf8'));
  await fs.writeFile(path, JSON.stringify({ ...manifest, _requested: { rawSpec: '1.0.0' } }));
  const result = await runCliUpdate(f.options);
  assert.equal(result.result?.status, 'pinned'); assert.equal(f.checks, 0); await result.release();
});

test('ordinary Bun range normalization tracks newer stable CLI releases', async t => {
  const f = await fixture({ spec: '^1.0.0' }); t.after(f.cleanup); f.metadata(registryMetadata('2.0.0')); f.archive(packageArchive(packageName, '2.0.0'));
  const result = await runCliUpdate({ ...f.options, argv: ['update'] });
  assert.equal(result.result?.status, 'updated'); assert.equal(result.result?.latestVersion, '2.0.0');
});

test('a product can retain restrictive installer lifecycle policy without enabling trust', async t => {
  const f = await fixture(); t.after(f.cleanup);
  const result = await runCliUpdate({ ...f.options, ignoreScripts: true, argv: ['update'] });
  assert.equal(result.result?.status, 'updated');
  const call = f.calls.find(call => call.args[0] === 'add')!;
  assert(call.args.includes('--ignore-scripts')); assert(!call.args.includes('--trust'));
});

for (const [label, env, additional] of [
  ['no-update environment', { HRANESS_NO_UPDATE: '1' }, {}], ['CI', { CI: 'true' }, {}],
  ['re-entry', { HRANESS_UPDATE_REENTRY: '1' }, {}], ['offline', {}, { offline: true }],
  ['nested', {}, { nested: true }], ['product pin', {}, { pinned: true }],
] as const) {
  test(`${label} suppresses incidental network and installation while retaining an active lease`, async t => {
    const f = await fixture(); t.after(f.cleanup);
    const result = await runCliUpdate({ ...f.options, ...additional, runtime: { ...f.runtime, env } });
    assert.equal(result.handled, false); assert.equal(f.checks, 0); assert.equal(f.installations, 0);
    await result.release();
  });
}

test('help and version do not fetch or install', async t => {
  const f = await fixture(); t.after(f.cleanup);
  for (const argv of [['--help'], ['--version'], ['-V'], ['completion'], ['help', 'work']]) {
    const result = await runCliUpdate({ ...f.options, argv }); assert.equal(result.handled, false); await result.release();
  }
  assert.equal(f.checks, 0); assert.equal(f.installations, 0);
  await assert.rejects(fs.stat(f.options.stateDirectory!));
});

test('source commands and help survive an invalid or unwritable updater state location', async t => {
  const f = await fixture(); t.after(f.cleanup);
  const badState = join(f.root, 'not-a-directory'); await fs.writeFile(badState, 'not a directory');
  let result = await runCliUpdate({ ...f.options, stateDirectory: join(badState, 'state'), argv: ['-V'] });
  assert.equal(result.handled, false); assert.equal(f.calls.length, 0);
  result = await runCliUpdate({ ...f.options, entrypoint: join(f.root, 'source.ts'), stateDirectory: join(badState, 'state') });
  assert.equal(result.handled, false); assert.equal(f.checks, 0);
});

test('child --version after a separator is real work and retains an active lease', async t => {
  const f = await fixture(); t.after(f.cleanup);
  const running = await runCliUpdate({ ...f.options, argv: ['run', '--', 'child', '--version'], runtime: { ...f.runtime, env: { HRANESS_NO_UPDATE: '1' } } });
  assert.equal(running.handled, false);
  const updating = await runCliUpdate({ ...f.options, argv: ['update'] });
  assert.equal(updating.result?.status, 'busy'); assert.equal(f.installations, 0); await running.release();
});

test('disabled and legacy notify policies survive the automatic default', async t => {
  const f = await fixture(); t.after(f.cleanup);
  let result = await runCliUpdate({ ...f.options, argv: ['update', 'disable', '--json'] });
  assert.equal(result.result?.policy, 'disabled');
  result = await runCliUpdate(f.options); assert.equal(result.handled, false); await result.release(); assert.equal(f.checks, 0);
  const store = new SafeState(f.options, runtimeFor(f.options));
  await store.patch({ policy: 'notify' });
  result = await runCliUpdate(f.options); assert.equal(result.result?.status, 'available'); await result.release();
  assert.equal(f.installations, 0); assert.match(f.stderr, /run example update/);
});

test('explicit check works with saved opt-out and does not install', async t => {
  const f = await fixture(); t.after(f.cleanup);
  await runCliUpdate({ ...f.options, argv: ['update', 'disable'] }); f.resetOutput();
  const result = await runUpdateCommand({ ...f.options, argv: ['--check', '--json'] });
  assert.equal(result.result?.status, 'available'); assert.equal(result.result?.policy, 'disabled'); assert.equal(f.installations, 0);
  assert.equal(JSON.parse(f.stdout).latestVersion, '1.1.0');
});

test('exact global dependency specs require explicit tracking and product pins remain authoritative', async t => {
  const f = await fixture({ spec: '1.0.0' }); t.after(f.cleanup);
  let result = await runCliUpdate(f.options); assert.equal(result.result?.status, 'pinned'); await result.release(); assert.equal(f.checks, 0);
  result = await runCliUpdate({ ...f.options, argv: ['update'] }); assert.equal(result.result?.status, 'pinned');
  result = await runCliUpdate({ ...f.options, argv: ['update', 'enable'] }); assert.equal(result.result?.status, 'enabled');
  result = await runCliUpdate({ ...f.options, pinned: true, argv: ['update', 'enable'] }); assert.equal(result.result?.status, 'pinned');
  result = await runCliUpdate(f.options); assert.equal(result.result?.status, 'updated');
});

test('daily cadence includes failed metadata checks and permits false CI marker', async t => {
  const f = await fixture(); t.after(f.cleanup);
  f.fetch(async () => { throw new Error('offline'); });
  let result = await runCliUpdate({ ...f.options, runtime: { ...f.runtime, env: { CI: 'false' } } });
  assert.equal(result.handled, false); await result.release(); assert.equal(f.checks, 1);
  result = await runCliUpdate(f.options); await result.release(); assert.equal(f.checks, 1);
  f.now(1_800_000_000_000 + 86_400_000);
  result = await runCliUpdate(f.options); await result.release(); assert.equal(f.checks, 2);
});

test('existing newer versions are never downgraded', async t => {
  const f = await fixture({ version: '2.0.0', spec: '^2.0.0' }); t.after(f.cleanup);
  const result = await runCliUpdate({ ...f.options, argv: ['update', '--json'] });
  assert.equal(result.result?.status, 'current'); assert.equal(f.installations, 0);
});

test('source, project, runner-cache, linked, and foreign-bin installations are rejected', async t => {
  const f = await fixture(); t.after(f.cleanup);
  for (const folder of ['source', 'project/node_modules', '.npm/_npx/run/node_modules']) {
    const root = join(f.root, folder, packageName); await fs.mkdir(join(root, 'bin'), { recursive: true });
    await fs.writeFile(join(root, 'package.json'), JSON.stringify({ name: packageName, version: '1.0.0', bin: { example: 'bin/cli.js' } }));
    await fs.writeFile(join(root, 'bin/cli.js'), '');
    const detected = await detectInstallation({ ...f.options, entrypoint: join(root, 'bin/cli.js') }, runtimeFor(f.options));
    assert.equal(detected.installation, undefined, folder);
  }
  const linkedRoot = join(f.root, 'linked-source'); await fs.rename(f.packageRoot, linkedRoot); await fs.symlink(linkedRoot, f.packageRoot);
  let detected = await detectInstallation(f.options, runtimeFor(f.options)); assert.equal(detected.installation, undefined);
  await fs.unlink(f.packageRoot); await fs.rename(linkedRoot, f.packageRoot);
  await fs.unlink(join(f.binDirectory, 'example')); await fs.writeFile(join(f.binDirectory, 'example'), 'foreign');
  detected = await detectInstallation(f.options, runtimeFor(f.options)); assert.equal(detected.installation, undefined);
  assert.equal(f.installations, 0);
});

test('noncanonical Git and file bindings are not silently changed', async t => {
  const f = await fixture({ spec: 'github:hraness/example#deadbeef' }); t.after(f.cleanup);
  const result = await runCliUpdate({ ...f.options, argv: ['update', '--json'] });
  assert.equal(result.result?.status, 'unsupported'); assert.equal(f.checks, 0); assert.equal(f.installations, 0);
});

test('another active command prevents replacement; release allows an explicit update', async t => {
  const f = await fixture(); t.after(f.cleanup);
  const running = await runCliUpdate({ ...f.options, runtime: { ...f.runtime, env: { HRANESS_NO_UPDATE: '1' } } });
  let result = await runCliUpdate({ ...f.options, argv: ['update', '--json'] });
  assert.equal(result.result?.status, 'busy'); assert.equal(result.exitCode, 75); assert.equal(f.installations, 0);
  await running.release(); result = await runCliUpdate({ ...f.options, argv: ['update'] });
  assert.equal(result.result?.status, 'updated');
});

test('simultaneous startup is excluded while one updater checks and installs', async t => {
  const f = await fixture(); t.after(f.cleanup);
  let releaseFetch!: () => void, entered!: () => void;
  const ready = new Promise<void>(resolve => { entered = resolve; });
  const gate = new Promise<void>(resolve => { releaseFetch = resolve; });
  f.fetch(async () => { entered(); await gate; return new Response(JSON.stringify(registryMetadata())); });
  const first = runCliUpdate(f.options); await ready;
  const second = await runCliUpdate(f.options);
  assert.equal(second.result?.status, 'busy'); assert.equal(second.handled, true);
  releaseFetch(); assert.equal((await first).result?.status, 'updated'); assert.equal(f.installations, 1);
});

for (const failure of ['exit', 'throw', 'identity'] as const) {
  test(`${failure} after manager launch stops product work and records an uncertain installation`, async t => {
    const f = await fixture(); t.after(f.cleanup); f.fail(failure);
    const result = await runCliUpdate(f.options);
    assert.equal(result.handled, true); assert.equal(result.exitCode, 1); assert.equal(result.result?.codeMayHaveChanged, true);
    assert.equal(f.restarts.length, 0);
    if (failure !== 'identity') {
      const again = await runCliUpdate(f.options); assert.equal(again.handled, true); assert.match(again.result?.reason ?? '', /not finished verification/);
      f.fail('none'); const repair = await runCliUpdate({ ...f.options, argv: ['update'] }); assert.equal(repair.result?.status, 'updated');
    }
  });
}

test('post-install managed receipt keeps library-selected exact specs tracking', async t => {
  const f = await fixture(); t.after(f.cleanup);
  await runCliUpdate({ ...f.options, argv: ['update'] });
  f.now(1_800_000_000_000 + 86_400_000); f.metadata(registryMetadata('1.2.0')); f.archive(packageArchive(packageName, '1.2.0'));
  const result = await runCliUpdate({ ...f.options, version: '1.1.0' });
  assert.equal(result.result?.status, 'updated'); assert.equal(f.installations, 2);
});

test('status is local and explicit offline check does not use network', async t => {
  const f = await fixture(); t.after(f.cleanup);
  let result = await runCliUpdate({ ...f.options, argv: ['update', 'status', '--json'] });
  assert.equal(result.result?.status, 'status'); assert.equal(f.checks, 0);
  result = await runCliUpdate({ ...f.options, offline: true, argv: ['update', 'check', '--json'] });
  assert.equal(result.exitCode, 1); assert.equal(f.checks, 0);
});

test('a proven pre-spawn failure leaves the unchanged installation usable and clears quarantine', async t => {
  const f = await fixture(); t.after(f.cleanup);
  const original = f.runtime.run!;
  const runtime = { ...f.runtime, run: async (...args: Parameters<typeof original>) => {
    if (args[1][0] === 'add') throw new ProcessLaunchError('No child was created.');
    return original(...args);
  } };
  const result = await runCliUpdate({ ...f.options, runtime });
  assert.equal(result.handled, false); assert.equal(result.result?.status, 'skipped'); await result.release();
  const retry = await runCliUpdate({ ...f.options, argv: ['update'] }); assert.equal(retry.result?.status, 'updated');
});

test('a successful manager leader with a surviving process-group child remains quarantined', async t => {
  const f = await fixture(); t.after(f.cleanup); let group: number | undefined;
  t.after(() => { if (group) { try { process.kill(-group, 'SIGKILL'); } catch { /* fixture group already exited */ } } });
  const original = f.runtime.run!;
  const runtime = { ...f.runtime, run: async (...args: Parameters<typeof original>) => {
    if (args[1][0] !== 'add') return original(...args);
    return runProcess(process.execPath, ['-e', 'require("node:child_process").spawn(process.execPath,["-e","setTimeout(()=>{},10000)"],{stdio:"ignore"}).unref()'], {
      ...args[2], onSpawn: async pid => { group = pid; await args[2].onSpawn?.(pid); },
    });
  } };
  const result = await runCliUpdate({ ...f.options, runtime });
  assert.equal(result.handled, true); assert.equal(result.result?.status, 'error'); assert.match(result.result?.reason ?? '', /process group is still active/);
  assert.equal(f.restarts.length, 0);
});
