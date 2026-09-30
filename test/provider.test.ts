import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { gunzipSync, gzipSync } from 'node:zlib';
import { runCliUpdate } from '../src/index.js';
import { latestRelease, verifyPackageArchive } from '../src/provider.js';
import { runtimeFor, runProcess } from '../src/runtime.js';
import { compareVersions, parseVersion } from '../src/semver.js';
import { fixture, packageArchive, packageName, registryMetadata } from './helpers.js';

test('semantic versions compare numeric, prerelease, build, and large components without coercion', () => {
  const ordered = ['1.0.0-alpha', '1.0.0-alpha.1', '1.0.0-alpha.beta', '1.0.0-beta', '1.0.0-beta.2', '1.0.0-beta.11', '1.0.0-rc.1', '1.0.0', '1.0.10', '1.1.0', '2.0.0', '999999999999999999999.0.0'];
  for (let index = 1; index < ordered.length; index++) assert.equal(compareVersions(ordered[index - 1]!, ordered[index]!), -1);
  assert.equal(compareVersions('1.0.0+build.3', '1.0.0+other.4'), 0);
  for (const value of ['v1.0.0', '1.0', '01.0.0', '1.0.0-01', '1.0.0; echo', '1.0.0-', '1.0.0\n']) assert.equal(parseVersion(value), undefined);
});

test('registry metadata validates package, version, archive host and integrity', async t => {
  const f = await fixture(); t.after(f.cleanup);
  const values = [
    { ...registryMetadata(), name: '@someone/else' }, { ...registryMetadata(), version: 'main' },
    { ...registryMetadata(), dist: { ...registryMetadata().dist, tarball: 'https://evil.test/package.tgz' } },
    { ...registryMetadata(), dist: { ...registryMetadata().dist, tarball: 'https://registry.npmjs.org/@hraness/other/-/other-1.1.0.tgz' } },
    { ...registryMetadata(), dist: { ...registryMetadata().dist, integrity: 'sha512-madeup' } },
    registryMetadata('2.0.0-beta.1'),
  ];
  for (const value of values) { f.metadata(value); await assert.rejects(latestRelease(f.options, runtimeFor(f.options))); }
  assert.equal(f.installations, 0);
});

test('npm updates install canonical verified archive bytes while preserving scoped registry and lifecycle config', async t => {
  for (const algorithm of ['sha512', 'sha256'] as const) {
    const f = await fixture(); t.after(f.cleanup);
    const archive = packageArchive(), metadata = registryMetadata();
    metadata.dist.integrity = `${algorithm}-${createHash(algorithm).update(archive).digest('base64')}`;
    f.metadata(metadata); const config = join(f.root, '.npmrc');
    const configText = '@hraness:registry=https://enterprise.example/\nignore-scripts=true\n'; await fs.writeFile(config, configText);
    const env = { ...f.runtime.env, NPM_CONFIG_USERCONFIG: config, NPM_CONFIG_REGISTRY: 'https://enterprise.example/' };
    let verified = 0;
    const result = await runCliUpdate({ ...f.options, argv: ['update'], runtime: { ...f.runtime, env }, verifyArtifact: async artifact => {
      assert.equal(f.installations, 0); assert.equal(artifact.version, '1.1.0');
      assert.equal(artifact.sha256, createHash('sha256').update(archive).digest('hex')); verified++;
    } });
    assert.equal(result.result?.status, 'updated', result.result?.reason); assert.equal(verified, 1);
    const request = f.requests.find(request => request.url.endsWith('.tgz'));
    assert.equal(request?.url, metadata.dist.tarball); assert.equal(request?.init?.redirect, 'error');
    const manager = f.calls.find(call => call.args[0] === 'add')!;
    assert.equal(manager.options.env.NPM_CONFIG_USERCONFIG, config); assert.equal(manager.options.env.NPM_CONFIG_REGISTRY, env.NPM_CONFIG_REGISTRY);
    assert(!manager.args.some(arg => /registry|userconfig|trust|ignore-scripts/.test(arg)));
    assert(manager.args.at(-1)?.startsWith(`${packageName}@file:`));
    assert.deepEqual(await fs.readFile(manager.args.at(-1)!.slice((packageName + '@file:').length)), archive);
    assert.equal(await fs.readFile(config, 'utf8'), configText);
  }
});

test('npm SRI, package name/version, response authority, size, and verification failures precede manager writes', async t => {
  for (const failure of ['sri', 'name', 'version', 'response-url', 'redirect', 'oversize', 'callback', 'changed'] as const) {
    const f = await fixture(); t.after(f.cleanup); const metadata = registryMetadata();
    const bytes = failure === 'name' ? packageArchive('@other/name') : failure === 'version' ? packageArchive(packageName, '9.0.0') : packageArchive();
    if (failure === 'sri') metadata.dist.integrity = 'sha512-' + Buffer.alloc(64, 7).toString('base64');
    else metadata.dist.integrity = 'sha512-' + createHash('sha512').update(bytes).digest('base64');
    f.metadata(metadata); f.archive(bytes);
    if (failure === 'response-url') f.archiveFetch(async () => {
      const response = new Response(new Uint8Array(bytes)); Object.defineProperty(response, 'url', { value: 'https://enterprise.example/archive.tgz' }); return response;
    });
    if (failure === 'redirect') f.archiveFetch(async () => new Response(null, { status: 302, headers: { location: 'https://enterprise.example/archive.tgz' } }));
    if (failure === 'oversize') f.archiveFetch(async () => new Response(new Uint8Array(bytes), { headers: { 'content-length': '536870913' } }));
    const result = await runCliUpdate({ ...f.options, argv: ['update'], verifyArtifact: async artifact => {
      if (failure === 'callback') throw new Error('Product verification failed.');
      if (failure === 'changed') await fs.writeFile(artifact.path, 'changed after verification');
    } });
    assert.equal(result.result?.status, 'error', failure); assert.equal(f.installations, 0, failure);
    assert.equal(result.result?.codeMayHaveChanged, undefined, failure);
    assert.equal(JSON.parse(await fs.readFile(join(f.packageRoot, 'package.json'), 'utf8')).version, '1.0.0');
  }
});

test('an invalid npm archive keeps an unchanged ordinary command usable with a lease', async t => {
  const f = await fixture(); t.after(f.cleanup); f.archive(Buffer.from('different bytes'));
  const running = await runCliUpdate(f.options);
  assert.equal(running.handled, false); assert.equal(running.result?.status, 'skipped');
  assert.equal(f.installations, 0); assert.equal(f.restarts.length, 0);
  try { assert.equal((await runCliUpdate({ ...f.options, argv: ['update'] })).result?.status, 'busy'); }
  finally { await running.release(); }
});

test('npm archive download deadline aborts a stalled body without leaving staged files', async t => {
  const f = await fixture(); t.after(f.cleanup); const metadata = registryMetadata();
  const script = `import assert from 'node:assert/strict'; import * as fs from 'node:fs/promises';
    import { prepareNpmArchive } from ${JSON.stringify(new URL('../src/provider.js', import.meta.url).href)};
    const original = globalThis.setTimeout; globalThis.setTimeout = (fn, ms, ...args) => original(fn, ms === 120000 ? 25 : ms, ...args);
    let aborted = false;
    const runtime = {temporaryDirectory:${JSON.stringify(f.root)}, fetch:async (_url, init) => {
      init.signal.addEventListener('abort', () => {aborted = true;});
      return new Response(new ReadableStream({start() {}}));
    }};
    const release = {provider:{kind:'npm'},packageName:${JSON.stringify(packageName)},version:'1.1.0',archiveUrl:${JSON.stringify(metadata.dist.tarball)},integrity:${JSON.stringify(metadata.dist.integrity)}};
    await assert.rejects(prepareNpmArchive(release, {packageName:${JSON.stringify(packageName)}}, runtime), /timed out/);
    assert(aborted); assert(!(await fs.readdir(${JSON.stringify(f.root)})).some(name => name.startsWith('hraness-cli-update-')));`;
  const child = await runProcess(process.execPath, ['-e', script], { env: process.env, timeoutMs: 3_000, maxOutputBytes: 2048 });
  assert.equal(child.code, 0, child.stderr);
});

test('a fixed prerelease npm tag can advance a prerelease-only product', async t => {
  const f = await fixture({ version: '1.0.0-beta.1', spec: 'beta' }); t.after(f.cleanup);
  f.metadata(registryMetadata('1.0.0-beta.12'));
  const release = await latestRelease({ ...f.options, provider: { kind: 'npm', tag: 'beta' } }, runtimeFor(f.options));
  assert.equal(release.version, '1.0.0-beta.12');
});

test('oversized, redirected, and corrupt metadata fail closed without installation', async t => {
  const f = await fixture(); t.after(f.cleanup);
  for (const response of [
    new Response('{}', { headers: { 'content-length': '9000000' } }),
    new Response('x'.repeat(2_097_153)), new Response('{broken'), new Response('{}', { status: 302 }),
  ]) {
    f.fetch(async () => response);
    const result = await runCliUpdate({ ...f.options, argv: ['update', 'check', '--json'] });
    assert.equal(result.result?.status, 'error'); assert.equal(f.installations, 0);
  }
});

test('metadata timeout aborts and ordinary command remains usable', async t => {
  const f = await fixture(); t.after(f.cleanup);
  let aborted = false;
  f.fetch((_input, init) => new Promise((_resolve, reject) => {
    init?.signal?.addEventListener('abort', () => { aborted = true; reject(new Error('aborted')); });
  }));
  const start = Date.now();
  const result = await runCliUpdate(f.options);
  assert.equal(result.handled, false); assert.equal(aborted, true); assert(Date.now() - start < 7000);
  assert.equal(f.installations, 0); await result.release();
});

test('subprocess execution bounds timeout and output', async () => {
  await assert.rejects(runProcess(process.execPath, ['-e', 'setTimeout(()=>{},10000)'], { env: {}, timeoutMs: 50, maxOutputBytes: 1024 }), /timed out/);
  await assert.rejects(runProcess(process.execPath, ['-e', 'process.stdout.write("x".repeat(8192))'], { env: {}, timeoutMs: 1000, maxOutputBytes: 1024 }), /limit/);
});

function githubRelease(archive: Buffer, version = '1.1.0') {
  return { draft: false, immutable: true, prerelease: version.includes('-'), tag_name: `v${version}`, assets: [{
    id: 123, name: `example-${version}.tgz`, size: archive.length,
    browser_download_url: `https://github.com/hraness/example/releases/download/v${version}/example-${version}.tgz`,
    digest: 'sha256:' + createHash('sha256').update(archive).digest('hex'),
  }] };
}

test('canonical private GitHub installs verify authenticated asset digest and package identity before manager launch', async t => {
  const f = await fixture({ spec: 'https://github.com/hraness/example/releases/download/v1.0.0/example-1.0.0.tgz' }); t.after(f.cleanup);
  const archive = packageArchive(); f.archive(archive); f.metadata([githubRelease(archive)]);
  let strongerVerification = 0;
  const options = { ...f.options, provider: { kind: 'github' as const, repository: 'hraness/example', assetName: 'example-{version}.tgz', authenticated: true },
    verifyArtifact: async () => { strongerVerification++; } };
  const result = await runCliUpdate({ ...options, argv: ['update', '--json'] });
  assert.equal(result.result?.status, 'updated', result.result?.reason); assert.equal(f.checks, 0); assert.equal(f.installations, 1); assert.equal(strongerVerification, 1);
  assert(f.calls.some(call => call.args[0] === 'api' && call.args.includes('repos/hraness/example/releases?per_page=30')));
  const call = f.calls.find(call => call.args[0] === 'add')!; assert.match(call.args.at(-1)!, /\.hraness-cli-update\/artifacts\/[a-f0-9]{32}\/[a-f0-9]{64}\.tgz$/);
  assert.equal((await fs.stat(call.args.at(-1)!.slice((packageName + '@file:').length))).isFile(), true);
  const later = await runCliUpdate({ ...options, version: '1.1.0', argv: ['update', 'status', '--json'] });
  assert.equal(later.result?.status, 'status');
});

test('GitHub releases require matching tag, channel, immutable asset identity, and digest', async t => {
  const f = await fixture(); t.after(f.cleanup); const archive = packageArchive();
  const options = { ...f.options, provider: { kind: 'github' as const, repository: 'hraness/example', assetName: 'example-{version}.tgz' } };
  const valid = githubRelease(archive);
  for (const value of [
    { ...valid, draft: true }, { ...valid, immutable: false }, { ...valid, tag_name: 'main' }, githubRelease(archive, '2.0.0-beta.1'),
    { ...valid, assets: [{ ...valid.assets[0]!, digest: undefined }] },
    { ...valid, assets: [{ ...valid.assets[0]!, browser_download_url: 'https://github.com/elsewhere/pkg/releases/download/v1.1.0/example-1.1.0.tgz' }] },
  ]) { f.metadata([value]); await assert.rejects(latestRelease(options, runtimeFor(options))); }
});

test('GitHub checksum and archive identity failures occur before any code mutation', async t => {
  const f = await fixture({ spec: 'https://github.com/hraness/example/releases/download/v1.0.0/example-1.0.0.tgz' }); t.after(f.cleanup);
  const archive = packageArchive(); const metadata = githubRelease(archive);
  f.metadata([metadata]); f.archive(packageArchive('@different/pkg'));
  const options = { ...f.options, argv: ['update'], provider: { kind: 'github' as const, repository: 'hraness/example', assetName: 'example-{version}.tgz' } };
  let result = await runCliUpdate(options); assert.equal(result.result?.status, 'error'); assert.equal(f.installations, 0);
  const wrongIdentity = packageArchive('@different/pkg'); f.metadata([githubRelease(wrongIdentity)]); f.archive(wrongIdentity);
  result = await runCliUpdate(options); assert.match(result.result?.reason ?? '', /identity/); assert.equal(f.installations, 0);
});

test('automatic archive verification failure keeps an unchanged installed command usable', async t => {
  const f = await fixture({ spec: 'https://github.com/hraness/example/releases/download/v1.0.0/example-1.0.0.tgz' }); t.after(f.cleanup);
  f.metadata([githubRelease(packageArchive())]); f.archive(Buffer.from('bad archive'));
  const result = await runCliUpdate({ ...f.options, provider: { kind: 'github', repository: 'hraness/example', assetName: 'example-{version}.tgz' } });
  assert.equal(result.handled, false); assert.equal(f.installations, 0); assert.equal(f.restarts.length, 0);
  await result.release();
});

test('an interrupted archive install repairs its new file binding before a final receipt exists', async t => {
  const f = await fixture({ spec: 'https://github.com/hraness/example/releases/download/v1.0.0/example-1.0.0.tgz' }); t.after(f.cleanup);
  f.metadata([githubRelease(packageArchive())]);
  const original = f.runtime.run!;
  const options = { ...f.options, argv: ['update'], provider: { kind: 'github' as const, repository: 'hraness/example', assetName: 'example-{version}.tgz' } };
  const interrupted = await runCliUpdate({ ...options, runtime: { ...f.runtime, run: async (...args: Parameters<typeof original>) => {
    const result = await original(...args);
    if (args[1][0] === 'add') throw new Error('Interrupted after manager replacement, before receipt publication.');
    return result;
  } } });
  assert.equal(interrupted.result?.codeMayHaveChanged, true);
  const repaired = await runCliUpdate({ ...options, version: '1.1.0' });
  assert.equal(repaired.result?.status, 'updated', repaired.result?.reason); assert.equal(f.installations, 2);
});

test('archive reader rejects truncated and mismatched packages', async t => {
  const f = await fixture(); t.after(f.cleanup); const path = join(f.root, 'archive.tgz');
  await fs.writeFile(path, packageArchive()); await verifyPackageArchive(path, packageName, '1.1.0');
  await assert.rejects(verifyPackageArchive(path, packageName, '9.9.9'));
  await fs.writeFile(path, packageArchive().subarray(0, 40)); await assert.rejects(verifyPackageArchive(path, packageName, '1.1.0'));
});

test('PAX effective-name override cannot replace an already verified package manifest', async t => {
  const f = await fixture(); t.after(f.cleanup);
  const tarEntry = (path: string, text: string, type: string) => {
    const contents = Buffer.from(text), header = Buffer.alloc(512); header.write(path, 0);
    header.write('0000644\0', 100); header.write('0000000\0', 108); header.write('0000000\0', 116);
    header.write(contents.length.toString(8).padStart(11, '0') + '\0', 124); header.write('00000000000\0', 136);
    header.fill(32, 148, 156); header.write(type, 156); header.write('ustar\0', 257); header.write('00', 263);
    header.write(header.reduce((sum, byte) => sum + byte, 0).toString(8).padStart(6, '0') + '\0 ', 148);
    return Buffer.concat([header, contents, Buffer.alloc((512 - contents.length % 512) % 512)]);
  };
  const record = 'path=package/package.json\n'; let pax = `0 ${record}`;
  for (let i = 0; i < 3; i++) pax = `${Buffer.byteLength(pax)} ${record}`;
  const normal = gunzipSync(packageArchive()).subarray(0, -1024);
  const malicious = gzipSync(Buffer.concat([normal, tarEntry('PaxHeader', pax, 'x'),
    tarEntry('package/unrelated.json', JSON.stringify({ name: '@wrong/package', version: '1.1.0' }), '0'), Buffer.alloc(1024)]));
  const path = join(f.root, 'pax-identity-override.tgz'); await fs.writeFile(path, malicious);
  await assert.rejects(verifyPackageArchive(path, packageName, '1.1.0'), /duplicate/);
  for (const alias of ['package/./package.json', 'package//package.json']) {
    await fs.writeFile(path, gzipSync(Buffer.concat([normal, tarEntry(alias, JSON.stringify({ name: '@wrong/package', version: '1.1.0' }), '0'), Buffer.alloc(1024)])));
    await assert.rejects(verifyPackageArchive(path, packageName, '1.1.0'), /duplicate/);
  }
});
