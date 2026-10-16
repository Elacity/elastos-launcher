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
    publishable: Boolean(version && headCid),
  };
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

export function runtimePinCandidates(env: NodeJS.ProcessEnv = process.env): string[] {
  const fromEnv = env.ELASTOS_RUNTIME_PIN?.trim();
  const packaged = process.resourcesPath
    ? path.join(process.resourcesPath, 'runtime-pin.json')
    : '';
  const dev = path.join(__dirname, '../../../resources/runtime-pin.json');
  return [fromEnv, packaged, dev].filter((item): item is string => Boolean(item));
}

export function loadRuntimePinFile(env: NodeJS.ProcessEnv = process.env): RuntimePinFile {
  const tried: string[] = [];
  for (const candidate of runtimePinCandidates(env)) {
    tried.push(candidate);
    if (!fs.existsSync(candidate)) continue;
    return parseRuntimePin(JSON.parse(fs.readFileSync(candidate, 'utf8')));
  }
  throw new Error(`Runtime pin file not found. Looked in ${tried.join(', ')}`);
}

export function loadActiveRuntimePin(env: NodeJS.ProcessEnv = process.env): ActiveRuntimePin {
  return activeRuntimePin(loadRuntimePinFile(env));
}
