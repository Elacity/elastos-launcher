# Contributing to the ElastOS launcher

The launcher installs one product: the pinned ElastOS runtime.

## Install rule

The Install button and the smoke jobs must call the published installer the way that script accepts it: `ELASTOS_HEAD_CID` set to the pin, and arguments `--install-only` and `--maintainer-did`. Do not add a head flag the installer rejects.

A pin mismatch stops the install. The launcher does not clone a git tree and does not install a second computer app.

## What a change has to keep

- Health is `GET http://localhost:8090/healthz` with body `OK`, probed on every address `localhost` resolves to (`src/main/targets/gatewayAddress.ts`, `probeGatewayHealth` in `src/main/targets/runtimeGateway.ts`).
- Home is `http://localhost:8090/home/`.
- Stop signals the gateway process group: `SIGTERM`, 15 seconds, then `SIGKILL`, and only after the pid has exited and `/healthz` has failed twice.
- Reset and uninstall remove only the ElastOS program, its data directory, and the launcher stage file. Other home directories stay on disk.
- IPC channel names are `elastos:*`. The preload object is `window.elastos`.
- `src/main/index.ts` does not import `./targets`.
- macOS signing stays on hardened runtime, `resources/entitlements.mac.plist`, and `scripts/notarize.js`.

## Tests

```bash
npm test
```
