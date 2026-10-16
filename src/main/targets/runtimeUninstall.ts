import * as path from 'path';

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
