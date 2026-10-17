import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { verifyReleaseHead } from './releaseHead';
import { loadRuntimePinFile } from './runtimePin';

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

/**
 * Top-level names the runtime writes in its data directory, from runtime 0.8:
 * the rooted Home folders (`elastos-common` `ALL_ROOTS`), the release files
 * that install.sh manages, and the files and folders the gateway and setup
 * create. A custom data directory holding any other name is refused by name.
 * A publisher's `release-key.hex` and `releases` are not on this list, so a
 * reset never deletes a release signing key.
 *
 * This copies the runtime layout; the runtime publishes no list of its own.
 * It was read from the runtime source of 0.8.0-alpha.22 (changelog commit
 * 5f74c7c0) and of develop 9be009b1, which write the same top-level names.
 * Paths below are in elastos/crates/elastos-server/src unless named.
 */
const RUNTIME_DATA_NAMES = new Set([
  'AppCapsules', 'ElastOS', 'Local', 'MyWebSite', 'Public', 'Users', 'UsersAI', 'WebSpaces',
  'installation', 'bin', 'libexec', 'capsules', 'tools', 'scripts', 'browser-vm', 'update-controller',
  'model-catalog.json', 'components.json', 'sources.json', '.components.upgrade.tmp',
  'host-process.lock', 'gateway-runtime-ownership.lock', 'managed-runtime-start.lock',
  'runtime-coords.json', 'gateway-runtime-coords.json', 'home-runtime-coords.json',
  'ca.key', 'ca.pem', 'tls.key', 'tls.pem', 'tls.ips', 'signing_key', 'identity', 'did',
  'capability_store', 'namespaces', 'gateway-cache', 'cache', 'content_cache',
  'config', 'config.toml', 'providers', 'protected-content', 'model-preparation',
  'services-model-runs.json', 'services-model-remote-runs.json', 'operator-control.json',
  'backups', 'logs', 'policy', 'shares', 'storage', 'time_counter', 'audit.log', '.audit',
  'crosvm', 'crosvm-empty', 'vz', 'vz-browser', 'rootfs-cache', 'Image', 'Runtime',
  // Community, which first setup joins (collaboration_release_network.rs:30-36,
  // collaboration_startup.rs:34, collaboration_core.rs:2732).
  '.collaboration-network-choice.lock', 'collaboration', 'collaboration-network-v1.json',
  'collaboration-isolated-v1', 'collaboration-community-membership-v1.json',
  // The IPFS provider's Kubo node (capsules/ipfs-provider/src/main.rs:558, 953, 2012).
  'ipfs-repo', 'ipfs-startup.lock', 'ipfs-coords.json',
  // Child runtimes (runtime_control.rs:527, runtime_control/gateway_children.rs:91)
  // and `elastos run` provider hosts (provider_host.rs:28).
  'managed-runtimes', 'gateway-owned-runtimes', 'run',
  // Gateway and operator records (api/gateway_inspect_actions/store.rs:8,
  // jev_approval_lens.rs:36, operator_control.rs:43-44).
  'inspect-actions', 'jev-approval-lens', 'operator-control-audit.jsonl', 'operator-control-requests.jsonl',
  // Linux Browser TURN credential (setup/browser_config.rs:530) and the chain
  // provider's node state (capsules/chain-provider/src/lifecycle.rs:125).
  'runtime-turn', 'chain-provider',
  // Install and update recovery state, kept until the next run finishes it
  // (installed_release.rs:21, install_transaction.rs:25-26 beside components.json
  // and sources.json, install_transaction/support.rs:4).
  '.elastos.installation-migrate', '.elastos.update-stage', '.elastos.update-rollback', '.elastos.update-support',
]);

/** True when `name` is a top-level name the runtime writes in its data directory. */
export function isRuntimeDataName(name: string): boolean {
  return RUNTIME_DATA_NAMES.has(name);
}
/** What a half-finished install leaves. These alone need no signed record. */
const RUNTIME_PARTIAL_FILES = new Set(['components.json', 'host-process.lock', 'sources.json']);
/** install.sh writes the verified release head here before anything else runs. */
export const INSTALLED_RELEASE_HEAD = path.join('installation', 'release-head.json');
const RELEASE_HEAD_MAX_BYTES = 64 * 1024;

/** A real directory. A symlink does not count, even when its target holds a marker. */
function isRealDirectory(dataDir: string): boolean {
  try {
    const stat = fs.lstatSync(dataDir);
    return !stat.isSymbolicLink() && stat.isDirectory();
  } catch {
    return false;
  }
}

function pinnedMaintainerDid(): string | null {
  try {
    return loadRuntimePinFile().maintainerDid || null;
  } catch {
    return null;
  }
}

/**
 * The install record proves this directory is a runtime data directory:
 * `installation/release-head.json` is a regular file in a real folder, and
 * its Ed25519 signature matches the pinned maintainer DID. A filename, a lock,
 * or a components manifest alone is not proof, because anyone can write them.
 * A missing pin or a bad signature is not proof either.
 */
export function signedInstallRecord(
  dataDir: string,
  maintainerDid: string | null = pinnedMaintainerDid(),
): boolean {
  if (!maintainerDid) return false;
  if (!isRealDirectory(path.join(dataDir, 'installation'))) return false;
  const head = path.join(dataDir, INSTALLED_RELEASE_HEAD);
  try {
    const stat = fs.lstatSync(head);
    if (!stat.isFile() || stat.size > RELEASE_HEAD_MAX_BYTES) return false;
    verifyReleaseHead(fs.readFileSync(head, 'utf8'), maintainerDid);
    return true;
  } catch {
    return false;
  }
}

type CustomXdgContents =
  | { kind: 'owned' }
  | { kind: 'absent' }
  | { kind: 'foreign'; names: string[] }
  | { kind: 'unproved' };

/**
 * A custom data directory this launcher may reset. It is a real directory and
 * is empty, holds only the partial-install files, or holds only runtime names
 * and a signed install record. A symlink, an unknown name, and a record that
 * does not verify are refused. A missing directory is absent.
 */
function customXdgContents(dataDir: string, proved: (dir: string) => boolean): CustomXdgContents {
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(dataDir);
  } catch {
    return { kind: 'absent' };
  }
  if (stat.isSymbolicLink() || !stat.isDirectory()) return { kind: 'foreign', names: [] };
  let names: string[];
  try {
    names = fs.readdirSync(dataDir).sort();
  } catch {
    return { kind: 'foreign', names: [] };
  }
  const foreign: string[] = [];
  let partialOnly = true;
  for (const name of names) {
    let entry: fs.Stats;
    try {
      entry = fs.lstatSync(path.join(dataDir, name));
    } catch {
      foreign.push(name);
      continue;
    }
    const plain = entry.isFile() || entry.isDirectory();
    if (!isRuntimeDataName(name) || entry.isSymbolicLink() || !plain) {
      foreign.push(name);
      continue;
    }
    if (!RUNTIME_PARTIAL_FILES.has(name) || !entry.isFile()) partialOnly = false;
  }
  if (foreign.length) return { kind: 'foreign', names: foreign };
  if (partialOnly) return { kind: 'owned' };
  return proved(dataDir) ? { kind: 'owned' } : { kind: 'unproved' };
}

function listNames(names: string[]): string {
  const shown = names.slice(0, 5).join(', ');
  return names.length > 5 ? `${shown}, and ${names.length - 5} more` : shown;
}

/** Names the path, and the entries, when a custom data directory is not one Reset may delete. */
export function foreignRuntimeDataMessage(
  dataDir: string,
  homeDir: string,
  platform: string,
  env: NodeJS.ProcessEnv,
  proved: (dir: string) => boolean = (dir) => signedInstallRecord(dir),
): string | null {
  const extra = customXdgDataDir(homeDir, platform, env);
  if (!extra || compareKey(extra, platform) !== compareKey(dataDir, platform)) return null;
  const contents = customXdgContents(dataDir, proved);
  if (contents.kind === 'foreign') {
    const named = contents.names.length ? `: ${listNames(contents.names)}` : '';
    return `will not reset ${dataDir} because it contains files that are not part of the runtime${named}. Move those files out, then reset.`;
  }
  if (contents.kind === 'unproved') {
    return `will not reset ${dataDir} because it has no signed ElastOS install record. ElastOS deletes only a folder it can prove it installed.`;
  }
  return null;
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
 * `components.json`, `host-process.lock`, and `sources.json`, or holds only
 * runtime names and an install record signed by the pinned maintainer.
 * The home defaults to `os.homedir()`. A relative path, a `..` segment,
 * another account, a data directory outside that home, and a bare
 * `<dir>/elastos` are refused. A user file is refused by name even when the
 * signed record is present.
 */
export function launcherOwnedDirectories(
  file: string,
  homeDir: string = os.homedir(),
  platform: string = process.platform,
  env: NodeJS.ProcessEnv = process.env,
  proved: (dataDir: string) => boolean = (dir) => signedInstallRecord(dir),
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
    if (customXdgContents(extra, proved).kind === 'owned') {
      owned.push(extra, runtimeHostLockPath(extra));
    }
  }
  const key = compareKey(file, platform);
  return owned.some((candidate) => compareKey(candidate, platform) === key);
}
