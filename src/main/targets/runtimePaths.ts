import * as fs from 'fs';
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

/** Exclusive claim for that resume. Reset removes it with the marker. */
export function runtimeResumeInstallLockPath(homeDir: string): string {
  return `${runtimeResumeInstallPath(homeDir)}.lock`;
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

/** A regular file. A symlink does not count, so a marker cannot point outside the directory. */
function isRegularFile(file: string): boolean {
  try {
    return fs.lstatSync(file).isFile();
  } catch {
    return false;
  }
}

/**
 * The host lock or `components.json` is present as a real file. A filename
 * alone does not make a custom directory safe to delete.
 */
export function elastosDataDirMarked(dataDir: string): boolean {
  return isRegularFile(runtimeHostLockPath(dataDir))
    || isRegularFile(runtimeJoin(dataDir, 'components.json'));
}

const RUNTIME_DATA_FILES = new Set([
  'components.json',
  'host-process.lock',
  'sources.json',
  'runtime-coords.json',
]);
const RUNTIME_DATA_DIRS = new Set(['state']);
const KNOWN_PARTIAL_FILES = new Set(['components.json', 'host-process.lock', 'sources.json']);

function readJsonObject(file: string): Record<string, unknown> | null {
  if (!isRegularFile(file)) return null;
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** The host lock names the gateway, or components.json is a component manifest. */
function elastosInstallProved(dataDir: string): boolean {
  const lock = readJsonObject(runtimeHostLockPath(dataDir));
  if (lock
    && typeof lock.pid === 'number'
    && Number.isInteger(lock.pid)
    && lock.pid > 0
    && lock.addr === '127.0.0.1:8090') {
    return true;
  }
  const components = readJsonObject(path.join(dataDir, 'components.json'));
  const manifest = components?.components;
  return !!manifest
    && typeof manifest === 'object'
    && !Array.isArray(manifest)
    && Object.keys(manifest as object).length > 0;
}

/** A real directory. A symlink does not count, even when its target holds a marker. */
function isRealDirectory(dataDir: string): boolean {
  try {
    const stat = fs.lstatSync(dataDir);
    return !stat.isSymbolicLink() && stat.isDirectory();
  } catch {
    return false;
  }
}

/**
 * A custom data directory this launcher may reset: it exists as a real
 * directory and is empty, or every entry is one of the runtime's own files.
 * Anything else, including a symlink or a user file beside a marker, is foreign.
 * A missing directory is absent. Extra runtime files count only when the
 * lock or components manifest proves this is an ElastOS install.
 */
function customXdgContents(dataDir: string): 'owned' | 'foreign' | 'absent' {
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(dataDir);
  } catch {
    return 'absent';
  }
  if (stat.isSymbolicLink() || !stat.isDirectory()) return 'foreign';
  let names: string[];
  try {
    names = fs.readdirSync(dataDir);
  } catch {
    return 'foreign';
  }
  let extra = false;
  for (const name of names) {
    const child = path.join(dataDir, name);
    if (RUNTIME_DATA_FILES.has(name)) {
      if (!isRegularFile(child)) return 'foreign';
      if (!KNOWN_PARTIAL_FILES.has(name)) extra = true;
      continue;
    }
    if (RUNTIME_DATA_DIRS.has(name)) {
      if (!isRealDirectory(child)) return 'foreign';
      extra = true;
      continue;
    }
    return 'foreign';
  }
  if (extra && !elastosInstallProved(dataDir)) return 'foreign';
  return 'owned';
}

/** Names the path when a custom data directory holds files Reset must not delete. */
export function foreignRuntimeDataMessage(
  dataDir: string,
  homeDir: string,
  platform: string,
  env: NodeJS.ProcessEnv,
): string | null {
  const extra = customXdgDataDir(homeDir, platform, env);
  if (!extra || compareKey(extra, platform) !== compareKey(dataDir, platform)) return null;
  if (customXdgContents(dataDir) !== 'foreign') return null;
  return `will not reset ${dataDir} because it contains files that are not part of the runtime. Move those files out, then reset.`;
}

function customXdgDataDir(
  homeDir: string,
  platform: string,
  env: NodeJS.ProcessEnv,
): string | null {
  if (platform === 'darwin') return null;
  const xdg = env.XDG_DATA_HOME?.trim() ?? '';
  if (!xdg || xdg.includes('\0') || hasDotSegment(xdg) || !isAbsolutePath(xdg)) return null;
  if (!withinHome(xdg, homeDir, platform)) return null;
  const data = runtimeJoin(xdg, 'elastos');
  if (!data || hasDotSegment(data) || !withinHome(data, homeDir, platform)) return null;
  return data;
}

/**
 * True only for an exact default runtime path of this account, or for an XDG
 * data directory under that home that is empty, holds only
 * `components.json`, `host-process.lock`, and `sources.json`, or holds a
 * proved ElastOS lock or components manifest and only other runtime files.
 * The home defaults to `os.homedir()`. A relative path, a `..` segment,
 * another account, a data directory outside that home, and a bare
 * `<dir>/elastos` are refused. A user file is refused by name even when a
 * marker is present.
 */
export function launcherOwnedDirectories(
  file: string,
  homeDir: string = os.homedir(),
  platform: string = process.platform,
  env: NodeJS.ProcessEnv = process.env,
  marked: (dataDir: string) => boolean = elastosDataDirMarked,
): boolean {
  if (!file || file.includes('\0') || hasDotSegment(file) || !isAbsolutePath(file)) return false;
  if (!homeDir || homeDir.includes('\0') || hasDotSegment(homeDir) || !isAbsolutePath(homeDir)) return false;
  const data = runtimeDataDir(platform, homeDir, {});
  const owned = [
    runtimeBinaryPath(homeDir),
    runtimeInstallStagePath(homeDir),
    runtimeResumeInstallPath(homeDir),
    runtimeResumeInstallLockPath(homeDir),
    runtimeJoin(homeDir, 'Desktop', SUPPORT_BUNDLE_FILE),
    runtimeJoin(homeDir, SUPPORT_BUNDLE_FILE),
  ];
  if (!hasDotSegment(data) && withinHome(data, homeDir, platform)) {
    owned.push(data, runtimeHostLockPath(data));
  }
  const extra = customXdgDataDir(homeDir, platform, env);
  if (extra && compareKey(extra, platform) !== compareKey(data, platform)) {
    if (customXdgContents(extra) === 'owned') {
      owned.push(extra, runtimeHostLockPath(extra));
    }
    void marked;
  }
  const key = compareKey(file, platform);
  return owned.some((candidate) => compareKey(candidate, platform) === key);
}
