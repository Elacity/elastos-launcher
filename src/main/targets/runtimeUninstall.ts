import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { runtimeBinaryPath, runtimeDataDir, runtimeInstallStagePath } from './runtimePaths';

export function mentionsPc2(file: string): boolean {
  const normalized = file.split('\\').join('/');
  return normalized.includes('/.pc2/') || normalized.includes('/pc2.net/');
}

export interface RemovalStat {
  isSymbolicLink(): boolean;
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

export function assertSafeRuntimeRemoval(binary: string, dataDir: string): void {
  if (path.basename(dataDir) !== 'elastos') {
    throw new Error('Refusing to remove a directory that is not the ElastOS data directory.');
  }
  if (mentionsPc2(dataDir) || mentionsPc2(binary)) {
    throw new Error('Refusing to remove the PC2 directory.');
  }
  if (path.basename(binary) !== 'elastos') {
    throw new Error('Refusing to remove a file that is not the ElastOS program.');
  }
}

export async function uninstallRuntime(deps: {
  binary: string;
  dataDir: string;
  stop: () => Promise<void>;
  remove: (target: string) => void;
  lstat?: (file: string) => RemovalStat;
}): Promise<void> {
  assertSafeRuntimeRemoval(deps.binary, deps.dataDir);
  try {
    await deps.stop();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes('did not start it')) {
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
}): Promise<void> {
  assertSafeRuntimeRemoval(deps.binary, deps.dataDir);
  if (path.basename(deps.stageFile) !== 'install-stage.json') {
    throw new Error('Refusing to remove a file that is not the ElastOS install stage.');
  }
  const stage = deps.stageFile.split('\\').join('/');
  if (stage.includes('/.pc2/') || stage.includes('/pc2.net/')) {
    throw new Error('Refusing to remove the PC2 directory.');
  }
  try {
    await deps.stop();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes('did not start it')) {
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
    stop,
    remove: (target) => fs.rmSync(target, { recursive: true, force: true }),
  });
}
