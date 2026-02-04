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

```bash
# Download the .dmg first, then run:
cp -R "/Volumes/ElastOS 0.1.2-arm64/ElastOS.app" /Applications/ && xattr -cr /Applications/ElastOS.app && open /Applications/ElastOS.app
```

**If you get "Permission denied" errors** (upgrading from older version):
```bash
sudo rm -rf /Applications/ElastOS.app
```
Then run the install command above.

## Linux Installation

**Ubuntu/Debian:**
```bash
sudo dpkg -i elastos-launcher_0.1.2_amd64.deb
```

**AppImage (any distro):**
```bash
chmod +x ElastOS-0.1.2.AppImage
./ElastOS-0.1.2.AppImage
```

## Features

- **One-Click Start/Stop** - No terminal needed
- **Status Monitoring** - See if PC2 is running
- **Log Viewer** - Built-in server logs
- **Auto-Install** - Downloads and sets up PC2 automatically
- **No Dependencies** - Everything managed by the app (no pm2/node required pre-installed)

## How It Works

1. Click "Power On" to start PC2
2. Click "Open Cloud" to access your Personal Cloud at `http://localhost:4200`
3. Connect your wallet to claim ownership

## Requirements

The launcher will automatically install:
- Node.js (via nvm if not present)
- PC2 (cloned from GitHub)

You just need:
- Git (usually pre-installed on Mac/Linux)
- Internet connection (for first-time setup)

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
