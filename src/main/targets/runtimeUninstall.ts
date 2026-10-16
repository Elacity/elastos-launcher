import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { runtimeBinaryPath, runtimeDataDir, runtimeInstallStagePath } from './runtimePaths';

export function assertSafeRuntimeRemoval(binary: string, dataDir: string): void {
  if (path.basename(dataDir) !== 'elastos') {
    throw new Error('Refusing to remove a directory that is not the ElastOS data directory.');
  }
  if (dataDir.includes(`${path.sep}.pc2`) || dataDir.includes(`${path.sep}pc2.net`)) {
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
  deps.remove(deps.binary);
  deps.remove(deps.dataDir);
}

export async function resetRuntime(deps: {
  binary: string;
  dataDir: string;
  stageFile: string;
  stop: () => Promise<void>;
  remove: (target: string) => void;
}): Promise<void> {
  assertSafeRuntimeRemoval(deps.binary, deps.dataDir);
  if (path.basename(deps.stageFile) !== 'install-stage.json') {
    throw new Error('Refusing to remove a file that is not the ElastOS install stage.');
  }
  const stage = deps.stageFile.split(path.sep).join('/');
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
