#!/usr/bin/env bash
# Runs inside ubuntu:24.04. The image starts without curl, python3, or gcc.
set -euo pipefail

absent() {
  if command -v "$1" >/dev/null 2>&1; then
    echo "clean image has $1"
    exit 1
  fi
}

absent curl
absent python3
absent gcc
command -v bash >/dev/null
command -v sha256sum >/dev/null

package_absent() {
  if dpkg -s "$1" >/dev/null 2>&1; then
    echo "clean image has $1"
    exit 1
  fi
}

package_absent ca-certificates
package_absent openssl

export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install -y --no-install-recommends libstdc++6 util-linux
absent curl
absent python3
absent gcc
package_absent ca-certificates
package_absent openssl
echo "clean image: curl, python3, gcc, openssl, and ca-certificates are absent"

if ! id elastos >/dev/null 2>&1; then
  useradd --create-home --shell /bin/bash elastos
fi
chmod 755 /home
chmod 700 /home/elastos
chown elastos:elastos /home/elastos

# Node's bundled Mozilla roots. The image does not install ca-certificates or openssl.
export NODE_OPTIONS="--use-bundled-ca${NODE_OPTIONS:+ ${NODE_OPTIONS}}"
runuser -u elastos -- env HOME=/home/elastos ELASTOS_HIDE_HOST_TOOLS=1 NODE_OPTIONS="${NODE_OPTIONS}" \
  "${HOST_NODE}" /src/scripts/clean-machine-install.js
