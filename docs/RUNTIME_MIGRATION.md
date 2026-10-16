# ElastOS launcher

Status: the desktop app installs and supervises the ElastOS runtime only.

Founder decision on 2026-10-16: the previous computer app is gone from this repository. The launcher does not import its data and does not delete other folders in the home directory. A runtime home starts empty.

| Decision | What this tree does |
|---|---|
| Product | The pinned ElastOS runtime. One Install button. |
| Update channel | `stable` is filled from runtime `main` when that head is published. `develop` maps to `canary` for testing. `"active"` in `resources/runtime-pin.json` is the switch. |
| Pin | Each launcher release pins a signed runtime version, UnixFS head CID, installer SHA-256, and maintainer DID. |
| Home | Fresh runtime data directory. No import of another product. |
| Windows | Dedicated WSL2 distro named `ElastOS`. |
| Intel Mac | “not yet supported on Intel Macs” until a signed `darwin-x64` release exists. |
| Telemetry | None. |
| Signing | Hardened runtime, `resources/entitlements.mac.plist`, and `scripts/notarize.js`. Tag builds use the existing Apple secrets. |

## 1. How the launcher runs the runtime

The launcher is an Electron 28 shell. It does not embed the runtime. It downloads the pinned `install.sh`, checks the Ed25519 release head and the installer SHA-256, and runs:

`ELASTOS_HEAD_CID=<pin> bash install.sh --install-only --maintainer-did <did>`

| Piece | File | Role |
|---|---|---|
| Main process | `src/main/index.ts` | Window, tray, and `elastos:*` IPC. It does not import `./targets`. |
| Supervisor | `src/main/launchController.ts` | Start, stop, install, update, reset, diagnostics. |
| Preload | `src/preload/index.ts` | `window.elastos`. |
| Renderer | `src/renderer/index.html`, `src/renderer/app.js`, `src/renderer/flow.js` | Install, then “Open my computer”. |
| Registry | `src/main/targets/` | One id, `runtime`. |

The tray says Start, Stop, and Open my computer. There is no Computer menu and no location dropdown.

## 2. Paths

| | Runtime |
|---|---|
| Program | `~/.local/bin/elastos` |
| Data | `~/Library/Application Support/elastos` on macOS, otherwise `$XDG_DATA_HOME/elastos` or `~/.local/share/elastos` |
| Lock | `{data}/host-process.lock` |
| Stage | `~/.elastos-launcher/install-stage.json` |
| Health | `GET http://127.0.0.1:8090/healthz` body `OK` |
| Home | `http://127.0.0.1:8090/home/` |

Reset and uninstall remove only those runtime paths. A directory segment that contains a dot is refused unless it is `.local` or `.elastos-launcher`. That leaves every other home folder on disk.

Stop signals the gateway process group: `SIGTERM`, 15 seconds, then `SIGKILL`, after the pid has exited and `/healthz` has failed twice. Exit 75 restarts only when the binary was replaced on disk.

On Windows the same installer runs inside distro `ElastOS` as root, and the Windows process reads `/healthz` on `127.0.0.1:8090`.

## 3. Release readiness

Check these before the runtime on `main` is marketed as a live product and this launcher is the no-code way in. The Install button, the gateway supervisor, and the canary pin are in this stack. They are not a signed release by themselves.

- [ ] Land launcher PR #5 (`v1.4.0`) before the tag build. It is the notarization that waits for Apple, fails on rejection, and staples the DMG. This stack's `package.json` is already version `1.4.0` and keeps the `test` script (`npm run build:ts && node --test test/*.test.js`) and `extraResources`. Merging PR #5 (`6e28656`) onto that tree leaves `package.json` at `1.4.0` with the test script. Notarization still lives only on PR #5.
- [ ] Fill `channels.stable` in `resources/runtime-pin.json`, then change `"active"` from `canary` to `stable`. That `active` field is the channel switch. Until a stable head exists, the pin stays on canary `0.8.0-alpha.20`.
- [x] Linux x64 click path on GitHub Actions, [run 38879770403](https://github.com/Elacity/elastos-launcher/actions/runs/38879770403) job [`smoke (linux-x64)`](https://github.com/Elacity/elastos-launcher/actions/runs/38879770403/job/116903424213) (2026-10-16, `941aeb3`, canary `0.8.0-alpha.20`): `Release head signature matches the pinned maintainer`, `install.sh SHA-256 matches the pin`, `Installed version: ElastOS Runtime v0.8.0-alpha.20`, `Installed head CID matches the pin`, `components.json is present`, `/healthz is OK`, `/home/ HTTP 200`, `Gateway stopped cleanly`. The job is required. This runtime-only tree re-runs that job.
- [x] macOS arm64 on the same run, job [`smoke (darwin-arm64)`](https://github.com/Elacity/elastos-launcher/actions/runs/38879770403/job/116903424267), runner `macos-14`: `Platform: macOS 14.8.9 on Apple silicon (aarch64-darwin)`, `Release head signature matches the pinned maintainer`, `install.sh SHA-256 matches the pin`, `Installed version: ElastOS Runtime v0.8.0-alpha.20`, `Installed head CID matches the pin`, `components.json is present`, `/healthz is OK`, `/home/ HTTP 200`, `Gateway stopped cleanly`. The job is required.
- [x] `continue-on-error` is removed from the Linux x64 and macOS arm64 smoke jobs.
- [x] Windows smoke: `smoke (windows-wsl)` on `windows-2025`, job [`116903424416`](https://github.com/Elacity/elastos-launcher/actions/runs/38879770403/job/116903424416) on the same run (`941aeb3`). The log has `This job does not skip. /healthz must be OK inside the ElastOS distro.`, `Rootfs SHA-256 matches the pin`, `kvm=yes`, `Release head signature matches the pinned maintainer`, `install.sh SHA-256 matches the pin`, `Installed version: ElastOS Runtime v0.8.0-alpha.20`, `Installed head CID matches the pin`, `/healthz is OK`, `/home/ HTTP 200`, `Gateway stopped cleanly`, `smoke_exit=0`. A missing `wsl.exe` or a failed import fails the job. Intel Macs stay blocked until a signed release exists.
- [x] Windows Install button path: job [`app install (windows-wsl)`](https://github.com/Elacity/elastos-launcher/actions/runs/38879770403/job/116903423941) runs `scripts/windows-app-install.js`, which calls `installRuntimeOnThisComputer` and then reads `http://127.0.0.1:8090/healthz` from the Windows node process. The log has `Rootfs SHA-256 matches the pin`, `Release head signature matches the pinned maintainer`, `install.sh SHA-256 matches the pin`, `Installed head CID matches the pin`, `/healthz is OK`, `/home/ HTTP 200`, `Opening Home in the Windows browser: http://127.0.0.1:8090/home/`, `Gateway stopped cleanly`.
- [x] Electron click: job [`e2e (linux-x64)`](https://github.com/Elacity/elastos-launcher/actions/runs/38879770403/job/116903424912) logs `Clicked Install`, `Release head signature matches the pinned maintainer`, `install.sh SHA-256 matches the pin`, `Installed head CID matches the pin`, `Install reached Open my computer`. Job [`e2e (darwin-arm64)`](https://github.com/Elacity/elastos-launcher/actions/runs/38879770403/job/116903424533) logs the same five lines.
- [ ] Intel Mac: the screen says “not yet supported on Intel Macs”. There is no signed `darwin-x64` release in the pin. The version probe can still see a binary later.
- [ ] Tag build signs and notarizes with the existing secrets (`CSC_LINK`, `CSC_KEY_PASSWORD`, `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID`). This environment has no Apple certificate and did not notarize a build.
- [ ] No phone-home telemetry.
- [x] Uninstall and Reset remove only the ElastOS program, its data directory, and the launcher stage file. A dotted directory other than `.local` or `.elastos-launcher` is refused, so other home folders stay on disk.
- [ ] A gateway this launcher did not start is left running. Stop of one it did start signals the process group: `SIGTERM`, 15 seconds, then `SIGKILL`, and only after the pid is dead and `/healthz` has failed twice.
- [ ] Diagnostics and the log panel do not contain `attach_secret` or the coordinate JSON files.
- [x] Live rollback on the same run, job [`rollback (linux-x64)`](https://github.com/Elacity/elastos-launcher/actions/runs/38879770403/job/116903424212): install of `0.8.0-alpha.20` prints `/healthz is OK`, then `previous head QmULef49FjitVQPtLqSpzXcpAJpvaCueLzs31R6dWBUdsM is 0.8.0-alpha.19`, `elastos update --rollback-to QmULef49FjitVQPtLqSpzXcpAJpvaCueLzs31R6dWBUdsM --yes` prints `Installed version: ElastOS Runtime v0.8.0-alpha.19` and `/healthz is OK`, then `elastos update --yes` prints `Installed version: ElastOS Runtime v0.8.0-alpha.20`, `/healthz is OK`, and `Rollback returned to the pinned release`.
