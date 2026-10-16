# ElastOS launcher → runtime migration

Status: discovery and design. This document is the map and the plan. The only code change that landed with it is a launch-target registry whose default is still PC2, and which the Electron main process does not call yet.

Sources, read from code rather than READMEs alone:

- This repo, `main` at `2efa553` (`v1.2.7: heartbeat-based pc2-node status`). Package version `1.2.7`.
- Shipped launcher tag `v1.4.0` (`6e28656`), which is `main` plus six unmerged commits. GitHub's latest launcher release is this tag, not `main`.
- [`Elacity/elastos-runtime`](https://github.com/Elacity/elastos-runtime), `main` after tag `v0.7.1` (workspace version `0.7.1` in `elastos/Cargo.toml`). Release `v0.7.1` (2026-09-30) has binary tarballs attached.

The product decision this plan assumes: the desktop app keeps launching PC2 until a runtime smoke test is green, then the runtime becomes the default. PC2 stays selectable and is deprecated about one month after that launch. There is no import of PC2 data. A runtime home starts empty.

## Founder decisions (2026-10-16)

| Topic | Decision |
| --- | --- |
| Update channel | Desktop follows `stable`, published from runtime `main`. Runtime `develop` maps to `canary` and is for testing only. |
| Install | Each launcher release pins a signed runtime version, head CID, and maintainer DID. If that pinned install fails, fall back to the stamped hosted `install.sh --install-only`. |
| Existing PC2 data | No import. Fresh runtime home. PC2 stays selectable. |
| Default flip | Runtime becomes the default once the smoke test is green (`/healthz` is `OK` and `/home/` returns 200). |
| PC2 lifetime | Deprecated about one month after the runtime launch. Remains selectable through that window. |
| Windows | Ticket 11: runtime runs in a dedicated WSL2 distro, separate from today's PC2-via-WSL path. |
| Intel Mac | A `darwin-x64` runtime build and CI will be added. The launcher probes that build the same way as Apple silicon once the binary exists. Native `win32` stays unsupported. |
| Telemetry | No phone-home telemetry. Local logs only. |
| Open URL | Still open. The supervised command in this plan remains `elastos gateway --addr 127.0.0.1:8090` and `/home/`. |
| Remote tunnels | Still open. First runtime launch in this plan binds loopback. |

On 2026-10-16 the public publisher `https://elastos.elacitylabs.com/release-head.json` was channel `canary`, version `0.8.0-alpha.20`, head `QmTAEJ8DAprsv5PbWcudofQwXrzL7ZjSgmhRmU8nqmwirf`, signer `did:key:z6MkgwHd2BCWe1jHMXPiR6H1q1RFPcv1YzhMbK5G1kBarbfe`. That is the testing channel, not the stable pin. A stable head was not published at that URL.

## 1. How the launcher runs PC2.net today

The launcher is an Electron 28 shell. It does not embed PC2. It clones `Elacity/pc2.net`, builds it with a private Node 22, and supervises `node dist/index.js`.

### Entry points

| Surface | File | What it calls |
| --- | --- | --- |
| Main process | `src/main/index.ts` | Imports `pc2Manager` directly. IPC names are all `pc2:*`. |
| Preload bridge | `src/preload/index.ts` | Exposes `window.pc2` (`start`, `stop`, `install`, `update`, `setEnvironment`, …). |
| Renderer | `src/renderer/index.html`, `src/renderer/app.js` | Power button installs when status is `not-installed`, otherwise start/stop. URL label is the literal `localhost:4200`. Location dropdown is `~/.pc2` or `~/pc2.net`. |
| Tray | `src/main/index.ts` lines 111–129 | "Start PC2" / "Stop PC2" / "Open in Browser". |

There is no second product behind those handlers. `electron-store` is a dependency. `src/main/targets/preferences.ts` is the only reader, and `src/main/index.ts` does not import it yet, so a cold start still calls `pc2Manager` only. The PC2 environment dropdown is still process memory and resets to `default` (`currentEnv` in `src/main/pc2Manager.ts`).

### Where it looks

`src/main/pc2Manager.ts` lines 294–355:

| Environment | Directory | Node entry |
| --- | --- | --- |
| `default` (every cold start) | `~/.pc2` | `~/.pc2/pc2-node/dist/index.js` |
| `dev` | `~/pc2.net` | `~/pc2.net/pc2-node/dist/index.js` |
| `custom` | caller-supplied | `<custom>/pc2-node` |

Windows rewrites those paths into WSL (`wsl bash -c …`, `getWSLHome()`). Installed means that `dist/index.js` exists (`isInstalled`, lines 570–582).

Bundled Node is a separate tree: `~/.elastos/node/node-v22.13.1-<platform>-<arch>/` (`NODE_VERSION`, `BUNDLED_NODE_DIR`, lines 17–26, 93–105). Download URLs exist for `darwin-arm64`, `darwin-x64`, `linux-x64`, `linux-arm64`. There is no Windows Node tarball; Windows uses whatever `node` WSL has on `PATH`.

### Install

`installPC2()` (lines 1082–1293):

1. Download Node 22.13.1 from nodejs.org if the bundled binary is missing (skipped on Windows).
2. If `~/.pc2` exists and `package.json` `name` is `puter` and `.git/config` contains `Elacity/pc2.net`, repair with `git fetch && git reset --hard origin/main`. Anything else is renamed to `~/.pc2_backup_<timestamp>`.
3. Otherwise `git clone https://github.com/Elacity/pc2.net`.
4. `HUSKY=0 npm install --legacy-peer-deps` at the repo root (`--ignore-scripts`) and again inside `pc2-node`, then `npm run build` in `pc2-node`.
5. `verifyNativeModules()` loads `@photostructure/sqlite` or `better-sqlite3` (chosen from `pc2-node/package.json`) and `node-datachannel`. Failure deletes that module and reinstalls it once, then throws.
6. On Mac/Linux, `setupNetworking()` installs WireGuard, AmneziaWG (built from source), a patched `awg-quick`, sing-box 1.13.0, sudoers for `wg-quick` / `awg-quick`, and writes Particle wallet keys into `packages/particle-auth/.env`. Failures are logged and do not fail the install. Privilege prompt is `osascript` on macOS and `sudo -n` / `pkexec` on Linux.

`CONTRIBUTING.md` requires this networking set to match `pc2.net` `scripts/start-local.sh` and `scripts/install-arm.sh`. That rule is about PC2. It does not apply to the runtime target.

The tag `v1.4.0` (not on `main`) also installs Xcode Command Line Tools before the clone, folds the macOS admin work into one password prompt, and installs `ffmpeg` and `cmake`. See [main versus the shipped tag](#main-versus-the-shipped-v140-tag).

### Start, health, stop

Start (`startPC2`, lines 673–840):

- Spawn `<bundled node> dist/index.js` with `cwd` = the `pc2-node` directory and an extended `PATH`.
- Windows: `wsl bash -c 'cd … && node dist/index.js'`.
- Before spawn, probe the SQLite module. ABI mismatch becomes a thrown error instead of a crash loop.
- Capture stdout/stderr into an in-memory ring of 500 lines (`getLogs`). Nothing tails a PC2 log file.
- `waitForServer()` polls `http://localhost:4200/health` for 30s (`PC2_URL`, line 10; `waitForServer`, lines 1389–1413). Any HTTP 2xx counts. Timeout kills the child.

Status (`getStatus`, lines 584–628), in order:

1. Missing `dist/index.js` → `not-installed`.
2. Heartbeat file `<pc2-node>/data/runtime/heartbeat.json`, schema `pc2.heartbeat.v1`, written by pc2-node every 2s. The poller is `src/main/pc2Heartbeat.ts`. Fresh and `healthy: true` → `running`. `healthy: false` → `stopping`. Older than 5s → `error`. The contract it follows lives in pc2.net `docs/wiki/Technical/RUNTIME_HEARTBEAT_PROTOCOL.md` (cited in the poller header; that file is not in this repo).
3. If the file is absent (older pc2-node, or really stopped), `GET http://localhost:4200/health` with a 2s timeout.
4. Child still alive but health failing → `starting`. Else `stopped`.

A child exit does not flip the UI to stopped immediately. The exit handler waits 6s so a pc2-node that respawned itself (in-app updater, `POST /api/system/restart`, pm2) can write a new heartbeat. `stopPC2` sets a flag so an explicit Stop skips that wait. Stop sends `SIGTERM`, then `SIGKILL` after 3s. If this process does not own the child, it deletes the heartbeat file and runs `lsof -ti:4200` (or `fuser -k 4200/tcp` inside WSL), excluding the Electron PID.

Restart prefers the heartbeat flag `data/runtime/restart-requested.flag` (`restartPC2ViaHeartbeat`). The IPC `pc2:restart` handler still calls `restartPC2()`, which is stop plus start. The flag path is exported and unused by the window.

Open uses `shell.openExternal('http://localhost:4200')`. LAN URL and QR code use the same port on the first non-internal IPv4 (`getLanURL`, `generateQRCode`). The renderer currently does not call the QR/LAN IPC methods.

### Version and update

- Installed version is the **root** `package.json` `version`, not the running process (`getPC2Version`, lines 1483–1491). `getRunningPC2Version()` reads the heartbeat and is also unused by the UI.
- Update check is `GET https://api.github.com/repos/Elacity/pc2.net/releases/latest` with `User-Agent: elastos-launcher` (lines 1503–1536). Comparison is numeric `major.minor.patch` only.
- `updatePC2` stops the child, `git fetch && git reset --hard origin/main` (this follows **main**, not the GitHub release tag the check just found), reinstalls, rebuilds, re-runs the native-module gauntlet, and starts again if it had been running.

Channel: git branch `origin/main` of `Elacity/pc2.net`, with a GitHub Releases tag used only as the "update available" signal.

### Uninstall

`uninstallPC2` (lines 1420–1451) refuses any path that contains neither `.pc2` nor `pc2.net`, then `rm -rf`s that directory. It does not remove `~/.elastos/node`, sudoers, WireGuard, or sing-box.

### Platforms, packaging, signing

| Platform | How PC2 is hosted | Packaged as |
| --- | --- | --- |
| macOS arm64 | Native spawn | DMG + zip. `appId` `com.elacity.personalcloud`, product name `ElastOS`. Hardened runtime, `resources/entitlements.mac.plist` (JIT, unsigned executable memory, dyld env, network client/server). `notarize: false` inside electron-builder; `scripts/notarize.js` submits DMG/zip via `notarytool` and does not wait or staple. |
| macOS Intel | Same code paths; README says Rosetta. No separate `x64` CI runner (`macos-latest` only). | Same job as arm64. |
| Linux x64 | Native spawn | AppImage + deb. CI runner is `ubuntu-latest`. |
| Linux arm64 | Node tarball exists in code. | No arm64 job in `.github/workflows/build.yml`. |
| Windows | WSL only. README tells users to prefer a VPS. | NSIS + portable. No Windows code signing in the workflow. |

CI (`.github/workflows/build.yml`) runs on tags `v*` and `workflow_dispatch`. It does not run on pull requests. Release job uploads `dist-electron` artifacts with `softprops/action-gh-release`. Signing secrets: `CSC_LINK`, `CSC_KEY_PASSWORD`, `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID`. Empty `CSC_LINK` is unset so electron-builder skips signing.

There is no launcher auto-update. Users download a new DMG/deb/exe. The in-app Update button updates **PC2**, not the Electron shell.

### main versus the shipped v1.4.0 tag

`git merge-base main v1.4.0` is `2efa553`. Six commits are on the tag and not on `main`:

- `579d539` install `ffmpeg` and `cmake` for parity with `start-local.sh`
- `e494c8d` version bump to 1.2.8
- `5de167e` one macOS password prompt for Homebrew and sudoers
- `328e574` Xcode CLT install before `git clone`
- `b8dbd64` version bump to 1.4.0
- `6e28656` notarization waits for Apple and staples the DMG

Migration PRs that branch from `main` do not contain those install fixes. Merge the tag back before changing install code, or the next `main` build will regress the installer people actually downloaded.

## 2. What the ElastOS runtime needs in order to launch

The user-facing binary is `elastos`, crate `elastos-server` (`elastos/crates/elastos-server/Cargo.toml`, `[[bin]] name = "elastos"`). The crate named `elastos-runtime` is a library. Capsules under `capsules/` and `elastos/capsules/` are child programs the host installs; they are not the process the launcher should exec first.

### Build and distribution

- Toolchain pin: repo-root `rust-toolchain.toml` channel `1.91.0`. Workspace `rust-version = "1.91"`.
- Dev entry: `just build` → `scripts/build.sh`. Direct: `cargo build --release -p elastos-server` from `elastos/`.
- Version baked into the binary is `ELASTOS_RELEASE_VERSION`, or `{Cargo version}-dev` when that env var is unset (`elastos/crates/elastos-server/build.rs`).
- CI (`.github/workflows/ci.yml`) builds on `ubuntu-24.04`, `ubuntu-24.04-arm`, and `macos-14`, then `scripts/package-release-binaries.sh` writes `elastos-runtime-<platform>.tar.gz` plus `.sha256`. Platforms the script accepts: `linux-amd64`, `linux-arm64`, `darwin-arm64`. Anything else exits 1. Artifacts upload on `main`, tags, and `workflow_dispatch`.
- GitHub release `v0.7.1` has those three tarballs attached. `main` has moved past that tag, so "latest main" and "latest release asset" are different bits.
- `scripts/install.sh` is the supported installer. It expects a publisher URL whose trust anchors (maintainer DID, head CID) are stamped in at publish time. It verifies an Ed25519 signature, downloads the binary and `components.json`, and installs to `~/.local/bin/elastos` plus the XDG data dir. `curl -fsSL https://elastos.elacitylabs.com/install.sh | bash` is the public form in `docs/INSTALL.md`. `--install-only` / `ELASTOS_INSTALL_ONLY=1` stops after bootstrap so a supervisor can start the process itself.
- `release-package.yml` is a manual workflow that builds inputs for an operator to sign. It is not a consumer installer.
- Channels on a trusted source: `stable`, `canary`, `jetson-test` (`elastos/crates/elastos-server/src/sources.rs` line 9).

A tarball is a directory of binaries (the `elastos` CLI plus provider binaries). It is not a configured home. First launch still needs `elastos setup` (default profile `home`) and a trusted source before published components will download.

### Start command

Default CLI with no subcommand is `elastos home` **without** `--browser`, which runs the terminal `home-cli`, not an HTTP server (`main.rs` around lines 1260–1265 and 1324–1332).

Two HTTP fronts exist:

| Command | Bind | Ready signal | Browser |
| --- | --- | --- | --- |
| `elastos home --browser` | hardcoded `localhost:8090` (`gateway_entry.rs` `run_browser_home`) | prints `Home: {url}` and calls `open_browser` | yes, always (`main.rs` `open_browser`, macOS `open`, Linux `wslview` then `xdg-open`) |
| `elastos gateway --addr <host:port>` | default `127.0.0.1:8090` (`main.rs` Gateway command) | stdout `ElastOS Gateway v…` and `Bind: http://…` (`api/gateway_server.rs`) | no |
| `elastos serve --addr <host:port>` | default `0.0.0.0:3000` | `GET /api/health` JSON `{"status":"ok","version":"…"}` (`api/routes.rs`, `api/server.rs` route `/api/health`) | no |

`home --browser` and `gateway` both call `setup_control_plane`. `serve` is the operator API. `docs/INSTALL.md` says only one live host may own a data directory: do not run Home and `serve` together. The lock is `host-process.lock` (flock, pid, role, addr) in `host_lock.rs`. A second start fails with "another ElastOS host already owns …".

The launcher should spawn:

```text
~/.local/bin/elastos gateway --addr 127.0.0.1:8090
```

and open `http://127.0.0.1:8090/home/` itself after health passes. `home --browser` would race the launcher's Open button and call `open` / `xdg-open` on ready. `/home/` is `HOME_ROUTE` (`api/gateway.rs`). `/apps/home/` on that same router redirects to it.

`http://localhost:61180/apps/home/` shows up in `docs/WINDOWS.md` and in `scripts/mac-source-home-restart.sh` (`MAC_GATEWAY_ADDR` default `localhost:61180`). That is the source-home staging bind, not the `home --browser` bind. Same routes, different port, chosen by the script. The launcher should own the port it passes to `--addr` and not special-case 61180.

### Config, data, logs

| Item | Location |
| --- | --- |
| Data dir | `$XDG_DATA_HOME/elastos` or `~/.local/share/elastos` (`default_data_dir` in `sources.rs`) |
| Binary | `~/.local/bin/elastos` (`default_install_path`) |
| Trusted publishers | `{data}/sources.json` |
| Installed components | `{data}/components.json` |
| Policy | `{data}/policy.json`, override `ELASTOS_POLICY_FILE` |
| Optional TOML | `{data}/config.toml` (merged with defaults; `carrier_bind_addr` is one extra key) |
| Host lock | `{data}/host-process.lock` |
| Managed runtime coords | `{data}/runtime-coords.json`, `gateway-runtime-coords.json`, `home-runtime-coords.json` (`RuntimeCoords`: `api_url`, `attach_secret`, `pid`, `runtime_kind`). Override `ELASTOS_RUNTIME_COORDS_FILE`. `attach_secret` is exchanged at `/api/auth/attach`; it is not a bearer token. |
| Managed runtime log | `{data}/logs/runtime.log` when the gateway detaches a child `serve` |

`elastos serve --storage-path` defaults to `/tmp/elastos/storage`. The Home/gateway path uses the data dir. The launcher should not point a desktop install at `/tmp`.

There is no `heartbeat.json` anywhere in the runtime repo. Liveness for the API is HTTP. The runtime already polls `GET {api_url}/api/health` for managed children (`runtime_control.rs`). Gateway liveness for the page the user opens is `GET /healthz`, body `OK` (`api/gateway_site.rs`, route in `api/gateway.rs`). Those are different servers: `/healthz` is not mounted on the operator `serve` router, and `/api/health` is the operator and the gateway's local control plane, not the public gateway page.

Foreground process. When stdin/stdout are not a terminal — the launcher case, because it pipes stdio — `should_isolate_process_group` is true for every command, including `gateway` (`main.rs`). The process calls `setpgid(0, 0)` and a SIGTERM/SIGINT handler signals that group, waits (10s for `gateway`), then `kill(0, SIGKILL)`. Providers and a managed `serve` are children. A launcher that SIGKILLs only the parent pid skips that handler and can leave children behind, so stop has to signal the process group (`kill(-pid)`).

### Updates

`elastos update` and `elastos upgrade` are the same handler (`main.rs` Update / Upgrade). `--check` does not install. `--yes` skips the prompt. `--rollback-to <head cid>` reinstalls that signed head. The transport is the trusted Carrier source and/or explicit `--gateway` URLs, then an atomic replace of `~/.local/bin/elastos` and `components.json`. This is not `git pull` and not "download the GitHub release asset and exec it" unless that asset is the signed payload the installer already verified.

`GET /api/health` returns the stamped version string. `elastos version` prints `ELASTOS_VERSION`.

### Operating systems

Accepted install targets in `docs/INSTALL.md`: Linux `x86_64` and `aarch64`, macOS Apple silicon. Intel Mac fails closed in the installer. Native Windows is rejected in `docs/WINDOWS.md`; the written direction is a Linux runtime inside WSL2 with a small Windows launcher, and that doc names `http://localhost:61180/apps/home/` as the URL that launcher would open. No Windows binary is in the `v0.7.1` release.

Browser isolation is extra: Linux wants KVM/crosvm, macOS wants Virtualization.framework and a signed `elastos-vz` helper (`scripts/dev/sign-elastos-vz/`). Home itself can run without that. The launcher's existing entitlements file does not grant the hypervisor entitlement, and entitlements apply to the signed Electron binary, not to `~/.local/bin/elastos`.

## 3. Gap list

### Launcher repo

| Gap | Evidence |
| --- | --- |
| One hardcoded product. IPC, tray labels, HTML, and uninstall safety all say PC2. | `src/main/index.ts`, `src/preload/index.ts`, `src/renderer/index.html`, `uninstallPC2` path check |
| No persisted settings, despite `electron-store` being a dependency. A target flag in memory would vanish on restart. | `package.json` dependency; no import under `src/` |
| Update check and update action disagree (GitHub Releases tag vs `git reset --hard origin/main`). Copying that pattern onto the runtime would skip the signed channel. | `checkForUpdate`, `updatePC2` |
| `main` is behind the installer users have (`v1.4.0`: ffmpeg, cmake, one password prompt, stapled notarization). | `git log main..v1.4.0` |
| No PR CI. `build.yml` is tag-only. This change adds `.github/workflows/test.yml` for the registry tests. | `.github/workflows/build.yml` |
| Windows path assumes `node dist/index.js` inside WSL and kills TCP 4200. | `wslCmd`, `stopPC2` |
| Stop-by-port and the uninstall guard are unsafe to reuse on a runtime data dir. | `lsof -ti:4200`, `uninstallPC2` |
| Bundled Node, SQLite ABI gauntlet, and `setupNetworking()` (WireGuard, AmneziaWG, sing-box, Particle `.env`) are PC2 install-parity. The runtime installs its own profile through `elastos setup`. | `setupNetworking`, `CONTRIBUTING.md` |
| README download links still point at launcher `v1.2.6` while the latest release is `v1.4.0`. | `README.md` |

### Runtime repo

| Gap | Evidence |
| --- | --- |
| No launcher-owned "start and do not open a browser" flag on `home --browser`. Workaround exists: `elastos gateway --addr`. Needs a founder confirmation that gateway-with-control-plane is the supported desktop entry. | `gateway_entry.rs` `run_browser_home`, `open_browser` |
| No pc2-style heartbeat file. Acceptable if the launcher binds a fixed loopback port and polls `/healthz`. | repo search for `heartbeat.json` is empty; `/healthz` returns `OK` |
| `/health`, port 4200, and `/api/health` on the public gateway are the wrong probes. A straight port of `waitForServer()` will time out against a healthy Home. | `PC2_URL` in the launcher; gateway route table |
| GitHub tarballs exist (`v0.7.1`) but are not a configured install. Setup plus a trusted source is still required. A launcher that only downloads the tarball will start a binary with nothing to serve. | `scripts/package-release-binaries.sh`, `docs/INSTALL.md` "Source checkout note" |
| `install.sh` in git still contains placeholder trust anchors (`__MAINTAINER_DID__`, `__HEAD_CID__`). The stamped script is whatever the publisher URL serves. The launcher cannot vendor the git copy and expect it to verify. | `scripts/install.sh` |
| Intel Mac and native Windows have no published binary. The Electron app's "Intel via Rosetta" story does not extend to the runtime. | `package-release-binaries.sh`, `docs/INSTALL.md`, `docs/WINDOWS.md` |
| One data dir, one host lock. The launcher's `default` / `dev` location switch has no runtime equivalent. | `host_lock.rs`, `ENVIRONMENTS` |
| `attach_secret` inside coords files is a local credential. A launcher log scraper must not copy those files into the log panel. | `RuntimeCoords` in `runtime_control.rs` |
| Release tag `v0.7.1` is behind `main`. Shipping "latest GitHub release" and "what we just tested on main" can diverge. | tags vs `git log` |

### Contract mismatch

| | PC2 today | Runtime |
| --- | --- | --- |
| Spawn | `node dist/index.js` | `elastos gateway --addr 127.0.0.1:8090` |
| Install root | `~/.pc2` git clone | `~/.local/bin/elastos` + `~/.local/share/elastos` |
| Health | `GET :4200/health` any 2xx, plus heartbeat file | `GET 127.0.0.1:8090/healthz` body `OK` |
| Open | `http://localhost:4200` | `http://127.0.0.1:8090/home/` |
| Update | `git reset --hard origin/main` | `elastos update` on channel `stable` / `canary` / `jetson-test` |
| Version | root `package.json` | `ELASTOS_VERSION` via `elastos version` or `/api/health` |
| Windows | WSL + system Node | No native binary. WSL2 is a future product, not this binary. |

## 4. Proposed design

### Pluggable target, PC2 stays the default

A `LaunchTarget` is the install/start/stop/update/health surface. Two ids: `pc2` and `runtime`. Selection order, once wired:

1. Explicit value (future UI, or a one-shot test).
2. `ELASTOS_LAUNCH_TARGET` in the environment (`pc2`, `pc2.net`, `runtime`, `elastos-runtime`; anything else is an error).
3. Persisted preference (the unused `electron-store` dependency is the right place).
4. Default `pc2`.

Empty and missing both mean PC2. The runtime id must be a positive choice so a typo cannot silently boot the wrong host.

This PR adds that registry under `src/main/targets/` and unit tests. `src/main/index.ts` is unchanged and still imports `pc2Manager`. The PC2 implementation is a delegate, so when a later PR points IPC at `createLaunchTarget('pc2')` the calls are the same functions. `createLaunchTarget('runtime')` returns a target whose lifecycle methods reject with a stable error. That is deliberate: a half-wired runtime that reported `not-installed` would invite the Power button to run the PC2 installer.

Descriptors (not executed) record the health URL, open URL, binary, and supported OS triples so the mismatch in section 3 cannot be re-hardcoded in a second file without a test failing.

### Install

Runtime install does not clone the runtime repo and does not run `cargo` on the user's machine.

1. If `~/.local/bin/elastos` runs and `elastos version` prints the pinned version, skip download.
2. Otherwise install the signed head pinned in that launcher release (version, CID, maintainer DID). Verify the signature. Do not use the unsigned `install.sh` checked into the runtime git tree.
3. If the pinned install fails, fall back to the stamped hosted `https://elastos.elacitylabs.com/install.sh --install-only`.
4. Run `elastos setup` for the home profile when `components.json` does not already have it.
5. Leave `~/.pc2` in place. Do not rename it and do not import it. The runtime home is empty.

PC2 install stays `installPC2()`. The networking gauntlet stays on that path only.

### Start, health, open, stop

Runtime start:

- Native `win32` is unsupported. Intel Mac (`darwin/x64`) is a supported probe target once the runtime publishes that build. Until the binary is on disk the probe reports not installed. Do not exec on an unsupported platform.
- If `host-process.lock` is held, surface the runtime's own "another ElastOS host already owns" error. Do not kill a server the user started in a terminal.
- Spawn `elastos gateway --addr 127.0.0.1:8090` in its own process group, stdout/stderr into the existing log ring.
- Poll `http://127.0.0.1:8090/healthz` until the body contains `OK` or 60s elapse (setup can be slower than PC2's 30s node boot).
- "Open My Cloud" opens `http://127.0.0.1:8090/home/`.
- Stop signals the process group (`SIGTERM`, then `SIGKILL`), then waits until `/healthz` fails. Do not `lsof -ti:4200`. Do not delete `~/.pc2` heartbeat files as a side effect.

PC2 start/stop stay byte-for-byte until the IPC wiring PR, and after that stay the PC2 target's methods.

### Update, rollback, coexistence

- PC2 target keeps today's GitHub check + git reset.
- Runtime target calls `elastos update --check` and `elastos update --yes` on channel `stable` (published from runtime `main`). `canary` is only for testing a runtime `develop` build. Rollback is `elastos update --rollback-to <cid>` once the previous head CID is stored next to the target preference. The launcher does not invent its own binary diff.
- Switching the preference from `runtime` back to `pc2` is the product rollback during the transition. It does not uninstall either tree.
- Uninstall is per target. The PC2 path guard stays. A runtime uninstall may remove only `~/.local/bin/elastos` and `~/.local/share/elastos`, and only after a confirm dialog that prints those paths.

### Data and identity

`~/.pc2` is a Puter/PC2 checkout (root package name `puter`) with its own wallet env and node data. The runtime data dir is a different identity and storage layout. Founder decision: no PC2 import. First runtime launch is a new home.

No phone-home telemetry. `electron-log` writes local logs. The log panel is the support tool.

LAN QR codes stay PC2-only. The runtime gateway in this plan binds loopback. `--public` starts a tunnel and is out of scope for the first runtime target.

### What this PR does not wire

`src/main/index.ts`, the preload, and the renderer are untouched. Unset `ELASTOS_LAUNCH_TARGET` cannot select the runtime, because nothing reads it. The new `.github/workflows/test.yml` runs `npm test` on pull requests (compile + `node --test`). The tag-based release workflow is unchanged.

## 5. Ticket plan

Each ticket is one PR. Done means the check is green, not that the code exists.

| # | Ticket | Done when |
| --- | --- | --- |
| 0 | This PR. Design doc + registry. Default id `pc2`. Runtime lifecycle calls reject. Main process does not import the registry. | `npm test` passes. `currentLaunchTargetId({}) === 'pc2'`. `createLaunchTarget('runtime').start()` rejects. `npm run build:ts` passes. A grep of `src/main/index.ts` shows no `targets` import. |
| 1 | Merge launcher `v1.4.0` back to `main` (ffmpeg, cmake, single password prompt, stapled notarization) before any install edits. | `git merge-base --is-ancestor v1.4.0 main` succeeds. Existing tag build workflow still packages macOS, Windows, and Linux. |
| 2 | Persist `launchTarget` with `electron-store`. Precedence: explicit, then `ELASTOS_LAUNCH_TARGET`, then store, then `pc2`. Still no renderer control and still no runtime spawn. | Unit test covers all four layers. Deleting the store key returns `pc2`. App cold start with no env still calls `pc2Manager` only. |
| 3 | Point IPC, preload, and tray at `createLaunchTarget` for the PC2 id only. Runtime id still rejects if forced. | Existing PC2 behavior: status, start, stop, install, update, logs. A test (or a main-process harness) asserts the PC2 target methods are the `pc2Manager` functions. Forcing `runtime` shows the stable error in the log panel and does not clone pc2.net. |
| 4 | Runtime probe only: `~/.local/bin/elastos version` and platform check. No gateway spawn. | On a fixture `PATH`, version parses from a shell-script `elastos`. Native `win32` returns unsupported and does not exec. `darwin/x64` is probed the same way as arm64 (founder is adding that runtime build). |
| 5 | Runtime repo: one-page launcher contract (command, addr, `/healthz` body, `/home/`, data dir, lock path, exit codes) checked into `elastos-runtime`. Confirm `elastos gateway --addr 127.0.0.1:8090` is the supported supervised Home entry, or add `elastos home --browser --no-open` and point the descriptor at it. | A runtime test already covers `/healthz` == `OK` (`gateway_tests`). The new doc links that test and the CLI flags. Descriptor `startArgs` in this repo updated in the same change if the flag lands. |
| 6 | Install runtime via the stamped installer `--install-only`, then `elastos setup` for the home profile. Do not `git clone` the runtime. Do not touch `~/.pc2`. | A scripted smoke on Linux x64 and macOS arm64, using a pinned signed head: binary exists, `elastos version` matches the pin, `components.json` exists, `~/.pc2` mtime is unchanged. Unsigned git `install.sh` must fail the test. |
| 7 | Spawn and health. Process group, poll `/healthz` for `OK`, open `/home/`, stream logs, stop the group, surface a held `host-process.lock` without killing it. | Smoke: start, `curl -fsS http://127.0.0.1:8090/healthz` prints `OK`, `curl -o /dev/null -w '%{http_code}' http://127.0.0.1:8090/home/` is `200`, stop, port refuses connections, no leftover `elastos` child. CI job is `workflow_dispatch` plus a release-branch cron, downloading the pinned runtime tarball or installer, not a full Rust build inside the launcher workflow. |
| 8 | Runtime update button: `elastos update --check` / `elastos update --yes`. Remember the previous head CID. Add rollback control calling `elastos update --rollback-to`. | Test doubles for the CLI: check parses, apply invokes `--yes`, rollback invokes the stored CID. A live smoke upgrades a fixture one pinned head and rolls it back; `/healthz` is `OK` after both. |
| 9 | Renderer target control, default still PC2. Copy and the confirm dialog must name the target and the directory. Hide runtime on Intel Mac and native Windows with the unsupported-platform reason. | UI test or a manual pass: cold launch shows PC2 and `localhost:4200`. Choosing runtime does not move `~/.pc2`. Choosing PC2 again starts PC2. Windows/Intel never enable the runtime option. |
| 10 | Flip the default to `runtime` once the macOS arm64 and Linux x64 smoke is green. PC2 remains selectable and is deprecated about one month after that launch. | Release checklist: new user with an empty home gets `/healthz` `OK` and `/home/` `200` from the DMG/deb. Existing `~/.pc2` is not migrated and can still be selected. Tag build signs and notarizes as today. |
| 11 | Windows: dedicated WSL2 distro for the runtime, not a native `elastos.exe`, and not the PC2 WSL path that runs `node dist/index.js`. | A Windows smoke starts that distro, probes the contracted URL, and stops it. Until that exists, Windows stays on PC2. |

Tickets 5 and the runtime half of 6 belong in `elastos-runtime`. The rest belong here. Ticket 7 is the smoke the launch depends on: the launcher starts the runtime and gets a healthy response.

## 6. Risks

- **Two health protocols.** Porting `waitForServer()` unchanged makes a healthy runtime look dead. Ticket 7 uses the descriptor probe, not `PC2_URL`.
- **Signed install vs GitHub zip.** Treating `elastos-runtime-*.tar.gz` as "the install" skips maintainer DID verification and skips `elastos setup`. Ticket 6 pins the publisher path.
- **`v1.4.0` not on `main`.** Install work based on `main` drops ffmpeg, cmake, the single password prompt, and notarization stapling.
- **Host lock and orphans.** `lsof` on one port will not reap provider children. Stop uses the process group. A lock held by a terminal session is an error, not a kill.
- **Quarantine and notarization.** A notarized Electron parent spawning `~/.local/bin/elastos` still depends on that binary's own signature and the quarantine xattr `curl` may set. Ticket 7's macOS smoke is the check. The launcher entitlements file does not sign the child.
- **Secret in coords JSON.** Logging `gateway-runtime-coords.json` would leak `attach_secret`. The log panel stays on stdout/stderr.
- **Data mix-up.** Uninstall and backup paths that key off `.pc2` must not grow a clause that deletes `~/.local/share/elastos` in the same function.
- **Port 61180 vs 8090.** Implementing the Windows doc's URL on the Mac product, or the reverse, fails the health check. One contract (ticket 5) picks the address.
- **Version compare.** `compareVersions` keeps three numeric fields. Runtime versions like `0.7.1-dev` need the runtime's own `update --check`, not that helper.
- **Single-instance home.** QA that starts `elastos serve` and the launcher together will fail the lock on purpose.

## 7. Open questions

Answered on 2026-10-16: update channel, install pin plus hosted fallback, no PC2 import, one-month PC2 deprecation after launch, runtime default after a green smoke, dedicated WSL2 distro, darwin-x64 runtime build, no telemetry. See the decisions table at the top.

Still open:

1. Confirm the first desktop URL is `http://127.0.0.1:8090/home/` (this plan) rather than the source-home staging URL `http://localhost:61180/apps/home/`.
2. Is remote access (WireGuard, AmneziaWG, sing-box, `.ela.city`) in the first runtime launcher, or does Home stay on loopback until the runtime's own tunnel is the path?
3. Who publishes the first `stable` head? The public publisher was serving `canary` `0.8.0-alpha.20` on 2026-10-16, so a stable pin cannot be filled until that head exists.

## Appendix — evidence index

Launcher (`main` @ `2efa553` unless noted):

- `src/main/pc2Manager.ts` — URL, Node 22.13.1, dirs, install, networking, start, `/health`, stop, update, uninstall
- `src/main/pc2Heartbeat.ts` — `pc2.heartbeat.v1`, 5s stale window
- `src/main/index.ts` — IPC and tray
- `src/preload/index.ts`, `src/renderer/app.js`, `src/renderer/index.html`
- `package.json` — electron-builder targets, `notarize: false`, `electron-store` unused
- `scripts/notarize.js`, `resources/entitlements.mac.plist`, `.github/workflows/build.yml`
- Tag `v1.4.0` — six commits listed in section 1

Runtime (`Elacity/elastos-runtime`, tag `v0.7.1` plus later `main`):

- `elastos/crates/elastos-server/Cargo.toml` — bin name `elastos`
- `elastos/crates/elastos-server/src/main.rs` — `serve` `0.0.0.0:3000`, `gateway` `127.0.0.1:8090`, `home --browser`, `update --check`, `update --rollback-to`, `open_browser`
- `elastos/crates/elastos-server/src/gateway_entry.rs` — `run_browser_home` binds `localhost:8090` and opens a browser
- `elastos/crates/elastos-server/src/api/gateway.rs` — `/healthz`, `/home/`, `/apps/home/`
- `elastos/crates/elastos-server/src/api/gateway_site.rs` — `healthz` returns `OK`
- `elastos/crates/elastos-server/src/api/routes.rs` and `api/server.rs` — `/api/health` JSON
- `elastos/crates/elastos-server/src/sources.rs` — data dir, install path, channels
- `elastos/crates/elastos-server/src/host_lock.rs`, `runtime_control.rs`
- `scripts/install.sh`, `scripts/package-release-binaries.sh`, `docs/INSTALL.md`, `docs/WINDOWS.md`
- `.github/workflows/ci.yml`, `.github/workflows/release-package.yml`
- GitHub release `v0.7.1` assets: `elastos-runtime-darwin-arm64.tar.gz`, `elastos-runtime-linux-amd64.tar.gz`, `elastos-runtime-linux-arm64.tar.gz`, each with `.sha256`
