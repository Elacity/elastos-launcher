import * as fs from 'fs';
import * as path from 'path';
import { LaunchTargetId } from './types';

export type RuntimeChannelName = 'stable' | 'canary';

export interface RuntimeChannelPin {
  version: string | null;
  headCid: string | null;
}

export interface RuntimePinFile {
  active: RuntimeChannelName;
  publisherGateway: string;
  fallbackInstallerUrl: string;
  maintainerDid: string;
  /** SHA-256 of the exact install.sh bytes this release will execute. */
  installerSha256: string | null;
  channels: Record<RuntimeChannelName, RuntimeChannelPin>;
}

/** The channel selected by `active`. Switching stable/canary is that one field. */
export interface ActiveRuntimePin {
  channel: RuntimeChannelName;
  version: string | null;
  headCid: string | null;
  maintainerDid: string;
  publisherGateway: string;
  fallbackInstallerUrl: string;
  installerSha256: string | null;
  /** True when this channel has a version and a head CID to verify. */
  publishable: boolean;
}

export function parseRuntimePin(raw: unknown): RuntimePinFile {
  if (!raw || typeof raw !== 'object') {
    throw new Error('Runtime pin is not an object.');
  }
  const pin = raw as Partial<RuntimePinFile>;
  if (pin.active !== 'stable' && pin.active !== 'canary') {
    throw new Error('Runtime pin "active" must be "stable" or "canary".');
  }
  if (!pin.publisherGateway || !pin.fallbackInstallerUrl || !pin.maintainerDid) {
    throw new Error('Runtime pin is missing the publisher, installer URL, or maintainer DID.');
  }
  const channels = pin.channels;
  if (!channels?.stable || !channels?.canary) {
    throw new Error('Runtime pin must include stable and canary channels.');
  }
  return {
    active: pin.active,
    publisherGateway: pin.publisherGateway,
    fallbackInstallerUrl: pin.fallbackInstallerUrl,
    maintainerDid: pin.maintainerDid,
    installerSha256: normalizeSha256(pin.installerSha256),
    channels: {
      stable: normalizeChannel(channels.stable),
      canary: normalizeChannel(channels.canary),
    },
  };
}

function normalizeChannel(channel: RuntimeChannelPin): RuntimeChannelPin {
  return {
    version: channel.version ?? null,
    headCid: channel.headCid ?? null,
  };
}

export function activeRuntimePin(pin: RuntimePinFile): ActiveRuntimePin {
  const channel = pin.channels[pin.active];
  const version = emptyToNull(channel.version);
  const headCid = emptyToNull(channel.headCid);
  return {
    channel: pin.active,
    version,
    headCid,
    maintainerDid: pin.maintainerDid,
    publisherGateway: pin.publisherGateway,
    fallbackInstallerUrl: pin.fallbackInstallerUrl,
    installerSha256: pin.installerSha256,
    publishable: Boolean(version && headCid),
  };
}

function normalizeSha256(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return /^[0-9a-f]{64}$/.test(trimmed) ? trimmed : null;
}

function emptyToNull(value: string | null | undefined): string | null {
  if (value == null) return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

/**
 * New users follow the runtime only when the active channel has a published
 * version. An empty stable pin keeps PC2 as the default.
 */
export function defaultLaunchTargetForPin(pin: ActiveRuntimePin): LaunchTargetId {
  return pin.publishable ? 'runtime' : 'pc2';
}

export function runtimePinCandidates(
  env: NodeJS.ProcessEnv = process.env,
  mode: PinLoadMode = pinLoadMode(env),
): string[] {
  const fromEnv = mode === 'dev' ? env.ELASTOS_RUNTIME_PIN?.trim() : '';
  const packaged = process.resourcesPath
    ? path.join(process.resourcesPath, 'runtime-pin.json')
    : '';
  const dev = path.join(__dirname, '../../../resources/runtime-pin.json');
  return [fromEnv, packaged, dev].filter((item): item is string => Boolean(item));
}

export type PinLoadMode = 'dev' | 'production';

function readIsPackaged(): boolean | undefined {
  try {
    const electron = require('electron') as { app?: { isPackaged?: boolean } };
    if (typeof electron.app?.isPackaged === 'boolean') return electron.app.isPackaged;
  } catch {
    return undefined;
  }
  return undefined;
}

/**
 * A packaged app stays in production mode even when NODE_TEST_CONTEXT is set.
 * An unpackaged app, and unit tests, may use a dev pin.
 */
export function pinLoadMode(
  env: NodeJS.ProcessEnv = process.env,
  packaged: boolean | undefined = readIsPackaged(),
): PinLoadMode {
  if (packaged === true) return 'production';
  if (env.NODE_TEST_CONTEXT) return 'dev';
  if (packaged === false) return 'dev';
  return 'production';
}

/**
 * A production override may select another channel that this package already
 * publishes. It may not change the maintainer, gateway, installer, or CIDs.
 */
export function overrideKeepsTrustRoot(packaged: RuntimePinFile, override: RuntimePinFile): boolean {
  if (packaged.maintainerDid !== override.maintainerDid) return false;
  if (packaged.publisherGateway !== override.publisherGateway) return false;
  if (packaged.fallbackInstallerUrl !== override.fallbackInstallerUrl) return false;
  if (packaged.installerSha256 !== override.installerSha256) return false;
  for (const name of ['stable', 'canary'] as const) {
    const base = packaged.channels[name];
    const over = override.channels[name];
    if ((over.version ?? null) !== (base.version ?? null)) return false;
    if ((over.headCid ?? null) !== (base.headCid ?? null)) return false;
  }
  if (override.active !== packaged.active) {
    const selected = packaged.channels[override.active];
    if (!selected.version || !selected.headCid) return false;
  }
  return true;
}

export function loadRuntimePinFile(
  env: NodeJS.ProcessEnv = process.env,
  mode: PinLoadMode = pinLoadMode(env),
): RuntimePinFile {
  const read = (file: string) => parseRuntimePin(JSON.parse(fs.readFileSync(file, 'utf8')));
  if (mode === 'production') {
    const packagedPath = runtimePinCandidates(env, 'production').find((file) => fs.existsSync(file));
    if (!packagedPath) {
      throw new Error('Runtime pin file not found.');
    }
    const packaged = read(packagedPath);
    const overridePath = env.ELASTOS_RUNTIME_PIN?.trim();
    if (!overridePath || !fs.existsSync(overridePath)) return packaged;
    const override = read(overridePath);
    if (!overrideKeepsTrustRoot(packaged, override)) {
      throw new Error('ELASTOS_RUNTIME_PIN cannot replace the packaged trust root.');
    }
    return override;
  }
  const tried: string[] = [];
  for (const candidate of runtimePinCandidates(env, mode)) {
    tried.push(candidate);
    if (!fs.existsSync(candidate)) continue;
    return read(candidate);
  }
  throw new Error(`Runtime pin file not found. Looked in ${tried.join(', ')}`);
}

export function loadActiveRuntimePin(env: NodeJS.ProcessEnv = process.env): ActiveRuntimePin {
  return activeRuntimePin(loadRuntimePinFile(env));
}
