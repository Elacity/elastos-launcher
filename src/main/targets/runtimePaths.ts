import * as os from 'os';
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

/** Written when Windows asks for a restart so the next open can continue Install. */
export function runtimeResumeInstallPath(homeDir: string): string {
  return runtimeJoin(homeDir, '.elastos-launcher', 'resume-install.json');
}

export const SUPPORT_BUNDLE_FILE = 'ElastOS-support.txt';

function slashPath(file: string): string {
  return file.replace(/\\/g, '/');
}

function hasDotSegment(file: string): boolean {
  return slashPath(file).split('/').some((segment) => segment === '.' || segment === '..');
}

function isAbsolutePath(file: string): boolean {
  const normalized = slashPath(file);
  return normalized.startsWith('/') || /^[A-Za-z]:\//.test(normalized);
}

function stripTrailingSlash(file: string): string {
  const normalized = slashPath(file);
  if (normalized.length > 1 && normalized.endsWith('/')) return normalized.replace(/\/+$/, '');
  return normalized;
}

function compareKey(file: string, platform: string): string {
  const normalized = stripTrailingSlash(file);
  return platform === 'win32' || platform === 'darwin' ? normalized.toLowerCase() : normalized;
}

function withinHome(candidate: string, homeDir: string, platform: string): boolean {
  const home = compareKey(homeDir, platform);
  const value = compareKey(candidate, platform);
  if (!home || !value) return false;
  return value === home || value.startsWith(`${home}/`);
}

/**
 * True only when `file` is an absolute runtime path computed for this account.
 * The home defaults to `os.homedir()`. A relative path, a `..` segment, another
 * account, and a data directory outside that home are refused.
 */
export function launcherOwnedDirectories(
  file: string,
  homeDir: string = os.homedir(),
  platform: string = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (!file || file.includes('\0') || hasDotSegment(file) || !isAbsolutePath(file)) return false;
  if (!homeDir || homeDir.includes('\0') || hasDotSegment(homeDir) || !isAbsolutePath(homeDir)) return false;
  const owned = [
    runtimeBinaryPath(homeDir),
    runtimeInstallStagePath(homeDir),
    runtimeJoin(homeDir, 'Desktop', SUPPORT_BUNDLE_FILE),
    runtimeJoin(homeDir, SUPPORT_BUNDLE_FILE),
  ];
  const xdg = env.XDG_DATA_HOME?.trim() ?? '';
  const xdgUsable = platform === 'darwin'
    || !xdg
    || (!xdg.includes('\0') && !hasDotSegment(xdg) && withinHome(xdg, homeDir, platform));
  if (xdgUsable) {
    const data = runtimeDataDir(platform, homeDir, platform === 'darwin' ? {} : env);
    if (!hasDotSegment(data) && withinHome(data, homeDir, platform)) {
      owned.push(data, runtimeHostLockPath(data));
    }
  }
  const key = compareKey(file, platform);
  return owned.some((candidate) => compareKey(candidate, platform) === key);
}
