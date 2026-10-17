import { execFileSync, spawn } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { backupStamp, verifyStoredZip } from '../legacyPc2Removal';
import {
  BackupDescription,
  BackupMeasure,
  BackupSpaceError,
  backupFileName,
  backupNeededBytes,
  describeMeasuredBackup,
  freeBytesAt,
  MAX_BACKUP_ATTEMPTS,
  prepareBackupFolder,
  readStoredZipEntries,
  runBackupWorker,
  RUNTIME_BACKUP_EXCLUDES,
  TOO_MANY_BACKUPS,
} from './runtimeBackup';
import { isForeignGatewayError } from './runtimeGateway';
import {
  classifyRuntimeEntries,
  installRecordTextProves,
  launcherOwnedDirectories,
  listNames,
  pinnedMaintainerDid,
  runtimeBinaryPath,
  runtimeDataDir,
  RuntimeDataEntry,
  runtimeInstallStagePath,
  runtimeResumeInstallLockPath,
  runtimeResumeInstallPath,
} from './runtimePaths';
import {
  assertNoSymlinkAncestors,
  assertStableRemovalTarget,
  RemovalStat,
  removeVerifiedTarget,
  RESET_CHOICE_MESSAGE,
  ResetResult,
  sweepRemovalHoldings,
} from './runtimeUninstall';
import { DISTRO_RESET_HELPER } from './distroResetHelper';
import { listDistros, lookupCommand } from './windowsHost';
import { DISTRO_HOME, DISTRO_NAME, wslSpawnEnv } from './windowsRuntime';
import { parseWslDistroList } from '../legacyPc2Removal';

/** The runtime paths inside the ElastOS Linux environment. Install writes these, and only these, there. */
export interface DistroResetPaths {
  root: string;
  binary: string;
  dataDir: string;
  stageFile: string;
  /** Folders that must be real folders (or missing) for a delete to go ahead. */
  ancestors: string[];
}

export function distroResetPaths(home: string = DISTRO_HOME): DistroResetPaths {
  return {
    root: home,
    binary: runtimeBinaryPath(home),
    dataDir: runtimeDataDir('linux', home, {}),
    stageFile: runtimeInstallStagePath(home),
    ancestors: [
      `${home}/.local`,
      `${home}/.local/bin`,
      `${home}/.local/share`,
      `${home}/.elastos-launcher`,
    ],
  };
}

export type DistroHelperOp = 'inspect' | 'measure' | 'zip' | 'remove';

export interface DistroHelperResult {
  code: number;
  stdout: string;
  stderr: string;
}

/**
 * Runs the fixed helper. `input` goes to stdin as JSON. When `outFd` is set,
 * stdout is written to that file instead of returned.
 */
export type DistroHelperRun = (
  op: DistroHelperOp,
  input: Record<string, unknown>,
  options?: { outFd?: number; timeoutMs?: number },
) => Promise<DistroHelperResult>;

/** The python3 that runs the Reset helper inside the ElastOS Linux environment. */
export const DISTRO_PYTHON = '/usr/bin/python3';

/**
 * The wsl.exe arguments. `--exec` runs python3 with no Linux shell, and the
 * only values are the fixed helper and the operation name. Paths and names
 * go through stdin, never through this list.
 */
export function distroHelperArgs(op: DistroHelperOp): string[] {
  return ['-d', DISTRO_NAME, '-u', 'root', '--exec', DISTRO_PYTHON, '-c', DISTRO_RESET_HELPER, op];
}

/** Spawn a helper process with no shell. Exported so tests can run the same helper with a local python3. */
export function spawnHelper(
  command: string,
  args: readonly string[],
  input: Record<string, unknown>,
  options: { outFd?: number; timeoutMs?: number; env?: NodeJS.ProcessEnv } = {},
): Promise<DistroHelperResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, [...args], {
      windowsHide: true,
      shell: false,
      env: options.env ?? process.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let writeError: unknown = null;
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
    };
    const timer = setTimeout(() => {
      child.kill();
      finish(() => reject(new Error('ElastOS took too long in its Linux environment.')));
    }, options.timeoutMs ?? 120_000);
    child.on('error', () => finish(() => reject(new Error('ElastOS could not reach its Linux environment.'))));
    child.stdout.on('data', (chunk: Buffer) => {
      if (options.outFd == null) {
        stdout.push(chunk);
        return;
      }
      if (writeError) return;
      try {
        let done = 0;
        while (done < chunk.length) done += fs.writeSync(options.outFd, chunk, done, chunk.length - done);
      } catch (err) {
        writeError = err;
        child.kill();
      }
    });
    child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));
    child.on('close', (code) => {
      finish(() => {
        if (writeError) {
          reject(new Error('ElastOS could not write the copy of your data.'));
          return;
        }
        resolve({
          code: code ?? 1,
          stdout: Buffer.concat(stdout).toString('utf8'),
          stderr: Buffer.concat(stderr).toString('utf8'),
        });
      });
    });
    child.stdin.on('error', () => {});
    child.stdin.end(Buffer.from(JSON.stringify(input), 'utf8'));
  });
}

export function wslHelperRun(): DistroHelperRun {
  return (op, input, options = {}) => spawnHelper('wsl.exe', distroHelperArgs(op), input, {
    ...options,
    env: wslSpawnEnv(),
  });
}

const DATA_IN_LINUX = 'in its Linux environment';

export interface DistroInspection {
  binary: RuntimeDataEntry['kind'] | 'absent';
  stage: RuntimeDataEntry['kind'] | 'absent';
  data: RuntimeDataEntry['kind'] | 'absent';
  ancestors: Array<[string, string]>;
  entries?: Array<[string, RuntimeDataEntry['kind']]>;
  record?: { kind: string; text?: string; sha256?: string };
  /** Names in the data folder on another drive or mount. `.` is the data folder itself. */
  crossing?: string[];
}

/** What `remove` must find again before it deletes anything. */
export interface DistroRemovalPlan {
  dataKind: 'dir' | 'absent';
  entries: Array<[string, RuntimeDataEntry['kind']]>;
  recordSha256: string | null;
}

function helperInput(paths: DistroResetPaths): Record<string, unknown> {
  return {
    root: paths.root,
    binary: paths.binary,
    stage: paths.stageFile,
    data: paths.dataDir,
    ancestors: paths.ancestors,
  };
}

function parseJson<T>(text: string): T {
  const line = text.trim().split(/\r?\n/).pop() ?? '';
  return JSON.parse(line) as T;
}

export async function inspectDistro(run: DistroHelperRun, paths: DistroResetPaths): Promise<DistroInspection> {
  const result = await run('inspect', helperInput(paths), { timeoutMs: 60_000 });
  if (result.code !== 0) {
    throw new Error(`ElastOS was not reset because it could not check its files ${DATA_IN_LINUX}. Nothing was deleted. Try again.`);
  }
  try {
    return parseJson<DistroInspection>(result.stdout);
  } catch {
    throw new Error(`ElastOS was not reset because it could not check its files ${DATA_IN_LINUX}. Nothing was deleted. Try again.`);
  }
}

/**
 * Apply the same ownership rule as Mac and Linux to the data folder inside
 * the ElastOS Linux environment: only runtime names, as plain files and
 * folders, and a signed install record for anything past a partial install.
 * The record bytes are checked here against the pinned maintainer DID.
 */
export function distroRemovalPlan(
  seen: DistroInspection,
  paths: DistroResetPaths,
  maintainerDid: string | null,
): DistroRemovalPlan {
  const where = `${paths.dataDir} ${DATA_IN_LINUX}`;
  for (const [file, kind] of seen.ancestors ?? []) {
    if (kind !== 'dir' && kind !== 'absent') {
      throw new Error(`ElastOS will not reset, because ${file} ${DATA_IN_LINUX} is not a real folder. Nothing was deleted.`);
    }
  }
  if (seen.binary !== 'file' && seen.binary !== 'absent') {
    throw new Error(`ElastOS will not reset, because ${paths.binary} ${DATA_IN_LINUX} is not a plain file. Nothing was deleted.`);
  }
  if (seen.stage !== 'file' && seen.stage !== 'absent') {
    throw new Error(`ElastOS will not reset, because ${paths.stageFile} ${DATA_IN_LINUX} is not a plain file. Nothing was deleted.`);
  }
  if (seen.data === 'absent') return { dataKind: 'absent', entries: [], recordSha256: null };
  if (seen.data !== 'dir' || !Array.isArray(seen.entries)) {
    throw new Error(`ElastOS will not reset ${where}, because it is not a real folder. Nothing was deleted.`);
  }
  if (!Array.isArray(seen.crossing)) {
    throw new Error(`ElastOS was not reset because it could not check its files ${DATA_IN_LINUX}. Nothing was deleted. Try again.`);
  }
  if (seen.crossing.length > 0) throw new Error(mountedMessage(where, seen.crossing));
  const entries = seen.entries;
  const record = seen.record;
  const recordText = record && record.kind === 'file' && typeof record.text === 'string'
    ? Buffer.from(record.text, 'base64').toString('utf8')
    : null;
  const verdict = classifyRuntimeEntries(
    entries.map(([name, kind]) => ({ name, kind })),
    () => recordText != null && installRecordTextProves(recordText, maintainerDid),
  );
  if (verdict.kind === 'foreign') {
    throw new Error(`ElastOS will not reset ${where}, because it contains files that are not part of the runtime: ${listNames(verdict.names)}. Move those files out, then reset. Nothing was deleted. To see them, open ${explorerPath(paths.dataDir)} in File Explorer.`);
  }
  if (verdict.kind === 'unproved') {
    throw new Error(`ElastOS will not reset ${where}, because it has no signed ElastOS install record. ElastOS deletes only a folder it can prove it installed. Nothing was deleted.`);
  }
  return {
    dataKind: 'dir',
    entries,
    recordSha256: verdict.byRecord && record && typeof record.sha256 === 'string' ? record.sha256 : null,
  };
}

function mountedMessage(where: string, names: string[]): string {
  const self = names.includes('.');
  const what = self
    ? `${where}, because that folder is on another drive or is mounted from another folder`
    : `${where}, because these names in it are on another drive or are mounted from another folder: ${listNames(names)}`;
  return `ElastOS will not reset ${what}. ElastOS deletes only its own files, never files on another drive. Nothing was deleted. Unmount ${self ? 'it' : 'them'}, then click Reset.`;
}

/** The File Explorer address of a path in the ElastOS Linux environment. */
export function explorerPath(file: string): string {
  return `\\\\wsl$\\${DISTRO_NAME}${file.replace(/\//g, '\\')}`;
}

export async function removeInDistro(
  run: DistroHelperRun,
  paths: DistroResetPaths,
  plan: DistroRemovalPlan,
): Promise<string[]> {
  const result = await run('remove', { ...helperInput(paths), ...plan }, { timeoutMs: 30 * 60 * 1000 });
  if (result.code === 3) {
    if (/ELASTOS-REFUSED mount/.test(result.stderr)) throw new Error(mountedMessage(`${paths.dataDir} ${DATA_IN_LINUX}`, ['.']));
    throw new Error(`ElastOS was not reset, because its files ${DATA_IN_LINUX} changed. Nothing was deleted there. Click Reset to try again.`);
  }
  if (result.code === 4) throw new Error(partialMessage(result.stdout, paths));
  if (result.code !== 0) {
    throw new Error(`ElastOS could not finish removing its files ${DATA_IN_LINUX}. Click Reset to try again.`);
  }
  try {
    return parseJson<{ removed: string[] }>(result.stdout).removed;
  } catch {
    throw new Error(`ElastOS could not finish removing its files ${DATA_IN_LINUX}. Click Reset to try again.`);
  }
}

interface DistroPartial {
  failed?: string;
  restored?: boolean;
  holding?: string | null;
  left?: string[];
}

/**
 * The helper stopped at one step (exit 4). Say what is where now, and that
 * Reset finishes the job: it moves the data aside first, so a second Reset
 * finds either the old install or only the moved folder, which it deletes.
 */
function partialMessage(stdout: string, paths: DistroResetPaths): string {
  let seen: DistroPartial = {};
  try {
    seen = parseJson<DistroPartial>(stdout);
  } catch {
    seen = {};
  }
  const holding = typeof seen.holding === 'string' ? seen.holding : null;
  if (seen.failed === 'move' && seen.restored) {
    return `ElastOS was not reset, because it could not move its data folder ${paths.dataDir} ${DATA_IN_LINUX}. Nothing was deleted. Click Reset to try again.`;
  }
  if (seen.failed === 'program' && seen.restored) {
    return `ElastOS was not reset, because it could not remove its program ${DATA_IN_LINUX}. Your data was not deleted. Click Reset to try again.`;
  }
  if ((seen.failed === 'move' || seen.failed === 'program') && holding) {
    return `ElastOS was not fully reset. Your data is now in ${holding} ${DATA_IN_LINUX}, and none of it was deleted. Click Reset to finish.`;
  }
  if (seen.failed === 'delete' && holding) {
    const names = Array.isArray(seen.left) && seen.left.length && !seen.left.includes('.') ? `: ${listNames(seen.left)}` : '';
    return `ElastOS was reset, but some old files in ${holding} ${DATA_IN_LINUX} were not deleted${names}. ElastOS never deletes files on another drive. Click Reset to try again.`;
  }
  return `ElastOS could not finish removing its files ${DATA_IN_LINUX}. Click Reset to try again.`;
}

/** The copy's size, measured inside the Linux environment with the same exclusions. Null when there is no data. */
export async function measureDistroBackup(run: DistroHelperRun, paths: DistroResetPaths): Promise<BackupMeasure | null> {
  const result = await run('measure', { ...helperInput(paths), excludes: RUNTIME_BACKUP_EXCLUDES }, { timeoutMs: 10 * 60 * 1000 });
  if (result.code !== 0) throw new Error('ElastOS could not measure its data.');
  const parsed = parseJson<{ present: boolean; files?: number; bytes?: number; nameBytes?: number }>(result.stdout);
  if (!parsed.present) return null;
  const files = Number(parsed.files);
  const bytes = Number(parsed.bytes);
  const nameBytes = Number(parsed.nameBytes);
  if (![files, bytes, nameBytes].every((n) => Number.isSafeInteger(n) && n >= 0)) {
    throw new Error('ElastOS could not measure its data.');
  }
  return { files, bytes, neededBytes: backupNeededBytes(files, bytes, nameBytes) };
}

/**
 * Owner-only access on Windows, the same intent as mode 0700 and 0600:
 * remove inherited and other entries, then grant full control to this
 * account's SID only. A failure stops the copy.
 */
export type RestrictToOwner = (target: string, folder: boolean) => void;

export function currentUserSid(run: (file: string, args: string[]) => string = defaultExec): string {
  const out = run('whoami.exe', ['/user', '/fo', 'csv', '/nh']);
  const match = /"(S-1-\d+(?:-\d+)+)"/.exec(out);
  if (!match) throw new Error('ElastOS could not find this Windows account.');
  return match[1];
}

export function ownerOnlyAclArgs(target: string, sid: string, folder: boolean): string[][] {
  if (!/^S-1-\d+(?:-\d+)+$/.test(sid)) throw new Error('ElastOS could not find this Windows account.');
  return [
    [target, '/reset', '/q'],
    [target, '/inheritance:r', '/grant:r', `*${sid}:${folder ? '(OI)(CI)F' : 'F'}`, '/q'],
  ];
}

function defaultExec(file: string, args: string[]): string {
  return execFileSync(file, args, { encoding: 'utf8', windowsHide: true, timeout: 30_000 });
}

export function windowsRestrictToOwner(
  run: (file: string, args: string[]) => string = defaultExec,
): RestrictToOwner {
  let sid: string | null = null;
  return (target, folder) => {
    try {
      sid = sid ?? currentUserSid(run);
      for (const args of ownerOnlyAclArgs(target, sid, folder)) run('icacls.exe', args);
    } catch {
      throw new Error(`ElastOS could not make ${target} private to this Windows account.`);
    }
  };
}

/**
 * Save the copy in `<Windows home>/ElastOS-backups`. The zip is written by
 * the helper inside the Linux environment straight into a new file here, so
 * the Linux side needs no extra space. The name never replaces a file. The
 * whole zip is read back and every CRC checked before it counts as saved.
 */
export async function writeDistroBackup(input: {
  run: DistroHelperRun;
  paths: DistroResetPaths;
  home: string;
  restrict: RestrictToOwner;
  now?: Date;
  platform?: string;
  freeBytes?: (dir: string) => number | null;
}): Promise<string | null> {
  const measured = await measureDistroBackup(input.run, input.paths);
  if (!measured) return null;
  const folder = prepareBackupFolder(input.home, input.paths.dataDir, input.platform);
  input.restrict(folder, true);
  const free = (input.freeBytes ?? freeBytesAt)(folder);
  if (free == null || free < measured.neededBytes) throw new BackupSpaceError(measured.neededBytes, free);
  const stamp = backupStamp(input.now ?? new Date());
  let dest: string | null = null;
  let fd: number | null = null;
  for (let attempt = 1; attempt <= MAX_BACKUP_ATTEMPTS && fd == null; attempt += 1) {
    const candidate = path.join(folder, backupFileName(stamp, attempt));
    try {
      fd = fs.openSync(candidate, 'wx', 0o600);
      dest = candidate;
    } catch (err) {
      if (err && typeof err === 'object' && (err as { code?: string }).code === 'EEXIST') continue;
      throw err;
    }
  }
  if (fd == null || dest == null) throw new Error(TOO_MANY_BACKUPS);
  try {
    try {
      input.restrict(dest, false);
      const result = await input.run(
        'zip',
        { ...helperInput(input.paths), excludes: RUNTIME_BACKUP_EXCLUDES },
        { outFd: fd, timeoutMs: 6 * 60 * 60 * 1000 },
      );
      if (result.code !== 0) throw new Error('The copy could not be read from the Linux environment.');
      const counted = /ELASTOS-ZIP-ENTRIES (\d+)/.exec(result.stderr);
      if (!counted) throw new Error('The copy could not be read from the Linux environment.');
      fs.fsyncSync(fd);
      fs.closeSync(fd);
      fd = null;
      const entries = readStoredZipEntries(dest);
      if (entries.length !== Number(counted[1])) throw new Error('The copy of your data is not a complete zip file.');
      for (const entry of entries) {
        // A Linux name may hold a backslash, which Windows reads as a folder break, so check both.
        const parts = entry.name.split(/[\\/]/);
        if (parts[0] !== 'elastos' || parts.length < 2 || parts.some((part) => part === '..')) {
          throw new Error('The copy of your data is not a complete zip file.');
        }
      }
      verifyStoredZip(dest, entries);
      fs.chmodSync(dest, 0o600);
    } finally {
      if (fd != null) fs.closeSync(fd);
    }
  } catch (err) {
    fs.rmSync(dest, { force: true });
    throw err;
  }
  return dest;
}

/** False with no wsl.exe. Null when wsl.exe is there but the distro list could not be read. */
export async function elastosDistroPresent(
  list: () => Promise<string> = listDistros,
  hasWsl: () => Promise<boolean> = () => lookupCommand('wsl.exe'),
): Promise<boolean | null> {
  if (!(await hasWsl())) return false;
  const text = (await list()).replace(/\0/g, '');
  if (!text.trim()) return null;
  return parseWslDistroList(text).some((row) => row.name === DISTRO_NAME);
}

function messageOf(err: unknown): string {
  const text = err instanceof Error ? err.message : String(err);
  return text.replace(/\.$/, '');
}

/**
 * Reset on Windows. The ElastOS data lives in the ElastOS Linux environment,
 * so this resets it there, and then removes the launcher's own files on
 * Windows. The Linux environment itself stays; removing it is Uninstall's
 * job. The order matches Mac and Linux: answer, ownership, space, Stop,
 * copy, delete.
 */
export async function resetRuntimeInDistro(deps: {
  backup: unknown;
  homeDir: string;
  platform?: string;
  env?: NodeJS.ProcessEnv;
  paths?: DistroResetPaths;
  stop: () => Promise<void>;
  distroPresent: () => Promise<boolean | null>;
  inspect: () => Promise<DistroInspection>;
  maintainerDid: string | null;
  /** Runs before Stop. Throws when the copy cannot fit. */
  checkBackupSpace?: () => Promise<void>;
  /** Runs after Stop and before any delete. */
  saveBackup?: () => Promise<string | null>;
  removeInDistro: (plan: DistroRemovalPlan) => Promise<unknown>;
  removeHost: (target: string) => void;
  sweepHost?: (parent: string) => void;
  lstat?: (file: string) => RemovalStat;
}): Promise<ResetResult> {
  if (typeof deps.backup !== 'boolean') throw new Error(RESET_CHOICE_MESSAGE);
  const wantsBackup = deps.backup;
  if (wantsBackup && !deps.saveBackup) {
    throw new Error('ElastOS was not reset. A copy of your data cannot be saved here. Nothing was deleted.');
  }
  const paths = deps.paths ?? distroResetPaths();
  const platform = deps.platform ?? 'win32';
  const env = deps.env ?? {};
  const hostFiles = [
    runtimeInstallStagePath(deps.homeDir),
    runtimeResumeInstallPath(deps.homeDir),
    runtimeResumeInstallLockPath(deps.homeDir),
  ];
  for (const file of hostFiles) {
    if (!launcherOwnedDirectories(file, deps.homeDir, platform, env)) {
      throw new Error('Refusing to remove a file that is not an ElastOS launcher file.');
    }
  }
  const present = await deps.distroPresent();
  if (present == null) {
    throw new Error('ElastOS was not reset because it could not check its Linux environment. Nothing was deleted. Try again.');
  }
  if (present) {
    distroRemovalPlan(await deps.inspect(), paths, deps.maintainerDid);
    if (wantsBackup && deps.checkBackupSpace) {
      try {
        await deps.checkBackupSpace();
      } catch (err) {
        throw new Error(`ElastOS was not reset. ${messageOf(err)}. Nothing was deleted. Free some space, or reset without a copy.`);
      }
    }
  }
  try {
    await deps.stop();
  } catch (err) {
    if (isForeignGatewayError(err)) {
      throw new Error('ElastOS is still running in another window. Quit it, then reset.');
    }
    throw err;
  }
  let backupPath: string | null = null;
  if (present) {
    if (wantsBackup && deps.saveBackup) {
      try {
        backupPath = await deps.saveBackup();
      } catch (err) {
        throw new Error(`ElastOS was not reset. The copy of your data could not be saved (${messageOf(err)}). Nothing was deleted.`);
      }
    }
    // Look again after Stop and the copy, and delete only what this look proved.
    const plan = distroRemovalPlan(await deps.inspect(), paths, deps.maintainerDid);
    try {
      await deps.removeInDistro(plan);
    } catch (err) {
      if (!backupPath) throw err;
      throw new Error(`${messageOf(err)}. Your copy of your data is in ${backupPath}.`);
    }
  }
  const lstat = deps.lstat ?? fs.lstatSync;
  for (const file of hostFiles) {
    assertNoSymlinkAncestors(file, lstat);
    assertStableRemovalTarget(file, lstat);
  }
  for (const file of hostFiles) deps.removeHost(file);
  (deps.sweepHost ?? sweepRemovalHoldings)(path.dirname(hostFiles[0]));
  return { backupPath };
}

export function describeDistroBackupOnThisComputer(): Promise<BackupDescription> {
  return describeDistroBackup({ run: wslHelperRun(), home: os.homedir() });
}

export async function describeDistroBackup(input: {
  run: DistroHelperRun;
  home: string;
  paths?: DistroResetPaths;
  distroPresent?: () => Promise<boolean | null>;
  freeBytes?: (dir: string) => number | null;
}): Promise<BackupDescription> {
  const present = await (input.distroPresent ?? (() => elastosDistroPresent()))();
  if (present === false) return describeMeasuredBackup(null, input.home, input.freeBytes);
  const measured = await measureDistroBackup(input.run, input.paths ?? distroResetPaths());
  return describeMeasuredBackup(measured, input.home, input.freeBytes);
}

/** The worker job body for `write-distro`. */
export function writeDistroBackupOnThisComputer(home: string = os.homedir()): Promise<string | null> {
  return writeDistroBackup({
    run: wslHelperRun(),
    paths: distroResetPaths(),
    home,
    restrict: windowsRestrictToOwner(),
  });
}

export async function resetRuntimeInDistroOnThisComputer(
  stop: () => Promise<void>,
  choice: { backup?: unknown } = {},
): Promise<ResetResult> {
  const home = os.homedir();
  const run = wslHelperRun();
  const paths = distroResetPaths();
  return resetRuntimeInDistro({
    backup: choice.backup,
    homeDir: home,
    platform: process.platform,
    env: process.env,
    paths,
    stop,
    distroPresent: () => elastosDistroPresent(),
    inspect: () => inspectDistro(run, paths),
    maintainerDid: pinnedMaintainerDid(),
    checkBackupSpace: async () => {
      const seen = describeMeasuredBackup(await measureDistroBackup(run, paths), home);
      if (seen.present && !seen.enough) throw new BackupSpaceError(seen.neededBytes, seen.freeBytes);
    },
    saveBackup: () => runBackupWorker<string | null>({ op: 'write-distro', home, dataDir: paths.dataDir }, 6 * 60 * 60 * 1000),
    removeInDistro: (plan) => removeInDistro(run, paths, plan),
    removeHost: (target) => removeVerifiedTarget(target),
  });
}
