import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import { RUNTIME_TARGET } from './descriptors';
import {
  createDefaultGatewaySupervisor,
  GatewaySupervisor,
  HEALTH_URL,
  isHealthOk,
  openRuntimeHome,
} from './runtimeGateway';
import * as runtimeInstall from './runtimeInstall';
import { runtimeBinaryPath, runtimeComponentsPath, runtimeDataDir } from './runtimePaths';
import { findRuntimeBinary, parseRuntimeVersion, probeRuntimeInstallation, RUNTIME_VERSION_ARGS } from './runtimeProbe';
import { runtimeInstallBlock } from './runtimeSupport';
import { uninstallRuntime } from './runtimeUninstall';
import { LaunchTarget } from './types';

function unavailable(action: string): Promise<never> {
  return Promise.reject(new Error(
    `ElastOS runtime target cannot ${action} yet. PC2 remains the default. See docs/RUNTIME_MIGRATION.md.`,
  ));
}

/**
 * Runtime host. Install, start, stop, and uninstall follow the launcher
 * contract. Update still rejects until the next ticket.
 */
export function createRuntimeTarget(): LaunchTarget {
  let supervisor: GatewaySupervisor | null = null;

  function binary(): string | null {
    return findRuntimeBinary(os.homedir(), process.env.PATH ?? '');
  }

  return {
    id: 'runtime',
    descriptor: RUNTIME_TARGET,
    isInstalled: () => runtimeIsInstalled(),
    getStatus: async () => {
      if (supervisor) {
        const phase = supervisor.phase();
        if (phase === 'starting' || phase === 'stopping' || phase === 'running' || phase === 'error') {
          return phase;
        }
      }
      if (runtimeInstallBlock(process.platform, process.arch)) return 'not-installed';
      if (!(await runtimeIsInstalled())) return 'not-installed';
      if (isHealthOk(await readHealth())) return 'running';
      return 'stopped';
    },
    start: async () => {
      const block = runtimeInstallBlock(process.platform, process.arch);
      if (block) throw new Error(block);
      const file = binary();
      if (!file) throw new Error('ElastOS is not installed yet. Click Install.');
      if (!supervisor) supervisor = createDefaultGatewaySupervisor(file);
      await supervisor.start();
    },
    stop: async () => {
      if (supervisor) {
        await supervisor.stop();
        return;
      }
      if (isHealthOk(await readHealth())) {
        throw new Error('ElastOS is already running. This window did not start it, so Stop leaves it running.');
      }
    },
    restart: async () => {
      if (supervisor) await supervisor.stop();
      const file = binary();
      if (!file) throw new Error('ElastOS is not installed yet. Click Install.');
      if (!supervisor) supervisor = createDefaultGatewaySupervisor(file);
      await supervisor.start();
    },
    install: (onProgress) => runtimeInstall.installRuntimeOnThisComputer(onProgress),
    update: () => unavailable('update'),
    uninstall: () => runtimeUninstall(() => supervisor?.stop() ?? Promise.resolve()),
    getVersion: () => readRuntimeVersion(),
    checkForUpdate: () => unavailable('check for updates'),
    openInBrowser: () => openRuntimeHome(),
    getLogs: async (lines) => supervisor?.getLogs(lines) ?? '',
  };
}

function readRuntimeVersion(): string {
  const block = runtimeInstallBlock(process.platform, process.arch);
  if (block) return block;
  const file = findRuntimeBinary(os.homedir(), process.env.PATH ?? '');
  if (!file) return 'not installed';
  try {
    const stdout = execFileSync(file, [...RUNTIME_VERSION_ARGS], { timeout: 5000, encoding: 'utf8' });
    return parseRuntimeVersion(stdout) ?? 'not installed';
  } catch {
    return 'not installed';
  }
}

async function readHealth(): Promise<{ status: number; body: string } | null> {
  try {
    const response = await fetch(HEALTH_URL, { signal: AbortSignal.timeout(500) });
    return { status: response.status, body: await response.text() };
  } catch {
    return null;
  }
}

async function runtimeUninstall(stop: () => Promise<void>): Promise<void> {
  const home = os.homedir();
  await uninstallRuntime({
    binary: runtimeBinaryPath(home),
    dataDir: runtimeDataDir(process.platform, home, process.env),
    stop: async () => {
      await stop();
      if (isHealthOk(await readHealth())) {
        throw new Error('ElastOS is already running. This window did not start it, so Stop leaves it running.');
      }
    },
    remove: (target) => fs.rmSync(target, { recursive: true, force: true }),
  });
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
