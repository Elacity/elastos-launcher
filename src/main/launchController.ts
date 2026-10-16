import * as pc2 from './pc2Manager';
import { applyOpenAtLogin, readOpenAtLogin } from './targets/openAtLogin';
import { buildDiagnostics, collectPreflight, PreflightReport, saveCollectedSupportBundle } from './targets/preflight';
import { HEALTH_URL, isHealthOk } from './targets/runtimeGateway';
import { collectFailureFacts, failureScreen, FailureScreen, fixCollectedFailure } from './targets/runtimeRecovery';
import { createLaunchTargetStore, LaunchTargetPreferenceStore, resolveLaunchTargetId } from './targets/preferences';
import { createLaunchTarget } from './targets';
import { parseLaunchTargetId } from './targets/registry';
import { setRuntimeLogSink } from './targets/runtimeGateway';
import { loadActiveRuntimePin } from './targets/runtimePin';
import { runtimeHeadStore } from './targets/runtimeUpdate';
import { rollbackRuntimeUpdate } from './targets/runtimeTarget';
import { resetRuntimeOnThisComputer } from './targets/runtimeUninstall';
import { fixWindowsOnThisComputer } from './targets/windowsHost';
import { LaunchTarget, LaunchTargetId, TargetStatus, UpdateCheck } from './targets/types';

export interface LaunchControllerOptions {
  explicit?: string | null;
  env?: NodeJS.ProcessEnv;
  store?: LaunchTargetPreferenceStore;
}

export interface LaunchController {
  readonly target: LaunchTarget;
  onStatusChange(listener: (status: TargetStatus) => void): void;
  onLog(listener: (line: string) => void): void;
  getStatus(): Promise<TargetStatus>;
  start(): Promise<void>;
  stop(): Promise<void>;
  restart(): Promise<void>;
  install(onProgress: (message: string) => void): Promise<void>;
  update(onProgress: (message: string) => void): Promise<void>;
  uninstall(): Promise<void>;
  resetRuntime(): Promise<void>;
  rollback(onProgress?: (message: string) => void): Promise<void>;
  getVersion(): string;
  checkForUpdate(): Promise<UpdateCheck>;
  openInBrowser(): void;
  getLogs(lines?: number): Promise<string>;
  isInstalled(): Promise<boolean>;
  setLaunchTarget(id: string): LaunchTargetId;
  getLaunchInfo(): Promise<LaunchInfo>;
  getPreflight(): Promise<PreflightReport>;
  getDiagnostics(): Promise<string>;
  saveSupportBundle(): Promise<string>;
  describeFailure(): Promise<FailureScreen>;
  fixFailure(): Promise<'ready' | 'still-blocked'>;
  setOpenAtLogin(enabled: boolean): void;
  getOpenAtLogin(): boolean;
  shutdown(): void;
}

export interface LaunchInfo {
  id: LaunchTargetId;
  displayName: string;
  openUrl: string;
  status: TargetStatus;
  platformNote: string | null;
  preflight: PreflightReport;
  openAtLogin: boolean;
  canRollback: boolean;
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * IPC-facing supervisor. PC2 methods are the pc2Manager functions.
 * Runtime errors are logged and are not turned into a PC2 install.
 */
export function createDefaultLaunchController(env: NodeJS.ProcessEnv = process.env): LaunchController {
  return createLaunchController({
    env,
    store: createLaunchTargetStore(),
  });
}

export function createLaunchController(options: LaunchControllerOptions = {}): LaunchController {
  const id = resolveLaunchTargetId({
    explicit: options.explicit,
    env: options.env,
    store: options.store,
  });
  let active = createLaunchTarget(id);
  let pc2Mode = id === 'pc2';
  let pc2Subscribed = false;
  let lastError = '';
  const statusListeners: Array<(status: TargetStatus) => void> = [];
  const logListeners: Array<(line: string) => void> = [];
  const runtimeLogs: string[] = [];

  const emitStatus = (status: TargetStatus) => {
    for (const listener of statusListeners) listener(status);
  };
  const emitLog = (line: string) => {
    runtimeLogs.push(line);
    for (const listener of logListeners) listener(line);
  };

  function attachTarget(): void {
    if (pc2Mode) {
      if (!pc2Subscribed) {
        pc2.onStatusChange(emitStatus);
        pc2.onLog(emitLog);
        pc2Subscribed = true;
      }
      return;
    }
    setRuntimeLogSink(emitLog);
  }
  attachTarget();

  async function runRuntime<T>(action: () => Promise<T>): Promise<T> {
    try {
      return await action();
    } catch (err) {
      lastError = messageOf(err);
      emitLog(lastError);
      emitStatus('error');
      throw err;
    }
  }

  function runRuntimeSync<T>(action: () => T): T {
    try {
      return action();
    } catch (err) {
      lastError = messageOf(err);
      emitLog(lastError);
      emitStatus('error');
      throw err;
    }
  }

  async function currentStatus(): Promise<TargetStatus> {
    return pc2Mode ? active.getStatus() : runRuntime(() => active.getStatus());
  }

  async function diagnosticsText(): Promise<string> {
    const preflight = active.id === 'runtime' ? await collectPreflight() : { ok: true, checks: [] };
    let channel = '';
    let pinVersion: string | null = null;
    try {
      const pin = loadActiveRuntimePin();
      channel = pin.channel;
      pinVersion = pin.version;
    } catch {
      channel = 'unknown';
    }
    const logs = pc2Mode
      ? await active.getLogs(200)
      : runtimeLogs.slice(-200).join('\n');
    let status = 'unknown';
    try {
      status = await currentStatus();
    } catch {
      status = 'error';
    }
    let runtimeVersion = 'unknown';
    try {
      runtimeVersion = active.getVersion();
    } catch {
      runtimeVersion = 'unknown';
    }
    let health = 'unknown';
    if (active.id === 'runtime') {
      try {
        const response = await fetch(HEALTH_URL, { signal: AbortSignal.timeout(800) });
        const body = await response.text();
        health = isHealthOk({ status: response.status, body }) ? 'OK' : 'not answering';
      } catch {
        health = 'not answering';
      }
    }
    return buildDiagnostics({
      launcherVersion: '1.4.0',
      runtimeVersion,
      target: active.id,
      channel,
      pinVersion,
      platform: process.platform,
      arch: process.arch,
      status,
      health,
      error: lastError,
      logs,
      checks: preflight.checks,
    });
  }

  return {
    get target() {
      return active;
    },
    onStatusChange(listener) {
      statusListeners.push(listener);
    },
    onLog(listener) {
      logListeners.push(listener);
    },
    getStatus: () => currentStatus(),
    start: () => (pc2Mode ? active.start() : runRuntime(() => active.start())),
    stop: () => (pc2Mode ? active.stop() : runRuntime(() => active.stop())),
    restart: () => (pc2Mode ? active.restart() : runRuntime(() => active.restart())),
    install: (onProgress) => (pc2Mode ? active.install(onProgress) : runRuntime(() => active.install(onProgress))),
    update: (onProgress) => (pc2Mode ? active.update(onProgress) : runRuntime(() => active.update(onProgress))),
    uninstall: () => (pc2Mode ? active.uninstall() : runRuntime(() => active.uninstall())),
    resetRuntime: () => (pc2Mode
      ? Promise.reject(new Error('Reset is for ElastOS.'))
      : runRuntime(() => resetRuntimeOnThisComputer(() => active.stop()))),
    rollback: (onProgress) => (
      pc2Mode
        ? Promise.reject(new Error('PC2 does not roll back through the runtime.'))
        : runRuntime(() => rollbackRuntimeUpdate(onProgress))
    ),
    getVersion: () => (pc2Mode ? active.getVersion() : runRuntimeSync(() => active.getVersion())),
    checkForUpdate: () => (pc2Mode ? active.checkForUpdate() : runRuntime(() => active.checkForUpdate())),
    openInBrowser: () => {
      if (pc2Mode) {
        active.openInBrowser();
        return;
      }
      runRuntimeSync(() => active.openInBrowser());
    },
    getLogs: (lines) => {
      if (pc2Mode) return active.getLogs(lines);
      const count = lines ?? runtimeLogs.length;
      return Promise.resolve(runtimeLogs.slice(-count).join('\n'));
    },
    isInstalled: () => (pc2Mode ? active.isInstalled() : runRuntime(() => active.isInstalled())),
    setLaunchTarget(raw: string) {
      const next = parseLaunchTargetId(raw);
      options.store?.set(next);
      active = createLaunchTarget(next);
      pc2Mode = next === 'pc2';
      lastError = '';
      attachTarget();
      return next;
    },
    async getLaunchInfo() {
      let status: TargetStatus = 'stopped';
      try {
        status = await currentStatus();
      } catch {
        status = 'error';
      }
      const preflight = active.id === 'runtime'
        ? await collectPreflight()
        : { ok: true, checks: [] };
      const platform = preflight.checks.find((check) => check.id === 'platform' && check.level === 'block');
      return {
        id: active.id,
        displayName: active.descriptor.displayName,
        openUrl: active.descriptor.openUrl,
        status,
        platformNote: platform?.message ?? null,
        preflight,
        openAtLogin: readOpenAtLogin(),
        canRollback: active.id === 'runtime' && Boolean(runtimeHeadStore().get()),
      };
    },
    getPreflight: () => collectPreflight(),
    async describeFailure() {
      const preflight = active.id === 'runtime' ? await collectPreflight() : { ok: true, checks: [] };
      return failureScreen(collectFailureFacts(lastError, preflight.checks));
    },
    async fixFailure() {
      const preflight = active.id === 'runtime' ? await collectPreflight() : { ok: true, checks: [] };
      const facts = collectFailureFacts(lastError, preflight.checks);
      if (failureScreen(facts).kind === 'windows') {
        await fixWindowsOnThisComputer();
        return 'ready';
      }
      return fixCollectedFailure(facts);
    },
    getDiagnostics: () => diagnosticsText(),
    saveSupportBundle: async () => saveCollectedSupportBundle(await diagnosticsText()),
    setOpenAtLogin(enabled: boolean) {
      applyOpenAtLogin(enabled);
    },
    getOpenAtLogin() {
      return readOpenAtLogin();
    },
    shutdown() {
      pc2.shutdownHeartbeatPoller();
      if (!pc2Mode) {
        void active.stop().catch(() => {});
      }
    },
  };
}
