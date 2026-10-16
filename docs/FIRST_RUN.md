# First run

A person downloads ElastOS and clicks Install. They do not open a terminal. This is what the computer asks for, and what is still missing.

The pinned `install.sh` is not changed. It still requires `bash`, `curl`, a `python3` that can run `python3 -c ''`, and `sha256sum` or `shasum`. The app puts those on the installer's `PATH` before it runs the script.

## What the installer needs

| Need | macOS | Linux | Windows |
|---|---|---|---|
| curl | The app supplies one. macOS also has its own. | The app supplies one. A minimal Ubuntu image does not. | Inside the ElastOS Linux environment, the app installs it. |
| python3 | The app downloads a pinned CPython when `python3 -c ''` fails, including the Command Line Tools stub. It does not run `xcode-select`. | The app downloads the same pinned CPython when `python3` is missing or does not run. | The app installs `python3` inside the Linux environment. |
| sha256sum or shasum | The app supplies `sha256sum`. | The app supplies `sha256sum`. Ubuntu also has it. | The Ubuntu environment has it. |
| bash | `/bin/bash` is part of macOS. | `/bin/bash` or `/usr/bin/bash`. Alpine does not have it. Install stops with a plain sentence. | The Ubuntu environment has it. |
| tar | Not used. Python is unpacked by the app. | Not used. | The rootfs import uses `wsl --import`, which Windows provides. |
| Xcode Command Line Tools | Not used. | — | — |
| glibc | — | Required. A musl system such as Alpine is refused before download. | The Ubuntu 24.04 environment is glibc. |
| systemd | Not used. The app starts and stops the gateway. | Not used. | Not used. |
| /dev/kvm | — | Not required to install or to open the computer in the system browser. The in-computer browser warns when it is missing. | Same warning inside WSL when `/dev/kvm` is missing. Install still finishes. |
| WSL | — | — | One Enable button. Windows shows one permission prompt and may ask for a restart. |
| Admin | No password for Install. Opening a downloaded app can show the system Gatekeeper dialog. | No password for Install. | One permission prompt to turn on Linux support, and Windows may ask for a restart. |
| Reboot | None for Install. | None for Install. | Possible, only when Linux support was off. |
| Disk | About 2 GB free. | About 2 GB free. | About 2 GB free. |

Intel Macs stop with “not yet supported on Intel Macs”. Nothing is downloaded.

## macOS

1. Download the app and open it. macOS may ask whether to open an app that was downloaded from the internet. That dialog is from macOS.
2. Click Install.
3. The app checks the signed release, downloads the pinned installer, and downloads a pinned Python only when the Mac cannot already run `python3 -c ''`.
4. The button becomes Open my computer. The page is `http://127.0.0.1:8090/home/` in the system browser.
5. There is no Terminal window, no `xcode-select --install` prompt, and no administrator password for Install.

The macOS test hides Command Line Tools, curl, and python3 from the installer and clicks Install on a `macos-14` runner. It is not a freshly imaged Mac.

## Linux

1. Open the app and click Install.
2. On glibc Linux with bash, that is the only step. The app supplies curl and, when needed, Python. No administrator password.
3. The button becomes Open my computer.
4. `/dev/kvm` is optional. Without it, Install still finishes and the system browser opens. The separate in-computer browser stays off. That later piece can ask for a password; it is not part of this click.

A musl system, or a system without bash, stops with one sentence. Install does not continue.

The Linux test is an `ubuntu:24.04` container with curl, python3, and gcc absent. The harness mounts Node, because the packaged app embeds it, and installs `libstdc++6` so that Node can start. It does not install curl, python3, or a compiler.

## Windows

1. If Linux support is off, the screen says Windows needs Linux support. The person clicks Enable. They do not type a command.
2. Windows asks for permission once. If Windows says a restart is required, ElastOS says: Restart Windows, then open ElastOS and click Install.
3. After the restart, they click Install. The app adds its own Linux environment, installs python3 and curl there if they are missing, and installs the runtime.
4. The button becomes Open my computer. The page opens in the Windows browser at `http://127.0.0.1:8090/home/`.

The ElastOS Linux environment is not removed by Remove PC2.

## Gaps

- The macOS click test hides developer tools on a GitHub `macos-14` runner. It does not boot a blank Mac.
- The Windows runner cannot turn Linux support off and reboot in the same job, so it cannot click from “WSL disabled” through to Open my computer. The Enable command and the restart sentence are tested. A runner that already has Linux support can install and open Home.
- A musl system is refused. ElastOS does not ship a musl runtime.
- A Linux system without bash is refused. The app does not bundle bash.
- The in-computer browser on Linux can still ask for a password later. Install and Open my computer do not.
- Gatekeeper on macOS can still ask the person to confirm the downloaded app. The app cannot remove that system dialog.
- This environment has not notarized a build. Notarization stays on the existing tag-build path.
