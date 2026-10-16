import { applyOpenAtLogin, readOpenAtLogin } from './targets/openAtLogin';
import { buildDiagnostics, collectPreflight, PreflightReport, saveCollectedSupportBundle } from './targets/preflight';
import { confirmInstalledGateway, HEALTH_URL, isForeignGatewayError, isHealthOk } from './targets/runtimeGateway';
import { collectFailureFacts, failureScreen, FailureScreen, fixCollectedFailure, windowsFixResult } from './targets/runtimeRecovery';
import { resolveLaunchTargetId } from './targets/preferences';
import { LAUNCH_TARGET_ENV, retiredPc2Notice } from './targets/registry';
import { createLaunchTarget } from './targets';
import { setRuntimeLogSink } from './targets/runtimeGateway';
import { loadActiveRuntimePin } from './targets/runtimePin';
import { runtimeHeadStore } from './targets/runtimeUpdate';
import { rollbackRuntimeUpdate } from './targets/runtimeTarget';
import { resetRuntimeOnThisComputer } from './targets/runtimeUninstall';
import { fixWindowsOnThisComputer, resumeInstallPlanOnThisComputer, ResumeInstallPlan } from './targets/windowsHost';
import { LaunchTarget, LaunchTargetId, TargetStatus, UpdateCheck } from './targets/types';

export type { TargetStatus };

export interface LaunchControllerOptions {
  explicit?: string | null;
  env?: NodeJS.ProcessEnv;
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
  getLaunchInfo(): Promise<LaunchInfo>;
  getPreflight(): Promise<PreflightReport>;
  getDiagnostics(): Promise<string>;
  saveSupportBundle(): Promise<string>;
  describeFailure(): Promise<FailureScreen>;
  fixFailure(): Promise<'ready' | 'still-blocked'>;
  resumeInstallPlan(): Promise<ResumeInstallPlan>;
  setOpenAtLogin(enabled: boolean): void;
  getOpenAtLogin(): boolean;
  shutdown(): Promise<void>;
}

export interface QuitGate {
  started: boolean;
  ready: boolean;
}

/** SIGTERM grace plus SIGKILL grace, with a little room for the health probes. */
export const QUIT_STOP_BUDGET_MS = 32_000;

export interface QuitStopOptions {
  budgetMs?: number;
  log?: (line: string) => void;
  onStopping?: () => void;
}

/**
 * The first before-quit waits for the gateway this window started.
 * The wait is bounded. A second before-quit, after that stop has finished, is the real quit.
 */
export async function finishQuitAfterGatewayStop(
  gate: QuitGate,
  event: { preventDefault(): void },
  shutdown: () => Promise<void>,
  quit: () => void,
  options: QuitStopOptions = {},
): Promise<void> {
  if (gate.ready) return;
  event.preventDefault();
  if (gate.started) return;
  gate.started = true;
  const budgetMs = options.budgetMs ?? QUIT_STOP_BUDGET_MS;
  const log = options.log ?? (() => {});
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    options.onStopping?.();
    const budget = new Promise<void>((resolve) => {
      timer = setTimeout(() => {
        log('ElastOS did not stop before quit finished. The window is closing.');
        resolve();
      }, budgetMs);
    });
    const stopping = shutdown().catch((err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      log(`ElastOS did not stop cleanly. ${message}`);
    });
    await Promise.race([stopping, budget]);
  } finally {
    if (timer) clearTimeout(timer);
    gate.ready = true;
    quit();
  }
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

/** IPC-facing supervisor for the ElastOS runtime. A leftover `pc2` target opens the runtime. */
export function createDefaultLaunchController(env: NodeJS.ProcessEnv = process.env): LaunchController {
  return createLaunchController({ env });
}

export function createLaunchController(options: LaunchControllerOptions = {}): LaunchController {
  const retired = retiredPc2Notice(options.explicit) ?? retiredPc2Notice(options.env?.[LAUNCH_TARGET_ENV]);
  const id = resolveLaunchTargetId({
    explicit: options.explicit,
    env: options.env,
  });
  const active = createLaunchTarget(id);
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

  setRuntimeLogSink(emitLog);
  if (retired) emitLog(retired);

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
    return runRuntime(() => active.getStatus());
  }

  async function diagnosticsText(): Promise<string> {
    const preflight = await collectPreflight();
    let channel = '';
    let pinVersion: string | null = null;
    try {
      const pin = loadActiveRuntimePin();
      channel = pin.channel;
      pinVersion = pin.version;
    } catch {
      channel = 'unknown';
    }
    const logs = runtimeLogs.slice(-200).join('\n');
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
    try {
      const response = await fetch(HEALTH_URL, { signal: AbortSignal.timeout(800) });
      const body = await response.text();
      health = isHealthOk({ status: response.status, body }) ? 'OK' : 'not answering';
    } catch {
      health = 'not answering';
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
    start: () => runRuntime(() => active.start()),
    stop: () => runRuntime(() => active.stop()),
    restart: () => runRuntime(() => active.restart()),
    install: (onProgress) => runRuntime(() => active.install(onProgress)),
    update: (onProgress) => runRuntime(() => active.update(onProgress)),
    uninstall: () => runRuntime(() => active.uninstall()),
    resetRuntime: () => runRuntime(() => resetRuntimeOnThisComputer(() => active.stop())),
    rollback: (onProgress) => runRuntime(() => rollbackRuntimeUpdate(onProgress)),
    getVersion: () => runRuntimeSync(() => active.getVersion()),
    checkForUpdate: () => runRuntime(() => active.checkForUpdate()),
    openInBrowser: () => {
      runRuntimeSync(() => active.openInBrowser());
    },
    getLogs: (lines) => {
      const count = lines ?? runtimeLogs.length;
      return Promise.resolve(runtimeLogs.slice(-count).join('\n'));
    },
    isInstalled: () => runRuntime(() => active.isInstalled()),
    async getLaunchInfo() {
      let status: TargetStatus = 'stopped';
      try {
        status = await currentStatus();
      } catch {
        status = 'error';
      }
      const preflight = await collectPreflight();
      const platform = preflight.checks.find((check) => check.id === 'platform' && check.level === 'block');
      return {
        id: active.id,
        displayName: active.descriptor.displayName,
        openUrl: active.descriptor.openUrl,
        status,
        platformNote: platform?.message ?? null,
        preflight,
        openAtLogin: readOpenAtLogin(),
        canRollback: Boolean(runtimeHeadStore().get()),
      };
    },
    getPreflight: () => collectPreflight(),
    async describeFailure() {
      const preflight = await collectPreflight();
      return failureScreen(collectFailureFacts(lastError, preflight.checks));
    },
    async fixFailure() {
      const preflight = await collectPreflight();
      const facts = collectFailureFacts(lastError, preflight.checks);
      if (failureScreen(facts).kind === 'windows') {
        return windowsFixResult(
          () => fixWindowsOnThisComputer(),
          async () => {
            try {
              const response = await fetch(HEALTH_URL, { signal: AbortSignal.timeout(800) });
              return { status: response.status, body: await response.text() };
            } catch {
              return null;
            }
          },
          () => confirmInstalledGateway(),
        );
      }
      return fixCollectedFailure(facts);
    },
    getDiagnostics: () => diagnosticsText(),
    saveSupportBundle: async () => saveCollectedSupportBundle(await diagnosticsText()),
    resumeInstallPlan: () => resumeInstallPlanOnThisComputer(),
    setOpenAtLogin(enabled: boolean) {
      applyOpenAtLogin(enabled);
    },
    getOpenAtLogin() {
      return readOpenAtLogin();
    },
    async shutdown() {
      try {
        await active.stop();
      } catch (err) {
        if (isForeignGatewayError(err)) return;
        throw err;
      }
    },
  };
}
