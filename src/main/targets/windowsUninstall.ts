import { execFile } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { backupStamp } from '../legacyPc2Removal';
import {
  backupFolder,
  BackupSpaceError,
  describeMeasuredBackup,
  freeBytesAt,
  MAX_BACKUP_ATTEMPTS,
  plainBytes,
  prepareBackupFolder,
  runBackupWorker,
  TOO_MANY_BACKUPS,
} from './runtimeBackup';
import { isForeignGatewayError } from './runtimeGateway';
import { pinnedMaintainerDid } from './runtimePaths';
import { RemovalStat, removeVerifiedTarget } from './runtimeUninstall';
import { lookupCommand } from './windowsHost';
import { DISTRO_NAME, wslSpawnEnv } from './windowsRuntime';
import {
  distroPythonMissingMessage,
  distroPythonPresent,
  distroRemovalPlan,
  distroResetPaths,
  DistroHelperRun,
  DistroInspection,
  DistroResetPaths,
  inspectDistro,
  launcherHostFiles,
  measureDistroBackup,
  removeLauncherHostFiles,
  RestrictToOwner,
  windowsRestrictToOwner,
  wslHelperRun,
} from './windowsReset';

/**
 * Uninstall on Windows. ElastOS lives in its own WSL2 Linux environment
 * named ElastOS, which Install imported from the pinned rootfs. Uninstall
 * removes that whole environment with `wsl.exe --unregister ElastOS`.
 *
 * Before anything is stopped, it reuses the Reset checks (windowsReset.ts):
 * python3, the data-folder ownership rule, no other drive or mount, and the
 * signed install record. It then offers the same copy of the data folder
 * as Reset, and asks a second, separate question.
 *
 * Only after a yes to that question, in this order:
 * 1. List the WSL environments again: exactly one line is exactly ElastOS.
 * 2. Check ownership and the signed record again (the same record).
 * 3. Save the whole Linux environment with `wsl.exe --export ElastOS` into
 *    the same owner-only ElastOS-backups folder, after a free-space check.
 *    The file must be a complete tar file. Any failure stops here, and
 *    nothing is removed.
 * 4. List again, right before unregister.
 * 5. `wsl.exe --unregister ElastOS`, once.
 * 6. List again: ElastOS must be gone.
 *
 * Every wsl.exe call is execFile with a fixed argument list and no shell.
 */

/** The exact arguments. No name from anywhere else is ever passed. */
export function wslUnregisterArgs(): string[] {
  return ['--unregister', DISTRO_NAME];
}

export function wslTerminateArgs(): string[] {
  return ['--terminate', DISTRO_NAME];
}

/** `file` is a path this code chose in the backups folder. */
export function wslExportArgs(file: string): string[] {
  return ['--export', DISTRO_NAME, file];
}

/** The list of names only, one per line. */
export function wslListArgs(): string[] {
  return ['--list', '--quiet'];
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

export function uninstallPrompt(backupPath: string | null, folder: string): UninstallPrompt {
  const copy = backupPath ? ` Your copy of your ElastOS data is in ${backupPath}.` : '';
  return {
    title: 'Remove the ElastOS Linux environment?',
    message: `This removes the Linux environment named ${DISTRO_NAME} from this computer, with everything in it: the ElastOS program and all your ElastOS data.`,
    detail: `First, ElastOS saves the whole Linux environment as one file in ${folder}. If it cannot save that file, nothing is removed.${copy} You cannot undo the removal. Only the saved file can bring the Linux environment back.`,
    confirmLabel: `Remove ${DISTRO_NAME}`,
    cancelLabel: 'Cancel',
  };
}

/** How to bring the environment back from the saved file. The folder is where Install puts it (windowsHost.ts). */
export function restoreHint(file: string): string {
  return `To bring it back, open PowerShell and run: wsl --import ${DISTRO_NAME} C:\\ElastOS\\distro "${file}"`;
}

/** The raw result of `wsl.exe --list --quiet`. `code` is null when wsl.exe could not run. */
export interface WslListOutput {
  code: number | null;
  stdout: Buffer | string;
}

/**
 * wsl.exe writes its list as UTF-16LE, with or without a byte order mark.
 * With WSL_UTF8=1 a newer wsl.exe writes UTF-8. Decode either.
 */
export function decodeWslText(raw: Buffer | string): string {
  if (typeof raw === 'string') return raw;
  if (raw.length >= 2 && raw[0] === 0xff && raw[1] === 0xfe) return raw.subarray(2).toString('utf16le');
  if (raw.length >= 3 && raw[0] === 0xef && raw[1] === 0xbb && raw[2] === 0xbf) return raw.subarray(3).toString('utf8');
  if (raw.length >= 2 && raw.length % 2 === 0) {
    // UTF-16LE with no mark: an ASCII name has a zero byte after each letter.
    let zeros = 0;
    for (let i = 1; i < raw.length; i += 2) if (raw[i] === 0) zeros += 1;
    if (zeros * 2 >= raw.length / 2) return raw.toString('utf16le');
  }
  return raw.toString('utf8');
}

/** One name per line. A byte order mark, a zero, a CR, and the spaces at each end are not part of the name. */
export function wslListLines(raw: Buffer | string): string[] {
  return decodeWslText(raw)
    .split(/\r\n|\n|\r/)
    .map((line) => line.replace(/[\uFEFF\0]/g, '').trim())
    .filter(Boolean);
}

export type DistroRow = 'present' | 'absent' | 'unknown';

/**
 * `present`: wsl.exe ran with exit 0, and exactly one line is exactly
 * ElastOS, with no other line that WSL would read as the same name (WSL
 * names ignore case, so `elastos` is refused). `absent`: no such line.
 * `unknown`: anything else, which proves nothing.
 */
export function elastosRowOf(out: WslListOutput): DistroRow {
  if (out.code == null) return 'unknown';
  const lines = wslListLines(out.stdout);
  const exact = lines.filter((line) => line === DISTRO_NAME).length;
  const near = lines.filter((line) => line.toLowerCase() === DISTRO_NAME.toLowerCase()).length;
  if (out.code !== 0) {
    // With no distro at all, wsl.exe prints a message and exits non-zero.
    return near === 0 && lines.length > 0 ? 'absent' : 'unknown';
  }
  if (near === 0) return 'absent';
  if (exact === 1 && near === 1) return 'present';
  return 'unknown';
}

const UNCHECKED = 'ElastOS was not uninstalled because it could not check its Linux environment. Nothing was removed. Try again.';

/**
 * The proof that this environment is the one ElastOS made: the Reset
 * ownership rule with Uninstall words, and a signed install record.
 * Returns the record's SHA-256. Throws a plain refusal.
 */
export function assertDistroIsElastos(
  seen: DistroInspection,
  paths: DistroResetPaths,
  maintainerDid: string | null,
): string {
  const plan = distroRemovalPlan(seen, paths, maintainerDid, 'uninstall');
  if (plan.dataKind !== 'dir' || plan.recordSha256 == null) {
    throw new Error(`ElastOS did not uninstall. It cannot prove that the Linux environment named ${DISTRO_NAME} is the one it made, because ${paths.dataDir} in it has no signed ElastOS install record. Click Install to finish installing ElastOS, then click Uninstall again. Nothing was removed.`);
  }
  return plan.recordSha256;
}

/** Room for the tar headers and the end of the file, on top of the bytes in use. */
export function exportNeededBytes(usedBytes: number): number {
  return usedBytes + Math.ceil(usedBytes / 10) + 64 * 1024 * 1024;
}

export class ExportSpaceError extends Error {
  readonly code = 'export-space';

  constructor(readonly neededBytes: number, readonly freeBytes: number | null) {
    super(freeBytes == null
      ? 'ElastOS could not check the free space for a copy of its whole Linux environment'
      : `There is not enough free space for a copy of the whole ElastOS Linux environment. It needs about ${plainBytes(neededBytes)}, and ${plainBytes(freeBytes)} is free`);
    this.name = 'ExportSpaceError';
  }
}

/** Refuse when the whole-environment copy cannot fit in the backups folder. */
export async function assertExportSpace(input: {
  home: string;
  usedBytes: () => Promise<number>;
  freeBytes?: (dir: string) => number | null;
}): Promise<void> {
  const used = await input.usedBytes();
  if (!Number.isSafeInteger(used) || used < 0) throw new Error('ElastOS could not measure its Linux environment');
  const needed = exportNeededBytes(used);
  let dir = backupFolder(input.home);
  while (!fs.existsSync(dir) && path.dirname(dir) !== dir) dir = path.dirname(dir);
  const free = (input.freeBytes ?? freeBytesAt)(dir);
  if (free == null || free < needed) throw new ExportSpaceError(needed, free);
}

/** The bytes in use in the Linux environment, from the helper's `used`. */
export async function distroUsedBytes(run: DistroHelperRun, paths: DistroResetPaths): Promise<number> {
  const result = await run('used', { root: paths.root }, { timeoutMs: 60_000 });
  let bytes = NaN;
  try {
    const line = result.stdout.trim().split(/\r?\n/).pop() ?? '';
    bytes = Number((JSON.parse(line) as { bytes?: unknown }).bytes);
  } catch {
    bytes = NaN;
  }
  if (result.code !== 0 || !Number.isSafeInteger(bytes) || bytes < 0) {
    throw new Error('ElastOS could not measure its Linux environment');
  }
  return bytes;
}

/** `ElastOS-linux-<stamp>.tar`, then `-2`, `-3`, and so on. */
export function exportFileName(stamp: string, attempt: number): string {
  return attempt === 1 ? `ElastOS-linux-${stamp}.tar` : `ElastOS-linux-${stamp}-${attempt}.tar`;
}

const NOT_A_TAR = 'The saved file is not a complete copy';

/**
 * The saved file must be a real, non-empty file with a tar header at the
 * start, a length in whole 512-byte blocks, and the two zero blocks that
 * end every tar file. A file cut short fails the last check.
 */
export function verifyExportFile(file: string): number {
  const st = fs.lstatSync(file);
  if (st.isSymbolicLink() || !st.isFile()) throw new Error(NOT_A_TAR);
  if (st.size === 0) throw new Error('The saved file is empty');
  if (st.size < 1536 || st.size % 512 !== 0) throw new Error(NOT_A_TAR);
  const fd = fs.openSync(file, 'r');
  try {
    const head = Buffer.alloc(512);
    const tail = Buffer.alloc(1024);
    if (fs.readSync(fd, head, 0, 512, 0) !== 512) throw new Error(NOT_A_TAR);
    if (fs.readSync(fd, tail, 0, 1024, st.size - 1024) !== 1024) throw new Error(NOT_A_TAR);
    if (head.subarray(257, 262).toString('latin1') !== 'ustar') throw new Error(NOT_A_TAR);
    if (tail.some((byte) => byte !== 0)) throw new Error(NOT_A_TAR);
  } finally {
    fs.closeSync(fd);
  }
  return st.size;
}

/** Runs wsl.exe with these arguments and no shell. Resolves to the exit code; rejects when it could not run or ran too long. */
export type RunWsl = (args: string[], timeoutMs: number) => Promise<number>;

export const EXPORT_TIMEOUT_MS = 6 * 60 * 60 * 1000;

/**
 * Save the whole ElastOS Linux environment as a tar file in the owner-only
 * backups folder, and return its path. The name never replaces a file.
 * The environment is stopped first, so no program writes while it is read.
 * A file left by a failed save is deleted.
 */
export async function exportDistroToBackups(input: {
  home: string;
  dataDir: string;
  restrict: RestrictToOwner;
  usedBytes: () => Promise<number>;
  runWsl: RunWsl;
  platform?: string;
  freeBytes?: (dir: string) => number | null;
  now?: Date;
}): Promise<string> {
  const folder = prepareBackupFolder(input.home, input.dataDir, input.platform);
  input.restrict(folder, true);
  await assertExportSpace(input);
  const stamp = backupStamp(input.now ?? new Date());
  let dest: string | null = null;
  for (let attempt = 1; attempt <= MAX_BACKUP_ATTEMPTS && dest == null; attempt += 1) {
    const candidate = path.join(folder, exportFileName(stamp, attempt));
    try {
      fs.lstatSync(candidate);
    } catch (err) {
      if (err && typeof err === 'object' && (err as { code?: string }).code === 'ENOENT') dest = candidate;
      else throw err;
    }
  }
  if (dest == null) throw new Error(TOO_MANY_BACKUPS);
  const stopCode = await input.runWsl(wslTerminateArgs(), 2 * 60 * 1000).catch(() => null);
  if (stopCode !== 0) throw new Error('ElastOS could not stop its Linux environment before saving it');
  try {
    let code: number;
    try {
      code = await input.runWsl(wslExportArgs(dest), EXPORT_TIMEOUT_MS);
    } catch {
      throw new Error('wsl.exe could not save it, or took too long');
    }
    if (code !== 0) throw new Error(`wsl.exe stopped with code ${code}`);
    verifyExportFile(dest);
    input.restrict(dest, false);
  } catch (err) {
    try {
      if (fs.lstatSync(dest).isFile()) fs.rmSync(dest, { force: true });
    } catch {
      // Nothing was written.
    }
    throw err;
  }
  return dest;
}

export interface UninstallResult {
  backupPath: string | null;
  /** The saved whole Linux environment (a tar file), when it was removed. */
  linuxCopyPath: string | null;
  /** How to bring that file back (restoreHint), for the window's log. */
  restoreHint: string | null;
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
  stop: () => Promise<void>;
  /** `wsl.exe --list --quiet`, raw. */
  listDistros: () => Promise<WslListOutput>;
  hasWsl: () => Promise<boolean>;
  pythonPresent: () => Promise<boolean | null>;
  inspect: () => Promise<DistroInspection>;
  maintainerDid: string | null;
  checkBackupSpace?: () => Promise<void>;
  saveBackup?: () => Promise<string | null>;
  /** Refuses when a copy of the whole Linux environment cannot fit. Runs before Stop. */
  checkLinuxSpace: () => Promise<void>;
  /** Saves the whole Linux environment and returns the file (exportDistroToBackups). */
  saveLinux: () => Promise<string>;
  /** The second confirmation. Only `true` counts as yes. */
  confirmRemoval: (prompt: UninstallPrompt) => Promise<unknown>;
  runWsl: RunWsl;
  removeHost: (target: string) => void;
  sweepHost?: (parent: string) => void;
  lstat?: (file: string) => RemovalStat;
}

async function elastosRow(deps: DistroUninstallDeps): Promise<DistroRow> {
  if (!(await deps.hasWsl())) return 'absent';
  try {
    return elastosRowOf(await deps.listDistros());
  } catch {
    return 'unknown';
  }
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
  const hostFiles = launcherHostFiles(deps.homeDir, deps.platform ?? 'win32', deps.env ?? {});
  const row = await elastosRow(deps);
  if (row === 'unknown') throw new Error(UNCHECKED);
  const present = row === 'present';
  let recordSha256: string | null = null;
  if (present) {
    const python = await deps.pythonPresent();
    if (python === false) throw new Error(distroPythonMissingMessage('uninstall'));
    if (python == null) throw new Error(UNCHECKED);
    recordSha256 = assertDistroIsElastos(await deps.inspect(), paths, deps.maintainerDid);
    if (wantsBackup && deps.checkBackupSpace) {
      try {
        await deps.checkBackupSpace();
      } catch (err) {
        throw new Error(`ElastOS was not uninstalled. ${messageOf(err)}. Nothing was removed. Free some space, or uninstall without a copy.`);
      }
    }
    try {
      await deps.checkLinuxSpace();
    } catch (err) {
      throw new Error(`ElastOS was not uninstalled. ${messageOf(err)}. Nothing was removed. Free some space, then click Uninstall.`);
    }
  }
  try {
    await deps.stop();
  } catch (err) {
    if (isForeignGatewayError(err)) throw new Error('ElastOS is still running in another window. Quit it, then uninstall.');
    throw err;
  }
  let backupPath: string | null = null;
  let linuxCopyPath: string | null = null;
  if (present) {
    if (wantsBackup && deps.saveBackup) {
      try {
        backupPath = await deps.saveBackup();
      } catch (err) {
        throw new Error(`ElastOS was not uninstalled. The copy of your data could not be saved (${messageOf(err)}). Nothing was removed.`);
      }
    }
    const kept = () => [
      backupPath ? ` Your copy of your ElastOS data is in ${backupPath}.` : '',
      linuxCopyPath ? ` A copy of the whole Linux environment is saved in ${linuxCopyPath}.` : '',
    ].join('');
    if ((await deps.confirmRemoval(uninstallPrompt(backupPath, backupFolder(deps.homeDir)))) !== true) {
      throw new Error(`ElastOS was not uninstalled. Nothing was removed.${kept()} Click Start to use ElastOS again.`);
    }
    const changed = () => new Error(`ElastOS was not uninstalled, because its Linux environment changed. Nothing was removed.${kept()} Click Uninstall to try again.`);
    // (1) The list again, after the yes.
    if ((await elastosRow(deps)) !== 'present') throw changed();
    // (2) Ownership and the same signed record again.
    let again: string;
    try {
      again = assertDistroIsElastos(await deps.inspect(), paths, deps.maintainerDid);
    } catch (err) {
      throw new Error(`${messageOf(err)}.${kept()}`);
    }
    if (again !== recordSha256) throw changed();
    // (3) Save the whole Linux environment. Without that file, nothing is removed.
    try {
      linuxCopyPath = await deps.saveLinux();
    } catch (err) {
      throw new Error(`ElastOS was not uninstalled. It could not save a copy of its whole Linux environment (${messageOf(err)}). Nothing was removed.${kept()} Click Uninstall to try again.`);
    }
    // (4) The list again, right before unregister.
    if ((await elastosRow(deps)) !== 'present') throw changed();
    // (5) Unregister, once.
    let code: number;
    try {
      code = await deps.runWsl(wslUnregisterArgs(), 10 * 60 * 1000);
    } catch {
      throw new Error(`ElastOS could not run wsl.exe to remove its Linux environment.${kept()} Click Uninstall to try again.`);
    }
    if (code !== 0) {
      throw new Error(`ElastOS could not remove its Linux environment (wsl.exe stopped with code ${code}).${kept()} Click Uninstall to try again.`);
    }
    // (6) It must be gone.
    if ((await elastosRow(deps)) !== 'absent') {
      throw new Error(`ElastOS asked Windows to remove its Linux environment, but it is still listed.${kept()} Restart Windows, then click Uninstall again.`);
    }
  }
  removeLauncherHostFiles(hostFiles, deps);
  return { backupPath, linuxCopyPath, restoreHint: linuxCopyPath ? restoreHint(linuxCopyPath) : null, removedLinux: present };
}

/** wsl.exe through execFile: a fixed argument list, no shell, a time limit. */
export function runWslNoShell(args: string[], timeoutMs: number): Promise<number> {
  return new Promise((resolve, reject) => {
    execFile('wsl.exe', [...args], {
      windowsHide: true,
      shell: false,
      env: wslSpawnEnv(),
      timeout: timeoutMs,
      encoding: 'buffer',
      // wsl.exe --export can print progress for a long time; too much output would stop it.
      maxBuffer: 64 * 1024 * 1024,
    }, (err) => {
      if (!err) return resolve(0);
      const code = (err as { code?: unknown }).code;
      if (typeof code === 'number' && !(err as { killed?: boolean }).killed) return resolve(code);
      reject(err);
    });
  });
}

/** `wsl.exe --list --quiet` through execFile, with the raw bytes. */
export function listDistroNames(): Promise<WslListOutput> {
  return new Promise((resolve) => {
    execFile('wsl.exe', wslListArgs(), {
      windowsHide: true,
      shell: false,
      env: wslSpawnEnv(),
      timeout: 60_000,
      encoding: 'buffer',
      maxBuffer: 1024 * 1024,
    }, (err, stdout) => {
      const raw = Buffer.isBuffer(stdout) ? stdout : Buffer.alloc(0);
      if (!err) return resolve({ code: 0, stdout: raw });
      const code = (err as { code?: unknown }).code;
      const killed = Boolean((err as { killed?: boolean }).killed);
      resolve({ code: typeof code === 'number' && !killed ? code : null, stdout: raw });
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
  const usedBytes = () => distroUsedBytes(run, paths);
  return uninstallRuntimeInDistro({
    backup: choice.backup,
    homeDir: home,
    platform: process.platform,
    env: process.env,
    paths,
    stop,
    listDistros: listDistroNames,
    hasWsl: () => lookupCommand('wsl.exe'),
    pythonPresent: () => distroPythonPresent(),
    inspect: () => inspectDistro(run, paths, 'uninstall'),
    maintainerDid: pinnedMaintainerDid(),
    checkBackupSpace: async () => {
      const seen = describeMeasuredBackup(await measureDistroBackup(run, paths), home);
      if (seen.present && !seen.enough) throw new BackupSpaceError(seen.neededBytes, seen.freeBytes);
    },
    saveBackup: () => runBackupWorker<string | null>({ op: 'write-distro', home, dataDir: paths.dataDir }, 6 * 60 * 60 * 1000),
    checkLinuxSpace: () => assertExportSpace({ home, usedBytes }),
    saveLinux: () => exportDistroToBackups({
      home,
      dataDir: paths.dataDir,
      restrict: windowsRestrictToOwner(),
      usedBytes,
      runWsl: runWslNoShell,
    }),
    confirmRemoval,
    runWsl: runWslNoShell,
    removeHost: (target) => removeVerifiedTarget(target),
  });
}
