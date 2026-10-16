import { DEFAULT_LAUNCH_TARGET, LAUNCH_TARGET_ENV, parseLaunchTargetId } from './registry';
import { LaunchTargetId } from './types';

export interface LaunchTargetSelection {
  /** One-shot override. Wins over the environment. */
  explicit?: string | null;
  /** Pass `process.env` from the app. Omitted means no environment override. */
  env?: NodeJS.ProcessEnv;
}

function present(raw: string | null | undefined): string | undefined {
  if (raw == null || raw.trim() === '') return undefined;
  return raw;
}

/**
 * explicit, then ELASTOS_LAUNCH_TARGET, then the runtime.
 * A blank layer is skipped. An unknown non-blank value throws.
 */
export function resolveLaunchTargetId(selection: LaunchTargetSelection = {}): LaunchTargetId {
  const explicit = present(selection.explicit);
  if (explicit !== undefined) return parseLaunchTargetId(explicit);

  const fromEnv = present(selection.env?.[LAUNCH_TARGET_ENV]);
  if (fromEnv !== undefined) return parseLaunchTargetId(fromEnv);

  return DEFAULT_LAUNCH_TARGET;
}
