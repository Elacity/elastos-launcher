import { RUNTIME_TARGET } from './descriptors';
import { LaunchTargetDescriptor, LaunchTargetId } from './types';

/** Session override. Unset means the runtime. */
export const LAUNCH_TARGET_ENV = 'ELASTOS_LAUNCH_TARGET';

export const DEFAULT_LAUNCH_TARGET: LaunchTargetId = 'runtime';

const BY_ID: Record<LaunchTargetId, LaunchTargetDescriptor> = {
  runtime: RUNTIME_TARGET,
};

export const RETIRED_PC2_NOTICE = 'ELASTOS_LAUNCH_TARGET=pc2 is retired. Opening the ElastOS runtime.';

/** PC2 is retired. The same notice is logged wherever the value is read. */
export function retiredPc2Notice(raw: string | null | undefined): string | null {
  return (raw ?? '').trim().toLowerCase() === 'pc2' ? RETIRED_PC2_NOTICE : null;
}

export function parseLaunchTargetId(raw: string | null | undefined): LaunchTargetId {
  const value = (raw ?? '').trim().toLowerCase();
  if (value === '' || value === 'runtime' || value === 'elastos-runtime' || value === 'pc2') {
    return 'runtime';
  }
  throw new Error(`Unknown launch target "${raw}". Expected "runtime".`);
}

/**
 * Read the target from an env object. Pass `process.env` at the call site.
 * An empty or absent variable resolves to the runtime.
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
