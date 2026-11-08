import { execFile as execFileCb } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { installerChildEnv, ReleaseHeadError, sha256Equals, sha256Hex, verifyReleaseHead, verifiedInstallerSha256 } from './releaseHead';
import { ActiveRuntimePin, loadActiveRuntimePin } from './runtimePin';
import {
  runtimeBinaryPath,
  runtimeComponentsPath,
  runtimeDataDir,
  runtimeInstallStagePath,
  runtimeJoin,
  runtimeSourcesPath,
  signedInstallRecord,
} from './runtimePaths';
import { probeRuntimeInstallation, RuntimeProbe, RuntimeProbeRequest } from './runtimeProbe';
import { prepareInstallerEnvironment } from './hostTools';
import { runtimeInstallBlock } from './runtimeSupport';

export interface ReleaseHead {
  channel: string;
  version: string;
  latestReleaseCid: string;
  signerDid: string;
  /** CID of the release-head bytes. Not latest_release_cid. */
  headCid: string;
}

/** `elastos version` prints `ElastOS Runtime v<version>`. Prefixes do not count. */
export function installedVersionMatches(reported: string | null, pinVersion: string | null): boolean {
  if (!reported || !pinVersion) return false;
  const line = reported.trim();
  return line === pinVersion || line === `ElastOS Runtime v${pinVersion}`;
}

export function parseReleaseHead(body: string): ReleaseHead {
  const json = JSON.parse(body) as {
    signer_did?: string;
    payload?: {
      channel?: string;
      version?: string;
      latest_release_cid?: string;
      signer_did?: string;
    };
  };
  const payload = json.payload ?? {};
  return {
    channel: String(payload.channel ?? ''),
    version: String(payload.version ?? ''),
    latestReleaseCid: String(payload.latest_release_cid ?? ''),
    signerDid: String(json.signer_did ?? payload.signer_did ?? ''),
    headCid: '',
  };
}

export function publisherMatchesPin(pin: ActiveRuntimePin, head: ReleaseHead | null): boolean {
  return pinMismatchField(pin, head) === null;
}

export class PinMismatchError extends Error {
  readonly code = 'RUNTIME_PIN_MISMATCH';
  readonly field: string;

  constructor(field: string) {
    super(`The pinned ElastOS release does not match the publisher (${field}). Install stopped.`);
    this.name = 'PinMismatchError';
    this.field = field;
  }
}

/** Compare numeric SemVer components and prerelease identifiers, never string prefixes. */
export function versionAtLeast(version: string | null, floor: string | null): boolean {
  const parse = (value: string | null) => /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z.-]+)?$/.exec(value ?? '');
  const actual = parse(version?.replace(/^ElastOS Runtime v/, '') ?? null);
  const minimum = parse(floor);
  if (!actual || !minimum) return false;
  for (let i = 1; i <= 3; i++) {
    if (BigInt(actual[i]) !== BigInt(minimum[i])) return BigInt(actual[i]) > BigInt(minimum[i]);
  }
  if (!actual[4]) return true;
  if (!minimum[4]) return false;
  const left = actual[4].split('.');
  const right = minimum[4].split('.');
  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    if (left[i] === right[i]) continue;
    if (left[i] === undefined) return false;
    if (right[i] === undefined) return true;
    const numericLeft = /^\d+$/.test(left[i]);
    const numericRight = /^\d+$/.test(right[i]);
    if (numericLeft && numericRight) return BigInt(left[i]) > BigInt(right[i]);
    if (numericLeft !== numericRight) return numericRight;
    return left[i] > right[i];
  }
  return true;
}

/** A package pins the trust root and rollback floor, while the publisher selects the head. */
export function pinMismatchField(pin: ActiveRuntimePin, head: ReleaseHead | null): string | null {
  if (!pin.publishable || !versionAtLeast(pin.version, '2.0.0')) return 'version';
  if (!head) return 'release-head';
  if (head.channel !== pin.channel) return 'channel';
  if (!versionAtLeast(head.version, pin.version)) return 'version';
  if (!head.headCid || !/^Qm[1-9A-HJ-NP-Za-km-z]{44}$/.test(head.headCid)) return 'headCid';
  if (head.signerDid !== pin.maintainerDid) return 'signerDid';
  return null;
}

export type InstallPlan =
  | { action: 'blocked'; message: string }
  | { action: 'already-installed' }
  | { action: 'resume-setup' }
  | { action: 'unchecked' }
  | { action: 'pinned' }
  | { action: 'refused'; field: string };

/**
 * ElastOS counts as installed when its version is at least the floor and
 * sources.json matches its signed installation/release-head.json record.
 * The record is checked against the pinned maintainer DID. Version and head CID
 * are read from files this account can edit, so they say which release is
 * there. The record is the proof that install.sh finished that release. With
 * no valid record, Install runs the pinned install.sh again, which writes it.
 */
export function planRuntimeInstall(input: {
  platform: string;
  arch: string;
  installedVersion: string | null;
  installedHeadCid: string | null;
  installRecordProved: boolean;
  componentsPresent: boolean;
  pin: ActiveRuntimePin;
  publisher: ReleaseHead | null;
}): InstallPlan {
  const blocked = runtimeInstallBlock(input.platform, input.arch);
  if (blocked) return { action: 'blocked', message: blocked };
  const versionOk = versionAtLeast(input.installedVersion, input.pin.version);
  const headOk = Boolean(input.installedHeadCid);
  if (!input.publisher) {
    return input.pin.publishable
      ? { action: 'unchecked' }
      : { action: 'refused', field: pinMismatchField(input.pin, null) ?? 'release-head' };
  }
  const field = pinMismatchField(input.pin, input.publisher);
  if (field) return { action: 'refused', field };
  const installed = versionOk && headOk && input.installRecordProved;
  if (installed && input.componentsPresent) return { action: 'already-installed' };
  if (installed && !input.componentsPresent) return { action: 'resume-setup' };
  return { action: 'pinned' };
}

export interface CommandResult {
  stdout: string;
  stderr: string;
}

export interface RuntimeInstallDeps {
  platform: string;
  arch: string;
  homeDir: string;
  env?: NodeJS.ProcessEnv;
  pin: ActiveRuntimePin;
  probe?: (request: RuntimeProbeRequest) => Promise<RuntimeProbe>;
  fetchText: (url: string) => Promise<string>;
  runInstaller: (
    scriptPath: string,
    args: readonly string[],
    env: NodeJS.ProcessEnv,
  ) => Promise<CommandResult>;
  runSetup: (binary: string) => Promise<CommandResult>;
  writeFile: (file: string, contents: string) => void;
  readFile: (file: string) => string;
  exists: (file: string) => boolean;
  statMtimeMs: (file: string) => number | null;
  mkdirp: (dir: string) => void;
  /**
   * True when the data directory holds the signed install record. This is
   * the same check Reset uses to prove the folder (signedInstallRecord in
   * runtimePaths.ts), so an install Install accepts is one Reset can prove.
   */
  installRecordProved: (dataDir: string) => boolean | Promise<boolean>;
}

const CHECK = 'Checking this computer (about 10 seconds)';
const DOWNLOAD = 'Downloading ElastOS (about 1 minute)';
const INSTALLING = 'Installing (about 30 seconds)';
const SETUP = 'Setting up your computer (about 2 minutes)';

export async function installRuntime(
  deps: RuntimeInstallDeps,
  onProgress: (message: string) => void = () => {},
): Promise<void> {
  onProgress(CHECK);
    const blocked = runtimeInstallBlock(deps.platform, deps.arch);
    if (blocked) throw new Error(blocked);

    const dataDir = runtimeDataDir(deps.platform, deps.homeDir, deps.env);
    const components = runtimeComponentsPath(dataDir);
    const probed = await probeInstalled(deps);
    let publisher: ReleaseHead | null = null;
    let raw = '';
    try {
      raw = await deps.fetchText(releaseHeadUrl(deps.pin));
      publisher = verifyReleaseHead(raw, deps.pin.maintainerDid);
      onProgress('Release head signature matches the pinned maintainer');
    } catch (err) {
      if (err instanceof ReleaseHeadError || err instanceof PinMismatchError) throw err;
      throw new PinMismatchError('release-head');
    }
    const plan = planRuntimeInstall({
      platform: deps.platform,
      arch: deps.arch,
      installedVersion: probed,
      installedHeadCid: readInstalledHeadCid(deps),
      installRecordProved: await recordProved(deps, dataDir, probed, readInstalledHeadCid(deps)),
      componentsPresent: deps.exists(components),
      pin: deps.pin,
      publisher,
    });
    if (plan.action === 'already-installed') {
      writeStage(deps, 'done');
      onProgress('ElastOS is already installed.');
      return;
    }
    if (plan.action === 'resume-setup') {
      onProgress('Resuming setup. The download already finished.');
      await runSetupStep(deps, onProgress);
      writeStage(deps, 'done');
      onProgress('Your computer is ready.');
      return;
    }
    if (plan.action === 'refused') throw new PinMismatchError(plan.field);
    if (plan.action !== 'pinned') {
      throw new PinMismatchError('version');
    }

    const manifest = await deps.fetchText(`${channelGateway(deps.pin)}/release.json`);
    const installerSha256 = verifiedInstallerSha256(manifest, publisher as ReturnType<typeof verifyReleaseHead>);
    const selected = { ...deps, pin: { ...deps.pin, version: publisher.version, headCid: publisher.headCid, installerSha256 } };
    await runInstallerStep(selected, onProgress, raw, manifest);
    const installed = await probeInstalled(deps);
    if (!installedVersionMatches(installed, publisher.version)) {
      throw new PinMismatchError('version');
    }
    if (readInstalledHeadCid(deps) !== publisher.headCid) {
      throw new PinMismatchError('headCid');
    }
    onProgress('Installed head CID matches the pin');
    if (!(await recordProved(deps, dataDir, installed, publisher.headCid))) throw new Error(NO_RECORD_AFTER_INSTALL);
    onProgress('Signed install record matches the pinned maintainer');

    if (!deps.exists(components)) {
      await runSetupStep(deps, onProgress);
    }
  writeStage(deps, 'done');
  onProgress('Your computer is ready.');
}

/** Install finished, but install.sh left no valid record. Reset could not prove this install. */
export const NO_RECORD_AFTER_INSTALL = 'ElastOS was installed, but it did not save its signed install record, so ElastOS cannot prove this install. Click Install to try again.';

async function recordProved(deps: RuntimeInstallDeps, dataDir: string, version: string | null, headCid: string | null): Promise<boolean> {
  try {
    if (!(await deps.installRecordProved(dataDir))) return false;
    const head = verifyReleaseHead(deps.readFile(runtimeJoin(dataDir, 'installation', 'release-head.json')), deps.pin.maintainerDid);
    return head.headCid === headCid && installedVersionMatches(version, head.version)
      && versionAtLeast(head.version, deps.pin.version);
  } catch {
    return false;
  }
}

function readInstalledHeadCid(deps: RuntimeInstallDeps): string | null {
  const file = runtimeSourcesPath(runtimeDataDir(deps.platform, deps.homeDir, deps.env));
  if (!deps.exists(file)) return null;
  try {
    const parsed = JSON.parse(deps.readFile(file)) as {
      default_source?: string;
      sources?: Array<{ name?: string; head_cid?: string }>;
    };
    const sources = parsed.sources ?? [];
    const named = sources.find((source) => source.name === parsed.default_source) ?? sources[0];
    return typeof named?.head_cid === 'string' && named.head_cid ? named.head_cid : null;
  } catch {
    return null;
  }
}

export function channelGateway(pin: ActiveRuntimePin): string {
  const origin = pin.publisherGateway.replace(/\/$/, '');
  return pin.channel === 'stable' ? origin : `${origin}/channels/${pin.channel}`;
}

function releaseHeadUrl(pin: ActiveRuntimePin): string {
  return `${channelGateway(pin)}/release-head.json`;
}

async function probeInstalled(deps: RuntimeInstallDeps): Promise<string | null> {
  const probe = deps.probe ?? probeRuntimeInstallation;
  const result = await probe({
    platform: deps.platform,
    arch: deps.arch,
    homeDir: deps.homeDir,
    pathEnv: deps.env?.PATH ?? '',
  });
  if (result.kind === 'unsupported-platform') {
    return null;
  }
  if (result.kind === 'not-installed') return null;
  return result.version;
}

async function runInstallerStep(
  deps: RuntimeInstallDeps,
  onProgress: (message: string) => void,
  head: string,
  manifest: string,
): Promise<void> {
  if (!deps.pin.installerSha256 || !deps.pin.headCid) {
    throw new PinMismatchError('installerSha256');
  }
  onProgress(DOWNLOAD);
  const script = await deps.fetchText(deps.pin.fallbackInstallerUrl);
  if (!sha256Equals(sha256Hex(script), deps.pin.installerSha256)) {
    throw new PinMismatchError('installerSha256');
  }
  const dir = runtimeJoin(deps.homeDir, '.elastos-launcher');
  deps.mkdirp(dir);
  const scriptPath = runtimeJoin(dir, 'install.sh');
  deps.writeFile(scriptPath, script);
  const written = deps.readFile(scriptPath);
  if (!sha256Equals(sha256Hex(written), deps.pin.installerSha256)) {
    throw new PinMismatchError('installerSha256');
  }
  onProgress('install.sh SHA-256 matches the pin');
  writeStage(deps, 'binary');
  onProgress(INSTALLING);
  const launch = pinnedInstallerLaunch(deps.pin, deps.env);
  // The installer re-fetches both metadata URLs. Serve the verified snapshot
  // through the existing curl shim so a publisher move cannot change the floor
  // decision between verification and activation. Artifact URLs still use HTTPS.
  const metadata = JSON.stringify({
    [`${channelGateway(deps.pin)}/release-head.json`]: head,
    [`${channelGateway(deps.pin)}/release.json`]: manifest,
  });
  const metadataPath = runtimeJoin(dir, 'release-metadata.json');
  deps.writeFile(metadataPath, metadata);
  launch.env.ELASTOS_LAUNCHER_METADATA_PATH = metadataPath;
  launch.env.ELASTOS_LAUNCHER_METADATA_SHA256 = sha256Hex(metadata);
  await deps.runInstaller(scriptPath, launch.args, launch.env);
}

/** The pinned install.sh records the head from ELASTOS_HEAD_CID and rejects a head flag. */
export function pinnedInstallerLaunch(
  pin: { headCid: string | null; maintainerDid: string; channel?: string; publisherGateway?: string },
  parent: NodeJS.ProcessEnv = {},
): { args: readonly string[]; env: NodeJS.ProcessEnv } {
  if (!pin.headCid || !/^Qm[1-9A-HJ-NP-Za-km-z]{20,}$/.test(pin.headCid)) {
    throw new PinMismatchError('headCid');
  }
  const env = installerChildEnv(parent);
  env.ELASTOS_HEAD_CID = pin.headCid;
  return {
    args: ['--install-only', '--maintainer-did', pin.maintainerDid,
      ...(pin.publisherGateway ? ['--publisher-gateway', channelGateway(pin as ActiveRuntimePin)] : [])],
    env,
  };
}

async function runSetupStep(
  deps: RuntimeInstallDeps,
  onProgress: (message: string) => void,
): Promise<void> {
  onProgress(SETUP);
  writeStage(deps, 'setup');
  const binary = runtimeBinaryPath(deps.homeDir);
  await deps.runSetup(binary);
}

function writeStage(deps: RuntimeInstallDeps, stage: 'binary' | 'setup' | 'done'): void {
  const file = runtimeInstallStagePath(deps.homeDir);
  deps.mkdirp(path.dirname(file));
  deps.writeFile(file, JSON.stringify({ stage, version: deps.pin.version, channel: deps.pin.channel }));
}

function exec(
  file: string,
  args: readonly string[],
  timeout: number,
  env: NodeJS.ProcessEnv,
): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    execFileCb(file, args as string[], { timeout, env }, (err, stdout, stderr) => {
      if (err) {
        reject(new Error((stderr || stdout || err.message).trim()));
        return;
      }
      resolve({ stdout: stdout ?? '', stderr: stderr ?? '' });
    });
  });
}

export function defaultRuntimeInstallDeps(pin: ActiveRuntimePin = loadActiveRuntimePin()): RuntimeInstallDeps {
  const homeDir = os.homedir();
  return {
    platform: process.platform,
    arch: process.arch,
    homeDir,
    env: process.env,
    pin,
    fetchText: fetchRuntimeText,
    runInstaller: async (scriptPath, args, env) => {
      const prepared = await prepareInstallerEnvironment({
        homeDir,
        platform: process.platform,
        arch: process.arch,
        env,
        hideHostTools: hideHostTools(),
      });
      return exec(prepared.bash, [scriptPath, ...args], 15 * 60 * 1000, prepared.env);
    },
    runSetup: async (binary) => {
      const prepared = await prepareInstallerEnvironment({
        homeDir,
        platform: process.platform,
        arch: process.arch,
        env: installerChildEnv(process.env),
        hideHostTools: hideHostTools(),
      });
      return exec(binary, ['setup'], 15 * 60 * 1000, prepared.env);
    },
    writeFile: (file, contents) => fs.writeFileSync(file, contents),
    readFile: (file) => fs.readFileSync(file, 'utf8'),
    exists: (file) => {
      try {
        return fs.statSync(file).isFile();
      } catch {
        return false;
      }
    },
    statMtimeMs: (file) => {
      try {
        return fs.statSync(file).mtimeMs;
      } catch {
        return null;
      }
    },
    mkdirp: (dir) => fs.mkdirSync(dir, { recursive: true }),
    installRecordProved: (dataDir) => signedInstallRecord(dataDir, pin.maintainerDid),
  };
}

/** A test switch for the launcher itself. It is read here, never passed to a child. */
function hideHostTools(): boolean {
  return process.env.ELASTOS_HIDE_HOST_TOOLS === '1';
}

/** Installer bytes and release metadata are bounded in size and total fetch time. */
export async function fetchRuntimeText(url: string): Promise<string> {
  if (!url.startsWith('https://')) throw new Error('ElastOS downloads require HTTPS.');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30000);
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok || !response.url.startsWith('https://')) {
      throw new Error(`Could not download ${url} (HTTP ${response.status}).`);
    }
    const reader = response.body?.getReader();
    if (!reader) throw new Error('ElastOS download has no body.');
    const chunks: Buffer[] = [];
    let size = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 2 * 1024 * 1024) {
        await reader.cancel();
        throw new Error('ElastOS metadata or installer exceeds the download limit.');
      }
      chunks.push(Buffer.from(value));
    }
    return new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks));
  } finally {
    clearTimeout(timer);
  }
}

/** What the runtime target calls. Tests replace this export; they do not hit the network. */
export async function installRuntimeOnThisComputer(
  onProgress: (message: string) => void = () => {},
): Promise<void> {
  if (process.platform === 'win32') {
    const windows = require('./windowsRuntime') as {
      installRuntimeInsideDistro: (onProgress: (message: string) => void) => Promise<void>;
    };
    await windows.installRuntimeInsideDistro(onProgress);
    return;
  }
  await installRuntime(defaultRuntimeInstallDeps(), onProgress);
}
