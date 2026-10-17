import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { assertBackupSpace, writeRuntimeBackupOnThisComputer } from './runtimeBackup';
import { isForeignGatewayError } from './runtimeGateway';
import {
  foreignRuntimeDataMessage,
  launcherOwnedDirectories,
  runtimeBinaryPath,
  runtimeDataDir,
  runtimeInstallStagePath,
  runtimeResumeInstallLockPath,
  runtimeResumeInstallPath,
} from './runtimePaths';

export interface RemovalStat {
  isSymbolicLink(): boolean;
  isDirectory?: () => boolean;
  dev?: number;
  ino?: number;
}

function statErrorCode(err: unknown): string {
  if (err && typeof err === 'object' && 'code' in err) return String((err as { code?: string }).code);
  return '';
}

export function assertNoSymlinkAncestors(
  target: string,
  lstat: (file: string) => RemovalStat,
): void {
  const resolved = path.resolve(target);
  const root = path.parse(resolved).root;
  let cursor = root;
  const parts = resolved.slice(root.length).split(path.sep).filter(Boolean);
  for (const part of parts) {
    cursor = path.join(cursor, part);
    let st: RemovalStat;
    try {
      st = lstat(cursor);
    } catch (err) {
      if (statErrorCode(err) === 'ENOENT') continue;
      throw new Error('Refusing to remove a path that could not be inspected.');
    }
    if (st.isSymbolicLink()) {
      throw new Error('Refusing to remove a path that follows a symlink.');
    }
  }
}

/** Re-stat the leaf immediately before delete. A failed lstat refuses the delete. */
export function assertStableRemovalTarget(
  target: string,
  lstat: (file: string) => RemovalStat,
): void {
  let first: RemovalStat;
  try {
    first = lstat(target);
  } catch (err) {
    if (statErrorCode(err) === 'ENOENT') return;
    throw new Error('Refusing to remove a path that could not be inspected.');
  }
  if (first.isSymbolicLink()) {
    throw new Error('Refusing to remove a path that follows a symlink.');
  }
  let second: RemovalStat;
  try {
    second = lstat(target);
  } catch {
    throw new Error('Refusing to remove a path that could not be inspected.');
  }
  if (second.isSymbolicLink() || second.dev !== first.dev || second.ino !== first.ino) {
    throw new Error('Refusing to remove a path that changed.');
  }
}

export function assertSafeRuntimeRemoval(
  binary: string,
  dataDir: string,
  homeDir: string = os.homedir(),
  platform: string = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): void {
  if (path.basename(dataDir) !== 'elastos' || !launcherOwnedDirectories(dataDir, homeDir, platform, env)) {
    const named = foreignRuntimeDataMessage(dataDir, homeDir, platform, env);
    if (named) throw new Error(named);
    throw new Error('Refusing to remove a directory that is not the ElastOS data directory.');
  }
  if (path.basename(binary) !== 'elastos' || !launcherOwnedDirectories(binary, homeDir, platform, env)) {
    throw new Error('Refusing to remove a file that is not the ElastOS program.');
  }
}

function removalContext(deps: {
  homeDir?: string;
  platform?: string;
  env?: NodeJS.ProcessEnv;
}): { homeDir: string; platform: string; env: NodeJS.ProcessEnv } {
  return {
    homeDir: deps.homeDir ?? os.homedir(),
    platform: deps.platform ?? process.platform,
    env: deps.env ?? process.env,
  };
}

function openFlags(directory: boolean): number {
  if (typeof fs.constants.O_NOFOLLOW !== 'number') {
    throw new Error('Refusing to remove a path that could not be inspected.');
  }
  return fs.constants.O_RDONLY
    | fs.constants.O_NOFOLLOW
    | (directory && typeof fs.constants.O_DIRECTORY === 'number' ? fs.constants.O_DIRECTORY : 0);
}

function sameInode(left: RemovalStat, right: RemovalStat): boolean {
  return !left.isSymbolicLink()
    && !right.isSymbolicLink()
    && left.dev === right.dev
    && left.ino === right.ino;
}

/**
 * Put the holding name back only when the original name is empty. Replacing a
 * file or directory that appeared there would delete whatever is in it now.
 */
function restoreHoldingName(
  holding: string,
  target: string,
  lstat: (file: string) => RemovalStat,
  rename: (from: string, to: string) => void,
): void {
  let blocked = false;
  try {
    lstat(target);
    blocked = true;
  } catch (err) {
    if (statErrorCode(err) !== 'ENOENT') blocked = true;
  }
  if (!blocked) {
    try {
      rename(holding, target);
      throw new Error('Refusing to remove a path that changed.');
    } catch (err) {
      if (err instanceof Error && /changed/.test(err.message)) throw err;
    }
  }
  throw new Error(`Refusing to remove a path that changed. The folder is still at ${holding}.`);
}

interface RemoveTargetDeps {
  lstat?: (file: string) => RemovalStat;
  rename?: (from: string, to: string) => void;
  remove?: (file: string) => void;
  open?: (file: string, flags: number) => number;
  close?: (fd: number) => void;
  realpath?: (file: string) => string;
  platform?: string;
  beforeRename?: () => void;
  afterHoldingCheck?: () => void;
}

/**
 * Open the real file with O_NOFOLLOW, rename it aside, and delete that holding
 * name only when a second O_NOFOLLOW open is still the same inode. A name that
 * was swapped for a symlink is not deleted. Rename-back does not replace a
 * path that reappeared. A failed delete names the holding path so the next
 * Reset can remove that same inode.
 *
 * Windows has no O_NOFOLLOW and cannot open a directory this way. There the
 * real path and the file index must still match, a directory is not opened,
 * and a file is opened read-only. The last delete is still the holding path.
 */
export function removeVerifiedTarget(target: string, deps: RemoveTargetDeps = {}): void {
  if ((deps.platform ?? process.platform) === 'win32') {
    removeVerifiedWindows(target, deps);
    return;
  }
  const lstat = deps.lstat ?? fs.lstatSync;
  const rename = deps.rename ?? fs.renameSync;
  const remove = deps.remove ?? ((file: string) => fs.rmSync(file, { recursive: true, force: true }));
  let first: RemovalStat;
  try {
    first = lstat(target);
  } catch (err) {
    if (statErrorCode(err) === 'ENOENT') return;
    throw new Error('Refusing to remove a path that could not be inspected.');
  }
  if (first.isSymbolicLink()) {
    throw new Error('Refusing to remove a path that follows a symlink.');
  }
  const flags = openFlags(Boolean(first.isDirectory?.()));
  let fd: number | null = null;
  let holdingFd: number | null = null;
  try {
    try {
      fd = fs.openSync(target, flags);
    } catch (err) {
      if (statErrorCode(err) === 'ENOENT') return;
      if (statErrorCode(err) === 'ELOOP') {
        throw new Error('Refusing to remove a path that follows a symlink.');
      }
      throw new Error('Refusing to remove a path that could not be inspected.');
    }
    const opened = fs.fstatSync(fd);
    if (!sameInode(opened, first)) {
      throw new Error('Refusing to remove a path that changed.');
    }
    deps.beforeRename?.();
    const holding = path.join(
      path.dirname(target),
      `.elastos-removing-${process.pid}-${crypto.randomBytes(8).toString('hex')}-${path.basename(target)}`,
    );
    try {
      rename(target, holding);
    } catch (err) {
      if (statErrorCode(err) === 'ENOENT') return;
      throw new Error('Refusing to remove a path that could not be inspected.');
    }
    deps.afterHoldingCheck?.();
    let named: RemovalStat;
    try {
      named = lstat(holding);
    } catch {
      throw new Error(`Refusing to remove a path that could not be inspected. The folder is still at ${holding}.`);
    }
    if (named.isSymbolicLink()) {
      throw new Error(`Refusing to remove a path that follows a symlink. The folder is still at ${holding}.`);
    }
    try {
      holdingFd = fs.openSync(holding, flags);
    } catch (err) {
      if (statErrorCode(err) === 'ELOOP') {
        throw new Error(`Refusing to remove a path that follows a symlink. The folder is still at ${holding}.`);
      }
      throw new Error(`Refusing to remove a path that could not be inspected. The folder is still at ${holding}.`);
    }
    const reopened = fs.fstatSync(holdingFd);
    const still = fs.fstatSync(fd);
    if (!sameInode(named, reopened) || !sameInode(reopened, still) || !sameInode(still, first)) {
      restoreHoldingName(holding, target, lstat, rename);
    }
    const beforeDelete = fs.fstatSync(holdingFd);
    let current: RemovalStat;
    try {
      current = lstat(holding);
    } catch {
      throw new Error(`Refusing to remove a path that could not be inspected. The folder is still at ${holding}.`);
    }
    if (!sameInode(current, beforeDelete) || !sameInode(beforeDelete, still)) {
      restoreHoldingName(holding, target, lstat, rename);
    }
    try {
      remove(holding);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(`ElastOS could not finish removing ${holding}. ${message}`);
    }
  } finally {
    if (holdingFd != null) fs.closeSync(holdingFd);
    if (fd != null) fs.closeSync(fd);
  }
}

function removeVerifiedWindows(target: string, deps: RemoveTargetDeps): void {
  const lstat = deps.lstat ?? fs.lstatSync;
  const realpath = deps.realpath ?? ((file: string) => fs.realpathSync(file));
  const open = deps.open ?? ((file: string, flags: number) => fs.openSync(file, flags));
  const close = deps.close ?? fs.closeSync;
  const rename = deps.rename ?? fs.renameSync;
  const remove = deps.remove ?? ((file: string) => fs.rmSync(file, { recursive: true, force: true }));
  let first: RemovalStat;
  try {
    first = lstat(target);
  } catch (err) {
    if (statErrorCode(err) === 'ENOENT') return;
    throw new Error('Refusing to remove a path that could not be inspected.');
  }
  if (first.isSymbolicLink()) {
    throw new Error('Refusing to remove a path that follows a symlink.');
  }
  const directory = Boolean(first.isDirectory?.());
  let resolved: string;
  try {
    resolved = realpath(target);
  } catch {
    throw new Error('Refusing to remove a path that could not be inspected.');
  }
  let resolvedStat: RemovalStat;
  try {
    resolvedStat = lstat(resolved);
  } catch {
    throw new Error('Refusing to remove a path that could not be inspected.');
  }
  if (resolvedStat.isSymbolicLink() || !sameInode(resolvedStat, first)) {
    throw new Error('Refusing to remove a path that changed.');
  }
  const flags = fs.constants.O_RDONLY;
  let fd: number | null = null;
  let holdingFd: number | null = null;
  try {
    if (!directory) {
      try {
        fd = open(resolved, flags);
      } catch (err) {
        if (statErrorCode(err) === 'ENOENT') return;
        throw new Error('Refusing to remove a path that could not be inspected.');
      }
      const opened = fs.fstatSync(fd);
      if (!sameInode(opened, first)) {
        throw new Error('Refusing to remove a path that changed.');
      }
    }
    deps.beforeRename?.();
    const holding = path.join(
      path.dirname(target),
      `.elastos-removing-${process.pid}-${crypto.randomBytes(8).toString('hex')}-${path.basename(target)}`,
    );
    try {
      rename(target, holding);
    } catch (err) {
      if (statErrorCode(err) === 'ENOENT') return;
      throw new Error('Refusing to remove a path that could not be inspected.');
    }
    deps.afterHoldingCheck?.();
    let named: RemovalStat;
    try {
      named = lstat(holding);
    } catch {
      throw new Error(`Refusing to remove a path that could not be inspected. The folder is still at ${holding}.`);
    }
    if (named.isSymbolicLink() || !sameInode(named, first)) {
      restoreHoldingName(holding, target, lstat, rename);
    }
    let holdingResolved: string;
    try {
      holdingResolved = realpath(holding);
    } catch {
      throw new Error(`Refusing to remove a path that could not be inspected. The folder is still at ${holding}.`);
    }
    let holdingStat: RemovalStat;
    try {
      holdingStat = lstat(holdingResolved);
    } catch {
      throw new Error(`Refusing to remove a path that could not be inspected. The folder is still at ${holding}.`);
    }
    if (holdingStat.isSymbolicLink() || !sameInode(holdingStat, named)) {
      restoreHoldingName(holding, target, lstat, rename);
    }
    if (!directory) {
      try {
        holdingFd = open(holding, flags);
      } catch (err) {
        if (statErrorCode(err) === 'ELOOP') {
          throw new Error(`Refusing to remove a path that follows a symlink. The folder is still at ${holding}.`);
        }
        throw new Error(`Refusing to remove a path that could not be inspected. The folder is still at ${holding}.`);
      }
      const reopened = fs.fstatSync(holdingFd);
      const still = fd == null ? reopened : fs.fstatSync(fd);
      if (!sameInode(reopened, still) || !sameInode(still, first)) {
        restoreHoldingName(holding, target, lstat, rename);
      }
    }
    try {
      remove(holding);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(`ElastOS could not finish removing ${holding}. ${message}`);
    }
  } finally {
    if (holdingFd != null) close(holdingFd);
    if (fd != null) close(fd);
  }
}

const OWNED_HOLDING_SUFFIX =
  /^(?:elastos|install-stage\.json|resume-install\.json|resume-install\.json\.lock|ElastOS-support\.txt|host-process\.lock|components\.json)$/;

function holdingPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return statErrorCode(err) === 'EPERM';
  }
}

/** A holding this process wrote for a known runtime name, whose other owner is gone. */
export function removalHoldingOwned(
  name: string,
  pidAlive: (pid: number) => boolean = holdingPidAlive,
): boolean {
  if (name.includes('\0') || name.includes('/') || name.includes('\\')) return false;
  const match = /^\.elastos-removing-(\d+)-[0-9a-f]{16}-(.+)$/.exec(name);
  if (!match || !OWNED_HOLDING_SUFFIX.test(match[2])) return false;
  const pid = Number(match[1]);
  if (!Number.isInteger(pid) || pid <= 0) return false;
  if (pid === process.pid) return true;
  return !pidAlive(pid);
}

/** Delete leftover holdings this launcher owns. A live other process is left alone. */
export function sweepRemovalHoldings(
  parent: string,
  options: { pidAlive?: (pid: number) => boolean } = {},
): void {
  let names: string[] = [];
  try {
    names = fs.readdirSync(parent);
  } catch {
    return;
  }
  const leftovers: string[] = [];
  for (const name of names) {
    if (!removalHoldingOwned(name, options.pidAlive)) continue;
    const full = path.join(parent, name);
    try {
      removeVerifiedTarget(full);
    } catch {
      leftovers.push(full);
    }
  }
  if (leftovers.length > 0) {
    throw new Error(`ElastOS could not finish removing ${leftovers.join(', ')}.`);
  }
}

export async function uninstallRuntime(deps: {
  binary: string;
  dataDir: string;
  stop: () => Promise<void>;
  remove: (target: string) => void;
  lstat?: (file: string) => RemovalStat;
  homeDir?: string;
  platform?: string;
  env?: NodeJS.ProcessEnv;
}): Promise<void> {
  const owned = removalContext(deps);
  assertSafeRuntimeRemoval(deps.binary, deps.dataDir, owned.homeDir, owned.platform, owned.env);
  try {
    await deps.stop();
  } catch (err) {
    if (isForeignGatewayError(err)) {
      throw new Error('ElastOS is still running in another window. Quit it, then uninstall.');
    }
    throw err;
  }
  const lstat = deps.lstat ?? fs.lstatSync;
  assertNoSymlinkAncestors(deps.binary, lstat);
  assertNoSymlinkAncestors(deps.dataDir, lstat);
  assertStableRemovalTarget(deps.binary, lstat);
  assertStableRemovalTarget(deps.dataDir, lstat);
  deps.remove(deps.binary);
  deps.remove(deps.dataDir);
}

export const RESET_CHOICE_MESSAGE =
  'Choose whether to save a copy of your ElastOS data first. Nothing was reset.';

export interface ResetResult {
  /** The backup zip, when the person chose one and the data folder existed. */
  backupPath: string | null;
}

export async function resetRuntime(deps: {
  binary: string;
  dataDir: string;
  stageFile: string;
  stop: () => Promise<void>;
  remove: (target: string) => void;
  /** The person's answer to "Save a copy of your ElastOS data first". Anything but a boolean refuses Reset. */
  backup: unknown;
  /** Runs before Stop. Throws when the copy cannot fit. */
  checkBackupSpace?: (dataDir: string) => void | Promise<void>;
  /** Writes the copy after Stop and before any delete. Returns its path, or null when there is no data. */
  saveBackup?: (dataDir: string) => Promise<string | null>;
  lstat?: (file: string) => RemovalStat;
  homeDir?: string;
  platform?: string;
  env?: NodeJS.ProcessEnv;
}): Promise<ResetResult> {
  if (typeof deps.backup !== 'boolean') throw new Error(RESET_CHOICE_MESSAGE);
  const wantsBackup = deps.backup;
  if (wantsBackup && !deps.saveBackup) {
    throw new Error('ElastOS was not reset. A copy of your data cannot be saved here. Nothing was deleted.');
  }
  const owned = removalContext(deps);
  assertSafeRuntimeRemoval(deps.binary, deps.dataDir, owned.homeDir, owned.platform, owned.env);
  if (path.basename(deps.stageFile) !== 'install-stage.json' || !launcherOwnedDirectories(deps.stageFile, owned.homeDir, owned.platform, owned.env)) {
    throw new Error('Refusing to remove a file that is not the ElastOS install stage.');
  }
  const resumeFile = runtimeResumeInstallPath(owned.homeDir);
  const resumeLock = runtimeResumeInstallLockPath(owned.homeDir);
  if (path.basename(resumeFile) !== 'resume-install.json' || !launcherOwnedDirectories(resumeFile, owned.homeDir, owned.platform, owned.env)) {
    throw new Error('Refusing to remove a file that is not the ElastOS install resume.');
  }
  if (path.basename(resumeLock) !== 'resume-install.json.lock' || !launcherOwnedDirectories(resumeLock, owned.homeDir, owned.platform, owned.env)) {
    throw new Error('Refusing to remove a file that is not the ElastOS install resume.');
  }
  if (wantsBackup && deps.checkBackupSpace) {
    try {
      await deps.checkBackupSpace(deps.dataDir);
    } catch (err) {
      throw new Error(`ElastOS was not reset. ${messageOf(err)}. Nothing was deleted. Free some space, or reset without a copy.`);
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
  if (wantsBackup && deps.saveBackup) {
    try {
      backupPath = await deps.saveBackup(deps.dataDir);
    } catch (err) {
      throw new Error(`ElastOS was not reset. The copy of your data could not be saved (${messageOf(err)}). Nothing was deleted.`);
    }
  }
  const lstat = deps.lstat ?? fs.lstatSync;
  assertNoSymlinkAncestors(deps.binary, lstat);
  assertNoSymlinkAncestors(deps.dataDir, lstat);
  assertNoSymlinkAncestors(deps.stageFile, lstat);
  assertNoSymlinkAncestors(resumeFile, lstat);
  assertNoSymlinkAncestors(resumeLock, lstat);
  assertStableRemovalTarget(deps.binary, lstat);
  assertStableRemovalTarget(deps.dataDir, lstat);
  assertStableRemovalTarget(deps.stageFile, lstat);
  assertStableRemovalTarget(resumeFile, lstat);
  assertStableRemovalTarget(resumeLock, lstat);
  deps.remove(deps.binary);
  deps.remove(deps.dataDir);
  deps.remove(deps.stageFile);
  deps.remove(resumeFile);
  deps.remove(resumeLock);
  for (const parent of new Set([
    path.dirname(deps.binary),
    path.dirname(deps.dataDir),
    path.dirname(deps.stageFile),
    path.dirname(resumeFile),
  ])) {
    sweepRemovalHoldings(parent);
  }
  return { backupPath };
}

function messageOf(err: unknown): string {
  const text = err instanceof Error ? err.message : String(err);
  return text.replace(/\.$/, '');
}

export async function resetRuntimeOnThisComputer(
  stop: () => Promise<void>,
  choice: { backup?: unknown } = {},
): Promise<ResetResult> {
  const home = os.homedir();
  return resetRuntime({
    binary: runtimeBinaryPath(home),
    dataDir: runtimeDataDir(process.platform, home, process.env),
    stageFile: runtimeInstallStagePath(home),
    homeDir: home,
    platform: process.platform,
    env: process.env,
    stop,
    backup: choice.backup,
    checkBackupSpace: (dataDir) => assertBackupSpace({ dataDir, home }),
    saveBackup: (dataDir) => writeRuntimeBackupOnThisComputer(dataDir),
    remove: (target) => removeVerifiedTarget(target),
  });
}
