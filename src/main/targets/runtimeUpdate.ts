import { execFile as execFileCb } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { findRuntimeBinary } from './runtimeProbe';
import { UpdateCheck } from './types';

export const UPDATE_CURRENT_LINE = 'Installed release is up to date.';
export const UPDATE_AVAILABLE_LINE = 'Run `elastos update` to install.';
export const UPDATE_CANCELLED_LINE = 'Update cancelled.';

export interface RuntimeCommandResult {
  code: number;
  stdout: string;
  stderr: string;
}

export type RuntimeCommand = (args: readonly string[]) => Promise<RuntimeCommandResult>;

export interface HeadCidStore {
  get(): string | undefined;
  set(cid: string): void;
}

export interface ParsedUpdateCheck {
  updateAvailable: boolean;
  detail: string;
  latest: string | null;
}

/** `update --check` exits 0 both when current and when a newer release exists. */
export function parseUpdateCheck(stdout: string): ParsedUpdateCheck {
  const latest = parseLatestVersion(stdout);
  if (stdout.includes(UPDATE_CURRENT_LINE)) {
    return { updateAvailable: false, detail: UPDATE_CURRENT_LINE, latest };
  }
  if (stdout.includes(UPDATE_AVAILABLE_LINE) || stdout.includes('Run elastos update to install.')) {
    return { updateAvailable: true, detail: UPDATE_AVAILABLE_LINE, latest };
  }
  return { updateAvailable: false, detail: stdout.trim() || 'No update information.', latest };
}

export function parseLatestVersion(stdout: string): string | null {
  const line = stdout.split(/\r?\n/).find((item) => item.includes('Latest available:'));
  if (!line) return null;
  const value = line.split(':').slice(1).join(':').trim();
  return value || null;
}

export function parseHeadCid(stdout: string): string | null {
  for (const line of stdout.split(/\r?\n/)) {
    const match = line.match(/^\s*Head CID:\s*(\S+)/);
    if (match) return match[1];
  }
  return null;
}

export async function checkRuntimeUpdate(run: RuntimeCommand): Promise<ParsedUpdateCheck> {
  const result = await run(['update', '--check']);
  if (result.code !== 0) {
    throw new Error(result.stderr.trim() || result.stdout.trim() || 'Could not check for an ElastOS update.');
  }
  return parseUpdateCheck(result.stdout);
}

export async function applyRuntimeUpdate(
  run: RuntimeCommand,
  store: HeadCidStore,
  onProgress: (message: string) => void = () => {},
): Promise<void> {
  onProgress('Checking the installed ElastOS release.');
  const shown = await run(['source', 'show']);
  if (shown.code !== 0) {
    throw new Error(shown.stderr.trim() || 'Could not read the installed ElastOS release.');
  }
  const cid = parseHeadCid(shown.stdout);
  if (cid) store.set(cid);
  onProgress('Installing the ElastOS update (about 2 minutes).');
  const updated = await run(['update', '--yes']);
  if (updated.stdout.includes(UPDATE_CANCELLED_LINE)) {
    throw new Error('The update did not run.');
  }
  if (updated.code !== 0) {
    throw new Error(updated.stderr.trim() || updated.stdout.trim() || 'The ElastOS update failed.');
  }
}

export async function rollbackRuntime(
  run: RuntimeCommand,
  store: HeadCidStore,
  onProgress: (message: string) => void = () => {},
): Promise<void> {
  const cid = store.get();
  if (!cid) throw new Error('There is no previous ElastOS release to go back to.');
  onProgress('Restoring the previous ElastOS release.');
  const result = await run(['update', '--rollback-to', cid, '--yes']);
  if (result.stdout.includes(UPDATE_CANCELLED_LINE)) {
    throw new Error('The restore did not run.');
  }
  if (result.code !== 0) {
    throw new Error(result.stderr.trim() || result.stdout.trim() || 'Could not restore the previous ElastOS release.');
  }
}

export function toUpdateCheck(current: string, parsed: ParsedUpdateCheck, releaseUrl: string): UpdateCheck {
  return {
    current,
    latest: parsed.latest ?? (parsed.updateAvailable ? 'a newer release' : current),
    updateAvailable: parsed.updateAvailable,
    releaseUrl,
  };
}

export function runtimeHeadStore(homeDir: string = os.homedir()): HeadCidStore {
  const file = path.join(homeDir, '.elastos-launcher', 'previous-head.json');
  return {
    get() {
      try {
        const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as { headCid?: string };
        return parsed.headCid || undefined;
      } catch {
        return undefined;
      }
    },
    set(cid: string) {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, JSON.stringify({ headCid: cid }));
    },
  };
}

export function runRuntimeCommand(args: readonly string[]): Promise<RuntimeCommandResult> {
  const binary = findRuntimeBinary(os.homedir(), process.env.PATH ?? '');
  if (!binary) {
    return Promise.reject(new Error('ElastOS is not installed yet. Click Install.'));
  }
  return new Promise((resolve) => {
    execFileCb(binary, [...args], { timeout: 15 * 60 * 1000 }, (err, stdout, stderr) => {
      const code = err && typeof err.code === 'number' ? err.code : err ? 1 : 0;
      resolve({ code, stdout: stdout ?? '', stderr: stderr ?? '' });
    });
  });
}
