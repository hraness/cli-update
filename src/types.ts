export type UpdatePolicy = 'auto' | 'notify' | 'disabled';

export interface NpmProvider {
  kind: 'npm';
  /** Fixed in product code; normally latest. A prerelease tag is never inferred. */
  tag?: string;
}

export interface GitHubProvider {
  kind: 'github';
  repository: string;
  tagPrefix?: string;
  /** Exact name or a template containing {version}. Wildcards are not allowed. */
  assetName: string;
  authenticated?: boolean;
  channel?: 'stable' | 'prerelease';
}

export type ReleaseProvider = NpmProvider | GitHubProvider;

export interface ProcessResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface ProcessOptions {
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
  maxOutputBytes: number;
  cwd?: string;
  /** stdout from an installer is always redirected to stderr. */
  diagnostics?: boolean;
  /** Called for the owned detached process group before awaiting its result. */
  onSpawn?: (pid: number) => void | Promise<void>;
}

/** Injectable effects; path overrides keep tests out of real user installations. */
export interface UpdateRuntime {
  env: NodeJS.ProcessEnv;
  homeDirectory: string;
  temporaryDirectory: string;
  execPath: string;
  execArgv: string[];
  pid: number;
  uid: number | undefined;
  now(): number;
  randomId(): string;
  isProcessAlive(pid: number): boolean;
  fetch: typeof globalThis.fetch;
  run(executable: string, args: readonly string[], options: ProcessOptions): Promise<ProcessResult>;
  download(executable: string, args: readonly string[], path: string, options: ProcessOptions, maxBytes: number): Promise<ProcessResult>;
  reenter(executable: string, args: readonly string[], env: NodeJS.ProcessEnv): Promise<number>;
  writeStdout(text: string): void;
  writeStderr(text: string): void;
  /** Returns a disposer. The default exit handler removes only this process's lease. */
  onExit(cleanup: () => void): () => void;
}

export interface CliUpdateOptions {
  packageName: string;
  version: string;
  binName: string;
  /** The product's actual bin module, not this library's module or a PATH lookup. */
  entrypoint: string;
  argv?: readonly string[];
  provider?: ReleaseProvider;
  offline?: boolean;
  nested?: boolean;
  pinned?: boolean;
  /** Preserve a product installer's restrictive lifecycle policy; never enables trust. */
  ignoreScripts?: boolean;
  /** Additional product-specific deployment/version bindings. */
  suppressAutomatic?: boolean;
  /** The product parser has identified whether there is product work; false overrides help/version inference. */
  effectFree?: boolean;
  stateDirectory?: string;
  managers?: { bun?: string; npm?: string; gh?: string };
  runtime?: Partial<UpdateRuntime>;
  /** Optional additional attestation gate; digest and package identity are always checked first. */
  verifyArtifact?: (artifact: { path: string; version: string; sha256: string }) => Promise<void>;
}

export interface Installation {
  id: string;
  manager: 'bun' | 'npm';
  managerPath: string;
  globalRoot: string;
  packageRoot: string;
  entrypoint: string;
  binPath: string;
  version: string;
  dependencySpec?: string;
  pinned: boolean;
}

export interface Release {
  version: string;
  packageName: string;
  provider: ReleaseProvider;
  archiveUrl: string;
  integrity?: string;
  sha256?: string;
  tag?: string;
  assetName?: string;
  assetId?: number;
}

export type UpdateStatus =
  | 'current' | 'available' | 'updated' | 'unsupported' | 'pinned'
  | 'enabled' | 'disabled' | 'status' | 'busy' | 'skipped' | 'error';

export interface UpdateResult {
  schema: 'hraness.cli-update.v1';
  package: string;
  currentVersion: string;
  latestVersion?: string;
  status: UpdateStatus;
  policy: UpdatePolicy;
  supported: boolean;
  manager?: 'bun' | 'npm';
  reason?: string;
  guidance?: string;
  /** True means a manager was launched; do not run the old command after a failure. */
  codeMayHaveChanged?: boolean;
}

export interface StartupResult {
  handled: boolean;
  exitCode: number;
  result?: UpdateResult;
  release(): Promise<void>;
}

export interface SavedState {
  schema: 1;
  policy?: UpdatePolicy;
  lastChecked?: number;
  /** Only an explicit enable command can opt an existing exact-version install into tracking. */
  trackInstallation?: string;
  managedInstall?: { id: string; version: string; dependencySpec?: string };
}
