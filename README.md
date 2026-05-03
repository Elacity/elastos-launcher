# ElastOS Desktop Launcher

A one-click desktop app to run your Personal Cloud Computer (PC2).

## Download

**[Download Latest Release](https://github.com/Elacity/elastos-launcher/releases/tag/v1.2.6)**

| Platform | Download | Status |
|----------|----------|--------|
| **macOS** (Apple Silicon M1/M2/M3/M4) | [ElastOS-1.2.6-arm64.dmg](https://github.com/Elacity/elastos-launcher/releases/download/v1.2.6/ElastOS-1.2.6-arm64.dmg) | Apple Notarized |
| **macOS** (Intel) | Works via Rosetta 2 | Apple Notarized |
| **Linux** (Ubuntu/Debian) | [elastos-launcher_1.2.6_amd64.deb](https://github.com/Elacity/elastos-launcher/releases/download/v1.2.6/elastos-launcher_1.2.6_amd64.deb) | Available |
| **Linux** (Other) | [ElastOS-1.2.6.AppImage](https://github.com/Elacity/elastos-launcher/releases/download/v1.2.6/ElastOS-1.2.6.AppImage) | Available |
| **Windows** | [ElastOS.Setup.1.2.6.exe](https://github.com/Elacity/elastos-launcher/releases/download/v1.2.6/ElastOS.Setup.1.2.6.exe) | Available |

## macOS Installation

**Download the `.dmg`, double-click to mount, drag ElastOS to Applications, and launch.** That's it -- no Terminal, no workarounds.

The app is signed with an Apple Developer ID certificate and notarized by Apple. macOS Gatekeeper will verify the signature automatically.

> **Upgrading from v1.1.x or earlier?** You may need to remove the old unsigned app first: `sudo rm -rf /Applications/ElastOS.app`

## Linux Installation

**Ubuntu/Debian:**
```bash
sudo dpkg -i elastos-launcher_*_amd64.deb
```

**AppImage (any distro):**
```bash
chmod +x ElastOS-*.AppImage
./ElastOS-*.AppImage
```

## Features

- **One-Click Start/Stop** - No terminal needed
- **Full Install** - Downloads PC2, Node.js, WireGuard, AmneziaWG, sing-box — everything the terminal scripts install
- **Version Display** - Shows your installed PC2 version
- **One-Click Updates** - Checks GitHub for new releases; click "Update" to pull, build, and restart
- **Status Monitoring** - See if PC2 is running
- **Log Viewer** - Built-in server logs
- **Environment Switcher** - Switch between `~/.pc2` and `~/pc2.net` installs

## How It Works

1. Click "Power On" to start PC2 (installs automatically on first run)
2. Click "Open Cloud" to access your Personal Cloud at `http://localhost:4200`
3. Connect your wallet to claim ownership

## What Gets Installed

The launcher automatically handles everything — identical to what the terminal install scripts (`start-local.sh` / `install-arm.sh`) provide:

- **Node.js 20 LTS** - Bundled, independent of your system Node.js
- **PC2** - Cloned and built from GitHub
- **WireGuard** - Fast encrypted tunnel for remote access via `.ela.city` domains
- **AmneziaWG** - DPI-resistant stealth transport (built from source)
- **sing-box 1.13.0** - VLESS Reality TCP stealth transport
- **Sudoers configs** - Passwordless `wg-quick` and `awg-quick` for background operation
- **Particle auth** - Wallet integration config

On macOS, a native password dialog appears during first install for the networking tools that require admin access.

You just need:
- Git (usually pre-installed on Mac/Linux)
- Internet connection (for first-time setup)

## Install Parity Rule

**The launcher must always install the exact same set of tools as the terminal scripts.** If a new tool or dependency is added to `start-local.sh` or `install-arm.sh`, the corresponding install step must be added to `setupNetworking()` in `src/main/pc2Manager.ts`. See [CONTRIBUTING.md](CONTRIBUTING.md) for details.

## Windows Users

Local Windows installation is complex and not recommended. Instead:

**Recommended: Use a VPS** - For $5-6/month you get a cloud server that runs 24/7 and works from any device.

```bash
# On your VPS (Ubuntu), run:
curl -fsSL https://raw.githubusercontent.com/Elacity/pc2.net/main/scripts/start-local.sh | bash
```

See our [VPS setup guide](https://docs.ela.city) for details.

## Alternative: Terminal Install

If you prefer using the terminal (Mac/Linux/Jetson):

```bash
# Mac (interactive — handles password prompts properly):
bash -c "$(curl -fsSL https://raw.githubusercontent.com/Elacity/pc2.net/main/scripts/start-local.sh)"

# Linux / Jetson (curl|bash works fine):
curl -fsSL https://raw.githubusercontent.com/Elacity/pc2.net/main/scripts/start-local.sh | bash
```

This installs Node.js, pm2, and PC2, then starts it with process management for 24/7 operation.

## Recovery / forced upgrade

If a node is stuck on an old version (v1.0/v1.1/v1.2.0) or the in-app updater fails, run this in a terminal on the node:

```bash
curl -fsSL https://raw.githubusercontent.com/Elacity/pc2.net/main/scripts/update.sh | bash
```

This is idempotent, fail-loud, and self-checking — it stops PC2 cleanly, pulls the latest code, rebuilds native modules against your current Node ABI, and restarts pm2 with a health check.

## Support

- **Documentation:** https://docs.ela.city
- **GitHub:** https://github.com/Elacity/pc2.net
- **Email:** sash@ela.city

## About

The ElastOS Personal Cloud is your sovereign computing environment - your data, your AI, your rules.

Built by [Elacity Labs](https://ela.city)
