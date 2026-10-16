import { RUNTIME_TARGET } from './descriptors';
import { targetSupportsHost } from './registry';

export const INTEL_MAC_MESSAGE =
  'ElastOS is not yet supported on Intel Macs. A signed release for this Mac is not published yet.';

export const WINDOWS_NATIVE_MESSAGE =
  'ElastOS on Windows runs in its own Linux environment. Click Enable. Windows will ask for permission once. You do not type any commands.';

export const KVM_MESSAGE =
  'The local Browser needs /dev/kvm, and this WSL2 distro does not have it. ElastOS can still install, and you can open your computer in the Windows browser. The in-computer browser stays off until /dev/kvm is available.';

/**
 * Signed-installer support. darwin/x64 stays probeable, but the publisher
 * does not ship a signed Intel Mac build, so install stops with a friendly
 * message instead of running install.sh (which would exit 1).
 */
export function runtimeInstallBlock(platform: string, arch: string): string | null {
  if (platform === 'darwin' && arch === 'x64') return INTEL_MAC_MESSAGE;
  if (platform === 'win32') return WINDOWS_NATIVE_MESSAGE;
  if (!targetSupportsHost(RUNTIME_TARGET, platform, arch)) {
    return `ElastOS is not supported on ${platform}/${arch}.`;
  }
  return null;
}

export function wslKvmMessage(wsl: boolean, kvmAvailable: boolean): string | null {
  if (wsl && !kvmAvailable) return KVM_MESSAGE;
  return null;
}

export function detectWsl(env: NodeJS.ProcessEnv, procVersion: string): boolean {
  if (env.WSL_DISTRO_NAME && env.WSL_DISTRO_NAME.trim()) return true;
  return /microsoft|wsl/i.test(procVersion);
}
