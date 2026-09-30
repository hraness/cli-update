import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const root = resolve(import.meta.dirname, '..');
const temporary = await mkdtemp(join(tmpdir(), 'hraness-cli-update-package-'));
try {
  const pack = execFileSync(process.env.BUN_BIN ?? 'bun', ['pm', 'pack', '--destination', temporary], {
    cwd: root,
    encoding: 'utf8',
    timeout: 30_000,
    maxBuffer: 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const archives = (await readdir(temporary)).filter(name => name.endsWith('.tgz'));
  assert.equal(archives.length, 1, `Expected one package archive: ${pack}`);
  const archive = join(temporary, archives[0]);
  const entries = execFileSync('tar', ['-tzf', archive], { encoding: 'utf8', maxBuffer: 1024 * 1024 }).trim().split('\n');
  assert(entries.every(name => name.startsWith('package/') && !name.includes('/../')));
  assert(entries.includes('package/dist/src/index.js'));
  assert(entries.includes('package/dist/src/index.d.ts'));
  assert(entries.every(name => !/^package\/(?:test|node_modules|target|\.git)(?:\/|$)/u.test(name)));
  execFileSync('tar', ['-xzf', archive, '-C', temporary], { timeout: 30_000 });
  const manifest = JSON.parse(await readFile(join(temporary, 'package', 'package.json'), 'utf8'));
  const source = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  assert.equal(manifest.name, '@hraness/cli-update');
  assert.equal(manifest.version, source.version);
  assert.deepEqual(manifest.dependencies ?? {}, {});
  const sandbox = join(temporary, 'home');
  await mkdir(sandbox, { mode: 0o700 });
  const moduleUrl = pathToFileURL(join(temporary, 'package', 'dist', 'src', 'index.js')).href;
  const program = `globalThis.fetch = () => { throw new Error('Network access during package import'); }; const api = await import(${JSON.stringify(moduleUrl)}); if (typeof api.runCliUpdate !== 'function') throw new Error('Missing runCliUpdate export'); console.log('import-ok');`;
  const result = execFileSync(process.execPath, ['--input-type=module', '--eval', program], {
    cwd: sandbox,
    env: { ...process.env, HOME: sandbox, USERPROFILE: sandbox, XDG_CACHE_HOME: join(sandbox, 'cache'), XDG_CONFIG_HOME: join(sandbox, 'config') },
    encoding: 'utf8',
    timeout: 10_000,
    maxBuffer: 1024 * 1024,
  });
  assert.equal(result.trim(), 'import-ok');
  assert.deepEqual(await readdir(sandbox), [], 'Import must not write updater state');
  console.log(`Package ${manifest.name}@${manifest.version}: standalone import and archive contents passed.`);
} finally {
  await rm(temporary, { recursive: true, force: true });
}
