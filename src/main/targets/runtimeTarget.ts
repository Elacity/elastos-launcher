import { RUNTIME_TARGET } from './descriptors';
import { LaunchTarget } from './types';

function unavailable(action: string): Promise<never> {
  return Promise.reject(new Error(
    `ElastOS runtime target cannot ${action} yet. PC2 remains the default. See docs/RUNTIME_MIGRATION.md.`,
  ));
}

function unavailableSync(action: string): never {
  throw new Error(
    `ElastOS runtime target cannot ${action} yet. PC2 remains the default. See docs/RUNTIME_MIGRATION.md.`,
  );
}

/**
 * Placeholder for the runtime host. Selecting it is explicit, and every
 * lifecycle call fails until a later ticket implements it.
 */
export function createRuntimeTarget(): LaunchTarget {
  return {
    id: 'runtime',
    descriptor: RUNTIME_TARGET,
    isInstalled: () => unavailable('check installation'),
    getStatus: () => unavailable('read status'),
    start: () => unavailable('start'),
    stop: () => unavailable('stop'),
    restart: () => unavailable('restart'),
    install: () => unavailable('install'),
    update: () => unavailable('update'),
    uninstall: () => unavailable('uninstall'),
    getVersion: () => unavailableSync('read version'),
    checkForUpdate: () => unavailable('check for updates'),
    openInBrowser: () => unavailableSync('open the browser'),
    getLogs: () => unavailable('read logs'),
  };
}
