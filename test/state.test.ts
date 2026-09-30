import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { runCliUpdate } from '../src/index.js';
import { detectInstallation, identity } from '../src/install.js';
import { runtimeFor } from '../src/runtime.js';
import { SafeState } from '../src/state.js';
import { fixture, packageName } from './helpers.js';

test('symlink, oversized, corrupt, and world-writable policy state are refused', async t => {
  const f = await fixture(); t.after(f.cleanup); const store = new SafeState(f.options, runtimeFor(f.options), f.coordinationDirectory); await store.initialize();
  const path = join(store.product, 'state.json'), target = join(f.root, 'foreign.json');
  await fs.writeFile(target, '{"schema":1}', { mode: 0o600 }); await fs.symlink(target, path);
  await assert.rejects(store.read()); await assert.rejects(store.patch({ policy: 'disabled' })); assert.equal(await fs.readFile(target, 'utf8'), '{"schema":1}');
  await fs.unlink(path);
  for (const content of ['{invalid', 'x'.repeat(16385), '{"schema":2}', '{"schema":1,"policy":"anything"}']) {
    await fs.writeFile(path, content, { mode: 0o600 }); await assert.rejects(store.read());
  }
  await fs.writeFile(path, '{"schema":1}', { mode: 0o600 }); await fs.chmod(path, 0o666); await assert.rejects(store.read());
});

test('state symlink and replaceable directory ancestors fail closed', async t => {
  const f = await fixture(); t.after(f.cleanup);
  await fs.mkdir(join(f.root, 'actual')); await fs.symlink(join(f.root, 'actual'), join(f.root, 'symlink'));
  await assert.rejects(new SafeState({ ...f.options, stateDirectory: join(f.root, 'symlink/state') }, runtimeFor(f.options)).initialize());
  await fs.mkdir(join(f.root, 'writable')); await fs.chmod(join(f.root, 'writable'), 0o777);
  await assert.rejects(new SafeState({ ...f.options, stateDirectory: join(f.root, 'writable/state') }, runtimeFor(f.options)).initialize());
});

test('unsupported shared global prefixes keep ordinary product commands usable without updater writes', async t => {
  const f = await fixture(); t.after(f.cleanup); await fs.chmod(f.prefix, 0o775);
  const result = await runCliUpdate(f.options);
  assert.equal(result.handled, false); assert.equal(result.result?.status, 'unsupported'); assert.equal(f.checks, 0); assert.equal(f.installations, 0);
  await assert.rejects(fs.stat(f.coordinationDirectory));
});

test('replaced parent directories are detected before later mutations', async t => {
  const f = await fixture(); t.after(f.cleanup); const store = new SafeState(f.options, runtimeFor(f.options), f.coordinationDirectory); await store.initialize();
  await fs.rename(store.product, store.product + '-old'); await fs.mkdir(store.product, { mode: 0o700 });
  await assert.rejects(store.patch({ policy: 'disabled' }), /changed identity/);
});

test('live claims exclude peers, and dead unique claims are reclaimed without reusing their paths', async t => {
  const f = await fixture(); t.after(f.cleanup);
  const alive = new Set([1001, 1002]); const name = `install-${identity('test')}`;
  const a = new SafeState(f.options, { ...runtimeFor(f.options), pid: 1001, isProcessAlive: pid => alive.has(pid) });
  const b = new SafeState(f.options, { ...runtimeFor(f.options), pid: 1002, isProcessAlive: pid => alive.has(pid) });
  await a.initialize(); await b.initialize();
  const first = await a.lock(name); assert(first); assert.equal(await b.lock(name), undefined);
  alive.delete(1001); const second = await b.lock(name); assert(second);
  // The old owner releasing later cannot unlink the new owner's unique claim.
  await first.release(); assert.equal(await b.lock(name), undefined); await second.release();
  const third = await b.lock(name); assert(third); await third.release();
});

test('simultaneous bakery ticket selection admits at most one process', async t => {
  const f = await fixture(); t.after(f.cleanup);
  const alive = new Set([2001, 2002]), name = `install-${identity('interleaving')}`;
  const stores = [2001, 2002].map(pid => new SafeState(f.options, { ...runtimeFor(f.options), pid, isProcessAlive: candidate => alive.has(candidate) }));
  await Promise.all(stores.map(store => store.initialize()));
  let arrivals = 0, unblock!: () => void;
  const barrier = new Promise<void>(resolve => { unblock = resolve; });
  for (const store of stores) {
    const original = store.writeJson.bind(store);
    store.writeJson = async (path, value) => {
      if (path.includes(name) && (value as { choosing?: boolean }).choosing === false) {
        arrivals++; if (arrivals === 2) unblock(); await barrier;
      }
      await original(path, value);
    };
  }
  const claims = await Promise.all(stores.map(store => store.lock(name)));
  assert(claims.filter(Boolean).length <= 1);
  for (const claim of claims) await claim?.release();
});

test('two dead-owner reclaimers cannot remove a newly acquired unique claim', async t => {
  const f = await fixture(); t.after(f.cleanup);
  const alive = new Set([3001, 3002, 3003]), name = `install-${identity('reclaim')}`;
  const stores = [3001, 3002, 3003].map(pid => new SafeState(f.options, { ...runtimeFor(f.options), pid, isProcessAlive: candidate => alive.has(candidate) }));
  for (const store of stores) await store.initialize();
  const dead = await stores[0]!.lock(name); assert(dead); alive.delete(3001);
  const contenders = await Promise.all([stores[1]!.lock(name), stores[2]!.lock(name)]);
  assert(contenders.filter(Boolean).length <= 1);
  await dead.release();
  const heldIndex = contenders.findIndex(Boolean);
  if (heldIndex !== -1) {
    assert.equal(await stores[heldIndex === 0 ? 2 : 1]!.lock(name), undefined);
    await contenders[heldIndex]!.release();
  }
});

test('an empty directory or dead partial claim from a crash does not strand the lock', async t => {
  const f = await fixture(); t.after(f.cleanup); const name = `install-${identity('partial')}`;
  const store = new SafeState(f.options, { ...runtimeFor(f.options), pid: 4001, isProcessAlive: pid => pid === 4001 }); await store.initialize();
  const directory = join(store.root, 'locks', name); await fs.mkdir(directory, { mode: 0o700 });
  await fs.writeFile(join(directory, '4002.dead-token-123.json'), '', { mode: 0o600 });
  const claim = await store.lock(name); assert(claim); await claim.release();
});

test('all executable aliases of one package share the active-use lease', async t => {
  const f = await fixture(); t.after(f.cleanup);
  const otherEntrypoint = join(f.packageRoot, 'bin/other.js'); await fs.writeFile(otherEntrypoint, '// other alias\n');
  await fs.writeFile(join(f.packageRoot, 'package.json'), JSON.stringify({ name: packageName, version: '1.0.0', bin: { example: 'bin/cli.js', 'example-builder': 'bin/other.js' } }));
  await fs.symlink(otherEntrypoint, join(f.binDirectory, 'example-builder'));
  const alias = { ...f.options, binName: 'example-builder', entrypoint: otherEntrypoint };
  const a = await detectInstallation(f.options, runtimeFor(f.options)), b = await detectInstallation(alias, runtimeFor(alias));
  assert.equal(a.installation?.id, b.installation?.id);
  const running = await runCliUpdate({ ...alias, runtime: { ...f.runtime, env: { HRANESS_NO_UPDATE: '1' } } });
  const result = await runCliUpdate({ ...f.options, argv: ['update'] });
  assert.equal(result.result?.status, 'busy'); assert.equal(f.installations, 0); await running.release();
});

test('a product parser can require a lease for commands that resemble generic read-only arguments', async t => {
  const f = await fixture(); t.after(f.cleanup);
  for (const argv of [['version'], ['completion'], ['completions'], ['-V'], ['--completion'], ['help']]) {
    const running = await runCliUpdate({ ...f.options, argv, effectFree: false,
      runtime: { ...f.runtime, env: { HRANESS_NO_UPDATE: '1' } } });
    assert.equal(running.handled, false); assert.equal(running.result?.supported, true, argv.join(' '));
    try {
      const result = await runCliUpdate({ ...f.options, argv: ['update'] });
      assert.equal(result.result?.status, 'busy', argv.join(' ')); assert.equal(f.installations, 0);
    } finally { await running.release(); }
  }
});

test('missing mutable files during an admitted update never become lease-free product startup', async t => {
  const f = await fixture(); t.after(f.cleanup); const store = new SafeState(f.options, runtimeFor(f.options), f.coordinationDirectory); await store.initialize();
  const detection = await detectInstallation(f.options, runtimeFor(f.options)); assert(detection.installation);
  const lock = await store.lock(`install-${detection.installation.id}`); assert(lock);
  await fs.unlink(f.entrypoint); await fs.unlink(join(f.packageRoot, 'package.json')); await fs.unlink(join(f.binDirectory, 'example'));
  let result = await runCliUpdate(f.options); assert.equal(result.handled, true); assert.equal(result.result?.status, 'busy');
  await lock.release(); result = await runCliUpdate(f.options); assert.equal(result.handled, true); assert.equal(result.result?.status, 'error');
});

test('a shared global-manager dependency graph is not changed while another package command is active', async t => {
  const f = await fixture(); t.after(f.cleanup); const store = new SafeState(f.options, runtimeFor(f.options), f.coordinationDirectory); await store.initialize();
  const detection = await detectInstallation(f.options, runtimeFor(f.options)); assert(detection.installation);
  const managerId = identity(`${detection.installation.manager}\0${detection.installation.globalRoot}`);
  const otherPackage = await store.lease(`manager-${managerId}`);
  const result = await runCliUpdate({ ...f.options, argv: ['update'] });
  assert.equal(result.result?.status, 'busy'); assert.equal(f.installations, 0); await otherPackage.release();
});

test('different HOME and preference roots cannot split the same installation coordination', async t => {
  const f = await fixture(); t.after(f.cleanup);
  const running = await runCliUpdate({ ...f.options, runtime: { ...f.runtime, env: { HRANESS_NO_UPDATE: '1' } } });
  const result = await runCliUpdate({ ...f.options, stateDirectory: join(f.root, 'other-preferences'),
    runtime: { ...f.runtime, homeDirectory: join(f.root, 'other-home'), env: { HOME: join(f.root, 'other-home') } }, argv: ['update'] });
  assert.equal(result.result?.status, 'busy'); assert.equal(f.installations, 0); await running.release();
});

test('a dead updater parent does not admit work while its package-manager group can still mutate code', async t => {
  const f = await fixture(); t.after(f.cleanup); const store = new SafeState(f.options, runtimeFor(f.options), f.coordinationDirectory); await store.initialize();
  const detected = await detectInstallation(f.options, runtimeFor(f.options)); assert(detected.installation);
  const managerId = identity(`${detected.installation.manager}\0${detected.installation.globalRoot}`);
  await store.managerMutation(managerId, { schema: 1, installationId: detected.installation.id, packageName, ownerPid: 7001, childPid: 7002, settled: false });
  const runtime = { ...f.runtime, isProcessAlive: (pid: number) => pid === process.pid || pid === -7002 };
  for (const argv of [['work'], ['update']]) {
    const result = await runCliUpdate({ ...f.options, runtime, argv });
    assert.equal(result.handled, true); assert.equal(result.result?.status, 'busy'); assert.equal(f.installations, 0);
  }
  const recovered = await runCliUpdate({ ...f.options, argv: ['update'], runtime: { ...f.runtime, isProcessAlive: pid => pid === process.pid } });
  assert.equal(recovered.result?.status, 'updated');
});

test('unknown subprocess custody and another package’s interrupted manager operation remain quarantined', async t => {
  const f = await fixture(); t.after(f.cleanup); const store = new SafeState(f.options, runtimeFor(f.options), f.coordinationDirectory); await store.initialize();
  const detected = await detectInstallation(f.options, runtimeFor(f.options)); assert(detected.installation);
  const managerId = identity(`${detected.installation.manager}\0${detected.installation.globalRoot}`);
  await store.managerMutation(managerId, { schema: 1, installationId: detected.installation.id, packageName, ownerPid: 8001, settled: false });
  let result = await runCliUpdate({ ...f.options, argv: ['update'] }); assert.equal(result.result?.status, 'error'); assert.match(result.result?.reason ?? '', /custody is unknown/);
  await store.managerMutation(managerId, { schema: 1, installationId: identity('other-package'), packageName: '@hraness/other', ownerPid: 8001, childPid: 8002, settled: true });
  result = await runCliUpdate(f.options); assert.equal(result.handled, true); assert.equal(result.result?.status, 'error'); assert.match(result.result?.reason ?? '', /@hraness\/other/);
  assert.equal(f.installations, 0);
});
