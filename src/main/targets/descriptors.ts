import { LaunchTargetDescriptor } from './types';

/**
 * Facts taken from the running launcher (src/main/pc2Manager.ts).
 * Port 4200 and /health are hardcoded there today.
 */
export const PC2_TARGET: LaunchTargetDescriptor = {
  id: 'pc2',
  displayName: 'PC2.net',
  implemented: true,
  installDir: '~/.pc2',
  binary: '~/.pc2/pc2-node/dist/index.js',
  startArgs: ['dist/index.js'],
  health: {
    url: 'http://localhost:4200/health',
    expectBodyIncludes: '',
  },
  openUrl: 'http://localhost:4200',
  platforms: [
    { platform: 'darwin', arch: 'arm64' },
    { platform: 'darwin', arch: 'x64' },
    { platform: 'linux', arch: 'x64' },
    { platform: 'linux', arch: 'arm64' },
    { platform: 'win32', arch: 'x64' },
  ],
};

/**
 * Facts taken from elastos-runtime as of workspace 0.7.1 / main.
 * `elastos gateway` is the supervised entry: `elastos home --browser`
 * also opens the system browser itself (gateway_entry.rs).
 * Health is GET /healthz → "OK" on the gateway, not PC2's /health.
 * darwin/x64 is included because a runtime build for Intel Mac is planned.
 * Native win32 is absent: Windows uses a WSL2 distro (ticket 11).
 */
export const RUNTIME_TARGET: LaunchTargetDescriptor = {
  id: 'runtime',
  displayName: 'ElastOS Runtime',
  implemented: false,
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
