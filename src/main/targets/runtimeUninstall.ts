import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { isForeignGatewayError } from './runtimeGateway';
import { launcherOwnedDirectories, runtimeBinaryPath, runtimeDataDir, runtimeInstallStagePath } from './runtimePaths';

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

/**
 * Open the real file, rename whatever is now at that path, and delete the
 * holding name only when it is still the opened inode. A replacement is
 * renamed back. The open keeps the original inode from being reused.
 */
export function removeVerifiedTarget(
  target: string,
  deps: {
    lstat?: (file: string) => RemovalStat;
    rename?: (from: string, to: string) => void;
    remove?: (file: string) => void;
    beforeRename?: () => void;
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
  const flags = fs.constants.O_RDONLY
    | (fs.constants.O_NOFOLLOW ?? 0)
    | (first.isDirectory?.() ? (fs.constants.O_DIRECTORY ?? 0) : 0);
  let fd: number | null = null;
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
    if (opened.isSymbolicLink() || opened.dev !== first.dev || opened.ino !== first.ino) {
      throw new Error('Refusing to remove a path that changed.');
    }
    deps.beforeRename?.();
    const holding = path.join(
      path.dirname(target),
      `.elastos-removing-${process.pid}-${Date.now()}-${path.basename(target)}`,
    );
    try {
      rename(target, holding);
    } catch (err) {
      if (statErrorCode(err) === 'ENOENT') return;
      throw new Error('Refusing to remove a path that could not be inspected.');
    }
    let second: RemovalStat;
    try {
      second = lstat(holding);
    } catch {
      throw new Error('Refusing to remove a path that could not be inspected.');
    }
    const still = fs.fstatSync(fd);
    if (
      second.isSymbolicLink()
      || second.dev !== still.dev
      || second.ino !== still.ino
      || second.dev !== first.dev
      || second.ino !== first.ino
    ) {
      try {
        rename(holding, target);
      } catch {
        // The replacement stays under the holding name and is not deleted.
      }
      throw new Error('Refusing to remove a path that changed.');
    }
    remove(holding);
  } finally {
    if (fd != null) fs.closeSync(fd);
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
  assertStableRemovalTarget(deps.binary, lstat);
  assertStableRemovalTarget(deps.dataDir, lstat);
  assertStableRemovalTarget(deps.stageFile, lstat);
  deps.remove(deps.binary);
  deps.remove(deps.dataDir);
  deps.remove(deps.stageFile);
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
