import * as fs from 'fs';
import * as os from 'os';
import { RUNTIME_TARGET } from './descriptors';
import * as runtimeInstall from './runtimeInstall';
import { runtimeComponentsPath, runtimeDataDir } from './runtimePaths';
import { probeRuntimeInstallation } from './runtimeProbe';
import { runtimeInstallBlock } from './runtimeSupport';
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
 * Runtime host. Install is the pinned publisher path. Start, stop, and
 * update stay rejected until the following tickets.
 */
export function createRuntimeTarget(): LaunchTarget {
  return {
    id: 'runtime',
    descriptor: RUNTIME_TARGET,
    isInstalled: () => runtimeIsInstalled(),
    getStatus: () => unavailable('read status'),
    start: () => unavailable('start'),
    stop: () => unavailable('stop'),
    restart: () => unavailable('restart'),
    install: (onProgress) => runtimeInstall.installRuntimeOnThisComputer(onProgress),
    update: () => unavailable('update'),
    uninstall: () => unavailable('uninstall'),
    getVersion: () => unavailableSync('read version'),
    checkForUpdate: () => unavailable('check for updates'),
    openInBrowser: () => unavailableSync('open the browser'),
    getLogs: () => unavailable('read logs'),
  };
}

async function runtimeIsInstalled(): Promise<boolean> {
  if (runtimeInstallBlock(process.platform, process.arch)) return false;
  const homeDir = os.homedir();
  const probe = await probeRuntimeInstallation({
    platform: process.platform,
    arch: process.arch,
    homeDir,
    pathEnv: process.env.PATH,
  });
  if (probe.kind !== 'version') return false;
  const components = runtimeComponentsPath(runtimeDataDir(process.platform, homeDir, process.env));
  try {
    return fs.statSync(components).isFile();
  } catch {
    return false;
  }
}
