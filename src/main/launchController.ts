import * as pc2 from './pc2Manager';
import { createLaunchTargetStore, LaunchTargetPreferenceStore, resolveLaunchTargetId } from './targets/preferences';
import { createLaunchTarget } from './targets';
import { setRuntimeLogSink } from './targets/runtimeGateway';
import { LaunchTarget, TargetStatus, UpdateCheck } from './targets/types';

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
  getVersion(): string;
  checkForUpdate(): Promise<UpdateCheck>;
  openInBrowser(): void;
  getLogs(lines?: number): Promise<string>;
  isInstalled(): Promise<boolean>;
  shutdown(): void;
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * IPC-facing supervisor. PC2 methods are the pc2Manager functions.
 * The runtime target rejects; those errors are logged and are not
 * turned into a PC2 install.
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
  const target = createLaunchTarget(id);
  const statusListeners: Array<(status: TargetStatus) => void> = [];
  const logListeners: Array<(line: string) => void> = [];
  const runtimeLogs: string[] = [];
  const pc2Mode = id === 'pc2';

  const emitStatus = (status: TargetStatus) => {
    for (const listener of statusListeners) listener(status);
  };
  const emitLog = (line: string) => {
    runtimeLogs.push(line);
    for (const listener of logListeners) listener(line);
  };

  if (pc2Mode) {
    pc2.onStatusChange(emitStatus);
    pc2.onLog(emitLog);
  } else {
    setRuntimeLogSink(emitLog);
  }

  async function runRuntime<T>(action: () => Promise<T>): Promise<T> {
    try {
      return await action();
    } catch (err) {
      emitLog(messageOf(err));
      emitStatus('error');
      throw err;
    }
  }

  function runRuntimeSync<T>(action: () => T): T {
    try {
      return action();
    } catch (err) {
      emitLog(messageOf(err));
      emitStatus('error');
      throw err;
    }
  }

  return {
    target,
    onStatusChange(listener) {
      statusListeners.push(listener);
    },
    onLog(listener) {
      logListeners.push(listener);
    },
    getStatus: () => (pc2Mode ? target.getStatus() : runRuntime(() => target.getStatus())),
    start: () => (pc2Mode ? target.start() : runRuntime(() => target.start())),
    stop: () => (pc2Mode ? target.stop() : runRuntime(() => target.stop())),
    restart: () => (pc2Mode ? target.restart() : runRuntime(() => target.restart())),
    install: (onProgress) => (pc2Mode ? target.install(onProgress) : runRuntime(() => target.install(onProgress))),
    update: (onProgress) => (pc2Mode ? target.update(onProgress) : runRuntime(() => target.update(onProgress))),
    uninstall: () => (pc2Mode ? target.uninstall() : runRuntime(() => target.uninstall())),
    getVersion: () => (pc2Mode ? target.getVersion() : runRuntimeSync(() => target.getVersion())),
    checkForUpdate: () => (pc2Mode ? target.checkForUpdate() : runRuntime(() => target.checkForUpdate())),
    openInBrowser: () => {
      if (pc2Mode) {
        target.openInBrowser();
        return;
      }
      runRuntimeSync(() => target.openInBrowser());
    },
    getLogs: (lines) => {
      if (pc2Mode) return target.getLogs(lines);
      const count = lines ?? runtimeLogs.length;
      return Promise.resolve(runtimeLogs.slice(-count).join('\n'));
    },
    isInstalled: () => (pc2Mode ? target.isInstalled() : runRuntime(() => target.isInstalled())),
    shutdown() {
      pc2.shutdownHeartbeatPoller();
      if (!pc2Mode) {
        void target.stop().catch(() => {});
      }
    },
  };
}
