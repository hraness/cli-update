import * as fs from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { gunzipSync, gzipSync } from 'node:zlib';
import type { CliUpdateOptions, ProcessOptions, ProcessResult, UpdateRuntime } from '../src/types.js';

export const packageName = '@hraness/example-cli';
export const integrity = 'sha512-' + createHash('sha512').update(packageArchive()).digest('base64');
export const registryMetadata = (version = '1.1.0') => ({ name: packageName, version, dist: {
  tarball: `https://registry.npmjs.org/${packageName}/-/example-cli-${version}.tgz`,
  integrity: 'sha512-' + createHash('sha512').update(packageArchive(packageName, version)).digest('base64'),
} });

export function packageArchive(name = packageName, version = '1.1.0', binPrefix = 'example'): Buffer {
  const entries = [
    ['package/package.json', JSON.stringify({ name, version, bin: { [binPrefix]: 'bin/cli.js', [`${binPrefix}-builder`]: 'bin/builder.js' } })],
    ['package/bin/cli.js', `#!/usr/bin/env node\nprocess.stdout.write(${JSON.stringify(version)});\n`],
    ['package/bin/builder.js', `#!/usr/bin/env node\nprocess.stdout.write(${JSON.stringify(version)});\n`],
  ];
  const blocks: Buffer[] = [];
  for (const [path, text] of entries) {
    const contents = Buffer.from(text!), header = Buffer.alloc(512);
    header.write(path!, 0);
    header.write('0000755\0', 100); header.write('0000000\0', 108); header.write('0000000\0', 116);
    header.write(contents.length.toString(8).padStart(11, '0') + '\0', 124);
    header.write('00000000000\0', 136); header.fill(32, 148, 156); header[156] = 48;
    header.write('ustar\0', 257); header.write('00', 263);
    const checksum = header.reduce((sum, byte) => sum + byte, 0);
    header.write(checksum.toString(8).padStart(6, '0') + '\0 ', 148);
    blocks.push(header, contents, Buffer.alloc((512 - contents.length % 512) % 512));
  }
  return gzipSync(Buffer.concat([...blocks, Buffer.alloc(1024)]));
}

export async function fixture(settings: { manager?: 'bun' | 'npm'; spec?: string; version?: string } = {}) {
  const root = await fs.mkdtemp(join(await fs.realpath(tmpdir()), 'hraness-update-test-'));
  const manager = settings.manager ?? 'bun', version = settings.version ?? '1.0.0';
  const prefix = join(root, 'prefix'), globalRoot = manager === 'bun' ? join(prefix, 'global') : prefix;
  const modules = manager === 'bun' ? join(globalRoot, 'node_modules') : join(prefix, 'lib/node_modules');
  const packageRoot = join(modules, packageName), entrypoint = join(packageRoot, 'bin/cli.js'), binDirectory = join(prefix, 'bin');
  await fs.mkdir(dirname(entrypoint), { recursive: true }); await fs.mkdir(binDirectory, { recursive: true });
  await fs.writeFile(entrypoint, '// fake product entrypoint\n');
  const manifest = { name: packageName, version, bin: { example: 'bin/cli.js' } };
  await fs.writeFile(join(packageRoot, 'package.json'), JSON.stringify(manifest));
  const globalManifest = { dependencies: { [packageName]: settings.spec ?? '^1.0.0' } };
  if (manager === 'bun') await fs.writeFile(join(globalRoot, 'package.json'), JSON.stringify(globalManifest));
  await fs.symlink(entrypoint, join(binDirectory, 'example'));
  const managers = { bun: join(root, 'fake-bun'), npm: join(root, 'fake-npm'), gh: join(root, 'fake-gh') };
  for (const path of Object.values(managers)) await fs.writeFile(path, '#!/bin/sh\nexit 99\n', { mode: 0o700 });
  const calls: Array<{ executable: string; args: readonly string[]; options: ProcessOptions }> = [];
  const requests: Array<{ url: string; init: RequestInit | undefined }> = [];
  const restarts: Array<{ executable: string; args: readonly string[]; env: NodeJS.ProcessEnv }> = [];
  let stdout = '', stderr = '', checks = 0, installations = 0;
  let metadata: unknown = registryMetadata(), installFailure: 'none' | 'exit' | 'throw' | 'identity' = 'none';
  let fetchOverride: typeof globalThis.fetch | undefined;
  let archiveFetchOverride: typeof globalThis.fetch | undefined;
  let runOverride: UpdateRuntime['run'] | undefined;
  let archive = packageArchive();
  let now = 1_800_000_000_000;
  const runtime: Partial<UpdateRuntime> = {
    env: { PATH: '', HOME: root }, homeDirectory: root, temporaryDirectory: root,
    execPath: process.execPath, execArgv: [], now: () => now,
    writeStdout: text => { stdout += text; }, writeStderr: text => { stderr += text; }, onExit: () => () => {},
    async fetch(input, init) {
      const url = String(input); requests.push({ url, init });
      if (url.endsWith('.tgz')) return archiveFetchOverride ? archiveFetchOverride(input, init) : new Response(new Uint8Array(archive));
      checks++; return fetchOverride ? fetchOverride(input, init) : new Response(JSON.stringify(metadata), { headers: { 'content-type': 'application/json' } });
    },
    async run(executable, args, options): Promise<ProcessResult> {
      calls.push({ executable, args, options });
      if (runOverride) return runOverride(executable, args, options);
      const result = (stdout: string, code = 0) => ({ code, stdout, stderr: '' });
      if (executable === managers.bun && args.join(' ') === 'pm -g ls') return manager === 'bun' ? result(`${globalRoot} node_modules (1)\n`) : result('', 1);
      if (executable === managers.bun && args.join(' ') === 'pm bin -g') return result(binDirectory + '\n');
      if (executable === managers.npm && args.join(' ') === 'root --global') return manager === 'npm' ? result(modules + '\n') : result('', 1);
      if (executable === managers.npm && args.join(' ') === 'prefix --global') return result(prefix + '\n');
      if (executable === managers.gh && args[0] === 'api') return result(JSON.stringify(metadata));
      if (args[0] === 'add' || args[0] === 'install') {
        installations++;
        await options.onSpawn?.(987654321);
        if (installFailure === 'throw') throw new Error('Manager timed out.');
        if (installFailure === 'exit') return result('', 1);
        const target = args.at(-1)!;
        let next = target.startsWith(packageName + '@') && !target.startsWith(packageName + '@file:') ? target.slice(packageName.length + 1) : '1.1.0';
        if (target.startsWith(packageName + '@file:')) {
          const tar = gunzipSync(await fs.readFile(target.slice((packageName + '@file:').length)));
          const size = Number.parseInt(tar.subarray(124, 136).toString('ascii').replace(/\0.*$/s, ''), 8);
          next = (JSON.parse(tar.subarray(512, 512 + size).toString('utf8')) as { version: string }).version;
        }
        await fs.writeFile(join(packageRoot, 'package.json'), JSON.stringify({ ...manifest, version: installFailure === 'identity' ? '0.0.0' : next }));
        if (manager === 'bun') {
          globalManifest.dependencies[packageName] = target.startsWith(packageName + '@file:') ? target.slice(packageName.length + 1) : target.startsWith(packageName + '@') ? next : target;
          await fs.writeFile(join(globalRoot, 'package.json'), JSON.stringify(globalManifest));
        }
        return result('installer chatter');
      }
      throw new Error(`Unexpected fake command ${executable} ${args.join(' ')}`);
    },
    async download(_exe, _args, path) { await fs.writeFile(path, archive, { mode: 0o600, flag: 'wx' }); return { code: 0, stdout: '', stderr: '' }; },
    async reenter(executable, args, env) { restarts.push({ executable, args, env }); return 42; },
  };
  const options: CliUpdateOptions = { packageName, version, binName: 'example', entrypoint, argv: ['work'], managers, runtime,
    stateDirectory: join(root, 'state'), provider: { kind: 'npm' } };
  return {
    root, prefix, globalRoot, packageRoot, entrypoint, binDirectory, coordinationDirectory: join(dirname(modules), '.hraness-cli-update'), options, runtime, calls, requests, restarts,
    get stdout() { return stdout; }, get stderr() { return stderr; }, get checks() { return checks; }, get installations() { return installations; },
    metadata(value: unknown) { metadata = value; }, fail(value: typeof installFailure) { installFailure = value; },
    fetch(value: typeof globalThis.fetch) { fetchOverride = value; }, run(value: UpdateRuntime['run']) { runOverride = value; },
    archiveFetch(value: typeof globalThis.fetch) { archiveFetchOverride = value; },
    archive(value: Buffer) { archive = value; }, now(value: number) { now = value; },
    resetOutput() { stdout = ''; stderr = ''; }, cleanup: () => fs.rm(root, { recursive: true, force: true }),
  };
}
