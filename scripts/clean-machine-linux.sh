#!/usr/bin/env bash
# Prove Install on a minimal Ubuntu image that does not have curl, python3, or a compiler.
# Node is mounted from the runner because the packaged app embeds it. libstdc++6 is
# installed only so that Node can start. curl, python3, gcc, openssl, and
# ca-certificates must still be absent. Node uses its bundled CA roots.
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
node_bin="$(readlink -f "$(command -v node)")"
node_dir="$(cd "$(dirname "${node_bin}")" && pwd)"

docker run --rm \
  -v "${root}:/src:ro" \
  -v "${node_dir}:/opt/nodebin:ro" \
  -e "HOST_NODE=/opt/nodebin/$(basename "${node_bin}")" \
  ubuntu:24.04 \
  bash /src/scripts/clean-machine-inside.sh
