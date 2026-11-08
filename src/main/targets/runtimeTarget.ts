import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import { RUNTIME_TARGET } from './descriptors';
import {
  createDefaultGatewaySupervisor,
  confirmInstalledGateway,
  installedGatewayOnThisComputer,
  ForeignGatewayError,
  GatewaySupervisor,
  homeLaunchForPlatform,
  isHealthOk,
  openRuntimeHome,
  probeGatewayHealth,
} from './runtimeGateway';
import * as runtimeInstall from './runtimeInstall';
import { runtimeBinaryPath, runtimeComponentsPath, runtimeDataDir, runtimeUpdateCheckPath, runtimeJoin, signedInstallRecord } from './runtimePaths';
import { findRuntimeBinary, parseRuntimeVersion, probeRuntimeInstallation, RUNTIME_VERSION_ARGS } from './runtimeProbe';
import { runtimeInstallBlock } from './runtimeSupport';
import { removeVerifiedTarget, uninstallRuntime } from './runtimeUninstall';
import {
  applyRuntimeUpdate,
  checkRuntimeUpdate,
  HeadVerify,
  launcherUpdateStatusStore,
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
} from './windowsRuntime';
import { LaunchTarget, UpdateCheck } from './types';

export function createRuntimeTarget(platform: NodeJS.Platform = process.platform, arch: string = process.arch): LaunchTarget {
  let supervisor: GatewaySupervisor | null = null;
  let updating = false;
  let requestedRunning = false;
  let lifecycle = Promise.resolve();

  function serialize(action: () => Promise<void>): Promise<void> {
    const next = lifecycle.then(action);
    lifecycle = next.catch(() => {});
    return next;
  }

  async function startGateway(): Promise<void> {
    if (!requestedRunning) return;
    if (platform === 'win32') {
      if (!distroIsInstalled()) throw new Error('ElastOS is not installed yet. Click Install.');
      if (!supervisor) supervisor = createDistroGatewaySupervisor();
    } else {
      const block = runtimeInstallBlock(platform, arch);
      if (block) throw new Error(block);
      const file = binary();
      if (!file) throw new Error('ElastOS is not installed yet. Click Install.');
      if (!supervisor) supervisor = createDefaultGatewaySupervisor(file, platform);
    }
    await supervisor.start();
  }

  function changeRuntime(action: () => Promise<void>): Promise<void> {
    if (platform !== 'darwin' && platform !== 'win32') return serialize(action);
    if (updating) return Promise.reject(new Error('An ElastOS update is already running.'));
    updating = true;
    requestedRunning = true;
    return serialize(async () => {
      // A failed Stop keeps its supervisor and must never lead to a new Start.
      await stopGateway(true);
      try {
        await action();
      } finally {
        if (requestedRunning) {
          supervisor = null;
          await startGateway();
        }
      }
    }).finally(() => { updating = false; });
  }

  function requestStop(adopt: boolean): Promise<void> {
    requestedRunning = false;
    return serialize(() => stopGateway(adopt));
  }

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

  async function runWithHomeRestart(action: () => Promise<void>): Promise<void> {
    if (updating) throw new Error('An ElastOS update is already running.');
    updating = true;
    try {
      await stopGateway(true);
      await action();
    } finally {
      supervisor = null;
      try {
        const file = binary();
        if (!file) throw new Error('ElastOS is not installed yet. Click Install.');
        supervisor = createDefaultGatewaySupervisor(file, platform);
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
      if (platform === 'linux' && (await installedGatewayOnThisComputer(platform)) === 'legacy') {
        return 'other-home';
      }
      const observedSupervisor = supervisor;
      const observedPhase = supervisor?.phase();
      if (supervisor) {
        const phase = observedPhase;
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
      if (runtimeInstallBlock(platform, arch)) return 'not-installed';
      const installed = await runtimeIsInstalled();
      if (updating) return 'starting';
      if (!installed) return 'not-installed';
      const health = await readHealth();
      if (platform === 'darwin') {
        const foreign = isHealthOk(health) && !(await confirmInstalledGateway());
        // A control action can finish while version, health and socket probes
        // are in flight. Its new phase supersedes those earlier observations.
        const latestPhase = supervisor?.phase();
        if (updating) return 'starting';
        if (supervisor !== observedSupervisor || latestPhase !== observedPhase) return latestPhase ?? 'stopped';
        if (foreign) throw new Error('Another program is answering on port 8090. Home was not adopted.');
      }
      return isHealthOk(health) ? 'running' : 'stopped';
    },
    start: () => {
      requestedRunning = true;
      return serialize(startGateway);
    },
    stop: () => requestStop(false),
    stopForRemoval: () => requestStop(true),
    forceStop: () => {
      requestedRunning = false;
      supervisor?.forceKill();
    },
    restart: () => {
      requestedRunning = true;
      return serialize(async () => {
        await stopGateway(false);
        await startGateway();
      });
    },
    install: (onProgress) => runtimeInstall.installRuntimeOnThisComputer(onProgress),
    update: (onProgress) => {
      const action = () => applyRuntimeUpdate(runtimeCommand(platform), runtimeHeadStore(), headVerify(platform), onProgress);
      if (platform === 'darwin' || platform === 'win32') return changeRuntime(action);
      if (!homeLaunchForPlatform(platform).updateRestartsHome) return serialize(action);
      return serialize(() => runWithHomeRestart(action));
    },
    rollback: (onProgress) => {
      const action = () => rollbackRuntime(runtimeCommand(platform), runtimeHeadStore(), headVerify(platform), onProgress);
      if (platform === 'darwin' || platform === 'win32') return changeRuntime(action);
      if (!homeLaunchForPlatform(platform).rollbackRestartsHome) return serialize(action);
      return serialize(() => runWithHomeRestart(action));
    },
    // On Windows the launch controller runs uninstallRuntimeInDistro (windowsUninstall.ts) with the two answers.
    uninstall: () => {
      requestedRunning = false;
      return platform === 'win32'
        ? Promise.reject(new Error('Uninstall on Windows needs your answer in the Uninstall window. Nothing was removed.'))
        : serialize(() => runtimeUninstall(() => stopGateway(true)));
    },
    getVersion: () => (platform === 'win32' ? readDistroVersion() : readRuntimeVersion(platform, arch)),
    checkForUpdate: () => runtimeCheckForUpdate(platform, arch),
    openInBrowser: () => openRuntimeHome(),
    getLogs: async (lines) => supervisor?.getLogs(lines) ?? '',
  };
}

function runtimeCommand(platform: NodeJS.Platform): RuntimeCommand {
  return platform === 'win32' ? runDistroRuntimeCommand : runRuntimeCommand;
}

function readHostUpdateStatus(platform: NodeJS.Platform): string {
  const home = os.homedir();
  return fs.readFileSync(runtimeUpdateCheckPath(runtimeDataDir(platform, home, process.env)), 'utf8');
}

async function runtimeCheckForUpdate(platform: NodeJS.Platform, arch: string): Promise<UpdateCheck> {
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
  const windows = platform === 'win32';
  if (windows ? !distroIsInstalled() : runtimeInstallBlock(platform, arch)
    || !findRuntimeBinary(os.homedir(), process.env.PATH ?? '')) return notInstalled;
  const current = windows ? readDistroVersion() : readRuntimeVersion(platform, arch);
  const store = launcherUpdateStatusStore(os.homedir());
  const fallback = async () => {
    await writeSignedUpdateCheck(current, loadActiveRuntimePin(), runtimeInstall.fetchRuntimeText, store.write);
    return store.read();
  };
  const parsed = await checkRuntimeUpdate(windows ? runDistroRuntimeCommand : runRuntimeCommand,
    windows ? readDistroUpdateStatus : () => readHostUpdateStatus(platform), fallback);
  return toUpdateCheck(current, parsed, releaseUrl);
}

function headVerify(platform: NodeJS.Platform): HeadVerify {
  const pin = loadActiveRuntimePin();
  return {
    maintainerDid: pin.maintainerDid,
    publisherGateway: pin.publisherGateway,
    fetchText: runtimeInstall.fetchRuntimeText,
    minimumVersion: pin.version ?? '2.0.0',
    readInstalledHead: platform === 'win32' ? undefined : () => {
      const data = runtimeDataDir(platform, os.homedir(), process.env);
      if (!signedInstallRecord(data, pin.maintainerDid)) throw new Error('The signed install record is not valid.');
      return fs.readFileSync(runtimeJoin(data, 'installation', 'release-head.json'), 'utf8');
    },
  };
}

function readRuntimeVersion(platform: NodeJS.Platform = process.platform, arch: string = process.arch): string {
  const block = runtimeInstallBlock(platform, arch);
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
