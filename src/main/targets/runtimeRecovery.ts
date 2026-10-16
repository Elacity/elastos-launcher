import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { HEALTH_URL } from './runtimeGateway';
import { installRuntimeOnThisComputer } from './runtimeInstall';
import { runtimeBinaryPath, runtimeComponentsPath, runtimeDataDir, runtimeHostLockPath } from './runtimePaths';
import { loadActiveRuntimePin } from './runtimePin';
import { portBusy } from './preflight';

export type FailureKind = 'port' | 'interrupted' | 'stale-lock' | 'offline' | 'other';

export interface FailureCheck {
  id: string;
  level: string;
  message: string;
}

export interface FailureFacts {
  error: string;
  checks: FailureCheck[];
  binaryPresent: boolean;
  componentsPresent: boolean;
  lockText: string | null;
  lockPath: string | null;
  pidAlive: (pid: number) => boolean;
}

export interface FailureScreen {
  kind: FailureKind;
  title: string;
  message: string;
  retryLabel: 'Try again';
  fixLabel: 'Fix it' | null;
}

export interface RecoveryDeps {
  recheckPort: () => Promise<'free' | 'ours' | 'busy'>;
  recheckOnline: () => Promise<boolean>;
  resumeSetup: () => Promise<void>;
  removeLock: (lockPath: string) => void;
}

const GENERIC = 'Something went wrong. Try again. If it keeps happening, copy diagnostics.';

export function lockPid(text: string | null): number | null {
  if (!text) return null;
  try {
    const parsed = JSON.parse(text) as { pid?: unknown };
    return typeof parsed.pid === 'number' && Number.isInteger(parsed.pid) && parsed.pid > 0
      ? parsed.pid
      : null;
  } catch {
    return null;
  }
}

export function lockIsStale(text: string | null, pidAlive: (pid: number) => boolean): boolean {
  const pid = lockPid(text);
  if (pid == null) return false;
  return !pidAlive(pid);
}

export function assertStaleLockPath(lockPath: string): void {
  if (path.basename(lockPath) !== 'host-process.lock') {
    throw new Error('Refusing to remove a file that is not the ElastOS host lock.');
  }
  if (path.basename(path.dirname(lockPath)) !== 'elastos') {
    throw new Error('Refusing to remove a lock outside the ElastOS data directory.');
  }
  const normalized = lockPath.split(path.sep).join('/');
  if (normalized.includes('/.pc2/') || normalized.includes('/pc2.net/')) {
    throw new Error('Refusing to remove the PC2 directory.');
  }
}

export function failureScreen(facts: FailureFacts): FailureScreen {
  const kind = classify(facts);
  const copy = kind === 'other'
    ? { title: 'ElastOS needs attention', message: plainError(facts.error) }
    : COPY[kind];
  return {
    kind,
    title: copy.title,
    message: copy.message,
    retryLabel: 'Try again',
    fixLabel: kind === 'other' ? null : 'Fix it',
  };
}

export async function applyFix(facts: FailureFacts, deps: RecoveryDeps): Promise<'ready' | 'still-blocked'> {
  const kind = classify(facts);
  if (kind === 'offline') {
    return (await deps.recheckOnline()) ? 'ready' : 'still-blocked';
  }
  if (kind === 'port') {
    const state = await deps.recheckPort();
    return state === 'busy' ? 'still-blocked' : 'ready';
  }
  if (kind === 'interrupted') {
    if (!facts.binaryPresent || facts.componentsPresent) return 'still-blocked';
    await deps.resumeSetup();
    return 'ready';
  }
  if (kind === 'stale-lock') {
    if (!facts.lockPath || !lockIsStale(facts.lockText, facts.pidAlive)) return 'still-blocked';
    assertStaleLockPath(facts.lockPath);
    deps.removeLock(facts.lockPath);
    return 'ready';
  }
  return 'still-blocked';
}

export function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function collectFailureFacts(error: string, checks: FailureCheck[]): FailureFacts {
  const home = os.homedir();
  const data = runtimeDataDir(process.platform, home, process.env);
  const lockPath = runtimeHostLockPath(data);
  let lockText: string | null = null;
  try {
    lockText = fs.readFileSync(lockPath, 'utf8');
  } catch {
    lockText = null;
  }
  return {
    error,
    checks,
    binaryPresent: isFile(runtimeBinaryPath(home)),
    componentsPresent: isFile(runtimeComponentsPath(data)),
    lockText,
    lockPath: lockText == null ? null : lockPath,
    pidAlive,
  };
}

export async function fixCollectedFailure(facts: FailureFacts): Promise<'ready' | 'still-blocked'> {
  return applyFix(facts, {
    recheckPort: recheckPort,
    recheckOnline: recheckOnline,
    resumeSetup: () => installRuntimeOnThisComputer(),
    removeLock: (lockPath) => {
      assertStaleLockPath(lockPath);
      fs.rmSync(lockPath, { force: true });
    },
  });
}

function classify(facts: FailureFacts): FailureKind {
  if (blocked(facts, 'network') || /offline|not reachable|ENOTFOUND|getaddrinfo/i.test(facts.error)) {
    return 'offline';
  }
  if (blocked(facts, 'port') || /port 8090|being used by another program/i.test(facts.error)) {
    return 'port';
  }
  if (lockIsStale(facts.lockText, facts.pidAlive)) return 'stale-lock';
  if ((facts.binaryPresent && !facts.componentsPresent) || /did not finish|interrupted install/i.test(facts.error)) {
    return 'interrupted';
  }
  return 'other';
}

function blocked(facts: FailureFacts, id: string): boolean {
  return facts.checks.some((check) => check.id === id && check.level === 'block');
}

function plainError(error: string): string {
  if (/attach_secret|runtime-coords|BEGIN [A-Z ]*PRIVATE KEY/i.test(error)) return GENERIC;
  const line = error.split('\n').map((part) => part.trim()).find(Boolean) ?? '';
  if (!line || /^\s*at\s+/.test(line)) return GENERIC;
  return line.replace(/^Error:\s*/, '');
}

const COPY: Record<Exclude<FailureKind, 'other'>, { title: string; message: string }> = {
  offline: {
    title: 'You are offline',
    message: 'ElastOS could not reach the internet, so nothing was installed. Connect, then click Fix it to check again.',
  },
  port: {
    title: 'Port 8090 is busy',
    message: 'Another program is using the address ElastOS needs. Quit that program, then click Fix it. ElastOS will not close other programs for you.',
  },
  interrupted: {
    title: 'The install did not finish',
    message: 'ElastOS was downloaded, but setup did not finish. Click Fix it to continue setup without downloading again.',
  },
  'stale-lock': {
    title: 'A previous ElastOS did not close',
    message: 'The old session is gone, but it left a lock. Click Fix it to clear that lock. A running ElastOS is left alone.',
  },
};

function isFile(file: string): boolean {
  try {
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
}

async function recheckPort(): Promise<'free' | 'ours' | 'busy'> {
  if (!(await portBusy(8090))) return 'free';
  try {
    const response = await fetch(HEALTH_URL, { signal: AbortSignal.timeout(800) });
    if (response.status === 200 && (await response.text()).trim() === 'OK') return 'ours';
  } catch {
    // Another program still has the port.
  }
  return 'busy';
}

async function recheckOnline(): Promise<boolean> {
  try {
    const pin = loadActiveRuntimePin();
    const url = `${pin.publisherGateway.replace(/\/$/, '')}/release-head.json`;
    const response = await fetch(url, { signal: AbortSignal.timeout(3000) });
    return response.ok;
  } catch {
    return false;
  }
}
