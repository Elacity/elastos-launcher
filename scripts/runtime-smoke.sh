#!/usr/bin/env bash
# Install a pinned ElastOS runtime, start `elastos gateway` on 127.0.0.1:8090,
# require /healthz to be OK and /home/ to return 200, then stop the process group.
#
# The product pin (resources/runtime-pin.json) is channel stable and is empty
# until a stable head is published. This script uses the testing pin
# (resources/runtime-smoke-pin.json, canary). If that pin does not match the
# publisher, it falls back to the stamped hosted install.sh --install-only.
#
# Uses an isolated HOME so it does not touch the runner's real data dir.
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
pin_file="${ELASTOS_SMOKE_PIN:-${root}/resources/runtime-smoke-pin.json}"
# The runtime installer rejects a data directory whose parents are group- or
# world-writable (/tmp is). Keep the isolated home under the real user home.
real_home="${HOME}"
smoke_base="${ELASTOS_SMOKE_BASE:-${real_home}/.elastos-smoke}"
mkdir -p "${smoke_base}"
chmod 700 "${smoke_base}"
work="$(mktemp -d "${smoke_base}/run.XXXXXX")"
export HOME="${work}/home"
export XDG_DATA_HOME="${HOME}/.local/share"
mkdir -p "${HOME}"
export PATH="${HOME}/.local/bin:${PATH}"

gw_pid=""
gw_log="${work}/gateway.log"

cleanup() {
  local status=$?
  if [[ -n "${gw_pid}" ]]; then
    echo "Stopping gateway pid ${gw_pid}"
    kill -TERM -"${gw_pid}" 2>/dev/null || kill -TERM "${gw_pid}" 2>/dev/null || true
    local i
    for i in 1 2 3 4 5 6 7 8 9 10; do
      if ! kill -0 "${gw_pid}" 2>/dev/null; then
        break
      fi
      sleep 1
    done
    if kill -0 "${gw_pid}" 2>/dev/null; then
      echo "Gateway still alive; sending SIGKILL to the process group"
      kill -KILL -"${gw_pid}" 2>/dev/null || kill -KILL "${gw_pid}" 2>/dev/null || true
    fi
    wait "${gw_pid}" 2>/dev/null || true
    gw_pid=""
  fi
  if [[ "${status}" -ne 0 && -f "${gw_log}" ]]; then
    echo "----- gateway log -----"
    tail -n 80 "${gw_log}" || true
  fi
  exit "${status}"
}
trap cleanup EXIT

python3 - "${pin_file}" "${work}/pin.match" <<'PY'
import json, sys, urllib.request
pin = json.load(open(sys.argv[1]))
url = pin["publisherGateway"].rstrip("/") + "/release-head.json"
with urllib.request.urlopen(url, timeout=30) as response:
    head = json.loads(response.read().decode())
payload = head["payload"]
print(f"publisher channel={payload.get('channel')} version={payload.get('version')} cid={payload.get('latest_release_cid')}")
print(f"pin       channel={pin.get('channel')} version={pin.get('version')} cid={pin.get('headCid')}")
matched = (
    payload.get("channel") == pin.get("channel")
    and payload.get("version") == pin.get("version")
    and payload.get("latest_release_cid") == pin.get("headCid")
    and head.get("signer_did") == pin.get("maintainerDid")
)
open(sys.argv[2], "w").write("yes\n" if matched else "no\n")
PY

matched="$(cat "${work}/pin.match")"
installer="${work}/install.sh"
fallback="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["fallbackInstallerUrl"])' "${pin_file}")"

if [[ "${matched}" == "yes" ]]; then
  echo "Pinned release matches the publisher. Installing that head."
else
  echo "Pinned release does not match the publisher. Falling back to hosted install.sh --install-only."
fi

curl -fsSL --max-time 60 "${fallback}" -o "${installer}"
# --install-only avoids opening a browser. Setup is a separate step so the
# smoke owns the gateway process.
bash "${installer}" --install-only

runtime_bin="${HOME}/.local/bin/elastos"
if [[ ! -x "${runtime_bin}" ]]; then
  echo "Installer did not produce ${runtime_bin}" >&2
  exit 1
fi

installed_version="$("${runtime_bin}" version)"
echo "Installed version: ${installed_version}"
if [[ "${matched}" == "yes" ]]; then
  want="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["version"])' "${pin_file}")"
  if [[ "${installed_version}" != *"${want}"* ]]; then
    echo "Installed version does not contain pinned ${want}: ${installed_version}" >&2
    exit 1
  fi
fi

echo "Running elastos setup"
"${runtime_bin}" setup </dev/null

echo "Starting elastos gateway --addr 127.0.0.1:8090"
"${runtime_bin}" gateway --addr 127.0.0.1:8090 >"${gw_log}" 2>&1 &
gw_pid=$!

healthy=0
for _ in $(seq 1 90); do
  if ! kill -0 "${gw_pid}" 2>/dev/null; then
    echo "Gateway exited before /healthz" >&2
    exit 1
  fi
  body="$(curl -fsS --max-time 2 http://127.0.0.1:8090/healthz 2>/dev/null || true)"
  if [[ "${body}" == "OK" ]]; then
    healthy=1
    break
  fi
  sleep 1
done
if [[ "${healthy}" -ne 1 ]]; then
  echo "Timed out waiting for /healthz" >&2
  exit 1
fi
echo "/healthz is OK"

home_code="$(curl -sS -o "${work}/home.body" -w '%{http_code}' --max-time 15 http://127.0.0.1:8090/home/ || true)"
echo "/home/ HTTP ${home_code}"
if [[ "${home_code}" != "200" ]]; then
  echo "Expected /home/ to return 200" >&2
  exit 1
fi

echo "Stopping gateway and checking the port closes"
kill -TERM -"${gw_pid}" 2>/dev/null || kill -TERM "${gw_pid}" 2>/dev/null || true
for _ in $(seq 1 15); do
  if ! kill -0 "${gw_pid}" 2>/dev/null; then
    break
  fi
  sleep 1
done
if kill -0 "${gw_pid}" 2>/dev/null; then
  kill -KILL -"${gw_pid}" 2>/dev/null || kill -KILL "${gw_pid}" 2>/dev/null || true
fi
wait "${gw_pid}" 2>/dev/null || true
stopped_pid="${gw_pid}"
gw_pid=""

if curl -fsS --max-time 2 http://127.0.0.1:8090/healthz >/dev/null 2>&1; then
  echo "Gateway still answering /healthz after stop (pid ${stopped_pid})" >&2
  exit 1
fi
echo "Gateway stopped cleanly"
