import * as os from 'os';
import { applyOpenAtLogin, readOpenAtLogin } from './targets/openAtLogin';
import { buildDiagnostics, collectPreflight, PreflightReport, saveCollectedSupportBundle } from './targets/preflight';
import { confirmInstalledGateway, isForeignGatewayError, isHealthOk, probeGatewayHealth, STOP_GRACE_MS } from './targets/runtimeGateway';
import { collectFailureFacts, failureScreen, FailureScreen, fixCollectedFailure, windowsFixResult } from './targets/runtimeRecovery';
import { resolveLaunchTargetId } from './targets/preferences';
import { LAUNCH_TARGET_ENV, retiredPc2Notice } from './targets/registry';
import { createLaunchTarget } from './targets';
import { setRuntimeLogSink } from './targets/runtimeGateway';
import { loadActiveRuntimePin } from './targets/runtimePin';
import { browserNote } from './targets/runtimeSupport';
import { runtimeHeadStore } from './targets/runtimeUpdate';
import { rollbackRuntimeUpdate } from './targets/runtimeTarget';
import { BackupDescription, describeRuntimeBackupOnThisComputer } from './targets/runtimeBackup';
import { resetRuntimeOnThisComputer, ResetResult } from './targets/runtimeUninstall';
import { describeDistroBackupOnThisComputer, resetRuntimeInDistroOnThisComputer } from './targets/windowsReset';
import { UninstallPrompt, UninstallResult, uninstallRuntimeInDistroOnThisComputer } from './targets/windowsUninstall';
import { finishResumeInstall as clearResumeInstall, fixWindowsOnThisComputer, resumeInstallPlanOnThisComputer, ResumeInstallPlan } from './targets/windowsHost';
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
  /**
   * On Windows `choice.backup` must be true or false, and `confirmRemoval`
   * asks the second question before the Linux environment is removed.
   */
  uninstall(choice?: { backup?: unknown }, confirmRemoval?: (prompt: UninstallPrompt) => Promise<unknown>): Promise<UninstallResult | void>;
  /** `choice.backup` must be true or false. Anything else resets nothing. */
  resetRuntime(choice?: { backup?: unknown }): Promise<ResetResult>;
  /** `action` picks the words of a refusal shown in the dialog (Reset or Uninstall). */
  describeResetBackup(action?: 'reset' | 'uninstall'): Promise<BackupDescription>;
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
  finishResumeInstall(ok: boolean): void;
  setOpenAtLogin(enabled: boolean): void;
  getOpenAtLogin(): boolean;
  shutdown(): Promise<void>;
  forceStopGateway(): void;
}

export interface QuitGate {
  started: boolean;
  ready: boolean;
}

/** One /healthz probe can outlive each grace, and stop may probe ownership once first. */
export const QUIT_HEALTH_PROBE_MS = 2_000;
export const QUIT_STOP_BUDGET_MS = 2 * STOP_GRACE_MS + 3 * QUIT_HEALTH_PROBE_MS + 4_000;

export interface QuitStopOptions {
  budgetMs?: number;
  log?: (line: string) => void;
  onStopping?: () => void;
  /** Runs when the wait expires, before the window closes. SIGKILL the gateway here. */
  onBudget?: () => void;
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
        log('ElastOS did not stop before quit finished. Stopping it now.');
        options.onBudget?.();
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
  /** Shown in the info panel. Windows only: its Browser is not available yet. */
  browserNote: string | null;
  /** Windows: Uninstall removes the Linux environment, so it offers a copy of the data first. */
  uninstallOffersCopy: boolean;
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
    const probed = await probeGatewayHealth({ timeoutMs: 800 });
    const health = isHealthOk(probed) ? 'OK' : 'not answering';
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
    // On Windows, Uninstall removes the ElastOS Linux environment, after the Reset checks and a second question.
    uninstall: (choice, confirmRemoval) => runRuntime<UninstallResult | void>(() => (process.platform === 'win32'
      ? uninstallRuntimeInDistroOnThisComputer(() => active.stopForRemoval(), choice ?? {}, confirmRemoval ?? (async () => false))
      : active.uninstall())),
    // On Windows the ElastOS data is inside the ElastOS Linux environment, so Reset works there.
    resetRuntime: (choice) => runRuntime(() => (process.platform === 'win32'
      ? resetRuntimeInDistroOnThisComputer(() => active.stopForRemoval(), choice ?? {})
      : resetRuntimeOnThisComputer(() => active.stopForRemoval(), choice ?? {}))),
    describeResetBackup: (action) => (process.platform === 'win32'
      ? describeDistroBackupOnThisComputer(action === 'uninstall' ? 'uninstall' : 'reset')
      : describeRuntimeBackupOnThisComputer()),
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
        browserNote: browserNote(process.platform),
        uninstallOffersCopy: process.platform === 'win32',
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
          () => probeGatewayHealth({ timeoutMs: 800 }),
          () => confirmInstalledGateway(),
        );
      }
      return fixCollectedFailure(facts);
    },
    getDiagnostics: () => diagnosticsText(),
    saveSupportBundle: async () => saveCollectedSupportBundle(await diagnosticsText()),
    resumeInstallPlan: () => resumeInstallPlanOnThisComputer({
      installed: () => active.isInstalled(),
    }),
    finishResumeInstall(ok: boolean) {
      clearResumeInstall(os.homedir(), ok);
    },
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
    forceStopGateway() {
      active.forceStop?.();
    },
  };
}
