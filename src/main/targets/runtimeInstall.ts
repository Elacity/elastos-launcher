import { execFile as execFileCb } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ActiveRuntimePin, loadActiveRuntimePin } from './runtimePin';
import {
  runtimeBinaryPath,
  runtimeComponentsPath,
  runtimeDataDir,
  runtimeInstallStagePath,
} from './runtimePaths';
import { probeRuntimeInstallation, RuntimeProbe, RuntimeProbeRequest } from './runtimeProbe';
import { runtimeInstallBlock } from './runtimeSupport';

export const UNSIGNED_INSTALLER_MARKERS = ['__MAINTAINER_DID__', '__HEAD_CID__'] as const;

export class UnsignedInstallerError extends Error {
  readonly code = 'UNSIGNED_RUNTIME_INSTALLER';

  constructor(marker: string) {
    super(
      `This installer is not signed for ElastOS. It still contains ${marker}. Download it again from the ElastOS publisher.`,
    );
    this.name = 'UnsignedInstallerError';
  }
}

export function assertSignedInstaller(text: string): void {
  for (const marker of UNSIGNED_INSTALLER_MARKERS) {
    if (text.includes(marker)) throw new UnsignedInstallerError(marker);
  }
}

export interface ReleaseHead {
  channel: string;
  version: string;
  latestReleaseCid: string;
  signerDid: string;
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
  };
}

export function publisherMatchesPin(pin: ActiveRuntimePin, head: ReleaseHead | null): boolean {
  if (!head || !pin.publishable || !pin.version || !pin.headCid) return false;
  return head.channel === pin.channel
    && head.version === pin.version
    && head.latestReleaseCid === pin.headCid
    && head.signerDid === pin.maintainerDid;
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
  if (head.latestReleaseCid !== pin.headCid) return 'headCid';
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
  componentsPresent: boolean;
  pin: ActiveRuntimePin;
  publisher: ReleaseHead | null;
}): InstallPlan {
  const blocked = runtimeInstallBlock(input.platform, input.arch);
  if (blocked) return { action: 'blocked', message: blocked };
  const versionOk = Boolean(
    input.pin.version && input.installedVersion && input.installedVersion.includes(input.pin.version),
  );
  if (versionOk && input.componentsPresent) return { action: 'already-installed' };
  if (versionOk && !input.componentsPresent) return { action: 'resume-setup' };
  // No publisher yet. This is not permission to install.
  if (input.publisher === null && input.pin.publishable) return { action: 'unchecked' };
  const field = pinMismatchField(input.pin, input.publisher);
  if (field) return { action: 'refused', field };
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
  pc2Dir?: string;
  probe?: (request: RuntimeProbeRequest) => Promise<RuntimeProbe>;
  fetchText: (url: string) => Promise<string>;
  runInstaller: (scriptPath: string, args: readonly string[]) => Promise<CommandResult>;
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

function assertPc2Untouched(deps: RuntimeInstallDeps, before: number | null): void {
  if (!deps.pc2Dir) return;
  if (deps.statMtimeMs(deps.pc2Dir) !== before) {
    throw new Error('Runtime install must not modify the PC2 directory.');
  }
}

export async function installRuntime(
  deps: RuntimeInstallDeps,
  onProgress: (message: string) => void = () => {},
): Promise<void> {
  const pc2Before = deps.pc2Dir ? deps.statMtimeMs(deps.pc2Dir) : null;
  try {
    onProgress(CHECK);
    const blocked = runtimeInstallBlock(deps.platform, deps.arch);
    if (blocked) throw new Error(blocked);

    const components = runtimeComponentsPath(runtimeDataDir(deps.platform, deps.homeDir, deps.env));
    const probed = await probeInstalled(deps);
    const early = planRuntimeInstall({
      platform: deps.platform,
      arch: deps.arch,
      installedVersion: probed,
      componentsPresent: deps.exists(components),
      pin: deps.pin,
      publisher: null,
    });
    if (early.action === 'already-installed') {
      writeStage(deps, 'done');
      onProgress('ElastOS is already installed.');
      assertPc2Untouched(deps, pc2Before);
      return;
    }
    if (early.action === 'resume-setup') {
      onProgress('Resuming setup. The download already finished.');
      await runSetupStep(deps, onProgress);
      writeStage(deps, 'done');
      onProgress('Your computer is ready.');
      assertPc2Untouched(deps, pc2Before);
      return;
    }
    if (early.action === 'refused') throw new PinMismatchError(early.field);

    let publisher: ReleaseHead | null = null;
    try {
      publisher = parseReleaseHead(await deps.fetchText(releaseHeadUrl(deps.pin)));
    } catch {
      throw new PinMismatchError('release-head');
    }
    const plan = planRuntimeInstall({
      platform: deps.platform,
      arch: deps.arch,
      installedVersion: probed,
      componentsPresent: deps.exists(components),
      pin: deps.pin,
      publisher,
    });
    if (plan.action === 'refused') throw new PinMismatchError(plan.field);
    if (plan.action !== 'pinned') {
      throw new PinMismatchError('version');
    }

    await runInstallerStep(deps, onProgress);
    const installed = await probeInstalled(deps);
    if (!deps.pin.version || !installed?.includes(deps.pin.version)) {
      throw new Error(
        `Installed ElastOS does not match the pinned release ${deps.pin.version ?? ''}.`,
      );
    }

    if (!deps.exists(components)) {
      await runSetupStep(deps, onProgress);
    }
    writeStage(deps, 'done');
    onProgress('Your computer is ready.');
    assertPc2Untouched(deps, pc2Before);
  } catch (err) {
    assertPc2Untouched(deps, pc2Before);
    throw err;
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
  onProgress(DOWNLOAD);
  const script = await deps.fetchText(deps.pin.fallbackInstallerUrl);
  assertSignedInstaller(script);
  const dir = path.join(deps.homeDir, '.elastos-launcher');
  deps.mkdirp(dir);
  const scriptPath = path.join(dir, 'install.sh');
  deps.writeFile(scriptPath, script);
  writeStage(deps, 'binary');
  onProgress(INSTALLING);
  await deps.runInstaller(scriptPath, ['--install-only']);
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

function exec(file: string, args: readonly string[], timeout: number): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    execFileCb(file, args as string[], { timeout }, (err, stdout, stderr) => {
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
    pc2Dir: path.join(homeDir, '.pc2'),
    fetchText: fetchText,
    runInstaller: (scriptPath, args) => exec('bash', [scriptPath, ...args], 15 * 60 * 1000),
    runSetup: (binary) => exec(binary, ['setup'], 15 * 60 * 1000),
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
  await installRuntime(defaultRuntimeInstallDeps(), onProgress);
}
