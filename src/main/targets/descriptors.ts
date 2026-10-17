import { GATEWAY_ADDR, HEALTH_URL, HOME_URL } from './gatewayAddress';
import { LaunchTargetDescriptor } from './types';

/**
 * Facts taken from elastos-runtime.
 * `elastos gateway` is the supervised entry: `elastos home --browser`
 * also opens the system browser itself.
 * Health is GET /healthz → "OK" on the gateway.
 * darwin/x64 is included because a runtime build for Intel Mac is planned.
 * Native win32 is absent: Windows uses a WSL2 distro.
 */
export const RUNTIME_TARGET: LaunchTargetDescriptor = {
  id: 'runtime',
  displayName: 'ElastOS Runtime',
  implemented: true,
  installDir: '~/.local/share/elastos',
  binary: '~/.local/bin/elastos',
  startArgs: ['gateway', '--addr', GATEWAY_ADDR],
  health: {
    url: HEALTH_URL,
    expectBodyIncludes: 'OK',
  },
  openUrl: HOME_URL,
  platforms: [
    { platform: 'darwin', arch: 'arm64' },
    { platform: 'darwin', arch: 'x64' },
    { platform: 'linux', arch: 'x64' },
    { platform: 'linux', arch: 'arm64' },
  ],
};
