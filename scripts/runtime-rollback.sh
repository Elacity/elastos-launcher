#!/usr/bin/env bash
# Install the pinned runtime (0.8.0-alpha.22), roll back to the publisher's
# previous signed head (0.8.0-alpha.21), require /healthz OK, then update
# forward again and require /healthz OK. This runs the real elastos binary.
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
real_home="${HOME}"
smoke_base="${ELASTOS_SMOKE_BASE:-${real_home}/.elastos-smoke}"
mkdir -p "${smoke_base}"
chmod 700 "${smoke_base}"
work="$(mktemp -d "${smoke_base}/rollback.XXXXXX")"
retain="${work}/home.path"

echo "Installing the pinned release before rollback"
ELASTOS_RETAIN_FILE="${retain}" bash "${root}/scripts/runtime-smoke.sh"
if [[ ! -s "${retain}" ]]; then
  echo "The install did not leave a home directory for rollback" >&2
  exit 1
fi
export HOME
HOME="$(tr -d '\r\n' < "${retain}")"
export XDG_DATA_HOME="${HOME}/.local/share"
export PATH="${HOME}/.local/bin:${PATH}"
runtime_bin="${HOME}/.local/bin/elastos"
if [[ ! -x "${runtime_bin}" ]]; then
  echo "Installer did not produce ${runtime_bin}" >&2
  exit 1
fi

pin_file="${root}/resources/runtime-pin.json"
python3 - "${pin_file}" "${work}/release-head.json" "${work}/prev-head.json" "${work}/rollback.env" <<'PY'
import json, re, sys, urllib.request

def varint(value):
    out = bytearray()
    while True:
        byte = value & 0x7F
        value >>= 7
        if value:
            out.append(byte | 0x80)
        else:
            out.append(byte)
            return bytes(out)

def unixfs_cid(raw):
    import hashlib
    unixfs = bytes([0x08, 0x02]) + bytes([0x12]) + varint(len(raw)) + raw + bytes([0x18]) + varint(len(raw))
    dag = bytes([0x0A]) + varint(len(unixfs)) + unixfs
    digest = hashlib.sha256(dag).digest()
    number = int.from_bytes(b"\x12\x20" + digest, "big")
    alphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"
    cid = ""
    while number:
        number, digit = divmod(number, 58)
        cid = alphabet[digit] + cid
    return cid

pin = json.load(open(sys.argv[1]))
channel = pin["channels"][pin["active"]]
gateway = pin["publisherGateway"].rstrip("/")
current = urllib.request.urlopen(gateway + "/release-head.json", timeout=60).read()
open(sys.argv[2], "wb").write(current)
current_doc = json.loads(current.decode())
current_cid = unixfs_cid(current)
if current_doc["payload"]["version"] != "0.8.0-alpha.22":
    sys.exit("publisher release-head.json is not 0.8.0-alpha.22")
if current_cid != channel["headCid"]:
    sys.exit(f"publisher head {current_cid} is not the pin {channel['headCid']}")
prev = current_doc["payload"].get("prev_head_cid") or ""
if not re.fullmatch(r"Qm[1-9A-HJ-NP-Za-km-z]{20,}", prev):
    sys.exit("publisher release head has no previous head CID")
prev_raw = urllib.request.urlopen(gateway + "/ipfs/" + prev, timeout=60).read()
open(sys.argv[3], "wb").write(prev_raw)
prev_doc = json.loads(prev_raw.decode())
prev_cid = unixfs_cid(prev_raw)
if prev_cid != prev:
    sys.exit(f"previous object CID {prev_cid} is not {prev}")
if prev_doc["payload"]["version"] != "0.8.0-alpha.21":
    sys.exit(f"previous head is {prev_doc['payload'].get('version')}, not 0.8.0-alpha.21")
open(sys.argv[4], "w").write(
    f"PREV_CID={prev}\nPIN_CID={channel['headCid']}\nMAINTAINER={pin['maintainerDid']}\n"
)
print(f"previous head {prev} is 0.8.0-alpha.21")
print(f"pinned head {channel['headCid']} is 0.8.0-alpha.22")
PY

# shellcheck disable=SC1090
source "${work}/rollback.env"
python3 "${root}/scripts/verify-release-head.py" "${work}/release-head.json" elastos.release.head.v1 "${MAINTAINER}"
python3 "${root}/scripts/verify-release-head.py" "${work}/prev-head.json" elastos.release.head.v1 "${MAINTAINER}"
echo "Release head signature matches the pinned maintainer"

gw_pid=""
gw_log="${work}/gateway.log"

stop_gateway() {
  if [[ -z "${gw_pid}" ]]; then
    return 0
  fi
  echo "Stopping gateway pid ${gw_pid}"
  kill -TERM -"${gw_pid}" 2>/dev/null || kill -TERM "${gw_pid}" 2>/dev/null || true
  local i
  for i in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15; do
    if ! kill -0 "${gw_pid}" 2>/dev/null; then
      break
    fi
    sleep 1
  done
  if kill -0 "${gw_pid}" 2>/dev/null; then
    kill -KILL -"${gw_pid}" 2>/dev/null || kill -KILL "${gw_pid}" 2>/dev/null || true
  fi
  wait "${gw_pid}" 2>/dev/null || true
  gw_pid=""
  if curl -fsS --max-time 2 http://localhost:8090/healthz >/dev/null 2>&1; then
    echo "Gateway still answering /healthz after stop" >&2
    exit 1
  fi
  echo "Gateway stopped cleanly"
}

cleanup() {
  local status=$?
  stop_gateway || true
  if [[ "${status}" -ne 0 && -f "${gw_log}" ]]; then
    echo "----- gateway log -----"
    tail -n 80 "${gw_log}" || true
  fi
  exit "${status}"
}
trap cleanup EXIT

require_health() {
  "${runtime_bin}" gateway --addr localhost:8090 >"${gw_log}" 2>&1 &
  gw_pid=$!
  local healthy=0
  local _
  for _ in $(seq 1 90); do
    if ! kill -0 "${gw_pid}" 2>/dev/null; then
      echo "Gateway exited before /healthz" >&2
      exit 1
    fi
    local body
    body="$(curl -fsS --max-time 2 http://localhost:8090/healthz 2>/dev/null || true)"
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
  stop_gateway
}

require_version() {
  local want="$1"
  local got
  got="$("${runtime_bin}" version)"
  echo "Installed version: ${got}"
  if [[ "${got}" != "ElastOS Runtime v${want}" && "${got}" != "${want}" ]]; then
    echo "Installed version is not exactly ${want}: ${got}" >&2
    exit 1
  fi
}

run_update() {
  echo "Running: ${runtime_bin} $*"
  set +e
  local out
  out="$("${runtime_bin}" "$@" 2>&1)"
  local code=$?
  set -e
  printf '%s\n' "${out}"
  if [[ "${code}" -ne 0 ]]; then
    echo "elastos update exited ${code}" >&2
    exit 1
  fi
}

echo "Rolling back to 0.8.0-alpha.21 ${PREV_CID}"
run_update update --rollback-to "${PREV_CID}" --yes
require_version "0.8.0-alpha.21"
require_health

echo "Updating back to the pinned release ${PIN_CID}"
run_update update --yes
require_version "0.8.0-alpha.22"
require_health
echo "Rollback returned to the pinned release"
trap - EXIT
