import { execFile as execFileCb } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { RUNTIME_TARGET } from './descriptors';
import { targetSupportsHost } from './registry';

/** The only argv the probe is allowed to pass. Never `gateway` or `serve`. */
export const RUNTIME_VERSION_ARGS = ['version'] as const;

export type RuntimeProbe =
  | { kind: 'version'; version: string; binaryPath: string }
  | { kind: 'not-installed' }
  | { kind: 'unsupported-platform'; platform: string; arch: string };

export class UnsupportedRuntimePlatformError extends Error {
  readonly code = 'UNSUPPORTED_RUNTIME_PLATFORM';
  readonly platform: string;
  readonly arch: string;

  constructor(platform: string, arch: string) {
    super(`ElastOS runtime is not supported on ${platform}/${arch}.`);
    this.name = 'UnsupportedRuntimePlatformError';
    this.platform = platform;
    this.arch = arch;
  }
}

export interface RuntimeProbeRequest {
  platform: string;
  arch: string;
  homeDir: string;
  pathEnv?: string;
  execFile?: (file: string, args: readonly string[]) => Promise<{ stdout: string; stderr: string }>;
}

function defaultExec(file: string, args: readonly string[]): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFileCb(file, args as string[], { timeout: 5000 }, (err, stdout, stderr) => {
      if (err) {
        reject(err);
        return;
      }
      resolve({ stdout: stdout ?? '', stderr: stderr ?? '' });
    });
  });
}

export function parseRuntimeVersion(stdout: string): string | null {
  const line = stdout.split(/\r?\n/).map((part) => part.trim()).find(Boolean);
  if (!line) return null;
  return line.replace(/^v/, '');
}

function isFile(file: string): boolean {
  try {
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
}

/** Prefer ~/.local/bin/elastos, then an `elastos` file on PATH. Does not exec. */
export function findRuntimeBinary(homeDir: string, pathEnv: string): string | null {
  const homeBin = path.join(homeDir, '.local', 'bin', 'elastos');
  if (isFile(homeBin)) return homeBin;
  for (const dir of pathEnv.split(path.delimiter)) {
    if (!dir) continue;
    const candidate = path.join(dir, 'elastos');
    if (isFile(candidate)) return candidate;
  }
  return null;
}

/**
 * Read `elastos version`. Unsupported platforms return before any exec.
 * A missing binary is `not-installed` and also does not exec.
 */
export async function probeRuntimeInstallation(request: RuntimeProbeRequest): Promise<RuntimeProbe> {
  const { platform, arch } = request;
  if (!targetSupportsHost(RUNTIME_TARGET, platform, arch)) {
    return { kind: 'unsupported-platform', platform, arch };
  }

  const binaryPath = findRuntimeBinary(request.homeDir, request.pathEnv ?? '');
  if (!binaryPath) {
    return { kind: 'not-installed' };
  }

  const execFile = request.execFile ?? defaultExec;
  const { stdout } = await execFile(binaryPath, RUNTIME_VERSION_ARGS);
  const version = parseRuntimeVersion(stdout);
  if (!version) {
    throw new Error('elastos version returned no version string');
  }
  return { kind: 'version', version, binaryPath };
}

export function unsupportedPlatformError(probe: RuntimeProbe): UnsupportedRuntimePlatformError | null {
  if (probe.kind !== 'unsupported-platform') return null;
  return new UnsupportedRuntimePlatformError(probe.platform, probe.arch);
}
