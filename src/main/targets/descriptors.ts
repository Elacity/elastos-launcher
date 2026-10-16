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
  startArgs: ['gateway', '--addr', '127.0.0.1:8090'],
  health: {
    url: 'http://127.0.0.1:8090/healthz',
    expectBodyIncludes: 'OK',
  },
  openUrl: 'http://127.0.0.1:8090/home/',
  platforms: [
    { platform: 'darwin', arch: 'arm64' },
    { platform: 'darwin', arch: 'x64' },
    { platform: 'linux', arch: 'x64' },
    { platform: 'linux', arch: 'arm64' },
  ],
};
