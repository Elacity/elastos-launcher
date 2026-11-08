# Contributing to the ElastOS launcher

The launcher installs the current signed ElastOS for the selected channel.

## Install rule

The Install button and the smoke jobs must call the published installer the way that script accepts it: `ELASTOS_HEAD_CID` set to the verified head, and arguments `--install-only` and `--maintainer-did`. Do not add a head flag the installer rejects.

A wrong signature or channel, version below the floor, changed metadata snapshot, or installer hash mismatch stops the install. The launcher does not clone a git tree and does not install a second computer app.

## What a change has to keep

- Health is `GET http://localhost:8090/healthz` with body `OK`, probed on every address `localhost` resolves to (`src/main/targets/gatewayAddress.ts`, `probeGatewayHealth` in `src/main/targets/runtimeGateway.ts`).
- Home is `http://localhost:8090/home/`.
- Update offers require signed metadata. Runtime 2.0.0 needs a compatibility `update-check.json` record after a successful CLI check. Human-readable stdout never determines the offer. A 2.0.0 source with an unknown head uses the stored signed install record and matching binary version for rollback identity.
- A foreign listener on 8090 keeps running and its specific error reaches the window. A status probe that overlaps Start, Stop, or Update must honor the newer control phase.
- On Mac, the signed Home controller owns System update restarts. Re-read the verified host generation before Stop. On Linux, Stop and Quit signal the update controller only, and only after a fresh read of its `/proc` start time, its exe, and the host lock generation. A mismatch sends no signal. A gateway on `127.0.0.1:8090` stays running and has no Stop control. A process the launcher spawned is signaled through its own process handle. Windows signals the gateway process group with `SIGTERM`, 15 seconds, then `SIGKILL`, and only after the pid has exited and `/healthz` has failed twice.
- Reset removes only the ElastOS program, its data directory, and the launcher stage file. Uninstall keeps Home data by default at the controller and removal boundaries; deleting data requires an explicit true choice from the native confirmation. Other home directories stay on disk.
- IPC channel names are `elastos:*`. The preload object is `window.elastos`.
- `src/main/index.ts` does not import `./targets`.
- macOS signing stays on hardened runtime, `resources/entitlements.mac.plist`, and `scripts/notarize.js`.

## Tests

```bash
npm test
```

The npm test runner creates an isolated HOME, clears inherited XDG paths, and removes PATH entries that contain an ElastOS program. The missing-runtime test also mocks binary discovery. These guards prevent unit tests from starting a host ElastOS installation. Temporary filesystem fixtures use physical paths so the symlink guard runs on Mac too.

## Native menu and action windows

Use `buildHomeMenu` for the tray and macOS application menu. Polls must preserve the existing menu when its state is unchanged; a stale status observation cannot override a newer action. Test the real builder, renderer and main entry point, rather than matching source strings. Run `scripts/prove-launch-redesign.js` to compare installed-app behavior against test.3 without starting Electron or a service.

After Windows setup, recheck its preflight and resume the pending install once Linux support is available. A setup result without a healthy Home is not proof that Linux setup failed.
