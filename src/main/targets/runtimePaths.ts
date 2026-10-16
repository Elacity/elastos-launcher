import * as path from 'path';

/**
 * Join a runtime path. A Linux path (`/root/...`) stays POSIX even when this
 * process is Windows, so the ElastOS distro paths are not rewritten with
 * backslashes.
 */
export function runtimeJoin(root: string, ...parts: string[]): string {
  const normalized = root.replace(/\\/g, '/');
  if (normalized.startsWith('/')) {
    return path.posix.join(normalized, ...parts);
  }
  return path.join(root, ...parts);
}

/** Binary installed by the publisher script. Contract: ~/.local/bin/elastos. */
export function runtimeBinaryPath(homeDir: string): string {
  return runtimeJoin(homeDir, '.local', 'bin', 'elastos');
}

/**
 * Platform data directory from the launcher contract.
 * macOS ignores XDG and uses ~/Library/Application Support/elastos.
 * Linux uses $XDG_DATA_HOME/elastos or ~/.local/share/elastos.
 */
export function runtimeDataDir(
  platform: string,
  homeDir: string,
  env: NodeJS.ProcessEnv = {},
): string {
  if (platform === 'darwin') {
    return runtimeJoin(homeDir, 'Library', 'Application Support', 'elastos');
  }
  const xdg = env.XDG_DATA_HOME?.trim();
  const base = xdg ? xdg : runtimeJoin(homeDir, '.local', 'share');
  return runtimeJoin(base, 'elastos');
}

export function runtimeComponentsPath(dataDir: string): string {
  return path.join(dataDir, 'components.json');
}

export function runtimeSourcesPath(dataDir: string): string {
  return path.join(dataDir, 'sources.json');
}

export function runtimeHostLockPath(dataDir: string): string {
  return path.join(dataDir, 'host-process.lock');
}

/** Launcher bookkeeping. Kept outside the runtime data dir so it cannot sit next to attach_secret. */
export function runtimeInstallStagePath(homeDir: string): string {
  return runtimeJoin(homeDir, '.elastos-launcher', 'install-stage.json');
}

const ALLOWED_DOTTED_DIRS = new Set(['.local', '.elastos-launcher']);

/**
 * A removable path may use a dotted directory only for the runtime layout
 * (`.local` and `.elastos-launcher`). Other dotted directories stay on disk.
 */
export function launcherOwnedDirectories(file: string): boolean {
  const segments = file.replace(/\\/g, '/').split('/').filter(Boolean);
  const dirs = segments.slice(0, -1);
  return dirs.every((segment) => !segment.includes('.') || ALLOWED_DOTTED_DIRS.has(segment));
}
