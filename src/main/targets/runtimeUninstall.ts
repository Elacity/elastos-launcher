import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { isForeignGatewayError } from './runtimeGateway';
import {
  launcherOwnedDirectories,
  runtimeBinaryPath,
  runtimeDataDir,
  runtimeInstallStagePath,
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

/**
 * Open the real file with O_NOFOLLOW, rename it aside, and delete that holding
 * name only when a second O_NOFOLLOW open is still the same inode. A name that
 * was swapped for a symlink is not deleted. Rename-back does not replace a
 * path that reappeared. A failed delete names the holding path so the next
 * Reset can remove that same inode.
 */
export function removeVerifiedTarget(
  target: string,
  deps: {
    lstat?: (file: string) => RemovalStat;
    rename?: (from: string, to: string) => void;
    remove?: (file: string) => void;
    beforeRename?: () => void;
    afterHoldingCheck?: () => void;
  } = {},
): void {
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

const HOLDING_PREFIX = '.elastos-removing-';

/** Delete leftover holding names in an owned parent, each one bound to its open inode. */
export function sweepRemovalHoldings(parent: string): void {
  let names: string[] = [];
  try {
    names = fs.readdirSync(parent);
  } catch {
    return;
  }
  const leftovers: string[] = [];
  for (const name of names) {
    if (!name.startsWith(HOLDING_PREFIX) || name.includes('\0') || name.includes('/') || name.includes('\\')) continue;
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

export async function resetRuntime(deps: {
  binary: string;
  dataDir: string;
  stageFile: string;
  stop: () => Promise<void>;
  remove: (target: string) => void;
  lstat?: (file: string) => RemovalStat;
  homeDir?: string;
  platform?: string;
  env?: NodeJS.ProcessEnv;
}): Promise<void> {
  const owned = removalContext(deps);
  assertSafeRuntimeRemoval(deps.binary, deps.dataDir, owned.homeDir, owned.platform, owned.env);
  if (path.basename(deps.stageFile) !== 'install-stage.json' || !launcherOwnedDirectories(deps.stageFile, owned.homeDir, owned.platform, owned.env)) {
    throw new Error('Refusing to remove a file that is not the ElastOS install stage.');
  }
  const resumeFile = runtimeResumeInstallPath(owned.homeDir);
  if (path.basename(resumeFile) !== 'resume-install.json' || !launcherOwnedDirectories(resumeFile, owned.homeDir, owned.platform, owned.env)) {
    throw new Error('Refusing to remove a file that is not the ElastOS install resume.');
  }
  try {
    await deps.stop();
  } catch (err) {
    if (isForeignGatewayError(err)) {
      throw new Error('ElastOS is still running in another window. Quit it, then reset.');
    }
    throw err;
  }
  const lstat = deps.lstat ?? fs.lstatSync;
  assertNoSymlinkAncestors(deps.binary, lstat);
  assertNoSymlinkAncestors(deps.dataDir, lstat);
  assertNoSymlinkAncestors(deps.stageFile, lstat);
  assertNoSymlinkAncestors(resumeFile, lstat);
  for (const parent of new Set([
    path.dirname(deps.binary),
    path.dirname(deps.dataDir),
    path.dirname(deps.stageFile),
    path.dirname(resumeFile),
  ])) {
    sweepRemovalHoldings(parent);
  }
  assertStableRemovalTarget(deps.binary, lstat);
  assertStableRemovalTarget(deps.dataDir, lstat);
  assertStableRemovalTarget(deps.stageFile, lstat);
  assertStableRemovalTarget(resumeFile, lstat);
  deps.remove(deps.binary);
  deps.remove(deps.dataDir);
  deps.remove(deps.stageFile);
  deps.remove(resumeFile);
}

export async function resetRuntimeOnThisComputer(stop: () => Promise<void>): Promise<void> {
  const home = os.homedir();
  await resetRuntime({
    binary: runtimeBinaryPath(home),
    dataDir: runtimeDataDir(process.platform, home, process.env),
    stageFile: runtimeInstallStagePath(home),
    homeDir: home,
    platform: process.platform,
    env: process.env,
    stop,
    remove: (target) => removeVerifiedTarget(target),
  });
}
