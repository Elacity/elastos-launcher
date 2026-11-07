import * as pc2 from '../pc2Manager';
import { PC2_TARGET } from './descriptors';
import { LaunchTarget } from './types';

/** Delegates to the existing PC2 manager. Does not change those functions. */
export function createPc2Target(): LaunchTarget {
  return {
    id: 'pc2',
    descriptor: PC2_TARGET,
    isInstalled: () => pc2.isInstalled(),
    getStatus: () => pc2.getStatus(),
    start: () => pc2.startPC2(),
    stop: () => pc2.stopPC2(),
    restart: () => pc2.restartPC2(),
    install: (onProgress) => pc2.installPC2(onProgress),
    update: (onProgress) => pc2.updatePC2(onProgress),
    uninstall: () => pc2.uninstallPC2(),
    getVersion: () => pc2.getPC2Version(),
    checkForUpdate: () => pc2.checkForUpdate(),
    openInBrowser: () => pc2.openInBrowser(),
    getLogs: (lines) => pc2.getLogs(lines),
  };
}
