import ElectronStore from 'electron-store';
import { DEFAULT_LAUNCH_TARGET, LAUNCH_TARGET_ENV, parseLaunchTargetId } from './registry';
import { LaunchTargetId } from './types';

export const LAUNCH_TARGET_STORE_KEY = 'launchTarget';

export interface LaunchTargetPreferenceStore {
  get(): string | undefined;
  set(value: string): void;
  delete(): void;
}

type LaunchTargetFile = {
  launchTarget?: string;
};

/**
 * electron-store file `launch-target.json`.
 * Pass an absolute `cwd` in tests. The Electron main process omits it and
 * uses the app userData directory.
 */
export function createLaunchTargetStore(cwd?: string): LaunchTargetPreferenceStore {
  const store = new ElectronStore<LaunchTargetFile>({
    name: 'launch-target',
    ...(cwd ? { cwd } : {}),
  });
  return {
    get() {
      const value = store.get(LAUNCH_TARGET_STORE_KEY);
      return typeof value === 'string' ? value : undefined;
    },
    set(value: string) {
      store.set(LAUNCH_TARGET_STORE_KEY, value);
    },
    delete() {
      store.delete(LAUNCH_TARGET_STORE_KEY);
    },
  };
}

export interface LaunchTargetSelection {
  /** One-shot override. Wins over the environment and the store. */
  explicit?: string | null;
  /** Pass `process.env` from the app. Omitted means no environment override. */
  env?: NodeJS.ProcessEnv;
  store?: LaunchTargetPreferenceStore;
}

function present(raw: string | null | undefined): string | undefined {
  if (raw == null || raw.trim() === '') return undefined;
  return raw;
}

/**
 * explicit, then ELASTOS_LAUNCH_TARGET, then the store, then PC2.
 * A blank layer is skipped. An unknown non-blank value throws.
 */
export function resolveLaunchTargetId(selection: LaunchTargetSelection = {}): LaunchTargetId {
  const explicit = present(selection.explicit);
  if (explicit !== undefined) return parseLaunchTargetId(explicit);

  const fromEnv = present(selection.env?.[LAUNCH_TARGET_ENV]);
  if (fromEnv !== undefined) return parseLaunchTargetId(fromEnv);

  const stored = selection.store ? present(selection.store.get()) : undefined;
  if (stored !== undefined) return parseLaunchTargetId(stored);

  return DEFAULT_LAUNCH_TARGET;
}
