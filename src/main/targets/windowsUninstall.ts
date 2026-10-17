import { spawn } from 'child_process';
import * as os from 'os';
import { parseWslDistroList } from '../legacyPc2Removal';
import { BackupSpaceError, describeMeasuredBackup, runBackupWorker } from './runtimeBackup';
import { isForeignGatewayError } from './runtimeGateway';
import { listNames, pinnedMaintainerDid, RuntimeDataEntry } from './runtimePaths';
import { RemovalStat, removeVerifiedTarget } from './runtimeUninstall';
import { RootfsFile, ROOTFS_MANIFEST } from './rootfsManifest';
import { listDistros, lookupCommand } from './windowsHost';
import { DISTRO_NAME, wslSpawnEnv } from './windowsRuntime';
import {
  distroPythonMissingMessage,
  distroPythonPresent,
  distroRemovalPlan,
  distroResetPaths,
  DistroHelperRun,
  DistroInspection,
  DistroResetPaths,
  explorerPath,
  inspectDistro,
  launcherHostFiles,
  measureDistroBackup,
  removeLauncherHostFiles,
  wslHelperRun,
} from './windowsReset';

/**
 * Uninstall on Windows. ElastOS lives in its own WSL2 Linux environment
 * named ElastOS, which Install imported from the pinned rootfs. Uninstall
 * removes that whole environment with `wsl.exe --unregister ElastOS`, so it
 * reuses every Reset check first (windowsReset.ts) and adds two:
 *
 * - The environment must be proven to be the one ElastOS made: the name is
 *   exactly ElastOS, and its data folder passes the Reset ownership rule
 *   with a signed install record (the marker). A partial or missing data
 *   folder is not enough, because unregister removes everything.
 * - Nothing a person keeps may be outside the data folder. /root holds
 *   only the names the rootfs, Install, the runtime, and a shell write, and
 *   the rootfs files in it are unchanged. /home holds only the home that
 *   the rootfs's cloud-init makes on first boot, with the /etc/skel files
 *   unchanged. Each .ssh folder is empty or holds only an empty
 *   authorized_keys. The bytes come from the pinned rootfs
 *   (rootfsManifest.ts). The copy that Uninstall offers holds only the data
 *   folder, so a file anywhere else would be lost with no copy. It is
 *   refused by name, whatever the person chose for the copy (fail closed).
 *
 * Then, after Stop and the copy, a second, separate confirmation in plain
 * words. Only a yes to that runs unregister, once, with a fixed argv.
 */

/** The exact arguments. No name from anywhere else is ever passed. */
export function wslUnregisterArgs(): string[] {
  return ['--unregister', DISTRO_NAME];
}

export const UNINSTALL_CHOICE_MESSAGE =
  'Choose whether to save a copy of your ElastOS data first. Nothing was removed.';

/** What the person sees in the second confirmation. */
export interface UninstallPrompt {
  title: string;
  message: string;
  detail: string;
  confirmLabel: string;
  cancelLabel: string;
}

export function uninstallPrompt(backupPath: string | null): UninstallPrompt {
  return {
    title: 'Remove the ElastOS Linux environment?',
    message: `This removes the Linux environment named ${DISTRO_NAME} from this computer, with everything in it: the ElastOS program and all your ElastOS data.`,
    detail: backupPath
      ? `You cannot undo this. Only your copy can bring your ElastOS data back. Your copy is in ${backupPath}.`
      : 'You cannot undo this. You chose not to save a copy, so your ElastOS data cannot come back.',
    confirmLabel: `Remove ${DISTRO_NAME}`,
    cancelLabel: 'Cancel',
  };
}

/** Folders outside the data folder that Uninstall checks, in the Linux environment. */
export interface DistroOutsideDirs {
  root: string;
  local: string;
  bin: string;
  share: string;
  rootSsh: string;
  homes: string;
  /** The home cloud-init makes for the rootfs's default user. */
  userHome: string;
  userSsh: string;
}

export function distroOutsideDirs(paths: DistroResetPaths, homes = '/home'): DistroOutsideDirs {
  const userHome = `${homes}/${ROOTFS_MANIFEST.defaultUser}`;
  return {
    root: paths.root,
    local: `${paths.root}/.local`,
    bin: `${paths.root}/.local/bin`,
    share: `${paths.root}/.local/share`,
    rootSsh: `${paths.root}/.ssh`,
    homes,
    userHome,
    userSsh: `${userHome}/.ssh`,
  };
}

/**
 * Other names in /root that Install, the launcher, the runtime (its cache
 * in ~/.cache), and a shell write. `.cache` and `.local/state` are caches
 * and history, never files a person keeps. `.motd_shown` and
 * `.cloud-locale-test.skip` are empty marks the rootfs's login scripts
 * write (etc/profile.d/update-motd.sh, Z99-cloud-locale-test.sh).
 */
const ROOT_NAMES = new Set([
  '.local', '.cache', '.elastos-launcher',
  '.bash_history', '.lesshst', '.wget-hsts', '.hushlogin', '.python_history',
  '.sudo_as_admin_successful', '.viminfo', '.selected_editor', '.motd_shown',
  '.cloud-locale-test.skip',
]);
const LOCAL_NAMES = new Set(['bin', 'share', 'state']);
/** install.sh and the install writer put only `elastos` and `.elastos.*` scratch here (install_transaction.rs:22-26). */
const BIN_NAME = (name: string) => name === 'elastos' || name.startsWith('.elastos.');
/** The data folder, and a folder Reset moved aside and has not finished deleting (`.elastos-removing-`). */
const SHARE_NAME = (name: string) => name === 'elastos' || name.startsWith('.elastos-removing-');

/** [name, kind, size, sha256]: size for a regular file, sha256 when it is at most 64 KiB. */
export type ListedEntry = [string, RuntimeDataEntry['kind'], number | null, string | null];
export type Listing = Record<string, ListedEntry[] | 'absent' | 'unknown'>;

type Rule = (entry: ListedEntry) => boolean;

const isFileOrDir: Rule = ([, kind]) => kind === 'file' || kind === 'dir';
const isDir: Rule = ([, kind]) => kind === 'dir';
/** The same bytes as the rootfs file. A changed, missing-hash, or other-kind entry fails. */
const sameAs = (want: RootfsFile): Rule => ([, kind, size, sha256]) => kind === 'file' && size === want.size && sha256 === want.sha256;
/**
 * cloud-init's ssh module writes ~/.ssh/authorized_keys for the default user
 * and root on first boot. With no keys given, the file is empty
 * (cloudinit/config/cc_ssh.py apply_credentials, ssh_util.py
 * setup_user_keys and update_authorized_keys in the rootfs). A key in it
 * came from someone, so it is refused.
 */
const sshRules: Record<string, Rule> = { authorized_keys: ([, kind, size]) => kind === 'file' && size === 0 };

function rulesOf(names: Iterable<string>, rule: Rule): Record<string, Rule> {
  return Object.fromEntries([...names].map((name) => [name, rule]));
}

/**
 * Full paths of entries outside the data folder that ElastOS did not make,
 * or that changed since the rootfs put them there. Null when a folder
 * could not be read, so nothing can be proven.
 */
export function foreignOutsideData(listing: Listing, dirs: DistroOutsideDirs): string[] | null {
  const foreign: string[] = [];
  const m = ROOTFS_MANIFEST;
  /** A folder is read only when its parent listed it as a folder; otherwise there is nothing in it to lose. */
  const check = (dir: string, rules: Record<string, Rule>, pattern?: (name: string) => boolean): boolean => {
    const seen = listing[dir];
    if (seen === 'absent') return true;
    if (!Array.isArray(seen)) return false;
    for (const entry of seen) {
      const name = entry[0];
      const rule = Object.prototype.hasOwnProperty.call(rules, name) ? rules[name] : pattern?.(name) ? isFileOrDir : null;
      if (!rule || !rule(entry)) foreign.push(`${dir}/${name}`);
    }
    return true;
  };
  const listedDir = (dir: string, name: string) => {
    const seen = listing[dir];
    return Array.isArray(seen) && seen.some((entry) => entry[0] === name && entry[1] === 'dir');
  };
  // /root is where Install puts ElastOS. Without it, this is not the environment ElastOS made.
  if (listing[dirs.root] === 'absent') foreign.push(dirs.root);
  const rootRules = {
    ...rulesOf(ROOT_NAMES, isFileOrDir),
    ...Object.fromEntries(Object.entries(m.rootFiles).map(([name, want]) => [name, sameAs(want)])),
    ...rulesOf(m.rootDirs, isDir),
  };
  if (!check(dirs.root, rootRules)) return null;
  if (listedDir(dirs.root, '.local') && !check(dirs.local, rulesOf(LOCAL_NAMES, isFileOrDir))) return null;
  if (listedDir(dirs.local, 'bin') && !check(dirs.bin, {}, BIN_NAME)) return null;
  if (listedDir(dirs.local, 'share') && !check(dirs.share, {}, SHARE_NAME)) return null;
  if (listedDir(dirs.root, '.ssh') && !check(dirs.rootSsh, sshRules)) return null;
  if (!check(dirs.homes, rulesOf([...m.homeEntries, m.defaultUser], isDir))) return null;
  const userHome = dirs.userHome.slice(dirs.homes.length + 1);
  if (listedDir(dirs.homes, userHome)) {
    const homeRules = {
      ...Object.fromEntries(Object.entries(m.skel).map(([name, want]) => [name, sameAs(want)])),
      '.ssh': isDir,
    };
    if (!check(dirs.userHome, homeRules)) return null;
    if (listedDir(dirs.userHome, '.ssh') && !check(dirs.userSsh, sshRules)) return null;
  }
  return foreign;
}

export async function listOutsideData(run: DistroHelperRun, paths: DistroResetPaths, dirs: DistroOutsideDirs): Promise<Listing> {
  const result = await run('list', { root: paths.root, dirs: Object.values(dirs) }, { timeoutMs: 60_000 });
  if (result.code !== 0) throw new Error(UNCHECKED);
  try {
    const line = result.stdout.trim().split(/\r?\n/).pop() ?? '';
    return JSON.parse(line) as Listing;
  } catch {
    throw new Error(UNCHECKED);
  }
}

const UNCHECKED = 'ElastOS was not uninstalled because it could not check its Linux environment. Nothing was removed. Try again.';

/**
 * The proof that this environment is the one ElastOS made, and that
 * removing it loses nothing but the ElastOS data. Throws a plain refusal.
 */
export function assertDistroIsElastosOnly(
  seen: DistroInspection,
  outside: Listing,
  paths: DistroResetPaths,
  dirs: DistroOutsideDirs,
  maintainerDid: string | null,
): void {
  // The Reset ownership rule, with Uninstall words (no user file, no mount, signed record).
  const plan = distroRemovalPlan(seen, paths, maintainerDid, 'uninstall');
  if (plan.dataKind !== 'dir' || plan.recordSha256 == null) {
    throw new Error(`ElastOS did not uninstall. It cannot prove that the Linux environment named ${DISTRO_NAME} is the one it made, because ${paths.dataDir} in it has no signed ElastOS install record. Click Install to finish installing ElastOS, then click Uninstall again. Nothing was removed.`);
  }
  const foreign = foreignOutsideData(outside, dirs);
  if (foreign == null) throw new Error(UNCHECKED);
  if (foreign.length) {
    throw new Error(`ElastOS did not uninstall, because the Linux environment named ${DISTRO_NAME} holds files that ElastOS did not make, or that were changed: ${listNames(foreign)}. Uninstall would delete them, and the copy holds only your ElastOS data. Move those files out, then click Uninstall. Nothing was removed. To see them, open ${explorerPath(foreign[0].slice(0, foreign[0].lastIndexOf('/')) || '/')} in File Explorer.`);
  }
}

export interface UninstallResult {
  backupPath: string | null;
  /** True when the ElastOS Linux environment was removed. */
  removedLinux: boolean;
}

export interface DistroUninstallDeps {
  /** The person's answer to "Save a copy of your ElastOS data first". Anything but a boolean refuses. */
  backup: unknown;
  homeDir: string;
  platform?: string;
  env?: NodeJS.ProcessEnv;
  paths?: DistroResetPaths;
  outsideDirs?: DistroOutsideDirs;
  stop: () => Promise<void>;
  /** The WSL list (`wsl.exe --list --verbose`). Empty when wsl.exe could not run. */
  listDistros: () => Promise<string>;
  hasWsl: () => Promise<boolean>;
  pythonPresent: () => Promise<boolean | null>;
  inspect: () => Promise<DistroInspection>;
  listOutside: () => Promise<Listing>;
  maintainerDid: string | null;
  checkBackupSpace?: () => Promise<void>;
  saveBackup?: () => Promise<string | null>;
  /** The second confirmation. Only `true` counts as yes. */
  confirmRemoval: (prompt: UninstallPrompt) => Promise<unknown>;
  /** Runs wsl.exe with these arguments, with no shell. Resolves to the exit code. */
  runWsl: (args: string[]) => Promise<number>;
  removeHost: (target: string) => void;
  sweepHost?: (parent: string) => void;
  lstat?: (file: string) => RemovalStat;
}

/** Exactly one row named exactly ElastOS. Another case or a look-alike name is not ElastOS. */
async function elastosRow(deps: DistroUninstallDeps): Promise<'present' | 'absent' | 'unknown'> {
  if (!(await deps.hasWsl())) return 'absent';
  const text = (await deps.listDistros()).replace(/\0/g, '');
  if (!text.trim()) return 'unknown';
  const rows = parseWslDistroList(text);
  const near = rows.filter((row) => row.name.toLowerCase() === DISTRO_NAME.toLowerCase());
  if (near.length === 0) return 'absent';
  if (near.length === 1 && near[0].name === DISTRO_NAME) return 'present';
  return 'unknown';
}

function messageOf(err: unknown): string {
  const text = err instanceof Error ? err.message : String(err);
  return text.replace(/\.$/, '');
}

export async function uninstallRuntimeInDistro(deps: DistroUninstallDeps): Promise<UninstallResult> {
  if (typeof deps.backup !== 'boolean') throw new Error(UNINSTALL_CHOICE_MESSAGE);
  const wantsBackup = deps.backup;
  if (wantsBackup && !deps.saveBackup) {
    throw new Error('ElastOS was not uninstalled. A copy of your data cannot be saved here. Nothing was removed.');
  }
  const paths = deps.paths ?? distroResetPaths();
  const dirs = deps.outsideDirs ?? distroOutsideDirs(paths);
  const hostFiles = launcherHostFiles(deps.homeDir, deps.platform ?? 'win32', deps.env ?? {});
  const row = await elastosRow(deps);
  if (row === 'unknown') throw new Error(UNCHECKED);
  const present = row === 'present';
  if (present) {
    const python = await deps.pythonPresent();
    if (python === false) throw new Error(distroPythonMissingMessage('uninstall'));
    if (python == null) throw new Error(UNCHECKED);
    assertDistroIsElastosOnly(await deps.inspect(), await deps.listOutside(), paths, dirs, deps.maintainerDid);
    if (wantsBackup && deps.checkBackupSpace) {
      try {
        await deps.checkBackupSpace();
      } catch (err) {
        throw new Error(`ElastOS was not uninstalled. ${messageOf(err)}. Nothing was removed. Free some space, or uninstall without a copy.`);
      }
    }
  }
  try {
    await deps.stop();
  } catch (err) {
    if (isForeignGatewayError(err)) throw new Error('ElastOS is still running in another window. Quit it, then uninstall.');
    throw err;
  }
  let backupPath: string | null = null;
  if (present) {
    if (wantsBackup && deps.saveBackup) {
      try {
        backupPath = await deps.saveBackup();
      } catch (err) {
        throw new Error(`ElastOS was not uninstalled. The copy of your data could not be saved (${messageOf(err)}). Nothing was removed.`);
      }
    }
    const kept = backupPath ? ` Your copy of your ElastOS data is in ${backupPath}.` : '';
    // Look again after Stop and the copy.
    try {
      assertDistroIsElastosOnly(await deps.inspect(), await deps.listOutside(), paths, dirs, deps.maintainerDid);
    } catch (err) {
      throw new Error(`${messageOf(err)}.${kept}`);
    }
    if ((await deps.confirmRemoval(uninstallPrompt(backupPath))) !== true) {
      throw new Error(`ElastOS was not uninstalled. Nothing was removed.${kept} Click Start to use ElastOS again.`);
    }
    if ((await elastosRow(deps)) !== 'present') {
      throw new Error(`ElastOS was not uninstalled, because its Linux environment changed. Nothing was removed.${kept} Click Uninstall to try again.`);
    }
    let code: number;
    try {
      code = await deps.runWsl(wslUnregisterArgs());
    } catch {
      throw new Error(`ElastOS could not run wsl.exe to remove its Linux environment.${kept} Click Uninstall to try again.`);
    }
    if (code !== 0) {
      throw new Error(`ElastOS could not remove its Linux environment (wsl.exe stopped with code ${code}).${kept} Click Uninstall to try again.`);
    }
    if ((await elastosRow(deps)) !== 'absent') {
      throw new Error(`ElastOS asked Windows to remove its Linux environment, but it is still listed.${kept} Restart Windows, then click Uninstall again.`);
    }
  }
  removeLauncherHostFiles(hostFiles, deps);
  return { backupPath, removedLinux: present };
}

function runWslNoShell(args: string[]): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn('wsl.exe', [...args], { windowsHide: true, shell: false, env: wslSpawnEnv(), stdio: 'ignore' });
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error('timeout'));
    }, 10 * 60 * 1000);
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on('exit', (code) => {
      clearTimeout(timer);
      resolve(code ?? 1);
    });
  });
}

export async function uninstallRuntimeInDistroOnThisComputer(
  stop: () => Promise<void>,
  choice: { backup?: unknown },
  confirmRemoval: (prompt: UninstallPrompt) => Promise<unknown>,
): Promise<UninstallResult> {
  const home = os.homedir();
  const run = wslHelperRun();
  const paths = distroResetPaths();
  const dirs = distroOutsideDirs(paths);
  return uninstallRuntimeInDistro({
    backup: choice.backup,
    homeDir: home,
    platform: process.platform,
    env: process.env,
    paths,
    outsideDirs: dirs,
    stop,
    listDistros,
    hasWsl: () => lookupCommand('wsl.exe'),
    pythonPresent: () => distroPythonPresent(),
    inspect: () => inspectDistro(run, paths, 'uninstall'),
    listOutside: () => listOutsideData(run, paths, dirs),
    maintainerDid: pinnedMaintainerDid(),
    checkBackupSpace: async () => {
      const seen = describeMeasuredBackup(await measureDistroBackup(run, paths), home);
      if (seen.present && !seen.enough) throw new BackupSpaceError(seen.neededBytes, seen.freeBytes);
    },
    saveBackup: () => runBackupWorker<string | null>({ op: 'write-distro', home, dataDir: paths.dataDir }, 6 * 60 * 60 * 1000),
    confirmRemoval,
    runWsl: runWslNoShell,
    removeHost: (target) => removeVerifiedTarget(target),
  });
}
