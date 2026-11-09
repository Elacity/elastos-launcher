# ElastOS Desktop App

ElastOS lives in the menu bar or system tray. Opening the app opens Home in your default browser.

## What it does

On first run, choose whether Home starts at login, then click Install. The app checks the signed release and installs Home. The ready window stays open until you click Open Home.

Use the menu bar (macOS), system tray (Windows), or top-bar indicator (Ubuntu) to open, start, stop and update Home. Troubleshoot contains diagnostics, logs and confirmed maintenance actions. Uninstall keeps Home data unless you choose to delete it. Quit ElastOS stops Home.

Home uses `http://localhost:8090/home/`. Passkeys require `localhost` rather than `127.0.0.1`. The signed 2.0.0 Home controller opens a browser on cold starts; quiet login and install await a Runtime option to suppress that open.

## Platforms

- Linux x64 and macOS Apple silicon install the pinned runtime directly.
- Intel Macs show “Intel Mac is not supported yet.” until a signed release exists.
- Windows installs the Linux runtime inside a dedicated WSL2 distro named `ElastOS` and opens Home in the Windows browser.

## Signing

macOS builds use hardened runtime, `resources/entitlements.mac.plist`, and `scripts/notarize.js` (`afterAllArtifactBuild`). Tag builds sign and notarize with the existing Apple secrets. This tree does not notarize a build by itself.

## Development

```bash
npm test
```

`npm test` compiles TypeScript and runs `node --test test/*.test.js`.
