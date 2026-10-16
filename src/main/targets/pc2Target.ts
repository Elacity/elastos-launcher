import * as pc2 from '../pc2Manager';
import { PC2_TARGET } from './descriptors';
import { LaunchTarget } from './types';

/** The PC2 target methods are the pc2Manager functions, not wrappers. */
export function createPc2Target(): LaunchTarget {
  return {
    id: 'pc2',
    descriptor: PC2_TARGET,
    isInstalled: pc2.isInstalled,
    getStatus: pc2.getStatus,
    start: pc2.startPC2,
    stop: pc2.stopPC2,
    restart: pc2.restartPC2,
    install: pc2.installPC2,
    update: pc2.updatePC2,
    uninstall: pc2.uninstallPC2,
    getVersion: pc2.getPC2Version,
    checkForUpdate: pc2.checkForUpdate,
    openInBrowser: pc2.openInBrowser,
    getLogs: pc2.getLogs,
  };
}
