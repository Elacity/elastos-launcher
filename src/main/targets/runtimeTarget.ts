import { execFileSync } from 'child_process';
import { randomUUID } from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import { RUNTIME_TARGET } from './descriptors';
import {
  createDefaultGatewaySupervisor,
  confirmInstalledGateway,
  ForeignGatewayError,
  GatewaySupervisor,
  isHealthOk,
  openRuntimeHome,
  probeGatewayHealth,
} from './runtimeGateway';
import * as runtimeInstall from './runtimeInstall';
import { runtimeBinaryPath, runtimeComponentsPath, runtimeDataDir, runtimeUpdateCheckPath } from './runtimePaths';
import { findRuntimeBinary, parseRuntimeVersion, probeRuntimeInstallation, RUNTIME_VERSION_ARGS } from './runtimeProbe';
import { runtimeInstallBlock } from './runtimeSupport';
import { removeVerifiedTarget, uninstallRuntime } from './runtimeUninstall';
import {
  applyRuntimeUpdate,
  checkRuntimeUpdate,
  HeadVerify,
  rollbackRuntime,
  RuntimeCommand,
  runRuntimeCommand,
  runtimeHeadStore,
  toUpdateCheck,
  writeSignedUpdateCheck,
} from './runtimeUpdate';
import { loadActiveRuntimePin } from './runtimePin';
import {
  createDistroGatewaySupervisor,
  distroIsInstalled,
  readDistroUpdateStatus,
  readDistroVersion,
  runDistroRuntimeCommand,
  writeDistroUpdateStatus,
} from './windowsRuntime';
import { LaunchTarget, UpdateCheck } from './types';

export function createRuntimeTarget(platform: NodeJS.Platform = process.platform): LaunchTarget {
  let supervisor: GatewaySupervisor | null = null;
  let updating = false;

  function binary(): string | null {
    return findRuntimeBinary(os.homedir(), process.env.PATH ?? '');
  }

  async function stopGateway(adopt: boolean): Promise<void> {
    if (!supervisor) {
      supervisor = platform === 'win32'
        ? createDistroGatewaySupervisor()
        : createDefaultGatewaySupervisor(binary() ?? runtimeBinaryPath(os.homedir()), platform);
    }
    await supervisor.stop({ adopt });
  }

  /** Stop Home, run one release command, then start `home --browser` again. */
  async function restartHomeAfter(run: () => Promise<void>): Promise<void> {
    if (updating) throw new Error('An ElastOS update is already running.');
    updating = true;
    try {
      await stopGateway(true);
      await run();
    } finally {
      supervisor = null;
      try {
        if (platform === 'win32') {
          if (!distroIsInstalled()) throw new Error('ElastOS is not installed yet. Click Install.');
          supervisor = createDistroGatewaySupervisor();
        } else {
          const file = binary();
          if (!file) throw new Error('ElastOS is not installed yet. Click Install.');
          supervisor = createDefaultGatewaySupervisor(file, platform);
        }
        await supervisor.start();
      } finally {
        updating = false;
      }
    }
  }

  return {
    id: 'runtime',
    descriptor: RUNTIME_TARGET,
    isInstalled: () => runtimeIsInstalled(),
    getStatus: async () => {
      if (updating) return 'starting';
      if (supervisor) {
        const phase = supervisor.phase();
        if (phase === 'starting' || phase === 'stopping' || phase === 'error'
          || (phase === 'running' && platform !== 'darwin' && platform !== 'win32')) {
          return phase;
        }
      }
      if (platform === 'win32') {
        if (!distroIsInstalled()) return 'not-installed';
        if (isHealthOk(await readHealth())) {
          // A live controller keeps Home up after the child pid changes. Health
          // and the distro facts are the status, not the supervisor's old phase.
          if (!(await confirmInstalledGateway())) {
            throw new Error('Another program is answering on port 8090. Home was not adopted.');
          }
          return 'running';
        }
        return 'stopped';
      }
      if (runtimeInstallBlock(platform, process.arch)) return 'not-installed';
      if (!(await runtimeIsInstalled())) return 'not-installed';
      if (isHealthOk(await readHealth())) {
        if (platform === 'darwin' && !(await confirmInstalledGateway())) throw new Error('Another program is answering on port 8090. Home was not adopted.');
        return 'running';
      }
      return 'stopped';
    },
    start: async () => {
      if (platform === 'win32') {
        if (!distroIsInstalled()) throw new Error('ElastOS is not installed yet. Click Install.');
        if (!supervisor) supervisor = createDistroGatewaySupervisor();
        await supervisor.start();
        return;
      }
      const block = runtimeInstallBlock(platform, process.arch);
      if (block) throw new Error(block);
      const file = binary();
      if (!file) throw new Error('ElastOS is not installed yet. Click Install.');
      if (!supervisor) supervisor = createDefaultGatewaySupervisor(file, platform);
      await supervisor.start();
    },
    stop: () => stopGateway(false),
    stopForRemoval: () => stopGateway(true),
    forceStop: () => {
      supervisor?.forceKill();
    },
    restart: async () => {
      await stopGateway(false);
      if (platform === 'win32') {
        if (!distroIsInstalled()) throw new Error('ElastOS is not installed yet. Click Install.');
        if (!supervisor) supervisor = createDistroGatewaySupervisor();
        await supervisor.start();
        return;
      }
      const file = binary();
      if (!file) throw new Error('ElastOS is not installed yet. Click Install.');
      if (!supervisor) supervisor = createDefaultGatewaySupervisor(file, platform);
      await supervisor.start();
    },
    install: (onProgress) => runtimeInstall.installRuntimeOnThisComputer(onProgress),
    update: async (onProgress) => {
      if (platform !== 'darwin' && platform !== 'win32') {
        return applyRuntimeUpdate(runtimeCommand(), runtimeHeadStore(), headVerify(), onProgress);
      }
      await restartHomeAfter(() => applyRuntimeUpdate(runtimeCommand(), runtimeHeadStore(), headVerify(), onProgress));
    },
    rollback: (onProgress) => (platform === 'win32'
      ? restartHomeAfter(() => rollbackRuntimeUpdate(onProgress))
      : rollbackRuntimeUpdate(onProgress)),
    // On Windows the launch controller runs uninstallRuntimeInDistro (windowsUninstall.ts) with the two answers.
    uninstall: () => (platform === 'win32' ? Promise.reject(new Error('Uninstall on Windows needs your answer in the Uninstall window. Nothing was removed.')) : runtimeUninstall(() => stopGateway(true))),
    getVersion: () => (platform === 'win32' ? readDistroVersion() : readRuntimeVersion()),
    checkForUpdate: () => runtimeCheckForUpdate(),
    openInBrowser: () => openRuntimeHome(),
    getLogs: async (lines) => supervisor?.getLogs(lines) ?? '',
  };
}

function runtimeCommand(): RuntimeCommand {
  return process.platform === 'win32' ? runDistroRuntimeCommand : runRuntimeCommand;
}

function readHostUpdateStatus(): string {
  const home = os.homedir();
  return fs.readFileSync(runtimeUpdateCheckPath(runtimeDataDir(process.platform, home, process.env)), 'utf8');
}

function writeHostUpdateStatus(raw: string): void {
  const file = runtimeUpdateCheckPath(runtimeDataDir(process.platform, os.homedir(), process.env));
  const temporary = `${file}.${randomUUID()}.tmp`;
  fs.writeFileSync(temporary, raw, { flag: 'wx', mode: 0o600 });
  try {
    fs.renameSync(temporary, file);
  } finally {
    if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
  }
}

async function runtimeCheckForUpdate(): Promise<UpdateCheck> {
  let releaseUrl = '';
  try {
    releaseUrl = loadActiveRuntimePin().publisherGateway;
  } catch {
    releaseUrl = '';
  }
  const notInstalled = toUpdateCheck('not installed', {
    updateAvailable: false,
    detail: 'not installed',
    latest: null,
  }, releaseUrl);
  if (process.platform === 'win32') {
    return checkDistroRuntimeUpdate({
      installed: distroIsInstalled,
      current: readDistroVersion,
      run: runDistroRuntimeCommand,
      readStatus: readDistroUpdateStatus,
      writeStatus: writeDistroUpdateStatus,
      fetchText: runtimeInstall.fetchRuntimeText,
      releaseUrl,
    });
  }
  if (runtimeInstallBlock(process.platform, process.arch)) return notInstalled;
  if (!findRuntimeBinary(os.homedir(), process.env.PATH ?? '')) return notInstalled;
  const current = readRuntimeVersion();
  const compatibilityRecord = runtimeInstall.installedVersionMatches(current, '2.0.0')
    ? () => writeSignedUpdateCheck(current, loadActiveRuntimePin(), runtimeInstall.fetchRuntimeText, writeHostUpdateStatus)
    : undefined;
  const parsed = await checkRuntimeUpdate(runRuntimeCommand, readHostUpdateStatus, compatibilityRecord);
  return toUpdateCheck(current, parsed, releaseUrl);
}

export async function checkDistroRuntimeUpdate(deps: {
  installed: () => boolean;
  current: () => string;
  run: RuntimeCommand;
  readStatus: () => string;
  writeStatus: (raw: string) => void;
  fetchText: (url: string) => Promise<string>;
  releaseUrl: string;
  pin?: ReturnType<typeof loadActiveRuntimePin>;
}): Promise<UpdateCheck> {
  const notInstalled = toUpdateCheck('not installed', {
    updateAvailable: false,
    detail: 'not installed',
    latest: null,
  }, deps.releaseUrl);
  if (!deps.installed()) return notInstalled;
  const current = deps.current();
  const compatibilityRecord = runtimeInstall.installedVersionMatches(current, '2.0.0')
    ? () => writeSignedUpdateCheck(
      current,
      deps.pin ?? loadActiveRuntimePin(),
      deps.fetchText,
      deps.writeStatus,
    )
    : undefined;
  const parsed = await checkRuntimeUpdate(deps.run, deps.readStatus, compatibilityRecord);
  return toUpdateCheck(current, parsed, deps.releaseUrl);
}

export async function rollbackRuntimeUpdate(
  onProgress: (message: string) => void = () => {},
): Promise<void> {
  await rollbackRuntime(runtimeCommand(), runtimeHeadStore(), headVerify(), onProgress);
}

function headVerify(): HeadVerify {
  const pin = loadActiveRuntimePin();
  return {
    maintainerDid: pin.maintainerDid,
    publisherGateway: pin.publisherGateway,
    fetchText: runtimeInstall.fetchRuntimeText,
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
  return probeGatewayHealth({ timeoutMs: 500 });
}

async function runtimeUninstall(stop: () => Promise<void>): Promise<void> {
  const home = os.homedir();
  await uninstallRuntime({
    binary: runtimeBinaryPath(home),
    dataDir: runtimeDataDir(process.platform, home, process.env),
    stop: async () => {
      await stop();
      if (isHealthOk(await readHealth())) {
        throw new ForeignGatewayError();
      }
    },
    homeDir: home,
    platform: process.platform,
    env: process.env,
    remove: (target) => removeVerifiedTarget(target),
  });
}

async function runtimeIsInstalled(): Promise<boolean> {
  if (process.platform === 'win32') return distroIsInstalled();
  if (runtimeInstallBlock(process.platform, process.arch)) return false;
  const homeDir = os.homedir();
  const probe = await probeRuntimeInstallation({
    platform: process.platform,
    arch: process.arch,
    homeDir,
    pathEnv: process.env.PATH,
  });
  if (probe.kind !== 'version') return false;
  if (!runtimeInstall.versionAtLeast(probe.version, loadActiveRuntimePin().version)) return false;
  const components = runtimeComponentsPath(runtimeDataDir(process.platform, homeDir, process.env));
  try {
    return fs.statSync(components).isFile();
  } catch {
    return false;
  }
}
