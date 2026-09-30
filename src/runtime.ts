import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import type { CliUpdateOptions, ProcessOptions, ProcessResult, UpdateRuntime } from './types.js';

/** A spawn error proves the operating system never created the child process. */
export class ProcessLaunchError extends Error {}

export function runtimeFor(options: CliUpdateOptions): UpdateRuntime {
  return {
    env: { ...process.env }, homeDirectory: homedir(), temporaryDirectory: tmpdir(),
    execPath: process.execPath, execArgv: [...process.execArgv], pid: process.pid,
    uid: process.getuid?.(), now: Date.now, randomId: randomUUID,
    isProcessAlive(pid) {
      try { process.kill(pid, 0); return true; }
      catch (error) { return (error as NodeJS.ErrnoException).code !== 'ESRCH'; }
    },
    fetch: globalThis.fetch.bind(globalThis), run: runProcess, download: downloadProcess,
    reenter(executable, args, env) {
      return new Promise((resolve, reject) => {
        const child = spawn(executable, [...args], { env, stdio: 'inherit', shell: false });
        const interrupt = () => { child.kill('SIGINT'); }, terminate = () => { child.kill('SIGTERM'); };
        process.on('SIGINT', interrupt); process.on('SIGTERM', terminate);
        const cleanup = () => { process.off('SIGINT', interrupt); process.off('SIGTERM', terminate); };
        child.once('error', error => { cleanup(); reject(error); });
        child.once('exit', (code, signal) => {
          cleanup(); resolve(code ?? (signal === 'SIGINT' ? 130 : signal === 'SIGTERM' ? 143 : 1));
        });
      });
    },
    writeStdout: text => { process.stdout.write(text); },
    writeStderr: text => { process.stderr.write(text); },
    onExit(cleanup) { process.once('exit', cleanup); return () => { process.off('exit', cleanup); }; },
    ...options.runtime,
  };
}

export function downloadProcess(executable: string, args: readonly string[], path: string, options: ProcessOptions, maxBytes: number): Promise<ProcessResult> {
  return new Promise((resolve, reject) => {
    const output = createWriteStream(path, { flags: 'wx', mode: 0o600 });
    const child = spawn(executable, [...args], { env: options.env, stdio: ['ignore', 'pipe', 'pipe'], shell: false });
    let bytes = 0, stderr = '', failure: Error | undefined, killTimer: ReturnType<typeof setTimeout> | undefined;
    const fail = (error: Error) => {
      if (failure) return;
      failure = error; child.kill('SIGTERM'); output.destroy();
      killTimer = setTimeout(() => child.kill('SIGKILL'), 1_000); killTimer.unref();
    };
    const timer = setTimeout(() => fail(new Error('Release archive download timed out.')), options.timeoutMs); timer.unref();
    output.on('error', fail);
    child.stdout.on('data', (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > maxBytes) { fail(new Error('Release archive exceeds its size limit.')); return; }
      if (!failure && !output.write(chunk)) child.stdout.pause();
    });
    output.on('drain', () => child.stdout.resume());
    child.stderr.on('data', (chunk: Buffer) => {
      if (Buffer.byteLength(stderr) + chunk.length > options.maxOutputBytes) fail(new Error('Release downloader output exceeded its limit.'));
      else stderr += chunk.toString('utf8');
    });
    child.on('error', fail);
    child.on('close', code => {
      clearTimeout(timer); if (killTimer) clearTimeout(killTimer);
      if (failure) { reject(failure); return; }
      output.end(() => resolve({ code: code ?? 1, stdout: '', stderr }));
    });
  });
}

/** Captures a bounded result; installer output is emitted only on stderr. */
export function runProcess(executable: string, args: readonly string[], options: ProcessOptions): Promise<ProcessResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, [...args], { env: options.env, cwd: options.cwd, stdio: ['ignore', 'pipe', 'pipe'], shell: false, detached: process.platform !== 'win32' });
    let stdout = '', stderr = '', bytes = 0, failure: Error | undefined;
    let spawnRecord: Promise<void> = Promise.resolve();
    const signalGroup = (signal: NodeJS.Signals) => {
      if (child.pid && process.platform !== 'win32') { try { process.kill(-child.pid, signal); } catch { /* group already exited */ } }
      else child.kill(signal);
    };
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    const stop = (error: Error) => {
      if (failure) return;
      failure = error; signalGroup('SIGTERM');
      killTimer = setTimeout(() => signalGroup('SIGKILL'), 1_000);
      killTimer.unref();
    };
    const timer = setTimeout(() => stop(new Error('Updater subprocess timed out.')), options.timeoutMs);
    timer.unref();
    const receive = (kind: 'stdout' | 'stderr', chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > options.maxOutputBytes) { stop(new Error('Updater subprocess output exceeded its limit.')); return; }
      const text = chunk.toString('utf8');
      if (kind === 'stdout') stdout += text; else stderr += text;
      if (options.diagnostics) process.stderr.write(text);
    };
    child.stdout.on('data', chunk => receive('stdout', chunk));
    child.stderr.on('data', chunk => receive('stderr', chunk));
    child.once('spawn', () => { if (child.pid) spawnRecord = Promise.resolve(options.onSpawn?.(child.pid)).catch(error => { stop(error as Error); }); });
    child.once('error', error => { failure = child.pid ? error : new ProcessLaunchError('The package-manager process could not be launched.', { cause: error }); });
    child.once('close', async code => {
      clearTimeout(timer); if (killTimer) clearTimeout(killTimer);
      if (failure) signalGroup('SIGKILL');
      try { await spawnRecord; } catch (error) { failure = error as Error; }
      if (failure) reject(failure); else resolve({ code: code ?? 1, stdout, stderr });
    });
  });
}
