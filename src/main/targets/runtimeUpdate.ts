import { execFile as execFileCb } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { findRuntimeBinary } from './runtimeProbe';
import { runtimeChildEnv, verifyReleaseHead } from './releaseHead';
import { UpdateCheck } from './types';
import { ActiveRuntimePin } from './runtimePin';
import { channelGateway, pinMismatchField, PinMismatchError, versionAtLeast } from './runtimeInstall';

export const UPDATE_CANCELLED_LINE = 'Update cancelled.';
export const UPDATE_STATUS_UNREADABLE = 'ElastOS update status is not readable.';

const UPDATE_CHECK_SCHEMA = 'elastos.update-check/v1';

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

export function parseUpdateCheckStatus(raw: string): ParsedUpdateCheck {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error(UPDATE_STATUS_UNREADABLE);
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(UPDATE_STATUS_UNREADABLE);
  }
  const record = value as Record<string, unknown>;
  const outcome = record.outcome;
  if (record.schema !== UPDATE_CHECK_SCHEMA
    || (outcome !== 'up_to_date' && outcome !== 'update_available' && outcome !== 'installed_newer')
    || typeof record.current_version !== 'string'
    || typeof record.latest_version !== 'string'
    || typeof record.offered !== 'boolean') {
    throw new Error(UPDATE_STATUS_UNREADABLE);
  }
  const updateAvailable = outcome === 'update_available' && record.offered === true;
  const latest = record.latest_version.trim() ? record.latest_version : null;
  return {
    updateAvailable,
    detail: updateAvailable ? record.latest_version : record.current_version,
    latest,
  };
}

export function parseHeadCid(stdout: string): string | null {
  for (const line of stdout.split(/\r?\n/)) {
    const match = line.match(/^\s*Head CID:\s*(\S+)/);
    if (match) return match[1];
  }
  return null;
}

export interface HeadVerify {
  maintainerDid: string;
  publisherGateway: string;
  fetchText: (url: string) => Promise<string>;
}

export function isStoredHeadCid(value: string): boolean {
  return /^Qm[1-9A-HJ-NP-Za-km-z]{20,}$/.test(value);
}

/** The stored value is the CID of a release head this process verified. */
export async function verifiedHeadForRollback(candidate: string, verify: HeadVerify): Promise<string> {
  if (!isStoredHeadCid(candidate)) {
    throw new Error('Refusing to store a head CID this launcher did not verify.');
  }
  const url = `${verify.publisherGateway.replace(/\/$/, '')}/ipfs/${candidate}`;
  const raw = await verify.fetchText(url);
  const verified = verifyReleaseHead(raw, verify.maintainerDid);
  if (verified.headCid !== candidate) {
    throw new Error('Refusing to store a head CID this launcher did not verify.');
  }
  return verified.headCid;
}

export async function checkRuntimeUpdate(
  run: RuntimeCommand,
  readStatus: () => string,
  afterCheck?: () => Promise<void>,
): Promise<ParsedUpdateCheck> {
  const result = await run(['update', '--check']);
  if (result.code !== 0) {
    throw new Error(result.stderr.trim() || result.stdout.trim() || 'Could not check for an ElastOS update.');
  }
  await afterCheck?.();
  let raw: string;
  try {
    raw = readStatus();
  } catch {
    throw new Error(UPDATE_STATUS_UNREADABLE);
  }
  return parseUpdateCheckStatus(raw);
}

/** Runtime 2.0.0 predates #61's status file. Derive that record from signed data. */
export async function writeSignedUpdateCheck(
  current: string,
  pin: ActiveRuntimePin,
  fetchText: (url: string) => Promise<string>,
  writeStatus: (raw: string) => void,
): Promise<void> {
  const head = verifyReleaseHead(await fetchText(`${channelGateway(pin)}/release-head.json`), pin.maintainerDid);
  const field = pinMismatchField(pin, head);
  if (field) throw new PinMismatchError(field);
  const version = current.replace(/^ElastOS Runtime v/, '');
  if (!versionAtLeast(version, pin.version)) throw new Error(UPDATE_STATUS_UNREADABLE);
  const offered = !versionAtLeast(version, head.version);
  const newer = !versionAtLeast(head.version, version);
  writeStatus(JSON.stringify({
    schema: UPDATE_CHECK_SCHEMA,
    outcome: offered ? 'update_available' : newer ? 'installed_newer' : 'up_to_date',
    current_version: version,
    latest_version: head.version,
    offered,
  }));
}

export async function applyRuntimeUpdate(
  run: RuntimeCommand,
  store: HeadCidStore,
  verify: HeadVerify,
  onProgress: (message: string) => void = () => {},
): Promise<void> {
  onProgress('Checking the installed ElastOS release.');
  const shown = await run(['source', 'show']);
  if (shown.code !== 0) {
    throw new Error(shown.stderr.trim() || 'Could not read the installed ElastOS release.');
  }
  const candidate = parseHeadCid(shown.stdout);
  if (!candidate) {
    throw new Error('Refusing to store a head CID this launcher did not verify.');
  }
  store.set(await verifiedHeadForRollback(candidate, verify));
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
  verify: HeadVerify,
  onProgress: (message: string) => void = () => {},
): Promise<void> {
  const cid = store.get();
  if (!cid) throw new Error('There is no previous ElastOS release to go back to.');
  const verified = await verifiedHeadForRollback(cid, verify);
  onProgress('Restoring the previous ElastOS release.');
  const result = await run(['update', '--rollback-to', verified, '--yes']);
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
    execFileCb(binary, [...args], { timeout: 15 * 60 * 1000, env: runtimeChildEnv(process.env) }, (err, stdout, stderr) => {
      const code = err && typeof err.code === 'number' ? err.code : err ? 1 : 0;
      resolve({ code, stdout: stdout ?? '', stderr: stderr ?? '' });
    });
  });
}
