/**
 * Launch-target registry.
 *
 * src/main/index.ts talks to src/main/launchController.ts, which calls
 * createLaunchTarget. With no explicit id, no ELASTOS_LAUNCH_TARGET, and
 * no stored preference, that target is PC2 and its methods are the
 * pc2Manager functions.
 */

import { createPc2Target } from './pc2Target';
import { createRuntimeTarget } from './runtimeTarget';
import { currentLaunchTargetId, DEFAULT_LAUNCH_TARGET } from './registry';
import { LaunchTarget, LaunchTargetId } from './types';

export {
  currentLaunchTargetId,
  DEFAULT_LAUNCH_TARGET,
  getLaunchTargetDescriptor,
  LAUNCH_TARGET_ENV,
  parseLaunchTargetId,
  targetSupportsHost,
} from './registry';
export {
  createLaunchTargetStore,
  LAUNCH_TARGET_STORE_KEY,
  resolveLaunchTargetId,
} from './preferences';
export type { LaunchTargetPreferenceStore, LaunchTargetSelection } from './preferences';
export { PC2_TARGET, RUNTIME_TARGET } from './descriptors';
export type { HealthProbe, LaunchTarget, LaunchTargetDescriptor, LaunchTargetId, TargetStatus, UpdateCheck } from './types';

export function createLaunchTarget(id: LaunchTargetId = DEFAULT_LAUNCH_TARGET): LaunchTarget {
  switch (id) {
    case 'pc2':
      return createPc2Target();
    case 'runtime':
      return createRuntimeTarget();
  }
}

export function createLaunchTargetFromEnv(env: NodeJS.ProcessEnv): LaunchTarget {
  return createLaunchTarget(currentLaunchTargetId(env));
}
