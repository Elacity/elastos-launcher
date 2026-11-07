import { PC2_TARGET, RUNTIME_TARGET } from './descriptors';
import { LaunchTargetDescriptor, LaunchTargetId } from './types';

/** Session override. Unset means PC2, including after this scaffold lands. */
export const LAUNCH_TARGET_ENV = 'ELASTOS_LAUNCH_TARGET';

export const DEFAULT_LAUNCH_TARGET: LaunchTargetId = 'pc2';

const BY_ID: Record<LaunchTargetId, LaunchTargetDescriptor> = {
  pc2: PC2_TARGET,
  runtime: RUNTIME_TARGET,
};

export function parseLaunchTargetId(raw: string | null | undefined): LaunchTargetId {
  const value = (raw ?? '').trim().toLowerCase();
  if (value === '' || value === 'pc2' || value === 'pc2.net') {
    return 'pc2';
  }
  if (value === 'runtime' || value === 'elastos-runtime') {
    return 'runtime';
  }
  throw new Error(`Unknown launch target "${raw}". Expected "pc2" or "runtime".`);
}

/**
 * Read the target from an env object. Pass `process.env` at the call site.
 * An empty or absent variable resolves to PC2.
 */
export function currentLaunchTargetId(env: NodeJS.ProcessEnv): LaunchTargetId {
  return parseLaunchTargetId(env[LAUNCH_TARGET_ENV]);
}

export function getLaunchTargetDescriptor(id: LaunchTargetId): LaunchTargetDescriptor {
  return BY_ID[id];
}

export function targetSupportsHost(
  descriptor: LaunchTargetDescriptor,
  platform: string,
  arch: string,
): boolean {
  return descriptor.platforms.some((entry) => entry.platform === platform && entry.arch === arch);
}
