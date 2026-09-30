import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { runCliUpdate } from '../src/index.js';
import { identity } from '../src/install.js';
import { runtimeFor, runProcess } from '../src/runtime.js';
import { SafeState } from '../src/state.js';
import { fixture, packageArchive, packageName } from './helpers.js';

async function enrollmentFixture() {
  const f = await fixture(), path = join(f.root, 'private-release.tgz');
  const archive = packageArchive(packageName, '1.0.0');
  await fs.writeFile(path, archive, { mode: 0o600 });
  await fs.writeFile(join(f.globalRoot, 'package.json'), JSON.stringify({ dependencies: { [packageName]: `file:${path}` } }));
  const release = { draft: false, immutable: true, prerelease: false, tag_name: 'v1.0.0', assets: [{
    id: 123, name: 'example-1.0.0.tgz', size: archive.length,
    browser_download_url: 'https://github.com/hraness/example/releases/download/v1.0.0/example-1.0.0.tgz',
    digest: 'sha256:' + createHash('sha256').update(archive).digest('hex'),
  }] };
  f.metadata(release);
  const options = { ...f.options, argv: ['update', 'enable'], provider: {
    kind: 'github' as const, repository: 'hraness/example', assetName: 'example-{version}.tgz', authenticated: true,
  } };
  const store = new SafeState(options, runtimeFor(options), f.coordinationDirectory);
  const id = identity(['bun', f.globalRoot, f.packageRoot].join('\0'));
  return { f, path, archive, release, options, store, id };
}

test('explicit enable enrolls only the authenticated current immutable archive and retains opt-out afterward', async t => {
  const e = await enrollmentFixture(); t.after(e.f.cleanup); let artifactChecks = 0;
  const result = await runCliUpdate({ ...e.options, verifyArtifact: async artifact => {
    assert.equal(artifact.path, e.path); assert.equal(artifact.version, '1.0.0'); artifactChecks++;
  } });
  assert.equal(result.result?.status, 'enabled', result.result?.reason); assert.equal(result.result?.supported, true);
  assert.equal(artifactChecks, 1); assert.equal(e.f.installations, 0); assert.equal(e.f.restarts.length, 0); assert.equal(e.f.checks, 0);
  assert(e.f.calls.some(call => call.args.includes('repos/hraness/example/releases/tags/v1.0.0')));
  assert(!e.f.calls.some(call => call.args.includes('repos/hraness/example/releases?per_page=30')));
  assert.deepEqual(await e.store.managedInstall(e.id), { id: e.id, version: '1.0.0', dependencySpec: `file:${e.path}` });
  assert.equal((await e.store.read()).trackInstallation, e.id);
  assert.equal((await runCliUpdate({ ...e.options, argv: ['update', 'disable'] })).result?.status, 'disabled');
  const calls = e.f.calls.filter(call => call.args[0] === 'api').length;
  const command = await runCliUpdate({ ...e.options, argv: ['work'] });
  assert.equal(command.handled, false); assert.equal(command.result?.policy, 'disabled'); await command.release();
  assert.equal(e.f.calls.filter(call => call.args[0] === 'api').length, calls);
});

test('unrecorded local archives never enroll during startup, status, help, check, install, or CI', async t => {
  const e = await enrollmentFixture(); t.after(e.f.cleanup);
  for (const argv of [['work'], ['update', 'status'], ['--help'], ['update', 'check'], ['update']]) {
    const result = await runCliUpdate({ ...e.options, argv }); await result.release();
    assert.notEqual(result.result?.status, 'enabled');
  }
  const ci = await runCliUpdate({ ...e.options, argv: ['work'], runtime: { ...e.f.runtime, env: { CI: 'true' } } }); await ci.release();
  assert.equal(e.f.calls.filter(call => call.args[0] === 'api').length, 0); assert.equal(e.f.checks, 0);
  assert.equal(await e.store.managedInstall(e.id), undefined); assert.equal((await e.store.read()).trackInstallation, undefined);
});

test('archive enrollment rejects mismatched bytes, package identity, callback denial, and changed bytes', async t => {
  for (const scenario of ['digest', 'identity', 'callback', 'changed'] as const) {
    const e = await enrollmentFixture(); t.after(e.f.cleanup);
    if (scenario === 'digest') await fs.writeFile(e.path, 'foreign archive');
    if (scenario === 'identity') {
      const archive = packageArchive('@other/package', '1.0.0'); await fs.writeFile(e.path, archive);
      e.release.assets[0]!.digest = 'sha256:' + createHash('sha256').update(archive).digest('hex'); e.f.metadata(e.release);
    }
    const result = await runCliUpdate({ ...e.options, verifyArtifact: async () => {
      if (scenario === 'callback') throw new Error('Product attestation rejected.');
      if (scenario === 'changed') await fs.writeFile(e.path, 'changed after preflight');
    } });
    assert.equal(result.result?.status, 'error', scenario); assert.equal(e.f.installations, 0);
    assert.equal(await e.store.managedInstall(e.id), undefined); assert.equal((await e.store.read()).trackInstallation, undefined);
  }
});

test('enrollment rejects wrong release identity and mutable or unauthenticated channels', async t => {
  for (const scenario of ['mutable', 'other-version', 'other-repository', 'unauthenticated'] as const) {
    const e = await enrollmentFixture(); t.after(e.f.cleanup);
    if (scenario === 'mutable') e.release.immutable = false;
    if (scenario === 'other-version') e.release.tag_name = 'v1.1.0';
    if (scenario === 'other-repository') e.release.assets[0]!.browser_download_url = 'https://github.com/other/project/releases/download/v1.0.0/example-1.0.0.tgz';
    e.f.metadata(e.release);
    const result = await runCliUpdate({ ...e.options, provider: { ...e.options.provider, authenticated: scenario !== 'unauthenticated' } });
    assert.notEqual(result.result?.status, 'enabled'); assert.equal(e.f.installations, 0);
    assert.equal(await e.store.managedInstall(e.id), undefined);
    if (scenario === 'unauthenticated') assert.equal(e.f.calls.filter(call => call.args[0] === 'api').length, 0);
  }
});

test('pinned, offline, source, directories, Git sources, and symlink archives cannot enroll', async t => {
  for (const scenario of ['pinned', 'offline', 'source', 'directory', 'git', 'symlink'] as const) {
    const e = await enrollmentFixture(); t.after(e.f.cleanup);
    if (scenario === 'directory') { await fs.unlink(e.path); await fs.mkdir(e.path); }
    if (scenario === 'git') await fs.writeFile(join(e.f.globalRoot, 'package.json'), JSON.stringify({ dependencies: { [packageName]: 'github:someone/else#main' } }));
    if (scenario === 'symlink') { const original = join(e.f.root, 'original.tgz'); await fs.rename(e.path, original); await fs.symlink(original, e.path); }
    const result = await runCliUpdate({ ...e.options, pinned: scenario === 'pinned', offline: scenario === 'offline',
      ...(scenario === 'source' ? { entrypoint: join(e.f.root, 'checkout', 'cli.js') } : {}) });
    assert.notEqual(result.result?.status, 'enabled'); assert.equal(e.f.installations, 0);
    assert.equal(await e.store.managedInstall(e.id), undefined);
    if (['pinned', 'offline', 'source', 'git'].includes(scenario)) assert.equal(e.f.calls.filter(call => call.args[0] === 'api').length, 0);
  }
});

test('enrollment cannot change the source binding or clear an interrupted manager operation', async t => {
  const e = await enrollmentFixture(); t.after(e.f.cleanup);
  const changed = await runCliUpdate({ ...e.options, verifyArtifact: async () => {
    await fs.writeFile(join(e.f.globalRoot, 'package.json'), JSON.stringify({ dependencies: { [packageName]: 'file:/different/archive.tgz' } }));
  } });
  assert.equal(changed.result?.status, 'error'); assert.equal(await e.store.managedInstall(e.id), undefined);
  await fs.writeFile(join(e.f.globalRoot, 'package.json'), JSON.stringify({ dependencies: { [packageName]: `file:${e.path}` } }));
  const managerId = identity(`bun\0${e.f.globalRoot}`);
  await e.store.managerMutation(managerId, { schema: 1, installationId: e.id, packageName, ownerPid: 987654321, settled: false });
  const calls = e.f.calls.filter(call => call.args[0] === 'api').length;
  const uncertain = await runCliUpdate(e.options);
  assert.equal(uncertain.result?.status, 'error'); assert(await e.store.managerMutation(managerId));
  assert.equal(e.f.calls.filter(call => call.args[0] === 'api').length, calls);
  assert.equal(await e.store.managedInstall(e.id), undefined);
});

test('an enrollment FIFO is rejected without blocking and replaceable source parents are refused', async t => {
  const e = await enrollmentFixture(); t.after(e.f.cleanup); await fs.unlink(e.path);
  const created = await runProcess('/usr/bin/mkfifo', [e.path], { env: process.env, timeoutMs: 1_000, maxOutputBytes: 1024 });
  assert.equal(created.code, 0);
  const script = `import { verifyExistingGitHubArchive } from ${JSON.stringify(new URL('../src/provider.js', import.meta.url).href)};
    try { await verifyExistingGitHubArchive(${JSON.stringify(e.path)}, {}, {}, {uid:process.getuid()}); process.exitCode=1; }
    catch(error) { if (!error.message.includes('regular file')) throw error; }`;
  const child = await runProcess(process.execPath, ['-e', script], { env: process.env, timeoutMs: 1_000, maxOutputBytes: 2048 });
  assert.equal(child.code, 0, child.stderr);
  await fs.unlink(e.path);
  const source = join(e.f.root, 'archive-source'), archive = join(source, 'private-release.tgz');
  await fs.mkdir(source, { mode: 0o700 }); await fs.writeFile(archive, e.archive, { mode: 0o600 });
  await fs.writeFile(join(e.f.globalRoot, 'package.json'), JSON.stringify({ dependencies: { [packageName]: archive } }));
  await fs.chmod(source, 0o777);
  try {
    const rejected = await runCliUpdate(e.options);
    assert.equal(rejected.result?.status, 'error'); assert.match(rejected.result?.reason ?? '', /ancestor|directory/);
    assert.equal(e.f.installations, 0);
  } finally { await fs.chmod(source, 0o700); }
  assert.equal(await e.store.managedInstall(e.id), undefined);
});

test('documented macOS /var archive spelling enrolls', { skip: process.platform !== 'darwin' }, async t => {
  const e = await enrollmentFixture(); t.after(e.f.cleanup);
  const canonical = await fs.realpath(e.path);
  assert(canonical.startsWith('/private/var/'), `Expected macOS temporary archive under /private/var, received ${canonical}`);
  const lexical = canonical.replace(/^\/private\/var\//, '/var/');
  await fs.writeFile(join(e.f.globalRoot, 'package.json'), JSON.stringify({ dependencies: { [packageName]: lexical } }));
  const enrolled = await runCliUpdate(e.options);
  assert.equal(enrolled.result?.status, 'enabled', enrolled.result?.reason);
  assert.equal((await e.store.managedInstall(e.id))?.dependencySpec, lexical);
  t.diagnostic(`Verified OS-owned alias enrollment: ${lexical}`);
});

test('user-owned directory aliases cannot enroll', async t => {
  const other = await enrollmentFixture(); t.after(other.f.cleanup);
  const alias = join(other.f.root, 'alias'); await fs.symlink(other.f.root, alias);
  await fs.writeFile(join(other.f.globalRoot, 'package.json'), JSON.stringify({ dependencies: { [packageName]: join(alias, 'private-release.tgz') } }));
  const rejected = await runCliUpdate(other.options);
  assert.equal(rejected.result?.status, 'error'); assert.equal(await other.store.managedInstall(other.id), undefined);
});
