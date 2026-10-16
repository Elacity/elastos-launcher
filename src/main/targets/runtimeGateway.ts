import { spawn } from 'child_process';

/** Supervised command from the launcher contract. */
export const GATEWAY_ARGS = ['gateway', '--addr', '127.0.0.1:8090'] as const;
export const HEALTH_URL = 'http://127.0.0.1:8090/healthz';
export const HOME_URL = 'http://127.0.0.1:8090/home/';
export const ALREADY_OWNS_TEXT = 'another ElastOS host already owns';
export const EXIT_BINARY_REPLACED = 75;
export const STOP_GRACE_MS = 15_000;

export interface HealthResult {
  status: number;
  body: string;
}

export interface GatewayProcess {
  readonly pid: number;
  onOutput(listener: (chunk: string) => void): void;
  onExit(listener: (code: number | null) => void): void;
  signal(signal: NodeJS.Signals): void;
}

export interface GatewaySupervisorDeps {
  binary: string;
  spawn: (binary: string, args: readonly string[]) => GatewayProcess;
  fetchHealth: () => Promise<HealthResult | null>;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
  openUrl: (url: string) => void;
  log: (line: string) => void;
  graceMs?: number;
  healthTimeoutMs?: number;
  pollMs?: number;
  maxRestarts?: number;
}

export interface GatewaySupervisor {
  start(): Promise<'started' | 'already-running'>;
  stop(): Promise<void>;
  openHome(): void;
  getLogs(lines?: number): string;
  phase(): 'running' | 'stopped' | 'starting' | 'stopping' | 'error';
}

export function isHealthOk(result: HealthResult | null): boolean {
  return Boolean(result && result.status === 200 && result.body.trim() === 'OK');
}

/** Drop lines that can carry attach_secret. The coords files stay on disk, out of the log. */
export function scrubRuntimeLog(chunk: string): string {
  if (/attach_secret|runtime-coords\.json|gateway-runtime-coords|home-runtime-coords/i.test(chunk)) {
    return '[elastos] omitted a line that can contain a local secret\n';
  }
  return chunk;
}

export function createGatewaySupervisor(deps: GatewaySupervisorDeps): GatewaySupervisor {
  const graceMs = deps.graceMs ?? STOP_GRACE_MS;
  const healthTimeoutMs = deps.healthTimeoutMs ?? 60_000;
  const pollMs = deps.pollMs ?? 250;
  const maxRestarts = deps.maxRestarts ?? 3;
  const logs: string[] = [];
  let owned: GatewayProcess | null = null;
  let foreign = false;
  let intentionalStop = false;
  let restarts = 0;
  let current: 'running' | 'stopped' | 'starting' | 'stopping' | 'error' = 'stopped';

  const note = (line: string) => {
    const clean = scrubRuntimeLog(line).replace(/\s+$/g, '');
    if (!clean) return;
    logs.push(clean);
    deps.log(clean);
  };

  async function launchOnce(): Promise<'ready' | 'replaced' | 'already'> {
    intentionalStop = false;
    foreign = false;
    const proc = deps.spawn(deps.binary, GATEWAY_ARGS);
    owned = proc;
    let output = '';
    let exited = false;
    let exitCode: number | null = null;
    proc.onOutput((chunk) => {
      output += chunk;
      note(chunk);
    });
    proc.onExit((code) => {
      exited = true;
      exitCode = code;
      if (current === 'running' && !intentionalStop && code === EXIT_BINARY_REPLACED) {
        owned = null;
        restarts += 1;
        if (restarts > maxRestarts) {
          current = 'error';
          note('ElastOS kept restarting after an update. Click Start to try again.');
          return;
        }
        note('ElastOS was updated. Starting it again.');
        void supervisor.start().catch((err: unknown) => {
          current = 'error';
          note(err instanceof Error ? err.message : String(err));
        });
      }
    });

    const deadline = deps.now() + healthTimeoutMs;
    while (deps.now() < deadline) {
      if (exited) return classifyExit(exitCode, output);
      const health = await deps.fetchHealth();
      if (exited) return classifyExit(exitCode, output);
      if (isHealthOk(health)) {
        restarts = 0;
        current = 'running';
        return 'ready';
      }
      await deps.sleep(pollMs);
      if (exited) return classifyExit(exitCode, output);
    }
    throw new Error('ElastOS did not become ready in time. Click Install to try again.');
  }

  function classifyExit(code: number | null, output: string): 'replaced' | 'already' {
    owned = null;
    if (code === EXIT_BINARY_REPLACED) {
      restarts += 1;
      if (restarts > maxRestarts) {
        throw new Error('ElastOS kept restarting after an update. Click Start to try again.');
      }
      note('ElastOS was updated. Starting it again.');
      return 'replaced';
    }
    if (output.includes(ALREADY_OWNS_TEXT)) {
      return 'already';
    }
    const tail = scrubRuntimeLog(output).trim().split('\n').slice(-3).join(' ');
    throw new Error(
      tail
        ? `ElastOS stopped before it was ready. ${tail}`
        : 'ElastOS stopped before it was ready. Click Install to try again.',
    );
  }

  const supervisor: GatewaySupervisor = {
    async start() {
      if (owned && current === 'running') return 'started';
      current = 'starting';
      for (;;) {
        const result = await launchOnce();
        if (result === 'replaced') continue;
        if (result === 'already') {
          const health = await deps.fetchHealth();
          if (!isHealthOk(health)) {
            current = 'error';
            throw new Error('ElastOS is already running, but it is not answering yet. Wait a moment and click Open my computer.');
          }
          foreign = true;
          owned = null;
          current = 'running';
          deps.openUrl(HOME_URL);
          return 'already-running';
        }
        current = 'running';
        return 'started';
      }
    },
    async stop() {
      if (!owned) {
        const health = await deps.fetchHealth();
        if (isHealthOk(health)) {
          throw new Error('ElastOS is already running. This window did not start it, so Stop leaves it running.');
        }
        foreign = false;
        current = 'stopped';
        return;
      }
      intentionalStop = true;
      current = 'stopping';
      const proc = owned;
      proc.signal('SIGTERM');
      const deadline = deps.now() + graceMs;
      while (deps.now() < deadline) {
        if (!isHealthOk(await deps.fetchHealth())) {
          owned = null;
          current = 'stopped';
          return;
        }
        await deps.sleep(pollMs);
      }
      proc.signal('SIGKILL');
      await deps.sleep(pollMs);
      owned = null;
      if (isHealthOk(await deps.fetchHealth())) {
        current = 'error';
        throw new Error('ElastOS is still running.');
      }
      current = 'stopped';
    },
    openHome() {
      deps.openUrl(HOME_URL);
    },
    getLogs(lines?: number) {
      const count = lines ?? logs.length;
      return logs.slice(-count).join('\n');
    },
    phase() {
      return current;
    },
  };

  return supervisor;
}

export function spawnGatewayProcess(binary: string, args: readonly string[]): GatewayProcess {
  const child = spawn(binary, [...args], {
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const outputListeners: Array<(chunk: string) => void> = [];
  const exitListeners: Array<(code: number | null) => void> = [];
  const emit = (chunk: Buffer | string) => {
    const text = chunk.toString();
    for (const listener of outputListeners) listener(text);
  };
  child.stdout?.on('data', emit);
  child.stderr?.on('data', emit);
  child.on('exit', (code) => {
    for (const listener of exitListeners) listener(code);
  });
  return {
    pid: child.pid ?? -1,
    onOutput(listener) {
      outputListeners.push(listener);
    },
    onExit(listener) {
      exitListeners.push(listener);
    },
    signal(signal) {
      if (!child.pid || child.pid < 0) return;
      try {
        process.kill(child.pid, signal);
      } catch {
        // The process already left.
      }
    },
  };
}

let logSink: (line: string) => void = () => {};

export function setRuntimeLogSink(sink: (line: string) => void): void {
  logSink = sink;
}

export function createDefaultGatewaySupervisor(binary: string): GatewaySupervisor {
  return createGatewaySupervisor({
    binary,
    spawn: spawnGatewayProcess,
    fetchHealth: async () => {
      try {
        const response = await fetch(HEALTH_URL, { signal: AbortSignal.timeout(2000) });
        return { status: response.status, body: await response.text() };
      } catch {
        return null;
      }
    },
    sleep: (ms) => new Promise((resolve) => { setTimeout(resolve, ms); }),
    now: () => Date.now(),
    openUrl: openRuntimeHome,
    log: (line) => logSink(line),
  });
}

export function openRuntimeHome(): void {
  // Same pattern as PC2: Electron is present in the app and absent in unit tests.
  const electron = require('electron') as { shell?: { openExternal: (url: string) => void } };
  if (!electron.shell?.openExternal) {
    throw new Error('Could not open your computer in the browser.');
  }
  electron.shell.openExternal(HOME_URL);
}
