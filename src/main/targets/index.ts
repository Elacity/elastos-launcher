/**
 * Launch-target registry.
 *
 * src/main/index.ts talks to src/main/launchController.ts, which calls
 * createLaunchTarget. The only target is the ElastOS runtime.
 */

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
export { resolveLaunchTargetId } from './preferences';
export type { LaunchTargetSelection } from './preferences';
export { RUNTIME_TARGET } from './descriptors';
export {
  findRuntimeBinary,
  parseRuntimeVersion,
  probeRuntimeInstallation,
  RUNTIME_VERSION_ARGS,
  UnsupportedRuntimePlatformError,
  unsupportedPlatformError,
} from './runtimeProbe';
export {
  activeRuntimePin,
  defaultLaunchTargetForPin,
  loadActiveRuntimePin,
  parseRuntimePin,
} from './runtimePin';
export type { ActiveRuntimePin, RuntimePinFile } from './runtimePin';
export {
  installRuntime,
  parseReleaseHead,
  pinMismatchField,
  planRuntimeInstall,
  publisherMatchesPin,
  PinMismatchError,
} from './runtimeInstall';
export {
  installerChildEnv,
  releaseHeadCid,
  sha256Equals,
  sha256Hex,
  verifyReleaseHead,
  ReleaseHeadError,
} from './releaseHead';
export { installedVersionMatches } from './runtimeInstall';
export { INTEL_MAC_MESSAGE, KVM_MESSAGE, runtimeInstallBlock, wslKvmMessage } from './runtimeSupport';
export {
  runtimeBinaryPath,
  runtimeComponentsPath,
  runtimeDataDir,
  runtimeHostLockPath,
} from './runtimePaths';
export type { RuntimeProbe, RuntimeProbeRequest } from './runtimeProbe';
export type { HealthProbe, LaunchTarget, LaunchTargetDescriptor, LaunchTargetId, TargetStatus, UpdateCheck } from './types';

export function createLaunchTarget(_id: LaunchTargetId = DEFAULT_LAUNCH_TARGET): LaunchTarget {
  return createRuntimeTarget();
}

export function createLaunchTargetFromEnv(env: NodeJS.ProcessEnv): LaunchTarget {
  return createLaunchTarget(currentLaunchTargetId(env));
}
