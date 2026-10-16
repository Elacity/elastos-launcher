/**
 * Launch-target registry.
 *
 * src/main/index.ts does not import this module. The app still calls
 * pc2Manager directly, so an unset ELASTOS_LAUNCH_TARGET changes nothing
 * a user can see. Wiring the IPC handlers through createLaunchTarget is
 * a later ticket (docs/RUNTIME_MIGRATION.md).
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
