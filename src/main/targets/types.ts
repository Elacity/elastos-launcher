/**
 * Launch-target contract shared by PC2.net and the ElastOS runtime.
 * Descriptors are data. They do not start a process.
 */

export type LaunchTargetId = 'pc2' | 'runtime';

/** Same strings the renderer already renders in src/renderer/app.js. */
export type TargetStatus =
  | 'running'
  | 'stopped'
  | 'starting'
  | 'stopping'
  | 'error'
  | 'not-installed';

export interface TargetPlatform {
  platform: 'darwin' | 'linux' | 'win32';
  arch: 'arm64' | 'x64';
}

export interface HealthProbe {
  /** Absolute URL the launcher polls until HTTP 2xx. */
  url: string;
  /**
   * Substring required in the response body.
   * Empty means any HTTP 2xx is enough (PC2's /health has no fixed body).
   */
  expectBodyIncludes: string;
}

export interface LaunchTargetDescriptor {
  id: LaunchTargetId;
  displayName: string;
  /**
   * False until this process can install and supervise the target.
   * The runtime descriptor stays false until the wiring tickets land.
   */
  implemented: boolean;
  /** Install root the launcher already uses, or the runtime's install root. */
  installDir: string;
  /** Executable or script the launcher spawns. Not invoked by the registry. */
  binary: string;
  /** Arguments for a launcher-owned start. Not invoked by the registry. */
  startArgs: readonly string[];
  health: HealthProbe;
  /** Page "Open My Cloud" should open once health passes. */
  openUrl: string;
  platforms: readonly TargetPlatform[];
}

export interface UpdateCheck {
  current: string;
  latest: string;
  updateAvailable: boolean;
  releaseUrl: string;
}

export interface LaunchTarget {
  readonly id: LaunchTargetId;
  readonly descriptor: LaunchTargetDescriptor;
  isInstalled(): Promise<boolean>;
  getStatus(): Promise<TargetStatus>;
  start(): Promise<void>;
  stop(): Promise<void>;
  restart(): Promise<void>;
  install(onProgress: (message: string) => void): Promise<void>;
  update(onProgress: (message: string) => void): Promise<void>;
  uninstall(): Promise<void>;
  getVersion(): string;
  checkForUpdate(): Promise<UpdateCheck>;
  openInBrowser(): void;
  getLogs(lines?: number): Promise<string>;
}
