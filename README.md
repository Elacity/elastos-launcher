# ElastOS Desktop Launcher

A one-click desktop app that installs the ElastOS runtime and opens Home in the browser.

## What it does

Click Install. The launcher checks the signed release pin, runs the pinned installer, starts `elastos gateway` on `localhost:8090`, and opens `http://localhost:8090/home/`. Passkeys need the `localhost` name: browsers refuse them on `127.0.0.1`.

The window talks to the main process through `window.elastos` and `elastos:*` IPC. There is one launch target, the runtime.

## Platforms

- Linux x64 and macOS Apple silicon install the pinned runtime directly.
- Intel Macs show “not yet supported on Intel Macs” until a signed release exists.
- Windows installs the Linux runtime inside a dedicated WSL2 distro named `ElastOS` and opens Home in the Windows browser.

## Signing

macOS builds use hardened runtime, `resources/entitlements.mac.plist`, and `scripts/notarize.js` (`afterAllArtifactBuild`). Tag builds sign and notarize with the existing Apple secrets. This tree does not notarize a build by itself.

## Development

```bash
npm test
```

`npm test` compiles TypeScript and runs `node --test test/*.test.js`.
