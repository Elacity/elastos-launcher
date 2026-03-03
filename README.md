# ElastOS Desktop Launcher

A one-click desktop app to run your Personal Cloud Computer (PC2).

## Download

**[Download Latest Release](https://github.com/Elacity/elastos-launcher/releases/latest)**

| Platform | Download |
|----------|----------|
| **macOS** (Apple Silicon M1/M2/M3) | [ElastOS-x.x.x-arm64.dmg](https://github.com/Elacity/elastos-launcher/releases/latest) |
| **macOS** (Intel) | Works via Rosetta 2 |
| **Linux** (Ubuntu/Debian) | [elastos-launcher_x.x.x_amd64.deb](https://github.com/Elacity/elastos-launcher/releases/latest) |
| **Linux** (Other) | [ElastOS-x.x.x.AppImage](https://github.com/Elacity/elastos-launcher/releases/latest) |
| **Windows** | Not recommended - [Use VPS instead](https://docs.ela.city) |

## macOS Installation

macOS shows a security warning for apps downloaded outside the App Store. Use this one-time Terminal command:

**Step 1: Remove any old versions**
```bash
sudo rm -rf /Applications/ElastOS.app
rm -rf ~/.elastos ~/.pc2
```

**Step 2: Download the .dmg, double-click to mount, then run:**
```bash
# Replace VERSION with the version you downloaded (run: ls /Volumes/ to check)
cp -R "/Volumes/ElastOS VERSION-arm64/ElastOS.app" /Applications/ && xattr -cr /Applications/ElastOS.app && open /Applications/ElastOS.app
```

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

If you prefer using the terminal (or on a VPS):

```bash
curl -fsSL https://raw.githubusercontent.com/Elacity/pc2.net/main/scripts/start-local.sh | bash
```

This installs Node.js, pm2, and PC2, then starts it with process management for 24/7 operation.

## Support

- **Documentation:** https://docs.ela.city
- **GitHub:** https://github.com/Elacity/pc2.net
- **Email:** sash@ela.city

## About

The ElastOS Personal Cloud is your sovereign computing environment - your data, your AI, your rules.

Built by [Elacity Labs](https://ela.city)
