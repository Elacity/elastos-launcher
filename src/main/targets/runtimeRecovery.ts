import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { GATEWAY_PORT } from './gatewayAddress';
import { confirmInstalledGateway, isHealthOk } from './runtimeGateway';
import { installRuntimeOnThisComputer } from './runtimeInstall';
import {
  NO_INSTALL_RECORD,
  launcherOwnedDirectories,
  runtimeBinaryPath,
  runtimeComponentsPath,
  runtimeDataDir,
  runtimeHostLockPath,
} from './runtimePaths';
import { loadActiveRuntimePin } from './runtimePin';
import { portBusy } from './preflight';

export type FailureKind = 'port' | 'interrupted' | 'stale-lock' | 'offline' | 'windows' | 'no-record' | 'other';

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
  enableWindows?: () => Promise<void>;
  healthOk?: () => Promise<boolean>;
  gatewayIdentity?: () => Promise<boolean>;
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
  if (path.basename(path.dirname(lockPath)) !== 'elastos' || !launcherOwnedDirectories(lockPath)) {
    throw new Error('Refusing to remove a lock outside the ElastOS data directory.');
  }
}

export interface LockStat {
  isSymbolicLink(): boolean;
  dev: number;
  ino: number;
}

/**
 * Re-read the lock at delete time. A snapshot from the error screen is not
 * enough: the file may have been replaced, or the pid may be alive again.
 */
export function removeStaleLockNow(lockPath: string, deps: {
  readFile: (file: string) => string;
  lstat: (file: string) => LockStat;
  pidAlive: (pid: number) => boolean;
  unlink: (file: string) => void;
}): void {
  assertStaleLockPath(lockPath);
  const first = deps.lstat(lockPath);
  if (first.isSymbolicLink()) {
    throw new Error('Refusing to remove a lock that is a symlink.');
  }
  const text = deps.readFile(lockPath);
  if (!lockIsStale(text, deps.pidAlive)) {
    throw new Error('A running ElastOS holds this lock.');
  }
  const second = deps.lstat(lockPath);
  if (second.isSymbolicLink() || second.dev !== first.dev || second.ino !== first.ino) {
    throw new Error('The lock changed. It was left in place.');
  }
  const again = deps.readFile(lockPath);
  if (again !== text || !lockIsStale(again, deps.pidAlive)) {
    throw new Error('The lock changed. It was left in place.');
  }
  deps.unlink(lockPath);
}

export function failureScreen(facts: FailureFacts): FailureScreen {
  const kind = classify(facts);
  if (kind === 'windows') {
    const check = facts.checks.find((item) => item.id === 'windows' && item.level === 'block');
    return {
      kind,
      title: 'Windows needs one step',
      message: check?.message || 'Windows needs Linux support. Click Fix it. You do not type any commands.',
      retryLabel: 'Try again',
      fixLabel: 'Fix it',
    };
  }
  if (kind === 'no-record') {
    // The refusal names the folder and the next clicks (foreignRuntimeDataMessage).
    return {
      kind,
      title: 'Install ElastOS again, then reset',
      message: plainError(facts.error, facts.checks),
      retryLabel: 'Try again',
      fixLabel: 'Fix it',
    };
  }
  const copy = kind === 'other'
    ? { title: 'ElastOS needs attention', message: plainError(facts.error, facts.checks) }
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
  if (kind === 'windows') {
    if (!deps.enableWindows || !deps.healthOk || !deps.gatewayIdentity) return 'still-blocked';
    await deps.enableWindows();
    if (!(await deps.healthOk())) return 'still-blocked';
    return (await deps.gatewayIdentity()) ? 'ready' : 'still-blocked';
  }
  if (kind === 'no-record') {
    // Nothing is deleted or changed here. On 'ready' the window runs Install,
    // and install.sh writes the signed record in installation/ (runtime
    // install-release). Then Reset can prove the folder.
    return 'ready';
  }
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
    if (!facts.lockPath) return 'still-blocked';
    assertStaleLockPath(facts.lockPath);
    try {
      deps.removeLock(facts.lockPath);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (/running ElastOS|lock changed|symlink/.test(message)) return 'still-blocked';
      throw err;
    }
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

export async function windowsFixResult(
  enable: () => Promise<void>,
  health: () => Promise<{ status: number; body: string } | null>,
  identity: () => Promise<boolean>,
): Promise<'ready' | 'still-blocked'> {
  await enable();
  if (!isHealthOk(await health())) return 'still-blocked';
  return (await identity()) ? 'ready' : 'still-blocked';
}

export async function fixCollectedFailure(facts: FailureFacts): Promise<'ready' | 'still-blocked'> {
  return applyFix(facts, {
    recheckPort: recheckPort,
    recheckOnline: recheckOnline,
    resumeSetup: () => installRuntimeOnThisComputer(),
    removeLock: (lockPath) => {
      removeStaleLockNow(lockPath, {
        readFile: (file) => fs.readFileSync(file, 'utf8'),
        lstat: (file) => fs.lstatSync(file),
        pidAlive,
        unlink: (file) => fs.rmSync(file, { force: true }),
      });
    },
  });
}

function classify(facts: FailureFacts): FailureKind {
  if (facts.error.includes(NO_INSTALL_RECORD)) return 'no-record';
  if (blocked(facts, 'windows')) return 'windows';
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

function plainError(error: string, checks: FailureCheck[]): string {
  if (/attach_secret|runtime-coords|BEGIN [A-Z ]*PRIVATE KEY/i.test(error)) return GENERIC;
  const line = error.split('\n').map((part) => part.trim()).find(Boolean) ?? '';
  if (line && !/^\s*at\s+/.test(line)) return line.replace(/^Error:\s*/, '');
  const block = checks.find((check) => check.level === 'block');
  return block?.message || GENERIC;
}

const COPY: Record<Exclude<FailureKind, 'other' | 'windows' | 'no-record'>, { title: string; message: string }> = {
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
    message: 'ElastOS was downloaded, but setup did not finish. Click Fix it to check the signed release again and continue setup. The installer is not downloaded again.',
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

/** Ours only when the installed gateway identity check agrees. An OK body is not enough. */
export async function recheckPortWith(deps: {
  portBusy: () => Promise<boolean>;
  confirm: () => Promise<boolean>;
}): Promise<'free' | 'ours' | 'busy'> {
  if (!(await deps.portBusy())) return 'free';
  try {
    return (await deps.confirm()) ? 'ours' : 'busy';
  } catch {
    return 'busy';
  }
}

async function recheckPort(): Promise<'free' | 'ours' | 'busy'> {
  return recheckPortWith({
    portBusy: () => portBusy(GATEWAY_PORT),
    confirm: () => confirmInstalledGateway(),
  });
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
