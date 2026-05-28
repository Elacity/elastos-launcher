# Contributing to ElastOS Desktop Launcher

## Install Parity Rule (CRITICAL)

The launcher's install flow **must always match** what the terminal install scripts provide. This is the single most important rule for this codebase.

### Why

Users who install via the launcher must get the exact same result as users who run the terminal scripts. If a terminal user gets WireGuard + AmneziaWG + sing-box + stealth mode, a launcher user must too. No exceptions.

### How It Works

There are three install paths for PC2:

| Path | Script | Platform |
|------|--------|----------|
| Terminal (Mac/Linux/VPS) | `pc2.net/scripts/start-local.sh` | Mac, Linux, VPS |
| Terminal (ARM) | `pc2.net/scripts/install-arm.sh` | Jetson, Raspberry Pi |
| Desktop Launcher | `elastos-launcher/src/main/pc2Manager.ts` → `installPC2()` + `setupNetworking()` | Mac, Linux |

### The Rule

**When you add a new tool or dependency to `start-local.sh` or `install-arm.sh`, you must also add the corresponding install step to `setupNetworking()` in `src/main/pc2Manager.ts`.**

### Checklist for New Tools

Before merging any change to the install scripts, verify:

- [ ] Tool is installed in `start-local.sh`
- [ ] Tool is installed in `install-arm.sh` (if ARM-relevant)
- [ ] Tool is installed in `pc2Manager.ts` → `setupNetworking()`
- [ ] Sudoers/permissions config is replicated in all three
- [ ] macOS uses `osascript` for GUI password prompt (not raw `sudo`)
- [ ] Linux uses `pkexec` fallback for GUI password prompt
- [ ] Install is non-fatal (PC2 still works if the tool fails to install)
- [ ] README.md "What Gets Installed" section is updated

### Current Tools Installed by All Paths

| Tool | Purpose | Installed By |
|------|---------|-------------|
| Xcode Command Line Tools | macOS git + make for source builds | Launcher (auto-triggers Apple system dialog); terminal scripts assume present |
| Homebrew | macOS package manager (required prereq) | Launcher (auto-installs via single password prompt); terminal scripts auto-install |
| Node.js 20+ | Runtime | All |
| PM2 | Process manager | Terminal scripts only (launcher manages process directly) |
| WireGuard | Fast encrypted tunnel | All |
| AmneziaWG | DPI-resistant stealth | All |
| sing-box 1.13.0 | VLESS Reality TCP stealth | All |
| awg-quick (patched) | AmneziaWG interface manager | All |
| FFmpeg | Media transcoder for video minting | All |
| cmake | Native build fallback for node-datachannel | All |
| Sudoers configs | Passwordless wg-quick/awg-quick | All (launcher uses consolidated `/etc/sudoers.d/elastos`) |
| Particle auth .env | Wallet integration | All |
| Go compiler | Build AmneziaWG (if not present) | All |

### macOS First-Run UX (v1.2.9+)

Fresh-Mac users on macOS experience exactly **one Apple system dialog + one password prompt** the first time they install PC2 via the launcher:

1. **Xcode Command Line Tools dialog** (Apple's native dialog, no password, ~5 min wait for CLT download/install) — only fires if CLT is not already present.
2. **Single GUI password prompt** for `elevatedSetup()` which installs Homebrew (if missing), pre-chowns the brew prefix + `/usr/local/bin` to the user, and writes the consolidated `/etc/sudoers.d/elastos` file granting NOPASSWD for `wg-quick`/`awg-quick` at all possible brew paths.

After these two interactions, every subsequent `brew install X`, `git clone`, `make`, `cp`, and runtime `wg-quick up` / `awg-quick up` runs without any further user interaction. Returning users (Homebrew already installed, sudoers already configured) see zero prompts.
| FFmpeg | Video transcode at mint time (dashPackager) | All |
| cmake | Fallback build dep for node-datachannel | All |

### Architecture Notes

- `installPC2()` handles: git clone, npm install, npm build, native module rebuild
- `setupNetworking()` handles: WireGuard, AmneziaWG, sing-box, sudoers, patches, Particle auth
- `sudoExec()` handles platform-specific privilege escalation (osascript on Mac, pkexec on Linux)
- All networking installs are wrapped in try/catch — failures log warnings but don't block the install
