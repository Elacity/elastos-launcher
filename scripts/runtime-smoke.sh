#!/usr/bin/env bash
# Install a pinned ElastOS runtime, start `elastos gateway` on 127.0.0.1:8090,
# require /healthz to be OK and /home/ to return 200, then stop the process group.
#
# Reads resources/runtime-pin.json. "active" selects canary or stable.
# If that pin does not match the publisher, install stops.
#
# Uses an isolated HOME so it does not touch the runner's real data dir.
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
raw_pin="${ELASTOS_SMOKE_PIN:-${root}/resources/runtime-pin.json}"
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

python3 - "${raw_pin}" "${work}/pin.json" <<'PY'
import json, sys
pin = json.load(open(sys.argv[1]))
if "channels" in pin:
    name = pin["active"]
    channel = pin["channels"][name]
    flat = {
        "channel": name,
        "version": channel.get("version"),
        "headCid": channel.get("headCid"),
        "maintainerDid": pin.get("maintainerDid"),
        "publisherGateway": pin.get("publisherGateway"),
        "fallbackInstallerUrl": pin.get("fallbackInstallerUrl"),
        "installerSha256": pin.get("installerSha256"),
    }
else:
    flat = pin
json.dump(flat, open(sys.argv[2], "w"))
print(f"smoke pin channel={flat.get('channel')} version={flat.get('version')}")
PY
pin_file="${work}/pin.json"

pc2_dir="${real_home}/.pc2"
pc2_stamp=""
if [[ -e "${pc2_dir}" ]]; then
  pc2_stamp="$(stat -c %Y "${pc2_dir}" 2>/dev/null || stat -f %m "${pc2_dir}")"
fi

python3 - "${pin_file}" "${work}/pin.match" "${work}/release-head.json" <<'PY'
import json, sys, urllib.request
pin = json.load(open(sys.argv[1]))
url = pin["publisherGateway"].rstrip("/") + "/release-head.json"
with urllib.request.urlopen(url, timeout=30) as response:
    raw = response.read()
open(sys.argv[3], "wb").write(raw)
head = json.loads(raw.decode())
payload = head["payload"]

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

unixfs = bytes([0x08, 0x02]) + bytes([0x12]) + varint(len(raw)) + raw + bytes([0x18]) + varint(len(raw))
dag = bytes([0x0A]) + varint(len(unixfs)) + unixfs
import hashlib
digest = hashlib.sha256(dag).digest()
number = int.from_bytes(b"\x12\x20" + digest, "big")
alphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"
head_cid = ""
while number:
    number, digit = divmod(number, 58)
    head_cid = alphabet[digit] + head_cid
print(f"publisher channel={payload.get('channel')} version={payload.get('version')} release_cid={payload.get('latest_release_cid')} head_cid={head_cid}")
print(f"pin       channel={pin.get('channel')} version={pin.get('version')} head_cid={pin.get('headCid')}")
matched = (
    payload.get("channel") == pin.get("channel")
    and payload.get("version") == pin.get("version")
    and head_cid == pin.get("headCid")
    and head.get("signer_did") == pin.get("maintainerDid")
)
open(sys.argv[2], "w").write("yes\n" if matched else "no\n")
PY

matched="$(cat "${work}/pin.match")"
installer="${work}/install.sh"
fallback="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["fallbackInstallerUrl"])' "${pin_file}")"

if [[ "${matched}" != "yes" ]]; then
  echo "Pinned release does not match the publisher. Install stopped." >&2
  exit 1
fi
echo "Pinned release matches the publisher. Verifying the signature and installer hash."
maintainer="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["maintainerDid"])' "${pin_file}")"
head_cid="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["headCid"])' "${pin_file}")"
want_sha="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["installerSha256"])' "${pin_file}")"
python3 "${root}/scripts/verify-release-head.py" "${work}/release-head.json" elastos.release.head.v1 "${maintainer}"
echo "Release head signature matches the pinned maintainer"

curl -fsSL --max-time 60 "${fallback}" -o "${installer}"
if command -v sha256sum >/dev/null 2>&1; then
  got_sha="$(sha256sum "${installer}" | awk '{print $1}')"
else
  got_sha="$(shasum -a 256 "${installer}" | awk '{print $1}')"
fi
if [[ "${got_sha}" != "${want_sha}" ]]; then
  echo "install.sh SHA-256 ${got_sha} does not match the pin ${want_sha}" >&2
  exit 1
fi
echo "install.sh SHA-256 matches the pin"
# --install-only avoids opening a browser. The pinned install.sh records the
# head from ELASTOS_HEAD_CID. That value is the pin, not whatever the caller
# had in the environment. The maintainer and publisher gateway stay on the
# installer's stamped trust root.
env -u ELASTOS_MAINTAINER_DID -u ELASTOS_PUBLISHER_GATEWAY \
  ELASTOS_HEAD_CID="${head_cid}" \
  bash "${installer}" --install-only --maintainer-did "${maintainer}"

runtime_bin="${HOME}/.local/bin/elastos"
if [[ ! -x "${runtime_bin}" ]]; then
  echo "Installer did not produce ${runtime_bin}" >&2
  exit 1
fi

installed_version="$("${runtime_bin}" version)"
echo "Installed version: ${installed_version}"
want="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["version"])' "${pin_file}")"
if [[ "${installed_version}" != "ElastOS Runtime v${want}" && "${installed_version}" != "${want}" ]]; then
  echo "Installed version is not exactly ${want}: ${installed_version}" >&2
  exit 1
fi

echo "Running elastos setup"
"${runtime_bin}" setup </dev/null

if [[ "$(uname -s)" == "Darwin" ]]; then
  components="${HOME}/Library/Application Support/elastos/components.json"
else
  components="${XDG_DATA_HOME}/elastos/components.json"
fi
if [[ ! -f "${components}" ]]; then
  echo "components.json missing at ${components}" >&2
  exit 1
fi
echo "components.json is present"
sources="$(dirname "${components}")/sources.json"
installed_head="$(python3 -c 'import json,sys; doc=json.load(open(sys.argv[1])); sources=doc.get("sources") or []; named=next((item for item in sources if item.get("name")==doc.get("default_source")), sources[0] if sources else {}); print(named.get("head_cid",""))' "${sources}")"
if [[ "${installed_head}" != "${head_cid}" ]]; then
  echo "Installed head CID ${installed_head} is not the pinned head ${head_cid}" >&2
  exit 1
fi
echo "Installed head CID matches the pin"

if [[ -n "${pc2_stamp}" ]]; then
  pc2_now="$(stat -c %Y "${pc2_dir}" 2>/dev/null || stat -f %m "${pc2_dir}")"
  if [[ "${pc2_now}" != "${pc2_stamp}" ]]; then
    echo "PC2 directory changed during the runtime install" >&2
    exit 1
  fi
  echo "PC2 directory was left unchanged"
fi

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
if [[ -n "${ELASTOS_RETAIN_FILE:-}" ]]; then
  printf '%s\n' "${HOME}" > "${ELASTOS_RETAIN_FILE}"
fi
