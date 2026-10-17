import { execFile as execFileCb } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { installerChildEnv, ReleaseHeadError, sha256Equals, sha256Hex, verifyReleaseHead } from './releaseHead';
import { ActiveRuntimePin, loadActiveRuntimePin } from './runtimePin';
import {
  runtimeBinaryPath,
  runtimeComponentsPath,
  runtimeDataDir,
  runtimeInstallStagePath,
  runtimeJoin,
  runtimeSourcesPath,
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

/** The first field where the pin and the publisher are not the same value. */
export function pinMismatchField(pin: ActiveRuntimePin, head: ReleaseHead | null): string | null {
  if (!pin.publishable || !pin.version || !pin.headCid) {
    return pin.version ? 'headCid' : 'version';
  }
  if (!head) return 'release-head';
  if (head.channel !== pin.channel) return 'channel';
  if (head.version !== pin.version) return 'version';
  if (!head.headCid || head.headCid !== pin.headCid) return 'headCid';
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

export function planRuntimeInstall(input: {
  platform: string;
  arch: string;
  installedVersion: string | null;
  installedHeadCid: string | null;
  componentsPresent: boolean;
  pin: ActiveRuntimePin;
  publisher: ReleaseHead | null;
}): InstallPlan {
  const blocked = runtimeInstallBlock(input.platform, input.arch);
  if (blocked) return { action: 'blocked', message: blocked };
  const versionOk = installedVersionMatches(input.installedVersion, input.pin.version);
  const headOk = Boolean(input.pin.headCid && input.installedHeadCid === input.pin.headCid);
  if (!input.publisher) {
    return input.pin.publishable
      ? { action: 'unchecked' }
      : { action: 'refused', field: pinMismatchField(input.pin, null) ?? 'release-head' };
  }
  const field = pinMismatchField(input.pin, input.publisher);
  if (field) return { action: 'refused', field };
  if (versionOk && headOk && input.componentsPresent) return { action: 'already-installed' };
  if (versionOk && headOk && !input.componentsPresent) return { action: 'resume-setup' };
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

    const components = runtimeComponentsPath(runtimeDataDir(deps.platform, deps.homeDir, deps.env));
    const probed = await probeInstalled(deps);
    let publisher: ReleaseHead | null = null;
    try {
      const raw = await deps.fetchText(releaseHeadUrl(deps.pin));
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

    await runInstallerStep(deps, onProgress);
    const installed = await probeInstalled(deps);
    if (!installedVersionMatches(installed, deps.pin.version)) {
      throw new PinMismatchError('version');
    }
    if (readInstalledHeadCid(deps) !== deps.pin.headCid) {
      throw new PinMismatchError('headCid');
    }
    onProgress('Installed head CID matches the pin');

    if (!deps.exists(components)) {
      await runSetupStep(deps, onProgress);
    }
  writeStage(deps, 'done');
  onProgress('Your computer is ready.');
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

function releaseHeadUrl(pin: ActiveRuntimePin): string {
  return `${pin.publisherGateway.replace(/\/$/, '')}/release-head.json`;
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
  await deps.runInstaller(scriptPath, launch.args, launch.env);
}

/** The pinned install.sh records the head from ELASTOS_HEAD_CID and rejects a head flag. */
export function pinnedInstallerLaunch(
  pin: { headCid: string | null; maintainerDid: string },
  parent: NodeJS.ProcessEnv = {},
): { args: readonly string[]; env: NodeJS.ProcessEnv } {
  if (!pin.headCid || !/^Qm[1-9A-HJ-NP-Za-km-z]{20,}$/.test(pin.headCid)) {
    throw new PinMismatchError('headCid');
  }
  const env = installerChildEnv(parent);
  env.ELASTOS_HEAD_CID = pin.headCid;
  return {
    args: ['--install-only', '--maintainer-did', pin.maintainerDid],
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
    fetchText: fetchText,
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
  };
}

/** A test switch for the launcher itself. It is read here, never passed to a child. */
function hideHostTools(): boolean {
  return process.env.ELASTOS_HIDE_HOST_TOOLS === '1';
}

async function fetchText(url: string): Promise<string> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Could not download ${url} (HTTP ${response.status}). Check your connection and try again.`);
  }
  return response.text();
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
