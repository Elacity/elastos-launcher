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

/**
 * Exact files the launcher may remove or write, relative to the account home.
 * Anything else, including another data folder under that home, is refused.
 */
const OWNED_RELATIVE_PATHS = new Set([
  '.local/bin/elastos',
  '.local/share/elastos',
  '.local/share/elastos/host-process.lock',
  'Library/Application Support/elastos',
  'Library/Application Support/elastos/host-process.lock',
  '.elastos-launcher/install-stage.json',
  'Desktop/ElastOS-support.txt',
  'ElastOS-support.txt',
]);

function accountNameOk(name: string): boolean {
  return name !== '.' && name !== '..' && /^[A-Za-z0-9._-]+$/.test(name);
}

/**
 * True only for a runtime binary, data directory, host lock, install stage,
 * or support bundle under `/home/<account>`, `/Users/<account>`, or
 * `X:/Users/<account>`. A `..` segment never matches.
 */
export function launcherOwnedDirectories(file: string): boolean {
  const segments = file.replace(/\\/g, '/').split('/');
  if (segments.some((segment) => segment === '.' || segment === '..')) return false;
  const parts = segments.filter(Boolean);
  let account = '';
  let rest: string[] = [];
  if (parts[0] === 'home' || parts[0] === 'Users') {
    account = parts[1] || '';
    rest = parts.slice(2);
  } else if (/^[A-Za-z]:$/.test(parts[0] || '') && parts[1] === 'Users') {
    account = parts[2] || '';
    rest = parts.slice(3);
  } else {
    return false;
  }
  if (!accountNameOk(account)) return false;
  return OWNED_RELATIVE_PATHS.has(rest.join('/'));
}
